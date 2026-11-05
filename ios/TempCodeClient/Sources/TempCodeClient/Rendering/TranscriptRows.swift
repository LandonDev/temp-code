import Foundation

/// A row's identity in the transcript list: one key space, the desktop's
/// `rowKey`. An item, a group and the step it grew from share one key (the
/// first step's `ThreadEntry.key`), so a lone call that becomes a group, a
/// call whose final row stamps its seq, and the host's echo of a sent
/// message all stay the same row. The turn's end row (its thinking tail
/// now, its working and closing line later) is keyed on its user row's key
/// with `end` set, one row from Send to the turn's close.
public struct TranscriptRowID: Hashable, Sendable {
    public var key: Int
    public var end: Bool

    public init(key: Int, end: Bool = false) {
        self.key = key
        self.end = end
    }
}

/// Which group key each step was drawn under, carried from one build of the
/// rows to the next (`TranscriptRows.rows(_:turnOpen:memory:)`): a group
/// keeps its key when history joins above it and adds steps before its
/// first. A plain class the view holds outside observation.
public final class RowKeyMemory: @unchecked Sendable {
    /// Step key → the key of the group it was drawn in.
    public internal(set) var groups: [Int: Int] = [:]

    public init() {}
}

/// One phase of a turn's work, the desktop's `ActivityPhase` in zen (its
/// default view): a run of calls of one kind with the thinking that led
/// into them, under one human line ("Read 3 files in src/lib and searched
/// for tokens"). The prose around a phase never joins it.
public struct ActivityGroup: Hashable, Sendable {
    /// What the calls were for, `ActivityPhaseKind`: reads and searches are
    /// one thing (looking around), a group the agent only thought in is `think`.
    public enum Kind: Hashable, Sendable {
        case research, edit, run, other, think
    }

    /// In order; one or more. Thinking and tool calls, edits among them.
    public var entries: [ThreadEntry]
    public var kind: Kind
    /// The key it is drawn under: its first step's, or the one an earlier
    /// build gave it (`RowKeyMemory`).
    public var key: Int
    /// The phase the agent is in: the last phase of the last activity run of
    /// a turn still open, with nothing after it. Its title shimmers in the
    /// present tense and it opens by itself on its second step.
    public var live: Bool

    public init(entries: [ThreadEntry], kind: Kind, live: Bool, key: Int? = nil) {
        self.entries = entries
        self.kind = kind
        self.live = live
        self.key = key ?? entries.first?.key ?? 0
    }

    public var id: TranscriptRowID { TranscriptRowID(key: key) }

    /// A lone step is not a group: it draws as its row with the kind's mark,
    /// never under a header repeating it. Thoughts are not counted: they show
    /// only in a group a person opened.
    public var isSingle: Bool { calls.count == 1 }

    /// The steps that are not thoughts.
    public var calls: [ThreadEntry] {
        entries.filter { if case .thinking = $0.item { false } else { true } }
    }

    /// The steps a phase shows: every one in a group the person opened, else
    /// its calls and edits alone (a thought is no row; the working line said it).
    public func shown(byHand: Bool) -> [ThreadEntry] { byHand ? entries : calls }

    /// The edits in the phase: a closed phase still shows what it changed.
    public var edits: [ToolItem] {
        entries.compactMap { entry in
            guard case .tool(let tool) = entry.item, Board.editPath(tool) != nil else { return nil }
            return tool
        }
    }

    /// The header, `activityPhaseTitle`: "Thinking" / "Thought" for a phase
    /// that only thought, else the calls in plain words, present tense while live.
    public func title(cwd: String? = nil) -> String {
        if kind == .think { return live ? "Thinking" : "Thought" }
        let tools = entries.compactMap { entry -> ToolItem? in
            if case .tool(let tool) = entry.item { return tool }
            return nil
        }
        let line = ToolPhrase.group(tools, cwd: cwd, live: live)
        return line.isEmpty ? (live ? "Working" : "Worked") : line
    }
}

