import ApplicationServices
import ComputerCore
import ComputerProtocol
import CoreGraphics
import Foundation

/// The `process` tier's rules that read AX: keys go only to a window that is key in its app,
/// a named destination must take keyboard focus first, a minimized window takes no pointer.
enum ProcessTier {
    /// Keys, `hold_key`, typing and paste post only when the app's AXFocusedWindow is the
    /// target window; anything else, no answer included, is `key_window_unavailable`.
    static func requireKeyWindow(pid: pid_t, window: AXUIElement) throws {
        let app = AX.app(pid)
        let focused = AX.element(app, "AXFocusedWindow")
        if AX.same(focused, window) { return }
        var key: ComputerError.KeyWindow?
        if let focused, let id = windowNumber(of: focused, pid: pid) {
            key = ComputerError.KeyWindow(id: Int(id), title: AX.string(focused, "AXTitle") ?? "")
        }
        let other = key.map { " \"\($0.title)\" is." } ?? ""
        throw ComputerFailure(ComputerError(
            kind: .keyWindowUnavailable,
            message: "The window isn't key in its app;\(other) Use set_value, or the session tier.",
            keyWindow: key
        ))
    }

    /// The window number of an AX window, matched by its frame among the pid's on-screen
    /// windows (public API: CGWindowList); nil when none matches.
    static func windowNumber(of w: AXUIElement, pid: pid_t) -> UInt32? {
        guard let frame = AX.frame(w),
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for info in list where (info[kCGWindowOwnerPID as String] as? Int) == Int(pid) {
            guard let b = info[kCGWindowBounds as String] as? [String: Double] else { continue }
            if abs((b["X"] ?? .nan) - frame.x) < 1, abs((b["Y"] ?? .nan) - frame.y) < 1,
               abs((b["Width"] ?? .nan) - frame.w) < 1, abs((b["Height"] ?? .nan) - frame.h) < 1 {
                return (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value
            }
        }
        return nil
    }

    /// `type` and `paste` naming an element: AXFocused on it, then up to 200 ms for the app's
    /// AXFocusedUIElement to be it; else nothing is posted.
    static func confirmFocus(_ e: ResolvedElement, pid: pid_t, clock: InputClock) throws {
        let app = AX.app(pid)
        if AX.same(AX.element(app, "AXFocusedUIElement"), e.element) { return }
        AX.set(e.element, "AXFocused", kCFBooleanTrue)
        let deadline = clock.seconds() + Double(InputTiming.focusConfirmMs) / 1000
        repeat {
            if AX.same(AX.element(app, "AXFocusedUIElement"), e.element) { return }
            clock.sleep(ms: 10)
        } while clock.seconds() < deadline
        throw ComputerFailure(ComputerError(kind: .actionUnsupported, message: "[\(e.index)] can't take keyboard focus.", element: e.index))
    }

    /// Whether keyboard focus is still where the checks left it (the paste's second check).
    static func focusStill(_ e: AXUIElement?, pid: pid_t) -> Bool {
        guard let e else { return true }
        return AX.same(AX.element(AX.app(pid), "AXFocusedUIElement"), e)
    }

    static func requireNotMinimized(_ window: AXUIElement) throws {
        if AX.bool(window, "AXMinimized") == true {
            throw ComputerFailure(.windowMinimized, "The window is minimized; the pointer can't reach it at this tier.")
        }
    }
}
