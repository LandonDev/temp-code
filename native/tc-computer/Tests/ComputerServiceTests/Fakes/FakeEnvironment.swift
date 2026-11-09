import ComputerProtocol
@testable import ComputerService
import ComputerServiceKit
import Foundation

final class FakeWorkspace: Workspace, @unchecked Sendable {
    private let lock = NSLock()
    var apps: [RunningApp] = [RunningApp(pid: 500, bundleId: "com.example.Doc", name: "Doc", path: "/Applications/Doc.app", active: false, hidden: false)]
    var installed: [AppCandidate] = [AppCandidate(bundleId: "com.example.Notes", name: "Notes", path: "/Applications/Notes.app")]
    var launches: [(path: String, open: [String])] = []
    /// the pid a launch gives
    var launchPid: Int32 = 600

    func runningApps() -> [RunningApp] { lock.withLock { apps } }
    func installedApps() -> [AppCandidate] { lock.withLock { installed } }
    func appPath(bundleId: String) -> String? { nil }

    func launch(path: String, open: [String], timeout: Duration) async throws -> (pid: Int32, launched: Bool) {
        lock.withLock {
            launches.append((path, open))
            if let running = apps.first(where: { $0.path == path }) { return (running.pid, false) }
            apps.append(RunningApp(pid: launchPid, bundleId: nil, name: URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent, path: path, active: false, hidden: false))
            return (launchPid, true)
        }
    }

    func isRunning(_ pid: Int32) -> Bool { lock.withLock { apps.contains { $0.pid == pid } } }

    func quit(_ pid: Int32) { lock.withLock { apps.removeAll { $0.pid == pid } } }
    var launchCount: Int { lock.withLock { launches.count } }
}

final class FakePermissions: PermissionSource, @unchecked Sendable {
    private let lock = NSLock()
    private var ax: Bool
    private var sr: Bool
    private(set) var prompts: [String] = []

    init(accessibility: Bool = true, screenRecording: Bool = true) {
        ax = accessibility
        sr = screenRecording
    }

    func accessibility() -> Bool { lock.withLock { ax } }
    func screenRecording() -> Bool { lock.withLock { sr } }
    func promptAccessibility() { lock.withLock { prompts.append("accessibility") } }
    func requestScreenRecording() { lock.withLock { prompts.append("screenRecording") } }
    func set(accessibility: Bool? = nil, screenRecording: Bool? = nil) {
        lock.withLock {
            if let accessibility { ax = accessibility }
            if let screenRecording { sr = screenRecording }
        }
    }
    var asked: [String] { lock.withLock { prompts } }
}

final class FakeSystem: SystemFacts, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 10

    func displays() -> [DisplayInfo] { [DisplayInfo(id: 1, frame: Rect(x: 0, y: 0, w: 1512, h: 982), scale: 2)] }
    func osVersion() -> String { "15.1.0" }
    func arch() -> String { "arm64" }
    func pasteboardChangeCount() -> Int { lock.withLock { count } }
    func now() -> Double { Date().timeIntervalSince1970 * 1_000 }
    func copy() { lock.withLock { count += 1 } }
}

final class FakeAppEvents: AppEventSource, @unchecked Sendable {
    private let lock = NSLock()
    private var handler: (@Sendable (AppEvent) -> Void)?

    func start(_ handler: @escaping @Sendable (AppEvent) -> Void) { lock.withLock { self.handler = handler } }
    func stop() { lock.withLock { handler = nil } }
    func send(_ event: AppEvent) { lock.withLock { handler }?(event) }
}

final class FakeWindowEvents: WindowEventSource, @unchecked Sendable {
    private let lock = NSLock()
    private var handler: (@Sendable (WindowEvent) -> Void)?
    private(set) var watched: Set<Int32> = []

    func start(_ handler: @escaping @Sendable (WindowEvent) -> Void) { lock.withLock { self.handler = handler } }
    func watch(pid: Int32) { lock.withLock { _ = watched.insert(pid) } }
    func unwatch(pid: Int32) { lock.withLock { _ = watched.remove(pid) } }
    func stop() { lock.withLock { handler = nil } }
    func send(_ event: WindowEvent) { lock.withLock { handler }?(event) }
    var watching: Set<Int32> { lock.withLock { watched } }
}

/// The first exit code, as the process would have ended with it.
final class ExitRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var codes: [Int32] = []

    func record(_ code: Int32) { lock.withLock { codes.append(code) } }
    var first: Int32? { lock.withLock { codes.first } }
}
