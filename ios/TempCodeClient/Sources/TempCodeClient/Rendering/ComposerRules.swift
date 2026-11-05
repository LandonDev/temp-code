import Foundation
import TempCodeContract

/// What the composer's one button does, the desktop's `ComposerIntent`
/// (lib/composerAction.ts): its glyph is what a tap would do.
public enum ComposerIntent: Hashable, Sendable {
    /// A turn from what is in the box.
    case send
    /// Into the live turn now (the corner glyph).
    case steer
    /// For the next turn (`queue.add`): a paused thread's tap, or a long press mid-turn.
    case queue
    /// The box is empty mid-turn: pause the turn.
    case pause

    /// The button's name, for VoiceOver and the long press's line.
    public var label: String {
        switch self {
        case .send: "Send"
        case .steer: "Steer"
        case .queue: "Queue for the next turn"
        case .pause: "Pause"
        }
    }
}

/// What the composer decides from the session: what its button does, when
/// it may act, and what the empty field says.
public enum ComposerRules {
    /// A turn is open: the host says it runs, starts or waits on the
    /// person, or this device just sent one. `watching` is not: a watching
    /// master's button is Send.
    public static func busy(status: SessionStatus?, sending: Bool) -> Bool {
        ComposerSlot.turnOpen(status) || sending
    }

    /// The desktop's `decideComposerAction`: paused queues (it goes on
    /// Continue); with no turn open it sends; mid-turn an empty box pauses
    /// and text steers, or queues while the long press holds.
    public static func intent(status: SessionStatus?, sending: Bool, hasText: Bool, holding: Bool = false) -> ComposerIntent {
        if status == .paused { return .queue }
        if !busy(status: status, sending: sending) { return .send }
        if !hasText { return .pause }
        return holding ? .queue : .steer
    }

    /// The long press offers "Queue for the next turn" only mid-turn with
    /// text, where a tap would steer.
    public static func offersQueue(status: SessionStatus?, sending: Bool, hasText: Bool) -> Bool {
        intent(status: status, sending: sending, hasText: hasText) == .steer
    }

    /// The button acts: Pause always (nothing to wait for), the rest once
    /// there is text and every photo is on the host; never while an action
    /// is already out.
    public static func enabled(_ intent: ComposerIntent, hasText: Bool, photosSettled: Bool, inFlight: Bool) -> Bool {
        guard !inFlight else { return false }
        if intent == .pause { return true }
        return hasText && photosSettled
    }

    /// The hold that turns a steer into a queue: the system's long press.
    public static let queueHold: Double = 0.5

    /// The field's placeholder: "Steer" for a root that takes direction (an
    /// implementation or orchestration thread, or a master of any type),
    /// "Message the agent" for a subagent, "Message" otherwise.
    public static func placeholder(for session: SessionMeta?) -> String {
        guard let session else { return "Message" }
        if session.parentId != nil { return "Message the agent" }
        if session.isMaster == true || session.threadType == .implementation || session.threadType == .orchestration { return "Steer" }
        return "Message"
    }
}

/// The composer's box, the desktop's (docs/LAYOUT.md "Composer"): one row,
/// `+` and the button (28 pt controls) 6 pt from the sides and 8 pt from
/// the top and bottom inside a 1 pt ring, the field in the prose type with
/// 3 pt above and below so its first line centres on the controls' line.
/// The empty box is 46 pt; each further line adds 22 pt upward while the
/// controls stay on the bottom line, up to 160 pt, then the field scrolls.
public enum ComposerHeight {
    public static let radius: Double = 12
    public static let side: Double = 6
    public static let edge: Double = 8
    public static let ring: Double = 1
    public static let fieldPad: Double = 3
    /// Between a control and the field.
    public static let gap: Double = 4
    public static let control = TranscriptLengths.composerControl
    public static let line = TranscriptScale.prose.lineHeight
    public static let maxHeight: Double = 160

    /// The box at `lines` lines of text, capped where it starts to scroll.
    public static func height(lines: Int) -> Double {
        min(maxHeight, natural(lines: lines))
    }

    /// The most lines the box shows before the field scrolls.
    public static var maxLines: Int {
        Int(((maxHeight - natural(lines: 0)) / line).rounded(.down))
    }

    public static func scrolls(lines: Int) -> Bool {
        lines > maxLines
    }

    /// A keystroke (Return included) and the clear after a send snap the
    /// height; a paste of more than one line eases it over `base`.
    public static func eases(from old: String, to new: String) -> Bool {
        new.count - old.count > 1 && lineCount(new) > lineCount(old)
    }

    private static func natural(lines: Int) -> Double {
        2 * (edge + ring) + 2 * fieldPad + line * Double(max(0, lines))
    }

    private static func lineCount(_ text: String) -> Int {
        text.reduce(1) { $1.isNewline ? $0 + 1 : $0 }
    }
}
