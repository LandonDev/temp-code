import ComputerProtocol
import ComputerServiceKit
import Foundation

/// A running regular app as NSWorkspace sees it.
public struct RunningApp: Sendable, Equatable {
    public var pid: Int32
    public var bundleId: String?
    public var name: String
    /// the bundle's path
    public var path: String?
    public var active: Bool
    public var hidden: Bool

    public init(pid: Int32, bundleId: String?, name: String, path: String?, active: Bool, hidden: Bool) {
        self.pid = pid
        self.bundleId = bundleId
        self.name = name
        self.path = path
        self.active = active
        self.hidden = hidden
    }
}

/// NSWorkspace, as the shell uses it.
public protocol Workspace: Sendable {
    /// Running apps whose activation policy is regular.
    func runningApps() -> [RunningApp]
    /// The `.app` bundles one level deep under the standard folders.
    func installedApps() -> [AppCandidate]
    func appPath(bundleId: String) -> String?
    /// Launches in the background (never activates, adds no recent item, never prompts) and waits for
    /// `isFinishedLaunching` up to `timeout`; `open` items go to it. An app already running is reused.
    func launch(path: String, open: [String], timeout: Duration) async throws -> (pid: Int32, launched: Bool)
    func isRunning(_ pid: Int32) -> Bool
}

/// The two TCC grants.
public protocol PermissionSource: Sendable {
    /// `AXIsProcessTrusted()`, live
    func accessibility() -> Bool
    /// from a fresh child (`tc-computer permissions`), since a process may keep its first answer
    func screenRecording() -> Bool
    /// `AXIsProcessTrustedWithOptions` with the prompt
    func promptAccessibility()
    /// `CGRequestScreenCaptureAccess()`
    func requestScreenRecording()
}

/// The rest of what the shell reads from the system.
public protocol SystemFacts: Sendable {
    func displays() -> [DisplayInfo]
    func osVersion() -> String
    func arch() -> String
    /// `NSPasteboard.general.changeCount`, never the contents
    func pasteboardChangeCount() -> Int
    /// epoch milliseconds
    func now() -> Double
}

/// One NSWorkspace notification about a regular app (`apps/changed`).
public struct AppEvent: Sendable, Equatable {
    public enum Change: String, Sendable { case launched, terminated, activated, hidden, unhidden }
    public var pid: Int32
    public var bundleId: String?
    public var name: String
    public var change: Change

    public init(pid: Int32, bundleId: String?, name: String, change: Change) {
        self.pid = pid
        self.bundleId = bundleId
        self.name = name
        self.change = change
    }
}

/// NSWorkspace's launch, terminate, activate, hide and unhide notifications.
public protocol AppEventSource: Sendable {
    func start(_ handler: @escaping @Sendable (AppEvent) -> Void)
    func stop()
}

/// One AX window notification (`window/changed`).
public struct WindowEvent: Sendable, Equatable {
    public enum Change: String, Sendable { case created, closed, minimized, restored, moved, resized, titled, focused }
    public var pid: Int32
    public var windowID: UInt32
    public var change: Change

    public init(pid: Int32, windowID: UInt32, change: Change) {
        self.pid = pid
        self.windowID = windowID
        self.change = change
    }
}

/// One AXObserver per pid some session has observed, on a thread of its own.
public protocol WindowEventSource: Sendable {
    func start(_ handler: @escaping @Sendable (WindowEvent) -> Void)
    func watch(pid: Int32)
    func unwatch(pid: Int32)
    func stop()
}

/// Every interval the shell keeps; the tests shorten them.
public struct ServiceTiming: Sendable {
    public var appSlotWait: Duration = .milliseconds(ComputerDefaults.Service.appSlotWaitMs)
    public var launchWindow: Duration = .milliseconds(ComputerDefaults.Service.launchWindowMs)
    public var serviceLockWait: Duration = .milliseconds(ComputerDefaults.Service.serviceLockWaitMs)
    /// the exit path ends the process whatever is unfinished after this
    public var exitDeadline: Duration = .milliseconds(ComputerDefaults.Service.shutdownExitMs)
    /// the outbox drains until this much of the exit deadline is left
    public var exitDrainLeave: Duration = .milliseconds(500)
    public var permissionPollOff: Duration = .milliseconds(ComputerDefaults.Service.permissionPollMs)
    public var permissionPollOn: Duration = .milliseconds(ComputerDefaults.Service.permissionPollGrantedMs)
    public var clipboardPoll: Duration = .milliseconds(ComputerDefaults.Service.clipboardPollMs)
    public var parentPoll: Duration = .milliseconds(ComputerDefaults.Service.parentPollMs)
    /// how long the Screen Recording restart waits for requests in flight
    public var restartQuiet: Duration = .seconds(10)
    /// the smart wait's sampling
    public var waitTick: Duration = .milliseconds(25)
    /// the installed-app scan is kept this long
    public var installedCache: Duration = .seconds(60)
    /// how long `session.close` waits for the session's cancelled requests to answer
    public var closeWait: Duration = .seconds(2)

    public init() {}
}

/// What the service runs against: the live Mac in the binary, fakes in the tests.
public struct ServiceEnvironment: Sendable {
    public var workspace: any Workspace
    public var permissions: any PermissionSource
    public var system: any SystemFacts
    public var appEvents: any AppEventSource
    public var windowEvents: any WindowEventSource
    /// the Mac-wide lock directory (`MacLocks.defaultDirectory()`)
    public var lockDirectory: URL
    /// ends the process; the tests record the code instead
    public var exit: @Sendable (Int32) -> Void
    /// `getppid() == 1`
    public var parentGone: @Sendable () -> Bool
    public var timing: ServiceTiming
    /// this process
    public var pid: Int32

    public init(workspace: any Workspace, permissions: any PermissionSource, system: any SystemFacts, appEvents: any AppEventSource,
                windowEvents: any WindowEventSource, lockDirectory: URL = MacLocks.defaultDirectory(),
                exit: @escaping @Sendable (Int32) -> Void, parentGone: @escaping @Sendable () -> Bool, timing: ServiceTiming = ServiceTiming(),
                pid: Int32 = ProcessInfo.processInfo.processIdentifier) {
        self.workspace = workspace
        self.permissions = permissions
        self.system = system
        self.appEvents = appEvents
        self.windowEvents = windowEvents
        self.lockDirectory = lockDirectory
        self.exit = exit
        self.parentGone = parentGone
        self.timing = timing
        self.pid = pid
    }
}

/// `{ version, build }` from `tc-computer.stamp` beside the executable; `dev` without one.
public struct BuildInfo: Sendable, Equatable {
    public var version: String
    public var build: String

    public init(version: String, build: String) {
        self.version = version
        self.build = build
    }

    public static let dev = BuildInfo(version: "dev", build: "dev")

    /// The stamp `scripts/lib/tcComputerBuild.ts` writes: `{"stamp","version","build"}`.
    public static func read(stampBeside executable: URL?) -> BuildInfo {
        guard let executable else { return .dev }
        let stamp = executable.deletingLastPathComponent().appendingPathComponent(executable.lastPathComponent + ".stamp")
        guard let data = try? Data(contentsOf: stamp),
              let json = try? JSONDecoder().decode([String: String].self, from: data),
              let version = json["version"], let build = json["build"] else { return .dev }
        return BuildInfo(version: version, build: build)
    }
}
