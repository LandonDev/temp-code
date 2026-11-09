import ComputerCore
import ComputerProtocol
import ComputerServiceKit
import Foundation

/// The apps on the Mac: running ones from NSWorkspace, installed ones scanned and kept a minute, and
/// resolving an `AppRef` (docs/computer-protocol.md §2.1, shell §4).
final class Inventory: @unchecked Sendable {
    private let workspace: any Workspace
    private let timing: ServiceTiming
    private let lock = NSLock()
    private var installedCache: (at: ContinuousClock.Instant, apps: [AppCandidate])?

    init(workspace: any Workspace, timing: ServiceTiming) {
        self.workspace = workspace
        self.timing = timing
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

    /// The pid an `AppRef` names, launching an installed app in the background when `launch` allows.
    func resolve(_ ref: AppRef, launch: Bool) async throws -> (pid: Int32, launched: Bool) {
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
            return try await workspace.launch(path: path, open: [], timeout: timing.launchWindow)
        case .notFound(let names, let launchable):
            throw ComputerError(kind: .appNotFound, message: Inventory.notFoundMessage(query, launchable: launchable), candidates: names)
        }
    }

    /// `apps.launch`: the app started in the background, or found running, with its `open` items.
    func launch(_ app: String, open: [String]) async throws -> (pid: Int32, launched: Bool) {
        let (pid, launched) = try await resolve(AppRef(app: app), launch: true)
        if !open.isEmpty, let path = running().first(where: { $0.pid == pid })?.path {
            _ = try await workspace.launch(path: path, open: open, timeout: timing.launchWindow)
        }
        return (pid, launched)
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
