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
        StripWords(title: "Queued", detail: StatusDetail.of(status: .queued, statusDetail: m.statusDetail, activity: m.activity))
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

/// What a row's status word is about, as the host means it (the desktop's
/// src/shared/statusWords.ts). A current host sends it on its own
/// (`SessionMeta.statusDetail`: "Waiting for memory", "3 subagents",
/// "Blocked, A errored", "Editing Rail.tsx"); an older host only wrote the
/// legacy `activity` line ("Queued  waiting for memory", "Waiting on 3
/// subagents", "Blocked: A errored"), read past the lead its word already
/// says and sentence-cased. Drawn, the word and the detail are two texts;
/// one string is `plain`: "Queued: Waiting for memory", or the word alone.
public enum StatusDetail {
    /// The detail for the meta's own status.
    public static func of(_ meta: SessionMeta) -> String? {
        of(status: meta.status, statusDetail: meta.statusDetail, activity: meta.activity)
    }

    /// `statusDetail` as written when the host sent one; else an older
    /// host's `activity` past its lead: a queued row's after "Queued" (nil
    /// when the line is not the host's queued line), a watching row's after
    /// "Waiting on" or "Blocked" (kept as "Blocked, …"), any other row's
    /// line as it is.
    public static func of(status: SessionStatus?, statusDetail: String?, activity: String?) -> String? {
        if let host = text(statusDetail) { return host }
        switch status {
        case .queued?:
            return sentenceStart(text(leadDetail(activity, lead: "Queued")))
        case .watching?:
            if let watched = leadDetail(activity, lead: "Waiting on") { return sentenceStart(text(watched)) }
            if let why = sentenceStart(text(leadDetail(activity, lead: "Blocked"))) { return "Blocked, \(why)" }
            return sentenceStart(text(activity))
        default:
            return text(activity)
        }
    }

    /// A state word and its detail as one string, for an accessibility label
    /// or a line built on the phone: "Queued: Waiting for memory"; the word
    /// alone with nothing to say.
    public static func plain(word: String, detail: String?) -> String {
        guard let detail = text(detail) else { return word }
        return "\(word): \(detail)"
    }

    /// A detail as written: trimmed, a trailing full stop dropped, its case
    /// untouched; nil when nothing is left.
    public static func text(_ raw: String?) -> String? {
        guard var t = raw?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        while t.hasSuffix(".") { t.removeLast() }
        t = t.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    /// The first letter raised when the first word is plain lower-case
    /// letters ("waiting for memory" → "Waiting for memory"); a name or a
    /// count ("rail.tsx", "3 subagents") keeps its case. Only for text an
    /// older host lower-cased.
    public static func sentenceStart(_ text: String?) -> String? {
        guard let text, let first = text.first else { return nil }
        let word = text.prefix { !$0.isWhitespace }
        guard word.allSatisfy({ $0 >= "a" && $0 <= "z" }) else { return text }
        return first.uppercased() + text.dropFirst()
    }

    /// The text after `lead` and whatever joins them: two spaces, the old
    /// " · ", a colon, a comma, or one space; nil when the line does not
    /// begin with the lead or says nothing more.
    static func leadDetail(_ line: String?, lead: String) -> String? {
        guard let line = line?.trimmingCharacters(in: .whitespacesAndNewlines), line.hasPrefix(lead) else { return nil }
        let rest = line.dropFirst(lead.count)
        guard let first = rest.first, first.isWhitespace || first == "·" || first == ":" || first == "," else { return nil }
        var joined = rest.drop { $0.isWhitespace }
        if let mark = joined.first, mark == "·" || mark == ":" || mark == "," { joined = joined.dropFirst() }
        let detail = joined.trimmingCharacters(in: .whitespacesAndNewlines)
        return detail.isEmpty ? nil : detail
    }
}