/// A turn's end row, one row from Send to the turn's close under its
/// message's key: the working line while the turn is open (`open`, with
/// the turn's entries for its words), the closing line once it settled
/// ("Worked for 12s", or Stopped). The app's `TurnLineRow` draws both, so
/// the row never remounts when the turn ends.
public struct TurnEnd: Hashable, Sendable {
    public var userSeq: Int
    /// The user row's key: the end row's.
    public var userKey: Int
    /// The turn runs, or its message waits for the host's echo.
    public var open: Bool
    /// The user turn's `completedTs` less its `ts`, never negative; nil while open.
    public var durationMs: Int?
    public var completedTs: Int?
    /// The turn's assistant prose joined by blank lines: what Copy answer copies.
    public var answer: String
    /// The person stopped it: its stopped error row, which draws nothing, landed.
    public var stopped: Bool
    /// An approval undecided or a question unanswered: the card says so, the line folds away.
    public var awaitsUser: Bool
    /// The open turn's entries, its message first: what the working line
    /// reads. Empty once the turn is over, so a settled row compares cheaply.
    public var turn: [ThreadEntry]
    /// The thread's last turn: the Watching line hangs under it.
    public var last: Bool

    public init(userSeq: Int, userKey: Int? = nil, open: Bool = false, durationMs: Int?, completedTs: Int?, answer: String, stopped: Bool = false, awaitsUser: Bool = false, turn: [ThreadEntry] = [], last: Bool = false) {
        self.userSeq = userSeq
        self.userKey = userKey ?? userSeq
        self.open = open
        self.durationMs = durationMs
        self.completedTs = completedTs
        self.answer = answer
        self.stopped = stopped
        self.awaitsUser = awaitsUser
        self.turn = turn
        self.last = last
    }

    public var id: TranscriptRowID { TranscriptRowID(key: userKey, end: true) }
}

/// What the transcript list shows, one row each: a thread entry on its
/// own, a phase of the agent's work, or a turn's end row (its working line,
/// then its closing line).
public enum TranscriptRowModel: Identifiable, Hashable, Sendable {
    case item(ThreadEntry)
    case group(ActivityGroup)
    case turnEnd(TurnEnd)

    public var id: TranscriptRowID {
        switch self {
        case .item(let entry): TranscriptRowID(key: entry.key)
        case .group(let group): group.id
        case .turnEnd(let end): end.id
        }
    }

    /// A seq the row shows, for finding it again after a rebuild.
    public var anchorSeq: Int? {
        switch self {
        case .item(let entry): entry.seq
        case .group(let group): group.entries.first?.seq
        case .turnEnd(let end): end.open ? nil : end.userSeq
        }
    }
}

/// Entries → rows, the desktop's `transcriptRows.ts` and
/// `transcriptActivity.ts` (`groupTurnItems` and `buildActivityPhases` with
/// zen on, the desktop's default) for the phone. Pure and linear: run on
/// every change of the entries, on the main actor, well under a millisecond
/// for two thousand entries.
public enum TranscriptRows {
    /// An entry that joins a run of activity, `isActivityBlock` in zen: a
    /// thought with words in it, or a tool call that is not a plan tool (a
    /// quiet line of its own) or a published page (a row of its own, the
    /// page). Edits join too; a closed phase keeps them in view. Questions,
    /// approvals, prose and every host row break the run.
    public static func folds(_ entry: ThreadEntry) -> Bool {
        switch entry.item {
        case .thinking(let block): return hasWords(block.text)
        case .tool(let tool): return !tool.isPlanTool && tool.htmlRender == nil
        default: return false
        }
    }

    /// Rows nothing draws, `isIgnoredTurnBlock`: an empty thought, an
    /// answer with no words yet. They never break a run.
    static func ignored(_ entry: ThreadEntry) -> Bool {
        switch entry.item {
        case .thinking(let block), .assistant(let block): !hasWords(block.text)
        default: false
        }
    }

