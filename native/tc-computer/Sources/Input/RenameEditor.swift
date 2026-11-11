import AppKit
import ApplicationServices
import ComputerCore
import ComputerProtocol
import Foundation

/// A rename that commits only in the app's own editor (docs/computer-protocol.md §26.9). Finder's list view keeps
/// a row's name in a field that takes `set_value` but never keyboard focus; Return on the selected row opens Finder's
/// editor, a field outside the window holding the name on disk, and Return there commits it (macOS 27.2). A commit
/// on such a field, once the ordinary route refused it for focus, selects its row, opens the editor with Return, writes the field's pending name into it, reads it
/// back and commits with Return, in a `front` hold (Return goes nowhere in a background app).
public enum RenameEditor {
    /// Return, Enter or `perform confirm` on a text field in a row that would not take keyboard focus (TC Probe's field
    /// takes it once its window is key, so the ordinary route's own refusal decides, `isFocusRefusal`).
    public static func applies(_ action: ComputerAction, role: String?, inRow: Bool, takesFocus: Bool) -> Bool {
        guard inRow, !takesFocus, role == "AXTextField" else { return false }
        switch action.action {
        case .key: return (action.repeat ?? 1) == 1 && ["Return", "Enter", "KP_Enter", "return", "enter"].contains(action.text ?? "")
        case .perform: return action.name == "confirm"
        default: return false
        }
    }

    /// The words of the refusal a key on an element that would not take keyboard focus fails with.
    public static let noFocus = " can't take keyboard focus."

    /// The ordinary route refused the step because its element would not take focus: nothing was posted.
    public static func isFocusRefusal(_ e: ComputerError) -> Bool { e.kind == .actionUnsupported && e.element != nil && e.message.hasSuffix(noFocus) }

    /// The editor the app opened: its focused text field, no longer the row's own field.
    public static func isEditor(role: String?, sameAsField: Bool) -> Bool { role == "AXTextField" && !sameAsField }
}

extension InputEngine {
    /// The row above a field, at most four levels up.
    func renameRow(_ field: AXUIElement) -> AXUIElement? {
        var node = AX.element(field, "AXParent")
        for _ in 0 ..< 4 {
            guard let n = node else { return nil }
            if AX.string(n, "AXRole") == "AXRow" { return n }
            node = AX.element(n, "AXParent")
        }
        return nil
    }

    /// The commit through the app's editor; nil when the step is no such commit.
    func renameInEditor(_ action: ComputerAction, target: InputTarget, tiers: [Tier]) throws -> InputOutcome? {
        guard let e = target.element, AX.string(e.element, "AXRole") == "AXTextField", let row = renameRow(e.element),
              RenameEditor.applies(action, role: "AXTextField", inRow: true, takesFocus: false) else { return nil }
        let app = NSRunningApplication(processIdentifier: target.pid)?.localizedName ?? "The app"
        guard tiers.contains(.front) else {
            throw ComputerFailure(ComputerError(kind: .needsTier, message: "\(app) renames only in its own editor, with the app in front.", needed: .front))
        }
        let name = AX.string(e.element, "AXValue") ?? ""
        let returnKey = { [sink] in
            sink.post(.key(36, down: true, flags: []), route: .pid(target.pid, windowID: target.windowID))
            sink.post(.key(36, down: false, flags: []), route: .pid(target.pid, windowID: target.windowID))
        }
        let (_, hold) = try frontTier.hold(pid: target.pid, window: target.window, app: app, cancelled: target.cancelled, changedSince: target.changedSince) { ctx in
            try ctx.check()
            AX.set(row, "AXSelected", kCFBooleanTrue)
            returnKey()
            // the editor: the app's focused text field, no longer the row's own
            var editor: AXUIElement?
            let until = clock.seconds() + Double(InputTiming.frontSettleMaxMs) / 1000
            while editor == nil, clock.seconds() < until {
                try ctx.check()
                if let f = AX.element(AX.app(target.pid), "AXFocusedUIElement"),
                   RenameEditor.isEditor(role: AX.string(f, "AXRole"), sameAsField: AX.same(f, e.element)) { editor = f } else { clock.sleep(ms: InputTiming.frontPollMs) }
            }
            guard let editor else { throw ComputerFailure(ComputerError(kind: .notCommitted, message: "\(app) did not open its rename editor on [\(e.index)].", element: e.index)) }
            let err = AX.set(editor, "AXValue", name as CFString)
            guard err == .success, AX.string(editor, "AXValue") == name else {
                throw ComputerFailure(ComputerError(kind: .notCommitted, message: "\(app)'s rename editor did not take \"\(name)\".", element: e.index))
            }
            try ctx.check()
            returnKey()
        }
        var out = InputOutcome(tier: .front, via: .keys, clipboard: nil, cursor: target.cursor, lastInputAt: clock.ticks(), on: "\(app)'s rename editor")
        out.front = hold
        return out
    }
}
