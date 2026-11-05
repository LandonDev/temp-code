import Foundation
import TempCodeContract

/// The desktop's "no jerk in any scenario" runner (surfaces/
/// transcriptScenario.testkit.ts) as a pure Swift runner: a scenario is a
/// list of timed pushes (a send, the host's rows, the reader scrolling up,
/// history joining above) played through `ThreadState`'s own append and
/// settle, `ThreadFold` and `TranscriptRows` on an injected clock. After
/// every push, and once it is all in, it asserts what a reader would feel
/// as a jerk:
///
/// - `keys`: every row still on screen keeps its key (found again by the
///   first thing it showed: a message by its text, a call by its callId,
///   anything else by its seq);
/// - `endRow`: the turn's end row keeps one key, its message's, from Send
///   to the turn's close;
/// - `follow`: while the reader is scrolled up, the follow rule writes
///   nothing, whatever lands.
///
/// The parts later slices build (the reveal, the phrase fade, the phase
/// hold, the word morph, the closing line's drain) are named here as
/// `Check`s a scenario awaits; a slice that builds one implements its
/// check in `run` and the scenarios that await it start asserting it.
public struct TranscriptScenario: Sendable {
    public enum Check: String, Hashable, Sendable, CaseIterable {
        /// Built: keys, the end row, the follow rule.
        case keys, endRow, follow
        /// Awaited: the jitter-buffer reveal (A4), the phrase fade (A5),
        /// the phase hold and the word morph (A6), the drain before the
        /// closing line (A6).
        case reveal, fade, hold, morph, drain

        /// The checks `run` implements today (the reveal, fade and drain
        /// in TranscriptScenarioReveal.swift).
        public static let built: Set<Check> = [.keys, .endRow, .follow, .reveal, .fade, .drain]
    }

    public enum Step: Sendable {
        /// The person sends: a pending row under the next optimistic key.
        case send(String)
        /// The host's rows, folded as a push folds them.
        case rows([EventRow])
        /// The reader scrolls up (`true`) or back to the bottom.
        case readerUp(Bool)
        /// Older rows join above (a page loaded), then the thread refolds.
        case history([EventRow])
        /// The rows are replayed whole (a resync, a remount): a refold.
        case refold
    }

    public struct Push: Sendable {
        public var atMs: Int
        public var label: String
        public var step: Step

        public init(atMs: Int, _ label: String, _ step: Step) {
            self.atMs = atMs
            self.label = label
            self.step = step
        }
    }

    public var name: String
    public var pushes: [Push]
    /// Checks this scenario needs that a later slice builds.
    public var awaits: Set<Check>
    /// Rows the thread already holds before the first push.
    public var history: [EventRow]
    /// Played as under reduced motion: the word steps stay, nothing fades.
    public var reducedMotion: Bool

    public init(_ name: String, history: [EventRow] = [], reducedMotion: Bool = false, awaits: Set<Check> = [], pushes: [Push]) {
        self.name = name
        self.history = history
        self.reducedMotion = reducedMotion
        self.awaits = awaits
        self.pushes = pushes
    }
}

/// What a scenario's run found: one line per jerk, empty when there were none.
public struct ScenarioReport: Sendable {
    public var violations: [String] = []
    /// The checks that ran, after removing those still awaited.
    public var checked: Set<TranscriptScenario.Check> = []
    /// When each turn (its message's key) finished revealing its text, ms:
    /// what the closing line waits for.
    public var drainedAt: [Int: Double] = [:]
    /// The rows after the last push, for a test that looks further.
    public var rows: [TranscriptRowModel] = []
    public var passed: Bool { violations.isEmpty }
}

