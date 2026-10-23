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
    /// A group activity (several threads of one host on one card): a row per
    /// thread, needs-you first. The fields above then name the lead thread,
    /// which is all a build that predates groups draws.
    var threads: [ThreadActivityRow]?
    /// Threads past the rows' cap: "and 2 more".
    var more: Int?

    init(phase: ThreadActivityPhase, since: Int, ts: Int, seq: Int? = nil, title: String? = nil, task: String? = nil, done: Int? = nil, total: Int? = nil, unit: ThreadActivityUnit? = nil, reason: String? = nil, threads: [ThreadActivityRow]? = nil, more: Int? = nil) {
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
        self.threads = threads
        self.more = more
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
    var shape: Shape { Shape(phase: phase, since: since, seq: seq, title: title, task: task, done: done, total: total, unit: unit, reason: reason, threads: threads, more: more) }

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
        var threads: [ThreadActivityRow]?
        var more: Int?
    }

    /// Two or more threads: the card lists them and the island counts them.
    var isGroup: Bool { (threads?.count ?? 0) >= 2 }

    /// A group whose other threads have left: the one row, drawn as a single thread's card.
    var soloRow: ThreadActivityRow? { threads?.count == 1 ? threads?.first : nil }

    /// The group's threads by state, from its rows.
    var counts: ThreadActivityCounts { ThreadActivityCounts(threads ?? []) }

    /// The longest-running working thread's start, the clock a group's island shows.
    var longestSince: Int { (threads ?? []).filter { $0.phase == .working }.map(\.since).min() ?? since }

    /// A row as a single thread's state, so the card's status line, tally and clock draw it.
    func state(of row: ThreadActivityRow) -> ThreadActivityContent {
        ThreadActivityContent(phase: row.phase, since: row.since, ts: row.ts ?? ts, title: row.title, task: row.task, done: row.done, total: row.total, unit: row.unit, reason: row.reason)
    }
}

/// One thread of a group activity: the single state's fields with the
/// thread's id and type; `ts` is where a paused, waiting or settled row's
/// clock froze (absent while it works). Keys match `HubActivityRow`.
nonisolated struct ThreadActivityRow: Codable, Hashable, Sendable, Identifiable {
    var id: String
    /// The thread type's raw value, for the glyph.
    var type: String?
    var phase: ThreadActivityPhase
    var since: Int
    var ts: Int?
    var title: String?
    var task: String?
    var done: Int?
    var total: Int?
    var unit: ThreadActivityUnit?
    var reason: String?

    init(id: String, type: String? = nil, phase: ThreadActivityPhase, since: Int, ts: Int? = nil, title: String? = nil, task: String? = nil, done: Int? = nil, total: Int? = nil, unit: ThreadActivityUnit? = nil, reason: String? = nil) {
        self.id = id
        self.type = type
        self.phase = phase
        self.since = since
        self.ts = ts
        self.title = title
        self.task = task
        self.done = done
        self.total = total
        self.unit = unit
        self.reason = reason
    }

    /// A thread's single state as a row, cut to what a row says. `updatedAt` freezes the clock of a row that is not working.
    init(id: String, type: String?, state: ThreadActivityContent, updatedAt: Int) {
        self.init(
            id: id,
            type: type,
            phase: state.phase,
            since: state.since,
            ts: state.phase == .working ? nil : updatedAt,
            title: state.title.map { ThreadActivityText.cut($0, ThreadActivityGroup.titleChars) },
            task: state.task.map { ThreadActivityText.cut($0, ThreadActivityGroup.taskChars) },
            done: state.total == nil ? nil : state.done,
            total: state.total,
            unit: state.unit,
            reason: state.reason.map { ThreadActivityText.cut($0, ThreadActivityGroup.reasonChars) }
        )
    }
}

