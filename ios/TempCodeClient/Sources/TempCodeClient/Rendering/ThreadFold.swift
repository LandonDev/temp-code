import Foundation
import TempCodeContract

// MARK: - The board state (the desktop's todos.ts)

public enum TodoStatus: String, Sendable, Hashable, Codable {
    case pending
    case inProgress = "in_progress"
    case completed
}

public struct TodoItem: Sendable, Hashable {
    public var content: String
    public var status: TodoStatus

    public init(content: String, status: TodoStatus) {
        self.content = content
        self.status = status
    }
}

/// One cumulative token snapshot, keyed to the task active when it landed.
public struct UsageMark: Sendable, Hashable {
    public var round: Int
    public var todo: Int
    public var input: Double?
    public var output: Double?

    public init(round: Int, todo: Int, input: Double? = nil, output: Double? = nil) {
        self.round = round
        self.todo = todo
        self.input = input
        self.output = output
    }
}

/// A `research-source` row, whole, for the research board.
public struct ResearchSource: Sendable, Hashable {
    public var callId: String
    public var url: String?
    public var query: String?
    public var agentId: String
    public var agentLabel: String
    public var title: String?
    /// The one-line finding this source supports (a cite_source call).
    public var claim: String?
    public var ts: Int

    public init(callId: String, url: String? = nil, query: String? = nil, agentId: String, agentLabel: String, title: String? = nil, claim: String? = nil, ts: Int = 0) {
        self.callId = callId
        self.url = url
        self.query = query
        self.agentId = agentId
        self.agentLabel = agentLabel
        self.title = title
        self.claim = claim
        self.ts = ts
    }
}

/// A turn silent this long is dead, not open (crash, kill).
public let staleTurnMs = 10 * 60_000
/// How long unfinished work stays warm enough to resume.
public let resumeWindowMs = 30 * 60_000

/// The task list a thread is working, folded from its own tool calls: the
/// desktop's todos.ts, so the board counts the same tasks. TodoWrite and
/// update_plan replace the list per call; the SDK task tools (TaskCreate,
/// TaskUpdate) build it up, addressing items by the "#3" the create call's
/// result reported.
public struct BoardState: Sendable, Hashable {
    /// Latest todo list.
    public var todos: [TodoItem] = []
    /// Index of the in-progress todo; -1 before the first list.
    public var activeTodo = -1
    /// Current round (0-based); bumps when a user message opens a new pass.
    public var round = 0
    /// Todo list of each finished round, by round index.
    public var rounds: [[TodoItem]] = []
    /// Cumulative session cost when each round archived.
    public var costs: [Double?] = []
    /// Cumulative token snapshots keyed to the task active when they landed.
    public var usage: [UsageMark] = []
    /// Cumulative session cost, from the latest turn-complete.
    public var cost: Double?
    /// The last run ended because the user hit Stop.
    public var stopped = false
    /// The harness is squeezing the conversation right now.
    public var compacting = false
    /// research-source rows, whole, for the research board.
    public var sources: [ResearchSource] = []
    /// Child session ids this thread spawned, in spawn order.
    public var agents: [String] = []
    public var turnOpen = false
    public var sawUser = false
    /// Inside a completed-turn pass: items born now get the pass flag.
    public var inPass = false
    /// "3" (from "Task #3 created") → its index in the list.
    public var taskIds: [String: Int] = [:]
    /// Pending TaskCreate calls waiting for the result that names them.
    public var taskByCall: [String: Int] = [:]
    /// Task calls already folded (re-delivery guard).
    public var taskSeen: Set<String> = []

    public init() {}

    public var tally: (done: Int, total: Int) { Self.tally(todos) }

    public static func tally(_ todos: [TodoItem]) -> (done: Int, total: Int) {
        (todos.count { $0.status == .completed }, todos.count)
    }