    /// The rows for `entries`. `turnOpen` is the fold's `board.turnOpen`:
    /// while true, the last phase of the last turn (with nothing after it)
    /// is live and the last turn's end row is its working line, as it is
    /// from the moment a message is sent (a pending row, seq below zero). A
    /// settled turn's end row is its closing line. The person's Stop row is
    /// no row: the end row says Stopped. While the last turn is open, what
    /// its working line says is no row either: a thought still streaming
    /// and a call the line tells (`LinePhase.told`), which joins its phase
    /// once it settles. A phase of thoughts alone draws nothing.
    public static func rows(_ entries: [ThreadEntry], turnOpen: Bool, memory: RowKeyMemory? = nil) -> [TranscriptRowModel] {
        var rows: [TranscriptRowModel] = []
        rows.reserveCapacity(entries.count + 8)
        var run: [ThreadEntry] = []
        var turnUser: UserTurn?
        var turnUserKey = 0
        var answer: [String] = []
        /// Where the turn being built starts in `entries`, and what it holds.
        var turnStart = 0
        var turnStopped = false
        var turnAwaits = false
        // The open last turn: where it starts, and the calls its working line tells.
        let lastUser = entries.lastIndex { if case .user = $0.item { true } else { false } }
        let openTurn: Bool = lastUser.map { index in
            guard case .user(let user) = entries[index].item else { return false }
            return user.seq < 0 || (turnOpen && user.completedTs == nil)
        } ?? false
        let told: Set<String> = openTurn ? Set(LinePhase.told(Array(entries[lastUser!...])).map(\.callId)) : []

        /// Group keys given out in this build: a key is drawn once.
        var drawn: Set<Int> = []
        func flushRun() {
            for var phase in phases(run) where !phase.calls.isEmpty {
                // A group keeps the key it was drawn under before, whatever joined
                // above it; else its first step's, else any step's not yet drawn.
                let remembered = memory.map { memory in phase.entries.compactMap { memory.groups[$0.key] } } ?? []
                if let key = (remembered + phase.entries.map(\.key)).first(where: { !drawn.contains($0) }) { phase.key = key }
                drawn.insert(phase.key)
                if let memory { for entry in phase.entries { memory.groups[entry.key] = phase.key } }
                rows.append(.group(phase))
            }
            run = []
        }
        func closeTurn(open: Bool, end: Int) {
            flushRun()
            if let turnUser {
                let joined = answer.joined(separator: "\n\n")
                if open {
                    rows.append(.turnEnd(TurnEnd(userSeq: turnUser.seq, userKey: turnUserKey, open: true, durationMs: nil, completedTs: nil, answer: joined, stopped: turnStopped, awaitsUser: turnAwaits, turn: Array(entries[turnStart..<end]))))
                } else if turnUser.seq >= 0, let completedTs = turnUser.completedTs {
                    rows.append(.turnEnd(TurnEnd(userSeq: turnUser.seq, userKey: turnUserKey, durationMs: max(0, completedTs - turnUser.ts), completedTs: completedTs, answer: joined, stopped: turnStopped)))
                }
            }
            turnUser = nil
            answer = []
            turnStopped = false
            turnAwaits = false
        }

        for (index, entry) in entries.enumerated() {
            if case .user(let turn) = entry.item {
                closeTurn(open: false, end: index)
                turnUser = turn
                turnUserKey = entry.key
                turnStart = index
                rows.append(.item(entry))
                continue
            }
            if turnUser != nil {
                switch entry.item {
                case .system(let line) where line.kind == .error && line.stopped:
                    // The person's Stop: the end row says it.
                    turnStopped = true
                    continue
                case .approval(let approval) where approval.allowed == nil:
                    turnAwaits = true
                case .question(let question) where question.answers == nil && !question.resolved:
                    turnAwaits = true
                default: break
                }
            }
            if ignored(entry) || repeatsNextProse(entries, index) { continue }
            if openTurn, let lastUser, index > lastUser {
                switch entry.item {
                case .thinking(let block) where block.streaming: continue
                case .tool(let tool) where told.contains(tool.callId): continue
                default: break
                }
            }
            if folds(entry) {
                run.append(entry)
                continue
            }
            flushRun()
            if case .assistant(let block) = entry.item { answer.append(block.text) }
            rows.append(.item(entry))
        }
        // The last turn: its trailing phase is live while the turn is open.
        flushRun()
        if turnOpen, case .group(var group)? = rows.last {
            group.live = true
            rows[rows.count - 1] = .group(group)
        }
        closeTurn(open: openTurn && turnUser != nil, end: entries.count)
        if let at = rows.lastIndex(where: { if case .turnEnd = $0 { true } else { false } }), case .turnEnd(var end) = rows[at] {
            end.last = true
            rows[at] = .turnEnd(end)
        }
        return rows
    }

