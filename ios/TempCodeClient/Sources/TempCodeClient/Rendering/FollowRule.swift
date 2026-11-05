import Foundation

/// What the transcript does to its scroll offset on its own, the desktop's
/// follow rule: it follows the newest row only while the reader is at the
/// bottom, and it never writes the offset while they are up reading, however
/// the rows change. The one write a scrolled-up reader gets is the snap
/// back to the bottom as the app leaves the screen (`TranscriptLanding`),
/// and the one they ask for, the jump pill.
public enum FollowRule {
    public enum Event: Hashable, Sendable {
        /// The rows first appeared for a thread opening.
        case opened
        /// Rows were added, grew, settled or regrouped.
        case rowsChanged
        /// The reader tapped Jump to latest.
        case jump
        /// The app is going to the background.
        case enteringBackground
    }

    public enum Write: Hashable, Sendable {
        /// Leave the offset alone.
        case none
        /// To the bottom with no motion, the window back to one page.
        case snap
        /// Keep the bottom in view with no motion.
        case pin
        /// To the bottom, animated.
        case glide
    }

    /// The write for `event`. `atBottom` is the reader's place, `landing`
    /// a landing on a named row in flight, `reflowHeld` a width change
    /// restoring its own anchor.
    public static func write(for event: Event, atBottom: Bool, landing: Bool = false, reflowHeld: Bool = false) -> Write {
        switch event {
        case .opened:
            return landing ? .none : .snap
        case .rowsChanged:
            return atBottom && !landing && !reflowHeld ? .pin : .none
        case .jump:
            return .glide
        case .enteringBackground:
            return TranscriptLanding.snapsToBottom(enteringBackground: true, atBottom: atBottom) ? .snap : .none
        }
    }
}
