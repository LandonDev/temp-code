import AppKit
import ApplicationServices
import ComputerProtocol
import struct ComputerProtocol.WindowRef
import ComputerServiceKit
import Foundation

extension ServiceEnvironment {
    /// The Mac, as the binary runs it.
    public static func live(windows: any WindowSource, executable: URL?) -> ServiceEnvironment {
        ServiceEnvironment(
            workspace: LiveWorkspace(),
            permissions: LivePermissions(executable: executable),
            system: LiveSystem(),
            appEvents: LiveAppEvents(),
            windowEvents: LiveWindowEvents(windows: windows),
            front: LiveFrontSource(windows: windows),
            exit: { code in Foundation.exit(code) },
            parentGone: { getppid() == 1 }
        )
    }
}

/// Runs `body` on the main thread, which the binary keeps free for AppKit.
func onMain<T: Sendable>(_ body: @MainActor () -> T) -> T {
    if Thread.isMainThread { return MainActor.assumeIsolated(body) }
    return DispatchQueue.main.sync { MainActor.assumeIsolated(body) }
}

// MARK: NSWorkspace

final class LiveWorkspace: Workspace, @unchecked Sendable {
    static let folders = ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"]

    func runningApps() -> [RunningApp] {
        let workspace = NSWorkspace.shared
        let front = workspace.frontmostApplication?.processIdentifier
        return workspace.runningApplications.filter { $0.activationPolicy == .regular && !$0.isTerminated }.map { app in
            RunningApp(
                pid: app.processIdentifier, bundleId: app.bundleIdentifier,
                name: app.localizedName ?? app.bundleURL?.deletingPathExtension().lastPathComponent ?? "",
                path: app.bundleURL?.path, active: app.processIdentifier == front, hidden: app.isHidden
            )
        }
    }

    func installedApps() -> [AppCandidate] {
        var apps: [AppCandidate] = []
        for folder in LiveWorkspace.folders {
            guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder) else { continue }
            for name in names where name.hasSuffix(".app") {
                let path = folder + "/" + name
                let info = Bundle(path: path)?.infoDictionary ?? [:]
                let file = String(name.dropLast(4))
                let display = info["CFBundleDisplayName"] as? String ?? info["CFBundleName"] as? String ?? file
                let bundleId = info["CFBundleIdentifier"] as? String
                apps.append(AppCandidate(bundleId: bundleId, name: display, path: path))
                if display != file { apps.append(AppCandidate(bundleId: bundleId, name: file, path: path)) }
            }
        }
        return apps
    }

    func appPath(bundleId: String) -> String? {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId)?.path
    }

    /// One call: `openApplication` alone, or `open(_:withApplicationAt:)` with the items, so the app is told
    /// once; the configuration never activates (§23.1). `hides` and `createsNewApplicationInstance` stay off:
    /// a hidden app cannot be captured, and a second instance of one bundle id breaks pinning by name.
    func launch(path: String, open: [OpenItem], timeout: Duration) async throws -> (pid: Int32, launched: Bool) {
        let url = URL(fileURLWithPath: path)
        let running = NSWorkspace.shared.runningApplications.contains { $0.bundleURL?.standardizedFileURL == url.standardizedFileURL && !$0.isTerminated }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        configuration.addsToRecentItems = false
        configuration.promptsUserIfNeeded = false
        let items = open.compactMap { item -> URL? in
            switch item.kind {
            case .web(let url): URL(string: url)
            case .file(let path): URL(fileURLWithPath: path)
            }
        }
        let pid: Int32 = try await withCheckedThrowingContinuation { continuation in
            let done: @Sendable (NSRunningApplication?, (any Error)?) -> Void = { app, error in
                if let app { continuation.resume(returning: app.processIdentifier) } else {
                    continuation.resume(throwing: ComputerError(kind: .appNotFound, message: "\(url.lastPathComponent) could not be launched: \(error?.localizedDescription ?? "no app came up").", candidates: []))
                }
            }
            if items.isEmpty {
                NSWorkspace.shared.openApplication(at: url, configuration: configuration, completionHandler: done)
            } else {
                NSWorkspace.shared.open(items, withApplicationAt: url, configuration: configuration, completionHandler: done)
            }
        }
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline, NSRunningApplication(processIdentifier: pid)?.isFinishedLaunching == false {
            try await Task.sleep(for: .milliseconds(50))
        }
        return (pid, !running)
    }

    /// Whether the app's process is alive, read from the process table: `NSRunningApplication`, read off the main
    /// thread, once called a TextEdit gone right after a wait had seen it running every tick (the Mac proof, 2026-11-09).
    func isRunning(_ pid: Int32) -> Bool {
        pid > 0 && (kill(pid, 0) == 0 || errno == EPERM)
    }
}

