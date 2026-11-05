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

/// Everything the agent did between two paragraphs, the desktop's
/// `ActionGroup` (transcriptRows.ts, transcriptActivity.ts `actionGroupOf`):
/// calls, settled edits, todo updates, thoughts and the host's steps that
/// fold into the run (`FoldedStep`), in order. One step is
/// its own row at the prose's edge (`lone`); more is one muted line ("Read
/// 3 files in src/lib, ran a command") that opens onto a table of its rows.
/// A lone step and a group are one row under one key, so a second call
/// landing remounts nothing.
///
/// Thoughts are steps but no rows: one shows only in a group a person
/// opened, as "Thought". While the turn is open a call the working line
/// tells (`LinePhase.told`) is no row either; it counts in the phrase and
/// in `lone`, and lands as a past-tense row once it settles.
public struct ActivityGroup: Hashable, Sendable {
    /// The glyph the line leads with: the run's dominant kind of work, else `think`.
    public enum Kind: Hashable, Sendable {
        case research, edit, run, agents, other, think
    }

    /// In order; one or more. Thoughts and tool calls, edits among them.
    public var entries: [ThreadEntry]
    /// The key it is drawn under: its first step's, or the one an earlier
    /// build gave it (`RowKeyMemory`).
    public var key: Int
    /// The running turn's last item: the line reads in the present tense.
    public var live: Bool
    /// The open turn works in this group: it is the turn's last item, or
    /// only a card waiting on the person follows it. The group opens on its
    /// own at two steps while this holds (`GroupFold`).
    public var working: Bool
    /// The group's turn is over: a call still marked running (a Stop cut
    /// it) draws settled, never working.
    public var settled: Bool
    /// The calls the open turn's working line tells: steps, but no rows.
    public var told: Set<String>

    public init(entries: [ThreadEntry], live: Bool = false, working: Bool = false, settled: Bool = true, told: Set<String> = [], key: Int? = nil) {
        self.entries = entries
        self.live = live
        self.working = working
        self.settled = settled
        self.told = told
        self.key = key ?? entries.first?.key ?? 0
    }

    public var id: TranscriptRowID { TranscriptRowID(key: key) }

    /// The steps that are not thoughts.
    public var calls: [ThreadEntry] {
        entries.filter { if case .thinking = $0.item { false } else { true } }
    }

    public var tools: [ToolItem] {
        entries.compactMap { if case .tool(let tool) = $0.item { tool } else { nil } }
    }

    /// The steps' rows, `stepRows`: a wait draws one per agent it returned
    /// on, a batch spawn one per child, anything else one.
    public var stepRows: Int { calls.reduce(0) { $0 + FoldedStep.rows($1) } }

    /// At most one row of steps, thoughts aside: no line and no table, the step is its own row.
    public var lone: Bool { stepRows <= 1 }

    /// The rows it draws: a thought only once a hand opened the group (and
    /// never while it streams), a told call only once its turn is over.
    public func shown(byHand: Bool) -> [ThreadEntry] {
        entries.filter { entry in
            switch entry.item {
            case .thinking(let block): return byHand && !block.streaming
            case .tool(let tool): return settled || !told.contains(tool.callId)
            default: return true
            }
        }
    }

    /// The run's main kind of work, `dominantWorkKind`: the most steps of
    /// one kind, ties to the earlier of edit, run, research, agents, other.
    public var kind: Kind {
        var counts: [Kind: Int] = [:]
        for entry in calls {
            switch entry.item {
            case .tool(let tool): counts[TranscriptRows.category(tool), default: 0] += 1
            case .system(let line): counts[line.kind == .agentReport || line.kind == .agentSpawned ? .agents : .other, default: 0] += 1
            default: break
            }
        }
        var best: Kind?
        for kind in [Kind.edit, .run, .research, .agents, .other] {
            let count = counts[kind] ?? 0
            if count > 0, best == nil || count > (counts[best!] ?? 0) { best = kind }
        }
        return best ?? .think
    }

    /// The line's words: "Thinking" / "Thought" for a run of thoughts, else
    /// the steps in plain words (`GroupPhrase`), present tense while live.
    public func phrase(cwd: String? = nil, titleOf: (String) -> String? = { _ in nil }) -> String {
        if kind == .think { return live ? "Thinking" : "Thought" }
        let steps = calls.compactMap { entry -> GroupStep? in
            switch entry.item {
            case .tool(let tool): .tool(tool)
            case .system(let line): .system(line)
            default: nil
            }
        }
        let line = GroupPhrase.of(steps, cwd: cwd, live: live, titleOf: titleOf)
        return line.isEmpty ? (live ? "Working" : "Worked") : line
    }

