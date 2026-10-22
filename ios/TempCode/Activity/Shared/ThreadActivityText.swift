import Foundation

/// The Live Activity's content state and what the card derives from it: the
/// status word, the line beside the mark, the tally and its fraction. Pure
/// Swift with no ActivityKit, so the client package's tests compile this
/// one file (a symlink under Tests/TempCodeClientTests/Shared) and prove the
/// words and numbers the lock screen shows. The keys match the host's
/// `HubActivityState` (src/main/server/hub.ts) and the hub's `ActivityState`.

/// The strip's phase: how the thread works, or how it ended.
nonisolated enum ThreadActivityPhase: String, Codable, Hashable, CaseIterable, Sendable {
    case working, paused, waiting, finished, failed, stopped

    /// The status word, spelled only where the mark does not say it: the
    /// spinner already means working, so that phase shows the task alone.
    var word: String { ThreadActivityText.word(phase: self) }

    /// The thread is still at work: the clock runs (working) or holds (paused); every other phase ends the activity.
    var isLive: Bool { self == .working || self == .paused }

    /// The thread is done one way or another: the island's leading slot shows the mark instead of the glyph.
    var isSettled: Bool { self == .finished || self == .failed || self == .stopped }
}

/// What `done` and `total` count. Absent on the wire means tasks; a watching master sends its batch's threads.
nonisolated enum ThreadActivityUnit: String, Codable, Hashable, Sendable {
    case tasks, threads
}

/// What the host pushes as `content-state`. Everything but the phase and
/// the clock is optional, so an older host's state decodes.
nonisolated struct ThreadActivityContent: Codable, Hashable, Sendable {
    var phase: ThreadActivityPhase
    /// Clock milliseconds when the current stretch of work began (`busySince`); the elapsed time ticks from here on the device.
    var since: Int
    /// Clock milliseconds of this state: where a paused or settled clock freezes.
    var ts: Int
    /// The row a tap lands on: the prompt, the error, the last row.
    var seq: Int?
    /// The thread's title at this state, so a rename shows without a restart.
    var title: String?
    /// The in-progress task of the thread's list, else what it is doing right now; a master's running batch step.
    var task: String?
    /// The list's tally when the thread has one; a master's batch, children done of total.
    var done: Int?
    var total: Int?
    var unit: ThreadActivityUnit?
    /// Why the thread waits: the needs-you line ("Needs approval: Bash — bun test").
    var reason: String?

    init(phase: ThreadActivityPhase, since: Int, ts: Int, seq: Int? = nil, title: String? = nil, task: String? = nil, done: Int? = nil, total: Int? = nil, unit: ThreadActivityUnit? = nil, reason: String? = nil) {
        self.phase = phase
        self.since = since
        self.ts = ts
        self.seq = seq
        self.title = title
        self.task = task
        self.done = done
        self.total = total
        self.unit = unit
        self.reason = reason
    }

    var hasTasks: Bool { ThreadActivityText.hasTally(total: total) }

    /// "3/7", when the thread has a list.
    var tally: String? { ThreadActivityText.tally(done: done, total: total) }

    var fraction: Double { ThreadActivityText.fraction(done: done, total: total) }

    /// The line beside the mark: the task while it works or pauses, the reason while it waits, nothing once settled.
    var line: String? { ThreadActivityText.line(phase: phase, task: task, reason: reason) }

    /// "3 of 7 tasks done" / "3 of 7 threads done": the tally row's accessibility label.
    var tallyLabel: String { ThreadActivityText.tallyLabel(done: done, total: total, unit: unit) }

    /// The whole list is done: the tally reads in the success color once the thread finished.
    var allDone: Bool { ThreadActivityText.allDone(done: done, total: total) }

    /// Everything but the clock: what decides whether an update is worth sending.
    var shape: Shape { Shape(phase: phase, since: since, seq: seq, title: title, task: task, done: done, total: total, unit: unit, reason: reason) }

    nonisolated struct Shape: Hashable, Sendable {
        var phase: ThreadActivityPhase
        var since: Int
        var seq: Int?
        var title: String?
        var task: String?
        var done: Int?
        var total: Int?
        var unit: ThreadActivityUnit?
        var reason: String?
    }
}

/// The words and numbers of the card, as functions of plain values.
nonisolated enum ThreadActivityText {
    /// The status word. Working has one for accessibility only: the row shows the spinner and the task.
    static func word(phase: ThreadActivityPhase) -> String {
        switch phase {
        case .working: "Working"
        case .paused: "Paused"
        case .waiting: "Waiting"
        case .finished: "Done"
        case .failed: "Failed"
        case .stopped: "Stopped"
        }
    }

    static func hasTally(total: Int?) -> Bool { (total ?? 0) > 0 }

    /// "3/7" for either unit; nil without a list. `done` never reads past `total`.
    static func tally(done: Int?, total: Int?) -> String? {
        guard let total, total > 0 else { return nil }
        return "\(min(max(done ?? 0, 0), total))/\(total)"
    }

    /// 0…1 of the bar; 0 without a list.
    static func fraction(done: Int?, total: Int?) -> Double {
        guard let total, total > 0 else { return 0 }
        return min(1, max(0, Double(done ?? 0) / Double(total)))
    }

    static func allDone(done: Int?, total: Int?) -> Bool {
        guard let total, total > 0 else { return false }
        return (done ?? 0) >= total
    }

    /// The line beside the mark. Working and paused: the task. Waiting: the
    /// reason, else the task. Finished, failed and stopped: nothing; the
    /// word alone is the state. Empty strings count as nothing.
    static func line(phase: ThreadActivityPhase, task: String?, reason: String?) -> String? {
        let text: String? = switch phase {
        case .working, .paused: task
        case .waiting: reason ?? task
        case .finished, .failed, .stopped: nil
        }
        guard let text, !text.isEmpty else { return nil }
        return text
    }

    /// What VoiceOver reads for the tally row.
    static func tallyLabel(done: Int?, total: Int?, unit: ThreadActivityUnit?) -> String {
        let noun = unit == .threads ? "threads" : "tasks"
        return "\(min(max(done ?? 0, 0), total ?? 0)) of \(total ?? 0) \(noun) done"
    }

    /// What VoiceOver reads for the status row: the word, then the line when there is one.
    static func statusLabel(phase: ThreadActivityPhase, task: String?, reason: String?) -> String {
        let word = word(phase: phase)
        guard let line = line(phase: phase, task: task, reason: reason) else { return word }
        return "\(word), \(line)"
    }
}
