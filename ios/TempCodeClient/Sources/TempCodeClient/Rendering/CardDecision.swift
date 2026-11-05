import Foundation

/// What a live card says about the person's decision, the desktop's
/// ApprovalCard: the heading before and after, and the one quiet line a
/// refusal leaves when the buttons come back. The decision shows on the tap
/// (`ThreadState.decisions`) before the host answers, goes once
/// (`ThreadState.deciding`), and a refusal puts the buttons back with the
/// line kept on the thread (`ThreadState.refusals`) until the next decision.
public enum CardDecision {
    /// The approval card's heading: Approve while undecided, then Allowed or Denied.
    public static func heading(allowed: Bool?, auto: Bool) -> String {
        switch allowed {
        case nil: "Approve"
        case true?: "Allowed"
        case false?: auto ? "Denied (timed out)" : "Denied"
        }
    }

    /// The line a refused decision leaves under the buttons.
    public static func refusalLine(allow: Bool, reason: String) -> String {
        "\(allow ? "Not allowed" : "Not denied"): \(reason)"
    }
}
