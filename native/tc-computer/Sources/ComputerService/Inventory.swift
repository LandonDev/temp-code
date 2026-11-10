import ComputerCore
import ComputerProtocol
import ComputerServiceKit
import Foundation

/// The apps on the Mac: running ones from NSWorkspace, installed ones scanned and kept a minute, and
/// resolving an `AppRef` (docs/computer-protocol.md §2.1, shell §4).
final class Inventory: @unchecked Sendable {
    private let workspace: any Workspace
    private let timing: ServiceTiming
    /// every launch and open runs under its guard (§22.3)
    private let front: FrontWatch
    private let windows: any WindowSource
    /// the host, which no call may launch or open into
    private let parent: Int32
    private let lock = NSLock()
    private var installedCache: (at: ContinuousClock.Instant, apps: [AppCandidate])?

    init(workspace: any Workspace, timing: ServiceTiming, front: FrontWatch, windows: any WindowSource, parent: Int32) {
        self.workspace = workspace
        self.timing = timing
        self.front = front
        self.windows = windows
        self.parent = parent
    }

    /// An app found without launching it: running (with its pid) or installed at `path`.
    struct LaunchTarget: Sendable {
        var pid: Int32?
        var bundleId: String?
        var name: String
        var path: String
    }

    func running() -> [RunningApp] { workspace.runningApps() }

    func installed() -> [AppCandidate] {
        if let cached = lock.withLock({ installedCache }), ContinuousClock.now - cached.at < timing.installedCache { return cached.apps }
        let apps = workspace.installedApps()
        lock.withLock { installedCache = (.now, apps) }
        return apps
    }

