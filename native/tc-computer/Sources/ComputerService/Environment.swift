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
    /// `isFinishedLaunching` up to `timeout`; `open` items go to it in the same call. An app already
    /// running is reused (docs/computer-protocol.md §22.1).
    func launch(path: String, open: [OpenItem], timeout: Duration) async throws -> (pid: Int32, launched: Bool)
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
    /// the bundle's path, which arms the front guard on a launch whose pid is not known yet
    public var path: String?

    public init(pid: Int32, bundleId: String?, name: String, change: Change, path: String? = nil) {
        self.pid = pid
        self.bundleId = bundleId
        self.name = name
        self.change = change
        self.path = path
    }
}

/// NSWorkspace's launch, terminate, activate, hide and unhide notifications.
public protocol AppEventSource: Sendable {
    func start(_ handler: @escaping @Sendable (AppEvent) -> Void)
    func stop()
}

/// What the front guard reads and moves (docs/computer-protocol.md §22.3). Every call may block on AX; the
/// guard calls it from its own queue. The binary's is `LiveFrontSource`.
public protocol FrontSource: Sendable {
    /// the guard's clock in milliseconds: the system's uptime, which NSEvent stamps the person's input with
    func now() -> Double
    func frontmost() -> Int32?
    /// the CGWindowID of the app's focused window
    func focusedWindow(pid: Int32) -> UInt32?
    /// AXFrontmost on the app element; never `NSRunningApplication.activate`, which macOS refuses a background caller
    @discardableResult func setFrontmost(pid: Int32) -> Bool
    /// AXRaise and AXMain on the window, or on the app's focused window read fresh when `window` is nil
    @discardableResult func raise(pid: Int32, window: UInt32?) -> Bool
    /// a window of `pid` sits above `over`'s focused window and overlaps it (CGWindowList order)
    func orderedAbove(pid: Int32, over: Int32) -> Bool
    /// `NSRunningApplication.hide()`, which works on another app
    @discardableResult func hide(pid: Int32) -> Bool
    /// The listen-only monitor of the person's mouse downs and key downs, unmarked only; it runs while any
    /// watch does. `handler` gets `.personDown` and `.personKey`.
    func startSignals(_ handler: @escaping @Sendable (FrontEvent) -> Void)
    func stopSignals()
    /// what `apps.launch` checks of an item before it opens; nil when nothing is at the path
    func fileFacts(path: String) -> FileFacts?
}

/// A Mac with no front to guard: the default for an environment built without one.
public struct NoFrontSource: FrontSource {
    public init() {}
    public func now() -> Double { ProcessInfo.processInfo.systemUptime * 1_000 }
    public func frontmost() -> Int32? { nil }
    public func focusedWindow(pid: Int32) -> UInt32? { nil }
    public func setFrontmost(pid: Int32) -> Bool { false }
    public func raise(pid: Int32, window: UInt32?) -> Bool { false }
    public func orderedAbove(pid: Int32, over: Int32) -> Bool { false }
    public func hide(pid: Int32) -> Bool { false }
    public func startSignals(_ handler: @escaping @Sendable (FrontEvent) -> Void) {}
    public func stopSignals() {}
    public func fileFacts(path: String) -> FileFacts? { nil }
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
    /// the front guard's tick: the window order, the lock, the pause's bound, the watch's end
    public var frontTick: Duration = .milliseconds(100)
    /// the poll while a restore runs
    public var frontPoll: Duration = .milliseconds(20)
    /// an activation is handed to the guard this long after NSWorkspace tells it, so the person's click
    /// or ⌘-Tab that caused it, which the monitor hears on the main thread, is heard first
    public var frontChoiceGrace: Duration = .milliseconds(30)
    /// an action's watch runs on this long after its closing wait (§22.4)
    public var frontActionTail: Duration = .seconds(1)
    /// an open's wait for the new window: polled this often, and an existing window's new title must
    /// hold this long before it ends the wait (the URL went into a tab)
    public var launchWindowPoll: Duration = .milliseconds(100)
    public var launchTitleSettle: Duration = .milliseconds(300)

    public init() {}
}

/// What the service runs against: the live Mac in the binary, fakes in the tests.
public struct ServiceEnvironment: Sendable {
    public var workspace: any Workspace
    public var permissions: any PermissionSource
    public var system: any SystemFacts
    public var appEvents: any AppEventSource
    public var windowEvents: any WindowEventSource
    public var front: any FrontSource
    /// the Mac-wide lock directory (`MacLocks.defaultDirectory()`)
    public var lockDirectory: URL
    /// ends the process; the tests record the code instead
    public var exit: @Sendable (Int32) -> Void
    /// `getppid() == 1`
    public var parentGone: @Sendable () -> Bool
    public var timing: ServiceTiming
    /// this process
    public var pid: Int32
    /// the host: an app it resolves to is never launched or opened into (§22.2)
    public var parentPid: Int32

    public init(workspace: any Workspace, permissions: any PermissionSource, system: any SystemFacts, appEvents: any AppEventSource,
                windowEvents: any WindowEventSource, front: any FrontSource = NoFrontSource(), lockDirectory: URL = MacLocks.defaultDirectory(),
                exit: @escaping @Sendable (Int32) -> Void, parentGone: @escaping @Sendable () -> Bool, timing: ServiceTiming = ServiceTiming(),
                pid: Int32 = ProcessInfo.processInfo.processIdentifier, parentPid: Int32 = getppid()) {
        self.workspace = workspace
        self.permissions = permissions
        self.system = system
        self.appEvents = appEvents
        self.windowEvents = windowEvents
        self.front = front
        self.lockDirectory = lockDirectory
        self.exit = exit
        self.parentGone = parentGone
        self.timing = timing
        self.pid = pid
        self.parentPid = parentPid
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
