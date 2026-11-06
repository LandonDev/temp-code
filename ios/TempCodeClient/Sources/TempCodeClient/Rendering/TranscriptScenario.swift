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
/// - `follow`: the reader's place is played as the view keeps it
///   (`FollowRule.atBottom` over the geometry and the reader's own scroll):
///   while they are up, or their finger is on the list, nothing pins,
///   whatever lands or reveals; at the bottom and at rest every change pins.
///
/// and the parts later slices built: the reveal, the phrase fade and the
/// drain (TranscriptScenarioReveal.swift), the phase hold, the word morph
/// and the closing line waiting for the drain (TranscriptScenarioLine.swift),
/// the steer word (TranscriptScenarioSteer.swift).
/// A scenario lists in `awaits` a check it is not held to.
public struct TranscriptScenario: Sendable {
    public enum Check: String, Hashable, Sendable, CaseIterable {
        /// Keys, the end row, the follow rule.
        case keys, endRow, follow
        /// The jitter-buffer reveal (A4), the phrase fade (A5), the phase
        /// hold and the word morph (A6), the drain before the closing line
        /// (A5, A6).
        case reveal, fade, hold, morph, drain
        /// The steer word under its bubble moves only forward (A9).
        case steer

        /// The checks `run` implements.
        public static let built: Set<Check> = Set(allCases)
    }

    public enum Step: Sendable {
        /// The person sends: a pending row under the next optimistic key.
        case send(String)
        /// The host's rows, folded as a push folds them.
        case rows([EventRow])
        /// Where the reader is: at the bottom, dragging (a slow drag up still
        /// inside the bottom's slack, the finger down), or up and let go.
        case reader(ReaderPlace)
        /// Older rows join above (a page loaded), then the thread refolds.
        case history([EventRow])
        /// The rows are replayed whole (a resync, a remount): a refold.
        case refold
        /// The thread pauses (`true`) or resumes: the open turn's line folds and reopens.
        case paused(Bool)
    }

    public enum ReaderPlace: String, Sendable {
        case bottom, dragging, up
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
    /// What the end rows did, in order ("@ms <key> morph A → B", "fold", "open").
    public var lineEvents: [String] = []
    /// The words each end row rests on after the last push, by its key.
    public var lineWords: [Int: String] = [:]
    /// How many times the follow rule pinned (pushes and reveal steps).
    public var pins = 0
    public var passed: Bool { violations.isEmpty }
}

extension TranscriptScenario.Step {
    /// The reader scrolls up (`true`, let go) or back to the bottom.
    public static func readerUp(_ up: Bool) -> Self { .reader(up ? .up : .bottom) }
}

/// The reader's place as the view keeps it: the geometry, the finger, and
/// `FollowRule.atBottom` over both.
struct ReaderProbe {
    var place: TranscriptScenario.ReaderPlace = .bottom
    var atBottom = true
    var moving = false

    mutating func move(to next: TranscriptScenario.ReaderPlace) {
        place = next
        switch next {
        case .bottom:
            moving = false
            atBottom = FollowRule.atBottom(was: atBottom, geometry: true, readerMoving: false, offBottomWrite: false).atBottom
        case .dragging:
            // The finger is down and the offset still inside the bottom's 64 pt slack.
            moving = true
            atBottom = FollowRule.atBottom(was: atBottom, geometry: true, readerMoving: true, offBottomWrite: false).atBottom
        case .up:
            // Dragged past the slack, then let go once the list came to rest.
            moving = true
            atBottom = FollowRule.atBottom(was: atBottom, geometry: false, readerMoving: true, offBottomWrite: false).atBottom
            moving = false
        }
    }

    /// The follow rule's write for a change, and what is wrong with it.
    func check(at label: String) -> (pinned: Bool, violation: String?) {
        let write = FollowRule.write(for: .rowsChanged, atBottom: atBottom, readerMoving: moving)
        switch (place, write) {
        case (.bottom, .pin): return (true, nil)
        case (.bottom, _): return (false, "\(label): the reader at the bottom was left behind (\(write))")
        case (_, .none): return (false, nil)
        default: return (write == .pin, "\(label): the follow rule wrote \(write) while the reader was \(place.rawValue)")
        }
    }
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
        var reader = ReaderProbe()
        func follow(_ label: String) {
            guard report.checked.contains(.follow) else { return }
            let (pinned, violation) = reader.check(at: label)
            if pinned { report.pins += 1 }
            if let violation, !report.violations.contains(violation) { report.violations.append(violation) }
        }
        var seenKeys: [String: TranscriptRowID] = [:]
        var endKeys: [Int: TranscriptRowID] = [:]
        var endsShown: Set<TranscriptRowID> = []
        var steers: [Int: SteerEvent.State] = [:]
        var rows = TranscriptRows.rows(state.entries, turnOpen: state.fold.board.turnOpen, memory: memory)
        remember(rows, into: &seenKeys)
        endsShown = Set(rows.map(\.id).filter(\.end))
        let reveals = RevealProbes(history: state.entries, reduced: scenario.reducedMotion)
        let lines = LineProbes(reduced: scenario.reducedMotion)
        lines.sample(rows, drain: reveals.drain, at: 0, checks: report.checked, label: "\(scenario.name) before the first push")
        // Time moves in reveal steps and stops at every hold's end, sampling the lines at each.
        func advance(to target: Double, label: String) {
            while reveals.now < target {
                let step = min(target, reveals.now + SmoothText.stepMs, max(lines.nextDue ?? .infinity, reveals.now + 1))
                let grown = reveals.revision
                reveals.advance(to: step, checks: report.checked, label: label)
                // A reveal step grew a row: the row asks the follow rule to pin.
                if reveals.revision != grown { follow("\(label) @\(Int(step))ms a reveal step") }
                lines.sample(rows, drain: reveals.drain, at: step, checks: report.checked, label: label)
            }
        }