    /// A user message on a CLOSED turn starts a new round: the old board's
    /// todos archive and the active-task pointer resets. Explicit beats
    /// inferred: a send stamped with newPass decides directly; unstamped
    /// sends fall back to "unfinished and warm means resume".
    public mutating func beginTurn(ts: Int?, lastTs: Int?, newPass: Bool?) {
        let gap: Int = if let ts, let lastTs { ts - lastTs } else { 0 }
        let stale = turnOpen && gap > staleTurnMs
        let unfinished = !todos.isEmpty && todos.contains { $0.status != .completed }
        let resuming = unfinished && gap <= resumeWindowMs
        let wantNew: Bool = if let newPass { newPass && (!turnOpen || stale) } else { (!turnOpen || stale) && !resuming }
        if wantNew, sawUser {
            rounds.append(todos)
            costs.append(cost)
            todos = []
            activeTodo = -1
            round += 1
            taskIds = [:]
            taskByCall = [:]
            taskSeen = []
        }
        turnOpen = true
        sawUser = true
        stopped = false
    }

    /// The two harness plan tools in one shape. Some models stringify the
    /// array; that parses too rather than dropping the list.
    public static func todos(from name: String, input: JSONValue?) -> [TodoItem]? {
        var raw: JSONValue?
        switch name {
        case "TodoWrite": raw = input?["todos"]
        case "update_plan": raw = input?["plan"]
        default: return nil
        }
        if case .string(let text)? = raw {
            guard let parsed = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else { return nil }
            raw = parsed
        }
        guard case .array(let entries)? = raw else { return nil }
        return entries.compactMap { entry in
            let content = entry["content"]?.stringValue ?? entry["step"]?.stringValue ?? entry["activeForm"]?.stringValue
            guard let content, !content.isEmpty else { return nil }
            let status: TodoStatus = switch entry["status"]?.stringValue {
            case "in_progress": .inProgress
            case "completed": .completed
            default: .pending
            }
            return TodoItem(content: content, status: status)
        }
    }

    /// Folds a tool call into the todo model; true when the list moved.
    public mutating func applyTodoCall(_ event: ToolCallEvent) -> Bool {
        if event.partial == true { return false }
        if let list = Self.todos(from: event.name, input: event.input) {
            todos = list
            if let active = list.firstIndex(where: { $0.status == .inProgress }) { activeTodo = active }
            return true
        }
        if taskSeen.contains(event.callId) { return false }
        switch event.name {
        case "TaskCreate":
            guard let subject = event.input?["subject"]?.stringValue, !subject.isEmpty else { return false }
            taskSeen.insert(event.callId)
            todos.append(TodoItem(content: subject, status: .pending))
            taskByCall[event.callId] = todos.count - 1
            return true
        case "TaskUpdate":
            let taskId: String? = switch event.input?["taskId"] {
            case .string(let value)?: value
            case .number(let value)?: value.rounded() == value ? String(Int(value)) : String(value)
            default: nil
            }
            guard let taskId, let index = taskIds[taskId], index < todos.count,
                  let raw = event.input?["status"]?.stringValue, let status = TodoStatus(rawValue: raw)
            else { return false }
            taskSeen.insert(event.callId)
            todos[index].status = status
            if status == .inProgress { activeTodo = index }
            return true
        default:
            return false
        }
    }

    /// A TaskCreate result names the task's id ("Task #3 created …").
    public mutating func applyTaskResult(_ event: ToolResultEvent) -> Bool {
        guard let created = taskByCall.removeValue(forKey: event.callId) else { return false }
        let text: String = switch event.output {
        case .string(let value): value
        case .omittedBody(let body): body.head
        case .unknown: ""
        }
        if let id = Self.taskNumber(in: text) { taskIds[id] = created }
        return true
    }

    /// The digits after the first "#".
    static func taskNumber(in text: String) -> String? {
        guard let hash = text.firstIndex(of: "#") else { return nil }
        let digits = text[text.index(after: hash)...].prefix { $0.isNumber }
        return digits.isEmpty ? nil : String(digits)
    }

    /// One mark per (round, task); a later snapshot in the same task wins.
    public mutating func markUsage(input: Double?, output: Double?) {
        guard input != nil || output != nil else { return }
        let mark = UsageMark(round: round, todo: activeTodo, input: input, output: output)
        if let last = usage.last, last.todo == activeTodo, last.round == round {
            usage[usage.count - 1] = mark
        } else {
            usage.append(mark)
        }
    }
}

// MARK: - Items with their stamps

