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

    /// Where the reader is after the scroll geometry moved: `geometry` is
    /// what the geometry says (the bottom edge within the slack, or content
    /// shorter than the screen). The geometry alone cannot tell a reader who
    /// scrolled up from rows that grew below a reader at the bottom (a list
    /// keeps no bottom on size changes, and a streaming row grows between
    /// rows landing), so only the reader's own scroll (`readerMoving`: a
    /// drag or its deceleration) or a scroll the view made on purpose to a
    /// row away from the bottom (`offBottomWrite`: a search landing, a page
    /// joining above, a reflow restoring a row) takes a reader off the
    /// bottom. Growth under a reader at the bottom keeps them there and asks
    /// for a pin.
    public static func atBottom(was: Bool, geometry: Bool, readerMoving: Bool, offBottomWrite: Bool) -> (atBottom: Bool, pin: Bool) {
        if geometry { return (true, false) }
        if readerMoving || offBottomWrite || !was { return (false, false) }
        return (true, true)
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
