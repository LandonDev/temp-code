import AppKit
import ApplicationServices
import Carbon
import ComputerCore
import ComputerProtocol
import CoreGraphics
import Foundation

/// The session tier's reads and writes of the real Mac, over AX, NSWorkspace and CGEvent.
/// Activation goes through AX (AXFrontmost, AXRaise, AXMain): NSRunningApplication.activate
/// asks for cooperative activation, which macOS refuses to a background caller.
public final class LiveSessionHost: SessionHost, @unchecked Sendable {
    public typealias Window = AXUIElement
    private var observer: NSObjectProtocol?
    /// told of every app activation, while a record exists (the ledger counts the foreign ones)
    var onActivation: (@Sendable (Int?) -> Void)?

    public init() {}

    /// Starts the activation observer; NSWorkspace delivers its notifications on main.
    func observeActivations() {
        guard observer == nil else { return }
        observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            self?.onActivation?(app.map { Int($0.processIdentifier) })
        }
    }

    /// `CGSSessionScreenIsLocked` of the session dictionary: public call, undocumented key; a missing key passes.
    public func screenLocked() -> Bool {
        guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        return (d["CGSSessionScreenIsLocked"] as? Bool) == true || (d["CGSSessionScreenIsLocked"] as? Int) == 1
    }

    public func secureInputOn() -> Bool {
        IsSecureEventInputEnabled()
    }

    public func frontmost() -> AppBrief? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        return AppBrief(pid: Int(app.processIdentifier), bundleId: app.bundleIdentifier, name: app.localizedName ?? "")
    }

    public func pointer() -> ScreenPoint {
        ScreenPoint(CGEvent(source: nil)?.location ?? .zero)
    }

    public func secondsSinceInput() -> Double {
        CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!)
    }

    /// kCGAnyInputEventType in the combined session state: what powerMonitor.getSystemIdleTime reads.
    public func sessionIdleSeconds() -> Double {
        CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
    }

    public func isRunning(pid: Int) -> Bool {
        guard let app = NSRunningApplication(processIdentifier: pid_t(pid)) else { return false }
        return !app.isTerminated
    }

    public func minimized(_ w: AXUIElement) -> Bool {
        AX.bool(w, "AXMinimized") == true
    }

    public func unminimize(_ w: AXUIElement) throws {
        let err = AX.set(w, "AXMinimized", kCFBooleanFalse)
        if err != .success { throw AX.failure(err, element: nil, what: "come out of the Dock") }
    }

    public func bringForward(pid: Int32) throws {
        let err = AX.set(AX.app(pid), "AXFrontmost", kCFBooleanTrue)
        if err != .success, err != .cannotComplete { throw AX.failure(err, element: nil, what: "come forward") }
    }

    public func raise(_ w: AXUIElement) throws {
        AX.setTimeout(w, seconds: InputTiming.axTimeoutS)
        let err = AX.perform(w, "AXRaise")
        if err != .success { throw AX.failure(err, element: nil, what: "be raised") }
        AX.set(w, "AXMain", kCFBooleanTrue)
    }

    /// The app's focused window is `w`, or a sheet on it (`FocusedWindow`).
    public func isFocusedWindow(_ w: AXUIElement, pid: Int32) -> Bool {
        guard let focused = AX.element(AX.app(pid), "AXFocusedWindow") else { return false }
        return FocusedWindow.isOrSheetOf(focused, w, same: { AX.same($0, $1) }, role: { AX.string($0, "AXRole") }, parent: { AX.element($0, "AXParent") })
    }

    public func activate(_ app: AppBrief) -> Bool {
        guard isRunning(pid: app.pid) else { return false }
        AX.set(AX.app(pid_t(app.pid)), "AXFrontmost", kCFBooleanTrue)
        let deadline = Date().addingTimeInterval(Double(InputTiming.activationMs) / 1000)
        while Date() < deadline {
            if frontmost()?.pid == app.pid { return true }
            Thread.sleep(forTimeInterval: Double(InputTiming.activationPollMs) / 1000)
        }
        return frontmost()?.pid == app.pid
    }

    public func focusedElement(pid: Int32) -> AXUIElement? {
        let app = AX.app(pid)
        AX.setTimeout(app, seconds: InputTiming.axTimeoutS)
        return AX.element(app, "AXFocusedUIElement")
    }

    public func sameElement(_ e: AXUIElement, pid: Int32) -> Bool {
        AX.same(focusedElement(pid: pid), e)
    }

    /// Moves the pointer back with no event to any app, then lets the mouse drive it again at once.
    public func warpPointer(to p: ScreenPoint) {
        CGWarpMouseCursorPosition(p.cg)
        CGAssociateMouseAndMouseCursorPosition(1)
    }
}

/// Whether the app's focused window is the step's window: the window itself, or a sheet on it, however deep (a save
/// panel and its Go to Folder sheet, §26.7). A sheet takes AX's focused window while the window it sits on stays the
/// one the step acts in, so a hold that waited for the window alone was refused with the panel open (macOS 27.2).
public enum FocusedWindow {
    static let maxSheets = 4

    public static func isOrSheetOf<E>(_ focused: E, _ window: E, same: (E, E) -> Bool, role: (E) -> String?, parent: (E) -> E?) -> Bool {
        var node: E? = focused
        for _ in 0 ... maxSheets {
            guard let n = node else { return false }
            if same(n, window) { return true }
            guard role(n) == "AXSheet" else { return false }
            node = parent(n)
        }
        return false
    }
}