// MARK: TCC

struct LivePermissions: PermissionSource {
    /// the service's own executable, run as `permissions` for a fresh Screen Recording answer
    let executable: URL?

    func accessibility() -> Bool { AXIsProcessTrusted() }

    func screenRecording() -> Bool {
        if let executable, let read = LivePermissions.readFromChild(executable) { return read.screenRecording }
        return CGPreflightScreenCaptureAccess()
    }

    func promptAccessibility() {
        _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    }

    func requestScreenRecording() {
        _ = CGRequestScreenCaptureAccess()
    }

    /// `tc-computer permissions`: a child of the service is a child of TempCode, so TCC answers for TempCode.
    static func readFromChild(_ executable: URL) -> Permissions? {
        let process = Process()
        process.executableURL = executable
        process.arguments = ["permissions"]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(5)
        while process.isRunning && Date() < deadline { usleep(10_000) }
        if process.isRunning {
            process.terminate()
            return nil
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        return try? JSONDecoder().decode(Permissions.self, from: data)
    }
}

// MARK: Displays, the OS, the pasteboard

struct LiveSystem: SystemFacts {
    func displays() -> [DisplayInfo] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        return ids.prefix(Int(count)).map { id in
            let bounds = CGDisplayBounds(id)
            var scale = 1.0
            if let mode = CGDisplayCopyDisplayMode(id), mode.width > 0 { scale = Double(mode.pixelWidth) / Double(mode.width) }
            return DisplayInfo(id: Int(id), frame: Rect(x: bounds.origin.x, y: bounds.origin.y, w: bounds.width, h: bounds.height), scale: scale)
        }
    }

    func osVersion() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    func arch() -> String {
        #if arch(arm64)
        "arm64"
        #else
        "x86_64"
        #endif
    }

    func pasteboardChangeCount() -> Int {
        onMain { NSPasteboard.general.changeCount }
    }

    func now() -> Double { Date().timeIntervalSince1970 * 1_000 }
}

// MARK: App events

final class LiveAppEvents: AppEventSource, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [any NSObjectProtocol] = []
    private let queue: OperationQueue = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        return queue
    }()

    func start(_ handler: @escaping @Sendable (AppEvent) -> Void) {
        let center = NSWorkspace.shared.notificationCenter
        let names: [(Notification.Name, AppEvent.Change)] = [
            (NSWorkspace.didLaunchApplicationNotification, .launched),
            (NSWorkspace.didTerminateApplicationNotification, .terminated),
            (NSWorkspace.didActivateApplicationNotification, .activated),
            (NSWorkspace.didHideApplicationNotification, .hidden),
            (NSWorkspace.didUnhideApplicationNotification, .unhidden)
        ]
        let made = names.map { name, change in
            center.addObserver(forName: name, object: nil, queue: queue) { note in
                guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, app.activationPolicy == .regular else { return }
                handler(AppEvent(pid: app.processIdentifier, bundleId: app.bundleIdentifier, name: app.localizedName ?? "", change: change, path: app.bundleURL?.path))
            }
        }
        lock.withLock { tokens = made }
    }

    func stop() {
        let old = lock.withLock {
            defer { tokens = [] }
            return tokens
        }
        for token in old { NSWorkspace.shared.notificationCenter.removeObserver(token) }
    }
}

// MARK: Window events

/// One AXObserver per pid on a thread of its own running its run loop, so the service never needs the
/// main run loop for AX (shell §4.4).
final class LiveWindowEvents: WindowEventSource, @unchecked Sendable {
    fileprivate final class Context {
        let pid: pid_t
        weak var owner: LiveWindowEvents?
        /// windows seen, so a destroyed one (whose element can no longer be read) is still named
        var known: [(element: AXUIElement, id: UInt32)] = []

        init(pid: pid_t, owner: LiveWindowEvents) {
            self.pid = pid
            self.owner = owner
        }
    }

    private static let notifications: [(String, WindowEvent.Change)] = [
        (kAXWindowCreatedNotification, .created),
        (kAXUIElementDestroyedNotification, .closed),
        (kAXWindowMiniaturizedNotification, .minimized),
        (kAXWindowDeminiaturizedNotification, .restored),
        (kAXWindowMovedNotification, .moved),
        (kAXWindowResizedNotification, .resized),
        (kAXTitleChangedNotification, .titled),
        (kAXFocusedWindowChangedNotification, .focused)
    ]