    /// `buildActivityPhases`: one phase per kind of work, so a run of reads
    /// followed by a run of edits reads as two things. Thinking is a step,
    /// never a header; a thought at the end of a phase moves into the phase
    /// it introduced; a group that opened on a thought takes the shape of
    /// the work after it; a single call of another kind folds back into
    /// the phase before it (`absorbStrayPhases`).
    static func phases(_ run: [ThreadEntry]) -> [ActivityGroup] {
        var phases: [ActivityGroup] = []
        for entry in run {
            guard case .tool(let tool) = entry.item else {
                if phases.isEmpty { phases.append(ActivityGroup(entries: [], kind: .think, live: false)) }
                phases[phases.count - 1].entries.append(entry)
                continue
            }
            let kind = category(tool)
            if phases.isEmpty {
                phases.append(ActivityGroup(entries: [], kind: kind, live: false))
            } else if phases[phases.count - 1].kind == .think {
                phases[phases.count - 1].kind = kind
            } else if phases[phases.count - 1].kind != kind {
                // The run of thinking the phase ends on introduces the next one.
                var steps = phases[phases.count - 1].entries
                var cut = steps.count
                while cut > 0, !isTool(steps[cut - 1]) { cut -= 1 }
                let trailing = Array(steps[cut...])
                steps.removeSubrange(cut...)
                phases[phases.count - 1].entries = steps
                phases.append(ActivityGroup(entries: trailing, kind: kind, live: false))
            }
            phases[phases.count - 1].entries.append(entry)
        }
        var kept: [ActivityGroup] = []
        for phase in phases {
            let stray = phase.entries.filter(isTool).count == 1
            if stray, let last = kept.indices.last, !kept[last].entries.isEmpty {
                kept[last].entries.append(contentsOf: phase.entries)
                kept[last].kind = dominantKind(kept[last].entries) ?? kept[last].kind
                continue
            }
            kept.append(phase)
        }
        return kept.filter { !$0.entries.isEmpty }.map { phase in
            var phase = phase
            phase.key = phase.entries[0].key
            return phase
        }
    }

    /// `toolCategory`: edits, then reads and searches, then commands.
    public static func category(_ tool: ToolItem) -> ActivityGroup.Kind {
        if Board.editPath(tool) != nil { return .edit }
        switch ToolPhrase.kind(of: tool) {
        case .edit, .write, .patch: return .edit
        case .read, .search, .glob: return .research
        case .run: return .run
        default: return .other
        }
    }

    /// Ties break towards the kind that changed the most: an edit outranks a read.
    private static func dominantKind(_ entries: [ThreadEntry]) -> ActivityGroup.Kind? {
        var counts: [ActivityGroup.Kind: Int] = [:]
        for entry in entries {
            guard case .tool(let tool) = entry.item else { continue }
            counts[category(tool), default: 0] += 1
        }
        var best: ActivityGroup.Kind?
        for kind in [ActivityGroup.Kind.edit, .run, .research, .other] {
            let count = counts[kind] ?? 0
            if count > 0, best == nil || count > (counts[best!] ?? 0) { best = kind }
        }
        return best
    }