    /// Lines added and removed over every edit in the run.
    public var adds: Int { tools.reduce(0) { $0 + (ActionRow.of($1).adds ?? 0) } }
    public var dels: Int { tools.reduce(0) { $0 + (ActionRow.of($1).dels ?? 0) } }
    /// Steps that failed or were refused, each agent a wait found failed, a
    /// red gate, a failed report or task: the line's red count, never words.
    public var failed: Int { calls.reduce(0) { $0 + FoldedStep.failures($1) } }
}

/// How a group opens and folds, the desktop's ActionGroup with
/// `useFoldHold`: a lone step is always open (it is its row); a person's
/// hand (the line, or a row's body) decides from then on; otherwise it is
/// open while the turn works in it and `hold` seconds after the work moves
/// on, so the last step's settle shows before it folds. Mounted working it
/// is open, mounted settled closed, neither animated.
public struct GroupFold: Hashable, Sendable {
    /// `FOLD_HOLD_MS`.
    public static let hold: Double = 0.6
    /// `GROUP_WINDOW`: the newest rows a group shows while it runs on its own.
    public static let window = 5

    /// nil while the group runs on its own; else what the person chose.
    public private(set) var hand: Bool?
    /// While working ended less than `hold` ago: when the hold lets go.
    public private(set) var heldUntil: Double?
    private var working: Bool

    public init(working: Bool, hand: Bool? = nil) {
        self.working = working
        self.hand = hand
    }

    /// The turn's work moved: ending it starts the hold, starting it again drops it.
    public mutating func set(working: Bool, at now: Double) {
        guard working != self.working else { return }
        self.working = working
        heldUntil = working ? nil : now + Self.hold
    }

    public func isOpen(lone: Bool, at now: Double) -> Bool {
        if lone { return true }
        if let hand { return hand }
        return working || (heldUntil.map { now < $0 } ?? false)
    }

    /// The line was tapped: the person's choice is the opposite of what shows.
    public mutating func toggle(lone: Bool, at now: Double) {
        hand = !isOpen(lone: lone, at: now)
    }

    /// The person chose: open or closed from now on.
    public mutating func choose(open: Bool) {
        hand = open
    }

    /// A row's body was opened: the group stays as it is, the person's from now on.
    public mutating func decide() {
        if hand == nil { hand = true }
    }

    /// The rows a group shows: its newest `window` while it runs on its own,
    /// every one once a hand decided it (or a lone step's).
    public func visible<T>(_ rows: [T], lone: Bool) -> ArraySlice<T> {
        hand == nil && !lone ? rows.suffix(Self.window) : rows[...]
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
    /// An entry that joins a run, `isActivityBlock`: a thought with words in
    /// it, a tool call that is not a published page (a row of its own, the
    /// page), or a host row that is a step of the work (`FoldedStep`). Edits
    /// and todo updates join too. Questions, approvals, prose and every other
    /// host row break the run.
    public static func folds(_ entry: ThreadEntry) -> Bool {
        switch entry.item {
        case .thinking(let block): return hasWords(block.text)
        case .tool(let tool): return tool.htmlRender == nil
        case .system(let line): return FoldedStep.isFolded(line)
        default: return false
        }
    }

    /// Rows nothing draws, `isIgnoredTurnBlock` and `isHiddenTool`: an empty
    /// thought, an answer with no words yet, a wait (a state of the turn,
    /// never a row: open, or returned on nobody). They never break a run.
    static func ignored(_ entry: ThreadEntry) -> Bool {
        switch entry.item {
        case .thinking(let block), .assistant(let block): !hasWords(block.text)
        case .tool(let tool): WaitSteps.isHidden(tool)
        default: false
        }
    }

    /// The harness's question call when its card follows in the turn: the
    /// card is the question (the desktop draws the call as the card), so
    /// the call is no step.
    static func askedByCard(_ entries: [ThreadEntry], _ index: Int) -> Bool {
        guard case .tool(let tool) = entries[index].item, ToolPhrase.kind(of: tool) == .question else { return false }
        for entry in entries[(index + 1)...] {
            switch entry.item {
            case .question: return true
            case .user: return false
            default: continue
            }
        }
        return false
    }

    /// A card still waiting on the person: the work has not moved past the group above it.
    static func waitsOnPerson(_ row: TranscriptRowModel) -> Bool {
        guard case .item(let entry) = row else { return false }
        switch entry.item {
        case .approval(let approval): return approval.allowed == nil
        case .question(let question): return question.answers == nil && !question.resolved
        default: return false
        }
    }

    /// The rows for `entries`, the desktop's `flattenTurns`. `turnOpen` is
    /// the fold's `board.turnOpen`: while true, the last turn's last group
    /// is live and the last turn's end row is its working line, as it is
    /// from the moment a message is sent (a pending row, seq below zero). A
    /// settled turn's end row is its closing line. The person's Stop row is
    /// no row: the end row says Stopped. Everything between two paragraphs
    /// is one group. While the last turn is open a thought still streaming
    /// is no step, and a call the working line tells (`LinePhase.told`) is
    /// a step with no row; a group with nothing to draw (thoughts alone, or
    /// one told call) is no row.
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
        } ?? turnOpen
        let told: Set<String> = openTurn ? Set(LinePhase.told(Array(entries[(lastUser ?? 0)...])).map(\.callId)) : []
        /// Where the open last turn's rows start: its groups are the ones that may work.
        var openRowsFrom: Int?