    private let windows: any WindowSource
    private let lock = NSLock()
    private var handler: (@Sendable (WindowEvent) -> Void)?
    private var observers: [pid_t: (observer: AXObserver, context: Unmanaged<Context>)] = [:]
    private var runLoop: CFRunLoop?
    private let ready = DispatchSemaphore(value: 0)

    init(windows: any WindowSource) {
        self.windows = windows
        let ready = self.ready
        let thread = Thread { [weak self] in
            let loop = CFRunLoopGetCurrent()
            // a timer that never fires keeps the run loop alive before any observer is added
            let keepAlive = CFRunLoopTimerCreateWithHandler(nil, CFAbsoluteTimeGetCurrent() + 1e10, 1e10, 0, 0) { _ in }
            CFRunLoopAddTimer(loop, keepAlive, .defaultMode)
            self?.lock.withLock { self?.runLoop = loop }
            ready.signal()
            CFRunLoopRun()
        }
        thread.name = "tc-computer.windows"
        thread.start()
        ready.wait()
    }

    func start(_ handler: @escaping @Sendable (WindowEvent) -> Void) {
        lock.withLock { self.handler = handler }
    }

    func watch(pid: pid_t) {
        perform { [self] in
            guard lock.withLock({ observers[pid] }) == nil else { return }
            var made: AXObserver?
            guard AXObserverCreate(pid, LiveWindowEvents.callback, &made) == .success, let observer = made else { return }
            let context = Unmanaged.passRetained(Context(pid: pid, owner: self))
            let app = AXUIElementCreateApplication(pid)
            for (name, _) in LiveWindowEvents.notifications {
                AXObserverAddNotification(observer, app, name as CFString, context.toOpaque())
            }
            CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode)
            lock.withLock { observers[pid] = (observer, context) }
            // the windows already open, so the first thing one does can be to close
            var list: CFTypeRef?
            if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &list) == .success, let windows = list as? [AXUIElement] {
                for window in windows {
                    guard let id = self.windows.windowID(of: window, pid: pid) else { continue }
                    context.takeUnretainedValue().known.append((window, id))
                    AXObserverAddNotification(observer, window, kAXUIElementDestroyedNotification as CFString, context.toOpaque())
                }
            }
        }
    }

    func unwatch(pid: pid_t) {
        perform { [self] in
            guard let entry = lock.withLock({ observers.removeValue(forKey: pid) }) else { return }
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(entry.observer), .defaultMode)
            entry.context.release()
        }
    }

    func stop() {
        let pids = lock.withLock { Array(observers.keys) }
        for pid in pids { unwatch(pid: pid) }
    }

    private func perform(_ body: @escaping @Sendable () -> Void) {
        guard let runLoop = lock.withLock({ runLoop }) else { return }
        CFRunLoopPerformBlock(runLoop, CFRunLoopMode.defaultMode.rawValue, body)
        CFRunLoopWakeUp(runLoop)
    }

    private static let callback: AXObserverCallback = { _, element, notification, refcon in
        guard let refcon else { return }
        let context = Unmanaged<Context>.fromOpaque(refcon).takeUnretainedValue()
        guard let owner = context.owner, let change = notifications.first(where: { $0.0 == notification as String })?.1 else { return }
        owner.deliver(element: element, change: change, context: context)
    }

    private func deliver(element: AXUIElement, change: WindowEvent.Change, context: Context) {
        var id: UInt32?
        if change == .closed {
            guard let at = context.known.firstIndex(where: { CFEqual($0.element, element) }) else { return }
            id = context.known.remove(at: at).id
        } else {
            var role: CFTypeRef?
            let isWindow = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) == .success && (role as? String) == kAXWindowRole
            let window: AXUIElement
            if isWindow {
                window = element
            } else if change == .focused {
                var focused: CFTypeRef?
                guard AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &focused) == .success, let value = focused else { return }
                window = value as! AXUIElement
            } else {
                return
            }
            id = windows.windowID(of: window, pid: context.pid)
            if let id, !context.known.contains(where: { $0.id == id }) {
                context.known.append((window, id))
                AXObserverAddNotification(observer(for: context.pid), window, kAXUIElementDestroyedNotification as CFString, Unmanaged.passUnretained(context).toOpaque())
            }
        }
        guard let id, let handler = lock.withLock({ handler }) else { return }
        handler(WindowEvent(pid: context.pid, windowID: id, change: change))
    }

    private func observer(for pid: pid_t) -> AXObserver {
        lock.withLock { observers[pid]!.observer }
    }
}