/// A transcript item with what the board needs: which user request it
/// answers (`round`), which todo was in progress when it was born (`todo`,
/// -1 before any list), and whether it landed in a completed-turn pass.
public struct ThreadEntry: Sendable, Hashable, Identifiable {
    public var item: TranscriptItem
    public var round: Int
    public var todo: Int
    public var pass: Bool
    /// The row key it is drawn under, the desktop's `Block.rowKey`: its seq
    /// at birth, and never changed after. A call born from a partial keeps
    /// its provisional key when its final row stamps the real seq, and the
    /// host's echo of a sent message keeps the optimistic row's key.
    public var key: Int

    public init(item: TranscriptItem, round: Int = 0, todo: Int = -1, pass: Bool = false, key: Int? = nil) {
        self.item = item
        self.round = round
        self.todo = todo
        self.pass = pass
        self.key = key ?? item.seq
    }

    public var id: Int { item.seq }
    public var seq: Int { item.seq }
    public var ts: Int { item.ts }
}

// MARK: - The fold

/// Rows → items and board state, one row at a time. The desktop's fold
/// rules (src/renderer/src/lib/tcserver/fold.ts and session.ts): assistant
/// text and thinking merge by (msgId, blockIndex) with deltas appended until
/// the final row replaces them; a tool call and its result pair by callId;
/// questions and approvals pair by requestId; a compaction's done row
/// updates its start; `turn-complete` closes the open user turns; a user
/// message on a closed turn opens a new round; plan-tool calls move the
/// todo model before their own row lands so it and everything after belong
/// to the newly in-progress todo; `errors-cleared` drops the error lines.
public struct ThreadFold: Sendable, Hashable {
    public private(set) var items: [ThreadEntry] = []
    public private(set) var board = BoardState()
    /// Highest persisted seq folded; ephemeral rows never move it.
    public private(set) var lastSeq = 0
    private var textIndex: [String: Int] = [:]      // "msgId/blockIndex/kind" → items index
    private var toolIndex: [String: Int] = [:]      // callId → items index
    private var questionIndex: [String: Int] = [:]  // requestId → items index
    private var approvalIndex: [String: Int] = [:]
    private var openCompaction: Int?
    /// The items of the edit calls still running, oldest first: a live edit
    /// is stamped on the newest whose path matches (`stamp`), found here
    /// and never by a walk of the whole history.
    private var runningEdits: [Int] = []
    /// The ts of the host's `stopped` close (the harness gone) while nothing
    /// came after it: a busy status next is the Resume, which reopens that turn.
    private var stoppedClose: Int?
    /// Files the thread is changing right now, from the `live-edits` push, by
    /// path; `liveEditOrder` is oldest first, so the cap drops the oldest.
    public private(set) var liveEdits: [String: LiveEditState] = [:]
    private var liveEditOrder: [String] = []
    /// The next id for a tool item born from a partial call: below every
    /// persisted seq and above the pending turns' keys (-100_000 and down).
    private var nextProvisional = -1_000
    /// The keys rows were first drawn under, kept across a refold.
    public private(set) var keys = RowKeys()
    /// What each omitted wait returned on, read once (`WaitSteps.resolved`), kept across a refold.
    public private(set) var waitOutcomes = WaitOutcomeMemory()

    public init() {}

    /// A fold that keeps the keys an earlier fold gave out: a refold of the
    /// same rows draws every row under the key it had, and every wait keeps
    /// the outcomes it was read with.
    public init(keys: RowKeys, provisionalFrom previous: ThreadFold? = nil) {
        self.keys = keys
        if let previous {
            nextProvisional = previous.nextProvisional
            waitOutcomes = previous.waitOutcomes
        }
    }

    /// The waits' outcomes `previous` read (a fold built off the actor from the whole history).
    public mutating func carryWaitOutcomes(from previous: ThreadFold) {
        waitOutcomes = previous.waitOutcomes
    }

    /// The host's echo of a message this device sent: its row takes the key
    /// the optimistic row was drawn under, now and in every refold.
    public mutating func rekeyEcho(seq: Int, key: Int) {
        keys.echoes[seq] = key
        if let index = items.lastIndex(where: { $0.seq == seq }) { items[index].key = key }
    }

