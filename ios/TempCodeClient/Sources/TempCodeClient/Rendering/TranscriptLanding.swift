import Foundation

/// Where a thread's transcript lands. The person's last scroll position is
/// never restored: a thread opens at its newest row, and leaving the app with
/// a thread on screen puts it back at the bottom, so coming back always shows
/// the latest. The one exception is a launch or a tap that names a row (a
/// search hit, a notification, any `targetSeq`): that lands on the row.
public enum TranscriptLanding: Hashable, Sendable {
    case bottom
    case row(Int)

    /// The landing of a transcript that is opening. A route the app restored
    /// from its saved stacks at a cold launch never lands on a row, even when
    /// the search hit that first pushed it named one.
    public static func onOpen(targetSeq: Int?, restoredAtLaunch: Bool) -> TranscriptLanding {
        guard let targetSeq, !restoredAtLaunch else { return .bottom }
        return .row(targetSeq)
    }

    /// The row to land on, nil for the bottom.
    public var seq: Int? {
        if case .row(let seq) = self { return seq }
        return nil
    }

    /// Whether a transcript snaps to its bottom on a scene change: when the
    /// app goes to the background with the reader scrolled up. Snapping then,
    /// before the system takes its snapshot, means neither the switcher nor
    /// the return ever shows the old position or a scroll.
    public static func snapsToBottom(enteringBackground: Bool, atBottom: Bool) -> Bool {
        enteringBackground && !atBottom
    }
}
