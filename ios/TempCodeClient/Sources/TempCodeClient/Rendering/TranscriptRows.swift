import Foundation

/// A row's identity in the transcript list, stable as a turn grows: an item
/// keeps its seq, a group keeps its first step's seq however many steps
/// append, a turn's closing line and its thinking tail keep the user row's seq.
public struct TranscriptRowID: Hashable, Sendable {
    public enum Kind: UInt8, Hashable, Sendable {
        case item
        case group
        case turnEnd
        case thinkingTail
    }

    public var kind: Kind
    /// item: the entry's seq; group: the first step's seq; turnEnd and thinkingTail: the user turn's seq.
    public var seq: Int

    public init(kind: Kind, seq: Int) {
        self.kind = kind
        self.seq = seq
    }
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
    /// The phase the agent is in: the last phase of the last activity run of
    /// a turn still open, with nothing after it. Its title shimmers in the
    /// present tense and it opens by itself on its second step.
    public var live: Bool

    public init(entries: [ThreadEntry], kind: Kind, live: Bool) {
        self.entries = entries
        self.kind = kind
        self.live = live
    }

    public var id: TranscriptRowID { TranscriptRowID(kind: .group, seq: entries[0].seq) }

    /// A lone step is not a group: it draws as its row with the kind's mark,
    /// never under a header repeating it.
    public var isSingle: Bool { entries.count == 1 }

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

/// A settled turn's closing line: "Worked for 12s", and the clock time at its trailing edge.
public struct TurnEnd: Hashable, Sendable {
    public var userSeq: Int
    /// The user turn's `completedTs` less its `ts`, never negative.
    public var durationMs: Int
    public var completedTs: Int
    /// The turn's assistant prose joined by blank lines: what Copy answer copies.
    public var answer: String

    public init(userSeq: Int, durationMs: Int, completedTs: Int, answer: String) {
        self.userSeq = userSeq
        self.durationMs = durationMs
        self.completedTs = completedTs
        self.answer = answer
    }

    public var id: TranscriptRowID { TranscriptRowID(kind: .turnEnd, seq: userSeq) }
}

/// What the transcript list shows, one row each: a thread entry on its own,
/// a phase of the agent's work, a turn's closing line, or the "Thinking"
/// line a live turn ends on while it has nothing to show yet.
public enum TranscriptRowModel: Identifiable, Hashable, Sendable {
    case item(ThreadEntry)
    case group(ActivityGroup)
    case turnEnd(TurnEnd)
    /// The user turn's seq.
    case thinkingTail(Int)

    public var id: TranscriptRowID {
        switch self {
        case .item(let entry): TranscriptRowID(kind: .item, seq: entry.seq)
        case .group(let group): group.id
        case .turnEnd(let end): end.id
        case .thinkingTail(let seq): TranscriptRowID(kind: .thinkingTail, seq: seq)
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
    /// is live, and a turn with nothing to show yet ends on "Thinking".
    public static func rows(_ entries: [ThreadEntry], turnOpen: Bool) -> [TranscriptRowModel] {
        var rows: [TranscriptRowModel] = []
        rows.reserveCapacity(entries.count + 8)
        var run: [ThreadEntry] = []
        var turnUser: UserTurn?
        var answer: [String] = []
        /// The last entry drawn or ignored in the turn being built: the thinking tail reads it.
        var tailEntry: ThreadEntry?

        func flushRun() {
            for phase in phases(run) { rows.append(.group(phase)) }
            run = []
        }
        func closeTurn() {
            flushRun()
            if let turnUser, turnUser.seq >= 0, let completedTs = turnUser.completedTs {
                rows.append(.turnEnd(TurnEnd(userSeq: turnUser.seq, durationMs: max(0, completedTs - turnUser.ts), completedTs: completedTs, answer: answer.joined(separator: "\n\n"))))
            }
            turnUser = nil
            answer = []
        }

        for (index, entry) in entries.enumerated() {
            tailEntry = entry
            if case .user(let turn) = entry.item {
                closeTurn()
                turnUser = turn
                rows.append(.item(entry))
                continue
            }
            if ignored(entry) || repeatsNextProse(entries, index) { continue }
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
        let user = turnUser
        closeTurn()
        if turnOpen, let user, user.seq >= 0, user.completedTs == nil, showsThinkingTail(tailEntry) {
            rows.append(.thinkingTail(user.seq))
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
        return kept.filter { !$0.entries.isEmpty }
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

    /// `showsThinkingTail`: a live turn with nothing to show yet ends in a
    /// "Thinking" shimmer, after the prompt or behind a thought or an answer
    /// with no words yet. The next content takes that slot.
    static func showsThinkingTail(_ last: ThreadEntry?) -> Bool {
        guard let last else { return false }
        switch last.item {
        case .user: return true
        case .thinking(let block), .assistant(let block): return !hasWords(block.text)
        default: return false
        }
    }

    /// The row that shows a seq: its own item row, or the phase it is inside.
    public static func rowID(containing seq: Int, in rows: [TranscriptRowModel]) -> TranscriptRowID? {
        for row in rows {
            switch row {
            case .item(let entry):
                if entry.seq == seq { return row.id }
            case .group(let group):
                if group.entries.contains(where: { $0.seq == seq }) { return row.id }
            case .turnEnd, .thinkingTail:
                continue
            }
        }
        return nil
    }

    /// "Worked for 12s", "Worked for 2m 5s", "Worked for 2m"; under a second rounds up to 1s.
    public static func workedLabel(ms: Int) -> String {
        let total = max(1, Int((Double(ms) / 1_000).rounded()))
        if total < 60 { return "Worked for \(total)s" }
        let minutes = total / 60
        let seconds = total % 60
        return seconds == 0 ? "Worked for \(minutes)m" : "Worked for \(minutes)m \(seconds)s"
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