/// A group's threads by state: what the island's compact slots count.
nonisolated struct ThreadActivityCounts: Hashable, Sendable {
    var working = 0
    var paused = 0
    var waiting = 0
    var settled = 0

    init(_ rows: [ThreadActivityRow]) {
        for row in rows {
            switch row.phase {
            case .working: working += 1
            case .paused: paused += 1
            case .waiting: waiting += 1
            case .finished, .failed, .stopped: settled += 1
            }
        }
    }

    /// Threads still in play: working, held or waiting on the person.
    var active: Int { working + paused + waiting }
}

/// The host's group rules (remote/push.ts `activityGroupState`), for the
/// updates the app makes itself while its socket is up: rows needs-you
/// first, then working, paused, failed, stopped and finished, each kind
/// oldest first; a settled row leaves after a minute; at most six rows and
/// never past ActivityKit's 4 KB, the rest counted in `more`. Live while any
/// thread works or is paused; once none is, the phase is the lead row's.
nonisolated enum ThreadActivityGroup {
    static let maxRows = 6
    static let settleMs = 60_000
    static let maxBytes = 3_500
    static let titleChars = 60
    static let taskChars = 80
    static let reasonChars = 100

    static func rank(_ phase: ThreadActivityPhase) -> Int {
        switch phase {
        case .waiting: 0
        case .working: 1
        case .paused: 2
        case .failed: 3
        case .stopped: 4
        case .finished: 5
        }
    }

    static func state(rows: [ThreadActivityRow], now: Int) -> ThreadActivityContent? {
        guard !rows.isEmpty else { return nil }
        let sorted = rows.sorted { a, b in
            if rank(a.phase) != rank(b.phase) { return rank(a.phase) < rank(b.phase) }
            if a.since != b.since { return a.since < b.since }
            return a.id < b.id
        }
        let fresh = sorted.filter { !$0.phase.isSettled || now - ($0.ts ?? now) < settleMs }
        let shown = fresh.isEmpty ? sorted : fresh
        let working = sorted.filter { $0.phase == .working }
        let live = sorted.contains(where: { $0.phase.isLive })
        let lead = (live ? shown.first(where: { $0.phase.isLive }) : nil) ?? shown[0]
        let phase: ThreadActivityPhase = live ? (working.isEmpty ? .paused : .working) : lead.phase
        var state = ThreadActivityContent(
            phase: phase,
            since: working.map(\.since).min() ?? lead.since,
            ts: now,
            title: lead.title,
            task: lead.task,
            reason: phase == .waiting ? lead.reason : nil,
            threads: Array(shown.prefix(maxRows))
        )
        var more = shown.count - (state.threads?.count ?? 0)
        let encoder = JSONEncoder()
        while (state.threads?.count ?? 0) > 2, let data = try? encoder.encode(state), data.count > maxBytes {
            state.threads?.removeLast()
            more += 1
        }
        state.more = more > 0 ? more : nil
        return state
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

    /// One line, at most `max` characters, an ellipsis where it was cut.
    static func cut(_ text: String, _ max: Int) -> String {
        let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return flat.count <= max ? flat : String(flat.prefix(max - 1)) + "…"
    }

    /// What an island row says after the title: the task while it works, the
    /// reason (else the word) while it waits, the word otherwise. One line.
    static func rowDetail(phase: ThreadActivityPhase, task: String?, reason: String?) -> String? {
        let text: String? = switch phase {
        case .working: task
        case .waiting: reason ?? word(phase: phase)
        case .paused, .finished, .failed, .stopped: word(phase: phase)
        }
        guard let text, !text.isEmpty else { return nil }
        return text
    }

    /// "and 2 more": the threads past a group card's rows.
    static func more(_ count: Int) -> String { "and \(count) more" }

    /// What VoiceOver reads for a group: "3 threads, 1 needs you".
    static func groupLabel(_ counts: ThreadActivityCounts, total: Int) -> String {
        var parts = ["\(total) \(total == 1 ? "thread" : "threads")"]
        if counts.waiting > 0 { parts.append("\(counts.waiting) \(counts.waiting == 1 ? "needs" : "need") you") }
        if counts.working > 0 { parts.append("\(counts.working) working") }
        if counts.paused > 0 { parts.append("\(counts.paused) paused") }
        return parts.joined(separator: ", ")
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
