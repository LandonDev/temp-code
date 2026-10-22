import Foundation
import TempCodeContract

/// The words for the statuses the phone draws beside its dots: a queued
/// root's line, a stopped thread's, the paused master's batch clause and the
/// once-per-boot restart note. The host owns the facts; these are the
/// desktop's sentences (scheduler.ts, ThreadBanners.tsx, bootResume.ts).
public enum StatusWords {
    /// A queued root's words: "Queued", and the host's reason ("Waiting for
    /// Backfill the rollups (paused)") as the detail when it gave one.
    public static func queuedLine(_ m: SessionMeta) -> StripWords {
        StripWords.queued(activity: m.activity)
    }

    public static let stopped = StripWords.stopped
    public static let stoppedShort = "Stopped"

    /// Roots of the master's batch paused with it: the master's id on them,
    /// not archived, not subagents, paused or `treeHasPaused`. Zero unless the
    /// master itself is paused (the desktop folds a child under its master
    /// only when the master is in the paused set).
    public static func batchPaused(master: SessionMeta, in metas: [SessionMeta]) -> Int {
        guard master.status == .paused || master.treeHasPaused == true else { return 0 }
        return metas.count { m in
            m.masterId == master.id && m.parentId == nil && !m.archived && (m.status == .paused || m.treeHasPaused == true)
        }
    }

    /// ", and 3 batch threads with it"; "" for zero.
    public static func batchPausedClause(count: Int) -> String {
        guard count > 0 else { return "" }
        return ", and \(count) batch thread\(count == 1 ? "" : "s") with it"
    }

    public static func batchPausedClause(master: SessionMeta, in metas: [SessionMeta]) -> String {
        batchPausedClause(count: batchPaused(master: master, in: metas))
    }

    /// "7 threads resumed after restart", "1 thread resumed after restart".
    public static func bootResume(count: Int) -> String {
        "\(count) \(count == 1 ? "thread" : "threads") resumed after restart"
    }
}