    private static func isTool(_ entry: ThreadEntry) -> Bool {
        if case .tool = entry.item { return true }
        return false
    }

    private static func hasWords(_ text: String) -> Bool {
        text.contains { !$0.isWhitespace }
    }

    /// A thought the harness then says again as the next paragraph, word
    /// for word: the paragraph shows it in full, the step would only repeat it.
    static func repeatsNextProse(_ entries: [ThreadEntry], _ index: Int) -> Bool {
        guard case .thinking(let thought) = entries[index].item else { return false }
        for entry in entries[(index + 1)...] {
            if case .assistant(let block) = entry.item {
                if !hasWords(block.text) { continue }
                return plain(block.text) == plain(thought.text)
            }
            return false
        }
        return false
    }

    private static func plain(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// The row that shows a seq: its own item row, or the phase it is inside.
    public static func rowID(containing seq: Int, in rows: [TranscriptRowModel]) -> TranscriptRowID? {
        for row in rows {
            switch row {
            case .item(let entry):
                if entry.seq == seq { return row.id }
            case .group(let group):
                if group.entries.contains(where: { $0.seq == seq }) { return row.id }
            case .turnEnd:
                continue
            }
        }
        return nil
    }

    /// `proseSummary`: a thought's first paragraph as one plain line, code
    /// fences, list marks, links and emphasis stripped. "Thinking" when
    /// nothing is left.
    public static func summary(_ text: String) -> String {
        let body = text.replacing(/```[\s\S]*?(?:```|$)/, with: " ")
        let paragraph = body.split(separator: /\n\s*\n/).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty } ?? ""
        let line = paragraph
            .replacing(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/.anchorsMatchLineEndings(), with: "")
            .replacing(/`([^`]*)`/) { String($0.1) }
            .replacing(/!?\[([^\]]*)\]\([^)]*\)/) { String($0.1) }
            .replacing(/\*\*(.+?)\*\*/) { String($0.1) }
            .replacing(/__(.+?)__/) { String($0.1) }
            .replacing(/\*(.+?)\*/) { String($0.1) }
            .replacing(/_(.+?)_/) { String($0.1) }
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return line.isEmpty ? "Thinking" : line
    }
}

extension ToolItem {
    /// The harness's own task-list tools: mechanics, not work. A quiet line
    /// in the transcript, never a step in a phase.
    public var isPlanTool: Bool {
        ["TodoWrite", "update_plan", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"].contains(name)
    }
}

/// Tracks rows born after the transcript opened. Reading eligibility never
/// consumes it: SwiftUI may prepare a row several times before it appears.
/// The view claims it on appearance; a later mount then shows it whole.
public final class BornRows {
    public private(set) var openedAt: Int?
    private var claimed: Set<TranscriptRowID> = []

    public init() {}

    /// A placeholder or a first page still loading is not the opening paint.
    public func open(thread: ThreadState?) {
        guard let thread, !thread.isLoading,
              thread.isLive || !thread.rows.isEmpty else { return }
        open(at: thread.fold.lastSeq)
    }

    /// The first loaded paint fixes the line between history and live.
    public func open(at lastSeq: Int?) {
        if openedAt == nil, let lastSeq { openedAt = lastSeq }
    }

    public func isUnclaimed(_ row: TranscriptRowModel) -> Bool {
        guard let openedAt, let seq = row.anchorSeq,
              seq > openedAt || seq < 0 else { return false }
        return !claimed.contains(row.id)
    }

    /// Consume the reveal only once the row appears.
    @discardableResult
    public func claim(_ row: TranscriptRowModel) -> Bool {
        guard isUnclaimed(row) else { return false }
        claimed.insert(row.id)
        return true
    }
}