        for push in scenario.pushes.sorted(by: { $0.atMs < $1.atMs }) {
            let at = "\(scenario.name) @\(push.atMs)ms \(push.label)"
            advance(to: Double(push.atMs), label: at)
            switch push.step {
            case .send(let text):
                _ = state.addPending(text: text, sentAt: push.atMs)
            case .rows(let incoming):
                state.append(incoming, trim: false)
                state.settle(incoming)
            case .reader(let place):
                reader.move(to: place)
            case .history(let older):
                state.rows = (older + state.rows).sorted { ($0.ephemeral == true ? Int.max : $0.seq) < ($1.ephemeral == true ? Int.max : $1.seq) }
                state.refold()
            case .refold:
                state.refold()
            case .paused(let paused):
                lines.paused = paused
            }
            let next = TranscriptRows.rows(state.entries, turnOpen: state.fold.board.turnOpen, memory: memory)
            if report.checked.contains(.keys) {
                report.violations += keyJerks(from: rows, to: next, seen: seenKeys, at: at)
            }
            if report.checked.contains(.endRow) {
                report.violations += endJerks(next, ends: &endKeys, shown: &endsShown, at: at)
            }
            if report.checked.contains(.steer) {
                report.violations += steerJerks(next, last: &steers, at: at)
            }
            if case .reader = push.step {} else { follow(at) }
            reveals.sync(state.entries, checks: report.checked, label: at)
            lines.sample(next, drain: reveals.drain, at: reveals.now, checks: report.checked, label: at)
            remember(next, into: &seenKeys)
            rows = next
        }
        let after = "\(scenario.name) after the last push"
        advance(to: reveals.finishTarget, label: after)
        reveals.finish(checks: report.checked, label: after)
        // The last hold ends and every closing word lands.
        advance(to: reveals.now + MotionValues.wordHold * 1_000 + SmoothText.stepMs, label: after)
        lines.finish(at: reveals.now, checks: report.checked, label: after)
        report.violations += reveals.violations
        report.violations += lines.violations
        report.lineEvents = lines.events
        for row in rows { if case .turnEnd(let end) = row { report.lineWords[end.userKey] = lines.words(row.id) } }
        report.drainedAt = reveals.drainedAt
        report.rows = rows
        return report
    }

    /// What a row is, independent of its key: the first thing it shows.
    static func identity(_ row: TranscriptRowModel) -> String? {
        switch row {
        case .item(let entry): identity(entry)
        case .group(let group): group.entries.first.map(identity)
        case .turnEnd(let end): "end:\(end.userKey)"
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

    /// The end row is its turn's: keyed on the turn's first message (a
    /// steer's bubble inside the turn takes none of its own), the same from
    /// the first time it shows until the turn closes, and never gone while
    /// that message shows (`shown`: the end rows of the last push).
    static func endJerks(_ rows: [TranscriptRowModel], ends: inout [Int: TranscriptRowID], shown: inout Set<TranscriptRowID>, at: String) -> [String] {
        var jerks: [String] = []
        var openerKey: Int?
        var openerSeq: Int?
        var users: Set<Int> = []
        var now: Set<TranscriptRowID> = []
        for row in rows {
            if case .item(let entry) = row, case .user(let turn) = entry.item {
                users.insert(entry.key)
                if openerKey == nil {
                    openerKey = entry.key
                    openerSeq = turn.seq
                }
                continue
            }
            guard row.id.end else { continue }
            now.insert(row.id)
            defer { openerKey = nil; openerSeq = nil }
            guard let openerKey, let openerSeq else { continue }
            if row.id.key != openerKey { jerks.append("\(at): the end row is keyed \(row.id.key), its turn's message \(openerKey)") }
            if let first = ends[openerSeq], first != row.id { jerks.append("\(at): the end row moved from key \(first.key) to \(row.id.key)") }
            ends[openerSeq] = ends[openerSeq] ?? row.id
        }
        for id in shown where !now.contains(id) && users.contains(id.key) {
            jerks.append("\(at): the end row of message \(id.key) left while its message shows")
        }
        shown = now
        return jerks
    }
}