    /// How the fold holds a call: born from a streaming preview and still
    /// waiting for its final row, or final.
    enum HeldCall: Hashable, Sendable { case preview, final }

    /// The call as the fold holds it; nil for one it has not seen. `append`
    /// asks this before it looks for a preview's row, so a call that has
    /// none costs no search of the rows.
    func held(_ callId: String) -> HeldCall? {
        guard let index = toolIndex[callId], case .tool(let tool) = items[index].item else { return nil }
        return tool.seq < 0 ? .preview : .final
    }

    public static func fold(_ rows: [EventRow]) -> ThreadFold {
        var fold = ThreadFold()
        for row in rows { fold.apply(row) }
        return fold
    }

    /// A persisted row can fold into an earlier item (a text delta or a
    /// tool result). Resolve its identity without landing on a newer row.
    public func entryID(for row: EventRow) -> Int? {
        let index: Int?
        switch row.event {
        case .assistantText(let event):
            index = event.msgId.flatMap { textIndex["\($0)/\(event.blockIndex ?? 0)/a"] }
        case .thinking(let event):
            index = event.msgId.flatMap { textIndex["\($0)/\(event.blockIndex ?? 0)/t"] }
        case .toolCall(let event): index = toolIndex[event.callId]
        case .toolResult(let event): index = toolIndex[event.callId]
        case .questionResolved(let event): index = questionIndex[event.requestId]
        case .approvalResolved(let event): index = approvalIndex[event.requestId]
        case .steer(let event): index = steerIndex(event.steerId)
        default: index = nil
        }
        if let index, items.indices.contains(index) { return items[index].id }
        return items.first { $0.seq == row.seq }?.id
    }