    /// Running apps, the frontmost first, then by name as Finder sorts them.
    func sortedRunning() -> [RunningApp] {
        running().sorted { a, b in
            if a.active != b.active { return a.active }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }

    /// The pid an `AppRef` names, launching an installed app in the background when `launch` allows. That
    /// launch runs under the front guard; a steal is told as `apps/frontRestored` naming `session`.
    func resolve(_ ref: AppRef, launch: Bool, session: String? = nil) async throws -> (pid: Int32, launched: Bool) {
        let running = running()
        if let pid = ref.pid {
            guard running.contains(where: { Int($0.pid) == pid }) else {
                throw ComputerError(kind: .appNotFound, message: "No regular app runs as pid \(pid).", candidates: Array(running.map(\.name).prefix(AppMatcher.maxCandidates)))
            }
            return (Int32(pid), false)
        }
        let query = ref.app ?? ""
        var installed = installed()
        if Inventory.looksLikeBundleID(query), !installed.contains(where: { $0.bundleId == query }), let path = workspace.appPath(bundleId: query) {
            installed.append(AppCandidate(bundleId: query, name: URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent, path: path))
        }
        let candidates = running.map { AppCandidate(pid: $0.pid, bundleId: $0.bundleId, name: $0.name, path: $0.path) }
        switch AppMatcher.match(query, running: candidates, installed: installed, launch: launch) {
        case .running(let pid):
            return (pid, false)
        case .launch(let path):
            let target = installedTarget(path, installed: installed)
            let watch = front.begin(WatchedApp(bundleId: target.bundleId, path: path), session: session, name: target.name)
            do {
                let (pid, launched) = try await workspace.launch(path: path, open: [], timeout: timing.launchWindow)
                watch.bind(pid)
                watch.tellByNotice()
                return (pid, launched)
            } catch {
                watch.end(in: .zero)
                watch.tellByNotice()
                throw error
            }
        case .notFound(let names, let launchable):
            throw ComputerError(kind: .appNotFound, message: Inventory.notFoundMessage(query, launchable: launchable), candidates: names)
        }
    }

    /// The app `app` names, found without launching it.
    func target(_ app: String) throws -> LaunchTarget {
        let running = running()
        var installed = installed()
        if Inventory.looksLikeBundleID(app), !installed.contains(where: { $0.bundleId == app }), let path = workspace.appPath(bundleId: app) {
            installed.append(AppCandidate(bundleId: app, name: URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent, path: path))
        }
        let candidates = running.map { AppCandidate(pid: $0.pid, bundleId: $0.bundleId, name: $0.name, path: $0.path) }
        switch AppMatcher.match(app, running: candidates, installed: installed, launch: true) {
        case .running(let pid):
            let found = running.first { $0.pid == pid }
            return LaunchTarget(pid: pid, bundleId: found?.bundleId, name: found?.name ?? app, path: found?.path ?? "")
        case .launch(let path):
            return installedTarget(path, installed: installed)
        case .notFound(let names, let launchable):
            throw ComputerError(kind: .appNotFound, message: Inventory.notFoundMessage(app, launchable: launchable), candidates: names)
        }
    }

    private func installedTarget(_ path: String, installed: [AppCandidate]) -> LaunchTarget {
        let candidate = installed.first { $0.path == path }
        let bundleId = candidate?.bundleId ?? Bundle(path: path)?.bundleIdentifier
        return LaunchTarget(pid: nil, bundleId: bundleId, name: candidate?.name ?? URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent, path: path)
    }

    /// `apps.launch` (docs/computer-protocol.md §22.2): every item checked and the app resolved without
    /// launching it, refused when its bundle id is in `refuse` or it is the host; then ONE open call with the
    /// items under the front guard, a wait for the window it opened, and the report.
    func launch(_ app: String, open: [String], session: String?, refuse: [String]) async throws -> Methods.AppsLaunch.Output {
        let items: [OpenItem]
        switch OpenItem.classifyAll(open, facts: { [front] in front.fileFacts($0) }) {
        case .success(let checked): items = checked
        case .failure(let refusal): throw refusal.error
        }
        let target = try target(app)
        let host = running().first { $0.pid == parent }
        if target.bundleId.map(refuse.contains) == true || target.pid == parent || (host?.path).map({ $0 == target.path }) == true {
            throw ComputerError(kind: .openRefused, message: "\(target.name) is one of the apps no call may open or launch.", reason: .app)
        }
        var before: [WindowInfo] = []
        if let pid = target.pid { before = await windowList(pid) ?? [] }
        let watch = front.begin(WatchedApp(bundleId: target.bundleId, path: target.path.isEmpty ? nil : target.path, pid: target.pid), session: session, name: target.name)
        let start = ContinuousClock.now
        let pid: Int32
        let launched: Bool
        do {
            (pid, launched) = try await workspace.launch(path: target.path, open: items, timeout: timing.launchWindow)
        } catch {
            watch.end(in: .zero)
            _ = watch.answer()
            throw error
        }
        watch.bind(pid)
        var window: LaunchedWindow?
        var others: [LaunchedWindow] = []
        if launched || !items.isEmpty { (window, others) = await newWindow(pid, before: before, until: start + timing.launchWindow) }
        return Methods.AppsLaunch.Output(pid: Int(pid), launched: launched, front: watch.answer(), window: window, others: others.isEmpty ? nil : others)
    }

    /// The first window of `pid` that was not there before, read until `deadline`; and the app's other
    /// windows that appeared or changed title meanwhile. An existing window's new title that holds for
    /// `launchTitleSettle` with no new window ends the wait too (a URL that went into a tab).
    private func newWindow(_ pid: Int32, before: [WindowInfo], until deadline: ContinuousClock.Instant) async -> (LaunchedWindow?, [LaunchedWindow]) {
        let earlier = Dictionary(before.map { ($0.id, $0.title) }, uniquingKeysWith: { a, _ in a })
        var retitledSince: ContinuousClock.Instant?
        var list: [WindowInfo] = []
        while true {
            list = await windowList(pid) ?? list
            let fresh = list.filter { earlier[$0.id] == nil }
            let retitled = list.filter { info in earlier[info.id].map { $0 != info.title } ?? false }
            if !fresh.isEmpty { break }
            if retitled.isEmpty {
                retitledSince = nil
            } else if retitledSince == nil {
                retitledSince = .now
            }
            if let since = retitledSince, ContinuousClock.now - since >= timing.launchTitleSettle { break }
            guard ContinuousClock.now < deadline else { break }
            try? await Task.sleep(for: timing.launchWindowPoll)
        }
        let changed = list.filter { earlier[$0.id] == nil || earlier[$0.id] != $0.title }.map { LaunchedWindow(id: $0.id, title: $0.title) }
        let opened = list.first { earlier[$0.id] == nil }.map { LaunchedWindow(id: $0.id, title: $0.title) }
        return (opened, changed.filter { $0 != opened })
    }

    /// The app's windows, read on a dispatch queue (an AX walk can block); nil when the app did not answer.
    private func windowList(_ pid: Int32) async -> [WindowInfo]? {
        let windows = self.windows
        return await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async { continuation.resume(returning: try? windows.list(pid: pid)) }
        }
    }

    func isRunning(_ pid: Int32) -> Bool { workspace.isRunning(pid) }

    static func looksLikeBundleID(_ query: String) -> Bool {
        query.contains(".") && !query.contains(" ") && !query.hasPrefix("/")
    }

    static func notFoundMessage(_ query: String, launchable: Bool) -> String {
        launchable
            ? "\"\(query)\" is installed but not running; ask again with launch to start it in the background."
            : "No app named \"\(query)\" is running; the closest names are in candidates."
    }
}