public enum ScenarioRunner {
    /// Plays `scenario` and checks the built checks it does not await.
    @MainActor
    public static func run(_ scenario: TranscriptScenario) -> ScenarioReport {
        var report = ScenarioReport()
        report.checked = TranscriptScenario.Check.built.subtracting(scenario.awaits)
        var state = ThreadState()
        state.append(scenario.history, trim: false)
        let memory = RowKeyMemory()
        var readerUp = false
        var seenKeys: [String: TranscriptRowID] = [:]
        var endKeys: [Int: TranscriptRowID] = [:]
        var rows = TranscriptRows.rows(state.entries, turnOpen: state.fold.board.turnOpen, memory: memory)
        remember(rows, into: &seenKeys)
        let reveals = RevealProbes(history: state.entries, reduced: scenario.reducedMotion)

        for push in scenario.pushes.sorted(by: { $0.atMs < $1.atMs }) {
            let at = "\(scenario.name) @\(push.atMs)ms \(push.label)"
            reveals.advance(to: Double(push.atMs), checks: report.checked, label: at)
            switch push.step {
            case .send(let text):
                _ = state.addPending(text: text, sentAt: push.atMs)
            case .rows(let incoming):
                state.append(incoming, trim: false)
                state.settle(incoming)
            case .readerUp(let up):
                readerUp = up
            case .history(let older):
                state.rows = (older + state.rows).sorted { ($0.ephemeral == true ? Int.max : $0.seq) < ($1.ephemeral == true ? Int.max : $1.seq) }
                state.refold()
            case .refold:
                state.refold()
            }
            let next = TranscriptRows.rows(state.entries, turnOpen: state.fold.board.turnOpen, memory: memory)
            if report.checked.contains(.keys) {
                report.violations += keyJerks(from: rows, to: next, seen: seenKeys, at: at)
            }
            if report.checked.contains(.endRow) {
                report.violations += endJerks(next, ends: &endKeys, at: at)
            }
            if report.checked.contains(.follow), readerUp, case let write = FollowRule.write(for: .rowsChanged, atBottom: false), write != .none {
                report.violations.append("\(at): the follow rule wrote \(write) while the reader was up")
            }
            reveals.sync(state.entries, checks: report.checked, label: at)
            remember(next, into: &seenKeys)
            rows = next
        }
        reveals.finish(checks: report.checked, label: "\(scenario.name) after the last push")
        report.violations += reveals.violations
        report.drainedAt = reveals.drainedAt
        report.rows = rows
        return report
    }

    /// What a row is, independent of its key: the first thing it shows.
    static func identity(_ row: TranscriptRowModel) -> String? {
        switch row {
        case .item(let entry): identity(entry)
        case .group(let group): group.entries.first.map(identity)
        case .turnEnd(let end): "end:\(end.userSeq)"
        case .thinkingTail: nil
        }
    }

    static func identity(_ entry: ThreadEntry) -> String {
        switch entry.item {
        case .user(let turn): "user:\(turn.text)"
        case .tool(let tool): "call:\(tool.callId)"
        default: "seq:\(entry.seq)"
        }
    }

    private static func remember(_ rows: [TranscriptRowModel], into seen: inout [String: TranscriptRowID]) {
        for row in rows {
            guard let id = identity(row) else { continue }
            if seen[id] == nil { seen[id] = row.id }
        }
    }

    /// A row on screen before and after a push must keep its key.
    static func keyJerks(from old: [TranscriptRowModel], to new: [TranscriptRowModel], seen: [String: TranscriptRowID], at: String) -> [String] {
        var jerks: [String] = []
        var byIdentity: [String: TranscriptRowID] = [:]
        for row in new { if let id = identity(row), byIdentity[id] == nil { byIdentity[id] = row.id } }
        for row in old {
            guard let id = identity(row), let now = byIdentity[id], let first = seen[id] else { continue }
            if now != first { jerks.append("\(at): \(id) moved from key \(first.key) to \(now.key)") }
        }
        var keys = Set<TranscriptRowID>()
        for row in new where !keys.insert(row.id).inserted {
            jerks.append("\(at): two rows share key \(row.id.key)\(row.id.end ? " (end)" : "")")
        }
        return jerks
    }

    /// The end row is its message's: keyed on the user row's key, the same
    /// from the first time it shows until the turn closes.
    static func endJerks(_ rows: [TranscriptRowModel], ends: inout [Int: TranscriptRowID], at: String) -> [String] {
        var jerks: [String] = []
        var userKey: Int?
        var userSeq: Int?
        for row in rows {
            if case .item(let entry) = row, case .user(let turn) = entry.item {
                userKey = entry.key
                userSeq = turn.seq
                continue
            }
            guard row.id.end, let userKey, let userSeq else { continue }
            if row.id.key != userKey { jerks.append("\(at): the end row is keyed \(row.id.key), its message \(userKey)") }
            if let first = ends[userSeq], first != row.id { jerks.append("\(at): the end row moved from key \(first.key) to \(row.id.key)") }
            ends[userSeq] = ends[userSeq] ?? row.id
        }
        return jerks
    }
}