    public mutating func apply(_ row: EventRow) {
        switch row.event {
        case .userText(let event):
            stoppedClose = nil
            board.beginTurn(ts: row.ts, lastTs: items.last?.ts, newPass: event.newPass)
            append(.user(UserTurn(seq: row.seq, ts: row.ts, text: event.text, attachments: event.attachments ?? [], model: event.model, reasoning: event.reasoning, completedTs: nil, costUsd: nil, preamble: event.preamble, steerId: event.steerId)))
        case .steer(let event):
            // The last row per steer wins; one whose user row is not loaded changes nothing.
            if let index = steerIndex(event.steerId), case .user(var turn) = items[index].item {
                turn.steer = SteerStamp(state: event.state, how: event.how, reason: event.reason, ts: row.ts)
                items[index].item = .user(turn)
            }
        case .assistantText(let event):
            mergeText(row: row, kind: "a", text: event.text, delta: event.delta, msgId: event.msgId, blockIndex: event.blockIndex, parentCallId: event.parentCallId) { .assistant($0) }
        case .thinking(let event):
            mergeText(row: row, kind: "t", text: event.text, delta: event.delta, msgId: event.msgId, blockIndex: event.blockIndex, parentCallId: event.parentCallId) { .thinking($0) }
        case .toolCall(let event):
            // Plan-tool calls move the todo model first, so this row and
            // everything after it belong to the newly in-progress todo.
            if event.parentCallId == nil { _ = board.applyTodoCall(event) }
            if let index = toolIndex[event.callId], case .tool(var tool) = items[index].item {
                // A partial landing after the final call is stale: it would
                // overwrite the input the persisted row holds.
                if event.partial == true, tool.seq > 0 { break }
                tool.input = event.input ?? tool.input
                tool.partial = event.partial ?? false
                tool.preview = event.preview ?? tool.preview
                tool.display = event.display ?? tool.display
                tool.inputOmitted = tool.inputOmitted || Transcript.containsOmitted(event.input)
                // The final row of a call born as a partial stamps the real seq.
                if event.partial != true, row.ephemeral != true, tool.seq < 0 {
                    tool.seq = row.seq
                    tool.ts = row.ts
                }
                if tool.live == nil, let path = Board.editPath(tool) { tool.live = liveEdit(matching: path) }
                items[index].item = .tool(tool)
                // A streamed input names its file only once the path has arrived.
                noteRunningEdit(tool, at: index)
            } else {
                // A call born from a partial takes a provisional id of its own;
                // its final row stamps the real seq above.
                let provisional = event.partial == true
                var tool = ToolItem(seq: provisional ? nextProvisional : row.seq, ts: row.ts, callId: event.callId, name: event.name, display: event.display, input: event.input, partial: provisional, preview: event.preview, parentCallId: event.parentCallId, inputOmitted: Transcript.containsOmitted(event.input), output: .none, status: .running, reauth: nil)
                if provisional { nextProvisional -= 1 }
                if let path = Board.editPath(tool) { tool.live = liveEdit(matching: path) }
                append(.tool(tool))
                toolIndex[event.callId] = items.count - 1
                noteRunningEdit(tool, at: items.count - 1)
            }
        case .toolResult(let event):
            if event.parentCallId == nil { _ = board.applyTaskResult(event) }
            let output: BodyState = switch event.output {
            case .string(let text): .whole(text)
            case .omittedBody(let omitted): .omitted(omitted, seq: row.seq)
            case .unknown: .none
            }
            if let index = toolIndex[event.callId], case .tool(var tool) = items[index].item {
                tool.output = output
                tool.status = event.isError ? .failed : .done
                tool.reauth = event.reauth
                tool.partial = false
                tool.doneTs = row.ts
                items[index].item = .tool(tool)
                runningEdits.removeAll { $0 == index }
            } else {
                append(.tool(ToolItem(seq: row.seq, ts: row.ts, callId: event.callId, name: "result", display: nil, input: nil, partial: false, preview: nil, parentCallId: event.parentCallId, inputOmitted: false, output: output, status: event.isError ? .failed : .done, reauth: event.reauth, doneTs: row.ts)))
                toolIndex[event.callId] = items.count - 1
            }
        case .turnComplete(let event):
            closeUserTurns(at: row.ts, cost: event.costUsd)
            board.turnOpen = false
            board.inPass = false
            if let cost = event.costUsd { board.cost = cost }
            board.markUsage(input: event.inputTokens, output: event.outputTokens)
        case .questionRequest(let event):
            append(.question(QuestionItem(seq: row.seq, ts: row.ts, request: event, answers: nil, resolved: false)))
            questionIndex[event.requestId] = items.count - 1
        case .questionResolved(let event):
            if let index = questionIndex[event.requestId], case .question(var question) = items[index].item {
                question.answers = event.answers
                question.resolved = true
                items[index].item = .question(question)
            }
        case .approvalRequest(let event):
            append(.approval(ApprovalItem(seq: row.seq, ts: row.ts, request: event, allowed: nil, auto: false)))
            approvalIndex[event.requestId] = items.count - 1
        case .approvalResolved(let event):
            if let index = approvalIndex[event.requestId], case .approval(var approval) = items[index].item {
                approval.allowed = event.allow
                approval.auto = event.auto ?? false
                items[index].item = .approval(approval)
            }
        case .compaction(let event):
            // The CLI repeats its start every 30 s while it compacts: one
            // line per compaction, counted from the first start.
            if event.phase == .start && openCompaction != nil { break }
            if event.phase == .start || openCompaction == nil {
                append(.compaction(CompactionItem(seq: row.seq, ts: row.ts, phase: event.phase, trigger: event.trigger, preTokens: event.preTokens, postTokens: event.postTokens, durationMs: event.durationMs, error: event.error)))
                openCompaction = event.phase == .start ? items.count - 1 : nil
            } else if let index = openCompaction, case .compaction(var compaction) = items[index].item {
                compaction.phase = event.phase
                compaction.postTokens = event.postTokens ?? compaction.postTokens
                compaction.preTokens = event.preTokens ?? compaction.preTokens
                compaction.durationMs = event.durationMs ?? compaction.durationMs
                compaction.error = event.error
                items[index].item = .compaction(compaction)
                openCompaction = nil
            }
            board.compacting = event.phase == .start
        case .plan(let event):
            append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .plan, text: event.text, detail: nil, stopped: false)))
        case .turnPass(let event):
            // The completed-turn pass opens here; items fold as pass work
            // until its turn-complete (or a status end) closes it.
            append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .turnPass, text: event.actions.joined(separator: ", "), detail: nil, stopped: false)))
            board.inPass = true
        case .agentSpawned(let event):
            // On its call: the spawn_agent row is the spawn's one row. A child
            // on another host is named as the call's result names it
            // (`<env>:<id>`); with no call to stand on, a row of its own.
            let id = event.environmentId.map { "\($0):\(event.childSessionId)" } ?? event.childSessionId
            if !stampSpawn(id) {
                append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .agentSpawned, text: "Spawned an agent", detail: event.childSessionId, stopped: false, agentId: event.childSessionId)))
            }
            if !board.agents.contains(event.childSessionId) { board.agents.append(event.childSessionId) }
        case .agentReport(let event):
            // The batch's own report names the master itself: it reads as the batch.
            var line = SystemLine(seq: row.seq, ts: row.ts, kind: .agentReport, text: event.title, detail: event.status, stopped: false, agentId: event.agentId)
            line.batch = event.agentId == row.sessionId
            append(.system(line))
        case .planHandoff(let event):
            // The plan's own record of its build: the title is what the person
            // recognises, the row composes the sentence and links to that thread.
            append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .planHandoff, text: event.title, detail: event.sessionId, stopped: false, agentId: event.sessionId)))
        case .backgroundTask(let event):
            append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .backgroundTask, text: event.description, detail: event.status.rawValue, stopped: false)))
        case .backgroundTasks:
            // No row: the live set is the thread's activity, a settled task its own step.
            break
        case .goal(let event):
            append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .goal, text: event.condition, detail: event.phase.rawValue, stopped: false)))
        case .error(let event):
            append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .error, text: event.message, detail: nil, stopped: event.stopped ?? false, failure: event.failure)))
            if event.stopped == true { board.stopped = true }
        case .errorsCleared:
            items.removeAll { $0.item.isError }
            rebuildIndexes()
            board.stopped = false
        case .status(let event):
            // A turn that ends or pauses with a compaction open: it stopped there.
            if ![.running, .starting, .waiting].contains(event.status), let index = openCompaction, case .compaction(var compaction) = items[index].item {
                compaction.stoppedTs = row.ts
                items[index].item = .compaction(compaction)
                openCompaction = nil
                board.compacting = false
            }
            // Logged end-of-turn signals close the turn even when the
            // turn-complete itself was lost; `watching` ends it too, since
            // the harness is idle behind its background work, and `stopped`
            // (the harness is gone), so a message sent after it opens a turn
            // of its own instead of joining the dead one (the desktop's fold).
            if [.idle, .error, .watching, .stopped].contains(event.status), board.turnOpen || board.inPass {
                board.turnOpen = false
                board.inPass = false
                closeUserTurns(at: row.ts, cost: nil)
                if event.status == .stopped { stoppedClose = row.ts }
            } else if [.starting, .running].contains(event.status), let closed = stoppedClose {
                // Resume on a turn the host put down with its harness gone
                // (`resumeStopped` writes starting then running, no user
                // row): the turn carries on, the desktop's resumeTurnClock.
                reopenUserTurns(closedAt: closed, at: row.ts)
                board.turnOpen = true
            }
            if ![.stopped, .starting, .running].contains(event.status) { stoppedClose = nil }
            // The session meta carries status; an error's detail is worth a line.
            if let detail = event.detail, !detail.isEmpty, event.status == .error {
                append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .status, text: detail, detail: nil, stopped: false)))
            }
        case .researchSource(let event):
            // Kept whole for the research board; a repeat callId only
            // enriches the earlier row (a late-arriving title or claim).
            if let index = board.sources.firstIndex(where: { $0.callId == event.callId }) {
                if let title = event.title { board.sources[index].title = title }
                if let url = event.url { board.sources[index].url = url }
                if let claim = event.claim { board.sources[index].claim = claim }
            } else {
                board.sources.append(ResearchSource(callId: event.callId, url: event.url, query: event.query, agentId: event.agentId, agentLabel: event.agentLabel, title: event.title, claim: event.claim, ts: row.ts))
            }
        case .usage(let event):
            board.markUsage(input: event.inputTokens, output: event.outputTokens)
        case .notice(let event):
            // A host's own line in the thread (an account that left, a review's
            // verdict, a restart mid-turn): one status row, the kind as detail,
            // the payload kept whole for the board's landing rows.
            if let review = event.review, review.outcome == .mergedAnyway {
                // The override settles the held row it answers, by run id.
                for index in items.indices.reversed() {
                    guard case .system(var line) = items[index].item,
                          line.notice?.review?.runId == review.runId,
                          line.notice?.review?.outcome == .held else { continue }
                    line.reviewResolved = true
                    items[index].item = .system(line)
                    break
                }
            }
            append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .status, text: event.message, detail: event.kind.rawValue, stopped: false, notice: event)))
        case .context, .phase:
            // Activity, never a row: the host folds both onto the session
            // meta (the context meter, the activity line) and drops the event.
            break
        case .unknown:
            append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .unknown, text: "Something this version of the app does not show", detail: nil, stopped: false)))
        }
        if row.ephemeral != true { lastSeq = max(lastSeq, row.seq) }
    }

    /// The host spawned a child: the newest spawn_agent call of the turn with
    /// room left (one child, or one per entry of `agents`) takes the id, so
    /// the call's row is the spawn's. A repeat changes nothing. False when no
    /// call of the turn has room.
    private mutating func stampSpawn(_ id: String) -> Bool {
        var target: Int?
        for index in items.indices.reversed() {
            if case .user = items[index].item { break }
            guard case .tool(let tool) = items[index].item, ToolPhrase.shortName(tool.name) == "spawn_agent" else { continue }
            if tool.spawned.contains(id) { return true }
            let asked = max(1, ToolPhrase.input(tool)["agents"]?.arrayValue?.count ?? 1)
            if target == nil, tool.spawned.count < asked { target = index }
        }
        guard let target, case .tool(var tool) = items[target].item else { return false }
        tool.spawned.append(id)
        items[target].item = .tool(tool)
        return true
    }

    /// New items land stamped with the board as it stands now.
    private mutating func append(_ item: TranscriptItem) {
        items.append(ThreadEntry(item: item, round: board.round, todo: board.activeTodo, pass: board.inPass, key: key(for: item)))
    }

    /// The key a new item is drawn under: a call's first key by its callId,
    /// an echoed message's optimistic key, else its seq.
    private mutating func key(for item: TranscriptItem) -> Int {
        switch item {
        case .tool(let tool):
            if let known = keys.calls[tool.callId] { return known }
            keys.calls[tool.callId] = tool.seq
            return tool.seq
        case .user(let turn):
            return keys.echoes[turn.seq] ?? turn.seq
        default:
            return item.seq
        }
    }

    /// The turn ending closes every open user section, each with its own
    /// timer, and ends every text still streaming: a turn over on the host
    /// streams nothing more, so its rows drain and its closing line can land
    /// even when a block's final row never came.
    private mutating func closeUserTurns(at ts: Int, cost: Double?) {
        var lastUser: Int?
        for index in items.indices {
            switch items[index].item {
            case .assistant(var block) where block.streaming:
                block.streaming = false
                block.doneTs = block.doneTs ?? ts
                items[index].item = .assistant(block)
                continue
            case .thinking(var block) where block.streaming:
                block.streaming = false
                block.doneTs = block.doneTs ?? ts
                items[index].item = .thinking(block)
                continue
            default: break
            }
            guard case .user(var turn) = items[index].item else { continue }
            lastUser = index
            if turn.completedTs == nil {
                turn.completedTs = ts
                items[index].item = .user(turn)
            }
        }
        if let cost, let lastUser, case .user(var turn) = items[lastUser].item {
            turn.costUsd = cost
            items[lastUser].item = .user(turn)
        }
    }

    /// Undoes the `stopped` close at `closedAt`: every user row it stamped
    /// opens again, the time it lay down kept out of its clock.
    private mutating func reopenUserTurns(closedAt: Int, at ts: Int) {
        stoppedClose = nil
        for index in items.indices {
            guard case .user(var turn) = items[index].item, turn.completedTs == closedAt else { continue }
            turn.completedTs = nil
            turn.downMs += max(0, ts - closedAt)
            items[index].item = .user(turn)
        }
    }

    private mutating func mergeText(row: EventRow, kind: String, text: String, delta: Bool, msgId: String?, blockIndex: Double?, parentCallId: String?, wrap: (TextBlock) -> TranscriptItem) {
        let key = msgId.map { "\($0)/\(blockIndex ?? 0)/\(kind)" }
        if let key, let at = textIndex[key] {
            var block: TextBlock
            switch items[at].item {
            case .assistant(let b), .thinking(let b): block = b
            default: return
            }
            if delta {
                if block.streaming { block.text += text }
            } else {
                block.text = text
                block.streaming = false
                block.doneTs = row.ts
            }
            items[at].item = wrap(block)
            return
        }
        let block = TextBlock(seq: row.seq, ts: row.ts, text: text, streaming: delta, parentCallId: parentCallId, doneTs: delta ? nil : row.ts)
        append(wrap(block))
        if let key { textIndex[key] = items.count - 1 }
    }

    /// Keeps a live edit by path (the newest 500, `LiveEdits.max`) and stamps
    /// it on the last running edit tool whose path matches, so that row's
    /// counts and diff move without a new row. True when an item changed.
    @discardableResult
    mutating func stamp(_ state: LiveEditState) -> Bool {
        if liveEdits[state.path] == nil {
            liveEditOrder.append(state.path)
            if liveEditOrder.count > LiveEdits.max { liveEdits[liveEditOrder.removeFirst()] = nil }
        }
        liveEdits[state.path] = state
        for index in runningEdits.reversed() {
            guard case .tool(var tool) = items[index].item, tool.status == .running,
                  let path = Board.editPath(tool), LiveEdits.matches(state.path, path) else { continue }
            tool.live = state
            items[index].item = .tool(tool)
            return true
        }
        return false
    }

    /// Keeps `runningEdits`, in the items' order: a running call that names a file it edits.
    private mutating func noteRunningEdit(_ tool: ToolItem, at index: Int) {
        guard tool.status == .running, Board.editPath(tool) != nil, runningEdits.last != index, !runningEdits.contains(index) else { return }
        // A call whose path streamed in late is older than the ones noted since.
        let at = runningEdits.firstIndex { $0 > index } ?? runningEdits.endIndex
        runningEdits.insert(index, at: at)
    }

    /// A fold rebuilt from rows starts with no live edits; the ones the
    /// previous fold held carry over (the host keeps them in memory only).
    mutating func carryLiveEdits(from previous: ThreadFold) {
        for path in previous.liveEditOrder {
            if let state = previous.liveEdits[path] { stamp(state) }
        }
    }

    /// The live edit for a tool's path, newest first.
    private func liveEdit(matching toolPath: String) -> LiveEditState? {
        if let exact = liveEdits[toolPath] { return exact }
        for path in liveEditOrder.reversed() where LiveEdits.matches(path, toolPath) {
            return liveEdits[path]
        }
        return nil
    }

    /// The user turn a steer row names, newest first (steers are few and recent).
    private func steerIndex(_ steerId: String) -> Int? {
        items.lastIndex { entry in
            if case .user(let turn) = entry.item { return turn.steerId == steerId }
            return false
        }
    }

    private mutating func rebuildIndexes() {
        textIndex = [:]
        toolIndex = [:]
        questionIndex = [:]
        approvalIndex = [:]
        openCompaction = nil
        runningEdits = []
        for (offset, entry) in items.enumerated() {
            switch entry.item {
            case .tool(let tool):
                toolIndex[tool.callId] = offset
                noteRunningEdit(tool, at: offset)
            case .question(let q): questionIndex[q.request.requestId] = offset
            case .approval(let a): approvalIndex[a.request.requestId] = offset
            case .compaction(let c) where c.phase == .start: openCompaction = offset
            default: break
            }
        }
    }
}

/// The keys rows were first drawn under (`ThreadEntry.key`): a call's by its
/// callId, an echoed message's by its seq. A refold starts from these, so a
/// row on screen never changes key.
public struct RowKeys: Sendable, Hashable {
    public var calls: [String: Int] = [:]
    public var echoes: [Int: Int] = [:]

    public init() {}
}
