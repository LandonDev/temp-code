import Foundation
import TempCodeContract

/// What a live card says about the person's decision, the desktop's
/// ApprovalCard: the heading before and after, and the one quiet line a
/// refusal leaves when the buttons come back. The decision shows on the tap
/// (`ThreadState.decisions`) before the host answers, goes once
/// (`ThreadState.deciding`), and a refusal puts the buttons back with the
/// line kept on the thread (`ThreadState.refusals`) until the next decision.
///
/// Every word is keyed by the request's `choices`: a computer step held for
/// the session tier (`run-skip`, the host's computer/schedule.ts) reads Run
/// now and Skip (the desktop's `choiceWords` and `decidedLine`); anything
/// else, an unknown value included, reads Allow and Deny. Allow is Run now,
/// Deny is Skip: the wire is `session.approve { allow }` either way.
public enum CardDecision {
    public typealias Choices = ApprovalRequestEvent.Choices

    /// One button's words: its title and what VoiceOver says it does.
    public struct Button: Sendable, Hashable {
        public let title: String
        public let hint: String
    }

    static func runSkip(_ choices: Choices?) -> Bool { choices == .runSkip }

    /// The allowing button: Run now or Allow.
    public static func allow(_ choices: Choices?) -> Button {
        runSkip(choices) ? Button(title: "Run now", hint: "Use the Mac's pointer and keyboard now") : Button(title: "Allow", hint: "Let the agent run this")
    }

    /// The refusing button: Skip or Deny.
    public static func deny(_ choices: Choices?) -> Button {
        runSkip(choices) ? Button(title: "Skip", hint: "Skip this step") : Button(title: "Deny", hint: "Refuse this")
    }

    /// The card's heading. Undecided, a held step says why it asks (the
    /// host's `macFreeWords()`), any other card Approve; decided, Ran now,
    /// Skipped or Skipped automatically, else Allowed or Denied.
    public static func heading(allowed: Bool?, auto: Bool, choices: Choices? = nil) -> String {
        if runSkip(choices) {
            switch allowed {
            case nil: return "Waiting for the Mac to be free"
            case true?: return "Ran now"
            case false?: return auto ? "Skipped automatically" : "Skipped"
            }
        }
        switch allowed {
        case nil: return "Approve"
        case true?: return "Allowed"
        case false?: return auto ? "Denied (timed out)" : "Denied"
        }
    }

    /// The line a refused decision leaves under the buttons, and the
    /// notification a refused action from the lock screen leaves.
    public static func refusalLine(allow: Bool, reason: String, choices: Choices? = nil) -> String {
        let word = runSkip(choices) ? (allow ? "Not run" : "Not skipped") : (allow ? "Not allowed" : "Not denied")
        return "\(word): \(reason)"
    }

    /// The Live Activity's needs-you line for a waiting held step: its title
    /// as the question the host's `approvalLine` makes of a titled request
    /// (one line, the action after "… wants to" when it says so, backticks
    /// and a closing full stop off, the first letter
    /// up, cut at 100 characters, a question mark when it has none), so the
    /// phone's first state and the host's push say the same line.
    public static func question(title: String) -> String {
        let line = title.replacing(/\s+/, with: " ").trimmingCharacters(in: .whitespaces)
        var action = (line.firstMatch(of: /(?i)\bwants to\s+(.+)$/).map { String($0.1) } ?? line).replacing("`", with: "")
        while let last = action.last, last == "." || last.isWhitespace { action.removeLast() }
        guard let first = action.first else { return "" }
        action = first.uppercased() + action.dropFirst()
        // The host cuts by UTF-16 units, as JavaScript counts.
        if action.utf16.count > questionLength {
            action = String(decoding: Array(action.utf16.prefix(questionLength - 1)), as: UTF16.self) + "…"
        }
        return action.contains("?") ? action : action + "?"
    }

    static let questionLength = 100
}

/// How a card shows what an approval asks for, by its tool. A computer
/// tool's title already names the app, the window and each action
/// (`computerApprovalTitle` on the host), so its card is the title alone,
/// never the input's fields under it.
public enum ApprovalShape {
    /// The four computer tools and the per-verb names, the host's
    /// `computerToolOf` (src/shared/computer/words.ts), plus the session
    /// tier's own card, `computer_session`. A server prefix (`mcp__app__`,
    /// codex's `app.`) is off before the name is read.
    public static func titleOnly(_ toolName: String) -> Bool {
        let bare = bareName(toolName)
        if bare == "computer_session" || fourTools.contains(bare) { return true }
        guard bare.hasPrefix("computer_") else { return false }
        return actions.contains(String(bare.dropFirst("computer_".count)))
    }

    static func bareName(_ name: String) -> String {
        if name.hasPrefix(appPrefix) { return String(name.dropFirst(appPrefix.count)) }
        if let dot = name.lastIndex(of: ".") { return String(name[name.index(after: dot)...]) }
        return name
    }

    static let appPrefix = "mcp__app__"

    static let fourTools: Set<String> = ["computer_apps", "computer_observe", "computer_act", "computer_batch"]

    /// COMPUTER_ACTION_NAMES (src/shared/computer/protocol.ts).
    static let actions: Set<String> = [
        "screenshot", "zoom", "left_click", "right_click", "middle_click", "double_click", "triple_click",
        "left_click_drag", "mouse_move", "left_mouse_down", "left_mouse_up", "cursor_position", "scroll",
        "type", "key", "hold_key", "wait", "set_value", "perform", "select_text", "paste"
    ]
}
