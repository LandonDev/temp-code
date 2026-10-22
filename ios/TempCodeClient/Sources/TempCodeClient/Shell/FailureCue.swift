import Foundation
import TempCodeContract

// The host's verdict on a failed turn (`failure.summary`, stamped on the
// session row from the harness's words and the gateway's last refusal) is
// the line a failed thread's row reads, on Home and in every list; the
// error row's first line is the fallback for a host that sent none.

extension SessionMeta {
    /// The host's one-line verdict on the last failed turn; nil while the thread is not in error.
    public var failureSummary: String? {
        status == .error ? failure?.summary : nil
    }
}

extension HomeModel {
    /// The needs-you line for an item: a failed root reads the host's verdict
    /// when it has one (and still points at the newest error row, so the tap
    /// lands on the card), else the kind's line from the rows.
    public static func cue(for item: NeedsYouItem, rows: [EventRow]) -> Cue {
        let fallback = cue(for: item.kind, rows: rows)
        guard item.kind == .error, let summary = item.meta.failureSummary, !summary.isEmpty else { return fallback }
        return Cue(text: summary, seq: fallback.seq)
    }
}