        /// Group keys given out in this build: a key is drawn once.
        var drawn: Set<Int> = []
        func flushRun(inOpenTurn: Bool) {
            defer { run = [] }
            var group = ActivityGroup(entries: run, settled: !inOpenTurn, told: inOpenTurn ? told : [])
            guard !group.calls.isEmpty, !(group.lone && group.shown(byHand: false).isEmpty) else { return }
            // A group keeps the key it was drawn under before, whatever joined
            // above it; else its first step's, else any step's not yet drawn.
            let remembered = memory.map { memory in group.entries.compactMap { memory.groups[$0.key] } } ?? []
            if let key = (remembered + group.entries.map(\.key)).first(where: { !drawn.contains($0) }) { group.key = key }
            drawn.insert(group.key)
            if let memory { for entry in group.entries { memory.groups[entry.key] = group.key } }
            rows.append(.group(group))
        }
        func closeTurn(open: Bool, end: Int) {
            flushRun(inOpenTurn: open)
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
            let inOpenTurn = openTurn && (lastUser.map { index > $0 } ?? true)
            if case .user(let turn) = entry.item {
                closeTurn(open: false, end: index)
                turnUser = turn
                turnUserKey = entry.key
                turnStart = index
                rows.append(.item(entry))
                if openTurn, index == lastUser { openRowsFrom = rows.count }
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
            if ignored(entry) || repeatsNextProse(entries, index) || askedByCard(entries, index) { continue }
            if inOpenTurn, case .thinking(let block) = entry.item, block.streaming { continue }
            if folds(entry) {
                run.append(entry)
                continue
            }
            flushRun(inOpenTurn: inOpenTurn)
            if case .assistant(let block) = entry.item { answer.append(block.text) }
            rows.append(.item(entry))
        }
        flushRun(inOpenTurn: openTurn)
        // The open turn's groups: the one it is in works (it is the turn's last
        // row, or only cards waiting on the person follow it), and is live
        // while the turn runs.
        if openTurn, let from = openRowsFrom ?? (lastUser == nil ? 0 : nil), from < rows.count {
            for at in (from..<rows.count).reversed() {
                guard case .group(var group) = rows[at] else {
                    if waitsOnPerson(rows[at]) { continue }
                    break
                }
                group.working = true
                group.live = turnOpen && at == rows.count - 1
                rows[at] = .group(group)
                break
            }
        }
        closeTurn(open: openTurn && turnUser != nil, end: entries.count)
        if let at = rows.lastIndex(where: { if case .turnEnd = $0 { true } else { false } }), case .turnEnd(var end) = rows[at] {
            end.last = true
            rows[at] = .turnEnd(end)
        }
        return rows
    }

    /// `toolCategory`: agent work, then edits, then reads and searches, then commands.
    public static func category(_ tool: ToolItem) -> ActivityGroup.Kind {
        if LinePhase.isAgentWork(tool) || ToolPhrase.shortName(tool.name) == "app_start_thread" { return .agents }
        if Board.editPath(tool) != nil { return .edit }
        switch ToolPhrase.kind(of: tool) {
        case .edit, .write, .patch: return .edit
        case .read, .search, .glob: return .research
        case .run: return .run
        default: return .other
        }
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

    /// Where the list's window starts: at the row it started at, so rows
    /// arriving below never push one out at the top (a row leaving the top
    /// makes the list re-estimate everything above the reader, and the offset
    /// drops); only when that row is gone, or the caller resized the window
    /// (`top` nil), the newest `count` rows.
    public static func windowStart(_ rows: [TranscriptRowModel], top: TranscriptRowID?, count: Int) -> Int {
        if let top, let index = rows.firstIndex(where: { $0.id == top }) { return index }
        return max(0, rows.count - count)
    }

    /// The row that shows a seq: its own item row, or the group it is inside.
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
