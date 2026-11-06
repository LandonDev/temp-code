import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct ThreadFoldTests {
    private func spawned(_ child: String, environmentId: String? = nil) -> AgentEvent {
        .agentSpawned(AgentSpawnedEvent(childSessionId: child, environmentId: environmentId))
    }

    @Test func `a spawn lands on its spawn_agent call, the newest with room in the turn`() {
        let fold = ThreadFold.fold(rows([
            user("go"),
            call("s1", "mcp__orchestrator__spawn_agent", ["task": .string("Map the plugin")]),
            spawned("c1"),
            call("s2", "mcp__orchestrator__spawn_agent", ["agents": .array([.object(["task": .string("a")]), .object(["task": .string("b")])])]),
            spawned("c2"),
            spawned("c3", environmentId: "env_mac"),
            spawned("c2"),
        ]))
        let tools = fold.items.compactMap { entry -> ToolItem? in if case .tool(let tool) = entry.item { tool } else { nil } }
        #expect(tools.map(\.spawned) == [["c1"], ["c2", "env_mac:c3"]])
        #expect(fold.items.count == 3)
        #expect(fold.board.agents == ["c1", "c2", "c3"])
    }

    @Test func `a spawn with no call of the turn to stand on is a row of its own`() {
        let fold = ThreadFold.fold(rows([
            call("s1", "mcp__orchestrator__spawn_agent", ["task": .string("x")]),
            spawned("c1"),
            user("again"),
            spawned("c2"),
        ]))
        guard case .system(let line) = fold.items.last?.item else {
            Issue.record("shape \(fold.items)")
            return
        }
        #expect(line.kind == .agentSpawned)
        #expect(line.agentId == "c2")
    }

    @Test func `the batch's own report names this thread; a compaction its turn left open stopped`() {
        let fold = ThreadFold.fold([
            EventRow(sessionId: "m", seq: 1, ts: 1_000, event: .agentReport(AgentReportEvent(agentId: "m", title: "Batch", status: "done"))),
            EventRow(sessionId: "m", seq: 2, ts: 1_100, event: .agentReport(AgentReportEvent(agentId: "c1", title: "Child", status: "idle"))),
            EventRow(sessionId: "m", seq: 3, ts: 1_200, event: .compaction(CompactionEvent(phase: .start))),
            EventRow(sessionId: "m", seq: 4, ts: 4_200, event: .status(StatusEvent(status: .idle))),
            EventRow(sessionId: "m", seq: 5, ts: 4_300, event: .backgroundTasks(BackgroundTasksEvent(tasks: ["lint"]))),
        ])
        let lines = fold.items.compactMap { entry -> SystemLine? in if case .system(let line) = entry.item { line } else { nil } }
        #expect(lines.map(\.batch) == [true, false])
        guard case .compaction(let compaction) = fold.items.last?.item else {
            Issue.record("shape \(fold.items)")
            return
        }
        #expect(compaction.stoppedTs == 4_200)
        #expect(!fold.board.compacting)
        #expect(fold.items.count == 3)
    }

    @Test func `stamps items with round and todo, and keeps the time`() {
        let fold = ThreadFold.fold(rows([
            user("go"),
            todoWrite("t1", [("A", "in_progress"), ("B", "pending")]),
            call("c1", "Read", ["file_path": .string("/repo/a.ts")]),
            result("c1", "x"),
            todoWrite("t2", [("A", "completed"), ("B", "in_progress")]),
            answer("done"),
            .turnComplete(TurnCompleteEvent(costUsd: 0.5, inputTokens: 10, outputTokens: 4))
        ]))
        #expect(fold.items.map { [$0.round, $0.todo] } == [[0, -1], [0, 0], [0, 0], [0, 1], [0, 1]])
        #expect(fold.items[0].ts == 1_000)
        guard case .user(let turn) = fold.items[0].item, case .tool(let read) = fold.items[2].item else {
            Issue.record("shape \(fold.items)")
            return
        }
        #expect(turn.completedTs == 1_600)
        #expect(read.doneTs == 1_300)
        #expect(fold.board.todos == [TodoItem(content: "A", status: .completed), TodoItem(content: "B", status: .inProgress)])
        #expect(fold.board.cost == 0.5)
        #expect(fold.board.usage == [UsageMark(round: 0, todo: 1, input: 10, output: 4)])
        #expect(!fold.board.turnOpen)
        #expect(fold.lastSeq == 7)
    }

    @Test func `TaskCreate learns its id from the result and TaskUpdate moves it by #n`() {
        let fold = ThreadFold.fold(rows([
            user("go"),
            call("k1", "TaskCreate", ["subject": .string("Write tests")]),
            result("k1", "Task #7 created successfully"),
            call("k2", "TaskCreate", ["subject": .string("Ship")]),
            result("k2", "Task #8 created"),
            call("k3", "TaskUpdate", ["taskId": .string("8"), "status": .string("in_progress")]),
            result("k3"),
            call("k3", "TaskUpdate", ["taskId": .string("8"), "status": .string("in_progress")])
        ]))
        #expect(fold.board.todos == [TodoItem(content: "Write tests", status: .pending), TodoItem(content: "Ship", status: .inProgress)])
        #expect(fold.board.activeTodo == 1)
        #expect(fold.board.taskIds == ["7": 0, "8": 1])
    }

    @Test func `a numeric task id and a stringified list both fold`() {
        var board = BoardState()
        _ = board.applyTodoCall(ToolCallEvent(callId: "k1", name: "TaskCreate", input: .object(["subject": .string("A")])))
        _ = board.applyTaskResult(ToolResultEvent(callId: "k1", output: .string("Task #3 created"), isError: false))
        let moved = board.applyTodoCall(ToolCallEvent(callId: "k2", name: "TaskUpdate", input: .object(["taskId": .number(3), "status": .string("completed")])))
        #expect(moved)
        #expect(board.todos == [TodoItem(content: "A", status: .completed)])
        let list = BoardState.todos(from: "update_plan", input: .object(["plan": .string(#"[{"step":"One","status":"in_progress"},{"step":"","status":"pending"},{"content":"Two"}]"#)]))
        #expect(list == [TodoItem(content: "One", status: .inProgress), TodoItem(content: "Two", status: .pending)])
        #expect(BoardState.todos(from: "Read", input: .object(["todos": .array([])])) == nil)
    }

    @Test func `a follow-up after a finished pass archives the list as a round`() {
        let fold = ThreadFold.fold(rows([
            user("one"),
            todoWrite("t1", [("A", "completed")]),
            .turnComplete(TurnCompleteEvent(costUsd: 0.2)),
            user("two"),
            todoWrite("t2", [("B", "in_progress")])
        ]))
        #expect(fold.board.round == 1)
        #expect(fold.board.rounds == [[TodoItem(content: "A", status: .completed)]])
        #expect(fold.board.costs == [0.2])
        #expect(fold.board.todos == [TodoItem(content: "B", status: .inProgress)])
        #expect(fold.items[3].round == 1)
        #expect(fold.items[2].round == 1)
    }

    @Test func `a warm message resumes an unfinished pass; an explicit newPass does not`() {
        let base = rows([
            user("one"),
            todoWrite("t1", [("A", "in_progress")]),
            .error(ErrorEvent(message: "boom", stopped: true)),
            .status(StatusEvent(status: .idle))
        ])
        let stoppedAt = ThreadFold.fold(base)
        #expect(stoppedAt.board.stopped)
        #expect(!stoppedAt.board.turnOpen)
        let resumed = ThreadFold.fold(base + [EventRow(sessionId: "s", seq: 5, ts: 1_500, event: user("continue"))])
        #expect(resumed.board.round == 0)
        #expect(resumed.board.todos.count == 1)
        #expect(!resumed.board.stopped)
        let fresh = ThreadFold.fold(base + [EventRow(sessionId: "s", seq: 5, ts: 1_500, event: user("next", newPass: true))])
        #expect(fresh.board.round == 1)
        #expect(fresh.board.todos.isEmpty)
    }

    @Test func `Resume after the harness is gone reopens the stopped turn; a message sent instead opens its own`() {
        func at(_ seq: Int, _ ts: Int, _ event: AgentEvent) -> EventRow { EventRow(sessionId: "s", seq: seq, ts: ts, event: event) }
        let base = [at(1, 1_000, user("go")), at(2, 1_200, .status(StatusEvent(status: .running))), at(3, 4_000, .status(StatusEvent(status: .stopped)))]
        let down = ThreadFold.fold(base)
        #expect(!down.board.turnOpen)
        guard case .user(let closed) = down.items[0].item else { Issue.record("no user row"); return }
        #expect(closed.completedTs == 4_000)
        // Resume: starting then running, no user row. The turn opens again.
        var resumed = ThreadFold.fold(base + [at(4, 9_000, .status(StatusEvent(status: .starting))), at(5, 9_100, .status(StatusEvent(status: .running)))])
        #expect(resumed.board.turnOpen)
        guard case .user(let open) = resumed.items[0].item else { Issue.record("no user row"); return }
        #expect(open.completedTs == nil)
        #expect(open.downMs == 5_000)
        resumed.apply(at(6, 10_000, .status(StatusEvent(status: .idle))))
        guard case .user(let done) = resumed.items[0].item else { Issue.record("no user row"); return }
        // The span: 3 s before the stop and 1 s after the Resume, the 5 s down left out.
        #expect(done.completedTs == 10_000)
        #expect(TranscriptRows.rows(resumed.items, turnOpen: resumed.board.turnOpen).compactMap { if case .turnEnd(let end) = $0 { end.durationMs } else { nil } } == [4_000])
        // A message sent while stopped opens its own turn; the dead one stays closed.
        let sent = ThreadFold.fold(base + [at(4, 9_000, user("again")), at(5, 9_050, .status(StatusEvent(status: .starting)))])
        guard case .user(let first) = sent.items[0].item, case .user(let second) = sent.items[1].item else { Issue.record("no user rows"); return }
        #expect(first.completedTs == 4_000 && first.downMs == 0)
        #expect(second.completedTs == nil)
        // A turn that ended on its own before the harness went stays ended.
        let idle = ThreadFold.fold([at(1, 1_000, user("go")), at(2, 2_000, .status(StatusEvent(status: .idle))), at(3, 4_000, .status(StatusEvent(status: .stopped))), at(4, 9_000, .status(StatusEvent(status: .running)))])
        #expect(!idle.board.turnOpen)
    }

    @Test func `a stale open turn does not swallow the next request`() {
        let fold = ThreadFold.fold(rows([user("one"), todoWrite("t1", [("A", "completed")])]) + [EventRow(sessionId: "s", seq: 3, ts: 1_100 + 11 * 60_000, event: user("later"))])
        #expect(fold.board.round == 1)
    }

    @Test func `keeps research sources whole and the spawned agents`() {
        let fold = ThreadFold.fold(rows([
            .researchSource(ResearchSourceEvent(callId: "r1", query: "bun sqlite", agentId: "a1", agentLabel: "Explorer 1")),
            .researchSource(ResearchSourceEvent(callId: "r2", url: "https://bun.sh/docs", agentId: "a1", agentLabel: "Explorer 1")),
            .researchSource(ResearchSourceEvent(callId: "r2", url: "https://bun.sh/docs", agentId: "a1", agentLabel: "Explorer 1", title: "Bun docs")),
            .researchSource(ResearchSourceEvent(callId: "r2", url: "https://bun.sh/docs", agentId: "a1", agentLabel: "Explorer 1", claim: "bun:sqlite ships built in")),
            .agentSpawned(AgentSpawnedEvent(childSessionId: "a1")),
            .agentSpawned(AgentSpawnedEvent(childSessionId: "a1"))
        ]))
        #expect(fold.board.sources.count == 2)
        #expect(fold.board.sources[1] == ResearchSource(callId: "r2", url: "https://bun.sh/docs", agentId: "a1", agentLabel: "Explorer 1", title: "Bun docs", claim: "bun:sqlite ships built in", ts: 1_100))
        #expect(fold.board.agents == ["a1"])
        #expect(fold.items.count == 2)
    }

    @Test func `items born after a turn-pass carry the pass flag until the turn ends`() {
        let fold = ThreadFold.fold(rows([
            user("go"),
            .turnComplete(TurnCompleteEvent()),
            .turnPass(TurnPassEvent(actions: ["test"])),
            call("c", "Bash", ["command": .string("bun test")]),
            .status(StatusEvent(status: .idle)),
            user("again")
        ]))
        #expect(fold.items.map(\.pass) == [false, false, true, false])
    }

    @Test func `compaction flips the board flag and the idle status closes the open user turn`() {
        let fold = ThreadFold.fold(rows([
            user("go"),
            .compaction(CompactionEvent(phase: .start, trigger: .auto, preTokens: 100_000)),
        ]))
        #expect(fold.board.compacting)
        #expect(fold.board.turnOpen)
        let done = ThreadFold.fold(rows([
            user("go"),
            .compaction(CompactionEvent(phase: .start, trigger: .auto, preTokens: 100_000)),
            .compaction(CompactionEvent(phase: .done, postTokens: 40_000)),
            .status(StatusEvent(status: .idle))
        ]))
        #expect(!done.board.compacting)
        #expect(!done.board.turnOpen)
        guard case .user(let turn) = done.items[0].item else {
            Issue.record("shape")
            return
        }
        #expect(turn.completedTs == 1_300)
    }

    @Test func `repeated compaction starts fold to one line from the first start, and done closes it`() {
        let fold = ThreadFold.fold(rows([
            user("go"),
            .compaction(CompactionEvent(phase: .start, trigger: .auto)),
            user("also this"),
            .compaction(CompactionEvent(phase: .start, trigger: .auto)),
            .compaction(CompactionEvent(phase: .start, trigger: .auto)),
            .compaction(CompactionEvent(phase: .done, preTokens: 414_000, postTokens: 3_600, durationMs: 134_717))
        ]))
        let compactions = fold.items.compactMap { entry -> CompactionItem? in
            if case .compaction(let c) = entry.item { return c }
            return nil
        }
        #expect(compactions.count == 1)
        #expect(compactions.first?.seq == 2)
        #expect(compactions.first?.ts == 1_100)
        #expect(compactions.first?.phase == .done)
        #expect(compactions.first?.postTokens == 3_600)
        #expect(!fold.board.compacting)
    }

    @Test func `folding one row at a time matches folding the whole`() {
        let all = rows([
            user("one"),
            todoWrite("t1", [("A", "in_progress")]),
            .thinking(ThinkingEvent(text: "hm", delta: true, msgId: "m", blockIndex: 0)),
            .thinking(ThinkingEvent(text: "hmm", delta: false, msgId: "m", blockIndex: 0)),
            call("c1", "Edit", ["file_path": .string("/repo/a.ts")], preview: editPreview("/repo/a.ts", adds: 2)),
            result("c1"),
            .approvalRequest(ApprovalRequestEvent(requestId: "p1", toolName: "Bash", title: "rm -rf build")),
            .turnComplete(TurnCompleteEvent(costUsd: 0.1))
        ])
        var incremental = ThreadFold()
        for row in all { incremental.apply(row) }
        #expect(incremental == ThreadFold.fold(all))
        #expect(Transcript.fold(all) == incremental.items.map(\.item))
        guard case .thinking(let thought) = incremental.items[2].item else {
            Issue.record("shape")
            return
        }
        #expect(thought.durationMs == 100)
    }

    @Test func `a notice row keeps its payload and a plain one carries none`() {
        let gate = GateNotice(step: .typecheck, branch: "feature", ok: true, log: "", at: 1_200)
        let fold = ThreadFold.fold(rows([
            user("go"),
            .notice(NoticeEvent(kind: .gate, message: "Typecheck passed on feature", gate: gate)),
            .notice(NoticeEvent(kind: .accountGone, message: "Account a is gone from this host"))
        ]))
        guard case .system(let landed) = fold.items[1].item, case .system(let plain) = fold.items[2].item else {
            Issue.record("shape \(fold.items)")
            return
        }
        #expect(landed.kind == .status)
        #expect(landed.detail == "gate")
        #expect(landed.notice?.gate?.ok == true)
        #expect(landed.notice?.gate?.branch == "feature")
        #expect(plain.notice?.gate == nil)
        #expect(plain.notice?.review == nil)
        #expect(plain.text == "Account a is gone from this host")
    }

    // MARK: - the host's own rows (thread 19)

    @Test func `a notice keeps its payload and stays a status line with the kind as detail`() throws {
        let gate = GateNotice(step: .typecheck, branch: "ios/export", ok: true, log: "", at: 1)
        let fold = ThreadFold.fold(rows([
            user("go"),
            .notice(NoticeEvent(kind: .gate, message: "Typecheck passed on ios/export", gate: gate)),
            .notice(NoticeEvent(kind: .batch, message: "Merged by the batch"))
        ]))
        guard case .system(let line) = fold.items[1].item, case .system(let batch) = fold.items[2].item else {
            Issue.record("shape \(fold.items)")
            return
        }
        #expect(line.kind == .status)
        #expect(line.detail == "gate")
        #expect(line.text == "Typecheck passed on ios/export")
        #expect(line.notice?.gate?.step == .typecheck)
        #expect(line.notice?.noticeKind == .gate)
        #expect(batch.notice?.noticeKind == .batch)
        #expect(batch.notice?.review == nil)
    }

    @Test func `a merged-anyway review resolves the held row with the same run id and leaves the others`() throws {
        let held = { (runId: String) in
            ReviewNotice(runId: runId, reviewerId: nil, provider: "codex", model: "gpt-6.1-sol", outcome: .held, branch: "b", target: "master", blocking: [ReviewFinding(file: "a.ts", summary: "x", failure_scenario: "y")], minor: [], merged: false, pushed: false)
        }
        let over = ReviewNotice(runId: "r1", reviewerId: nil, provider: "codex", model: "gpt-6.1-sol", outcome: .mergedAnyway, branch: "b", target: "master", blocking: [], minor: [], merged: true, pushed: true)
        let fold = ThreadFold.fold(rows([
            user("go"),
            .notice(NoticeEvent(kind: .review, message: "held one", review: held("r1"))),
            .notice(NoticeEvent(kind: .review, message: "held two", review: held("r2"))),
            .notice(NoticeEvent(kind: .review, message: "Merged anyway", review: over))
        ]))
        let lines = fold.items.compactMap { entry -> SystemLine? in
            if case .system(let line) = entry.item { return line }
            return nil
        }
        #expect(lines.count == 3)
        #expect(lines[0].reviewResolved)
        #expect(!lines[1].reviewResolved)
        #expect(lines[2].notice?.review?.outcome == .mergedAnyway)
        #expect(!lines[2].reviewResolved)
        let first = try #require(lines[0].notice?.review)
        let second = try #require(lines[1].notice?.review)
        #expect(!ReviewText.isHeld(first, resolved: lines[0].reviewResolved))
        #expect(ReviewText.isHeld(second, resolved: lines[1].reviewResolved))
    }

    @Test func `an error row keeps the host's verdict and errors-cleared drops it`() {
        let failure = Failure(kind: .rateLimited, account: "a@b", summary: "a@b hit its 5-hour limit", cause: "The window is spent.")
        let base = rows([
            user("go"),
            .error(ErrorEvent(message: "429", failure: failure)),
            .error(ErrorEvent(message: "stopped", stopped: true))
        ])
        let fold = ThreadFold.fold(base)
        guard case .system(let line) = fold.items[1].item, case .system(let stopped) = fold.items[2].item else {
            Issue.record("shape \(fold.items)")
            return
        }
        #expect(line.kind == .error)
        #expect(line.failure?.kind == .rateLimited)
        #expect(line.failure?.account == "a@b")
        #expect(!line.stopped)
        #expect(stopped.stopped)
        #expect(stopped.failure == nil)
        let cleared = ThreadFold.fold(base + [EventRow(sessionId: "s", seq: 9, ts: 9_000, event: .errorsCleared(ErrorsClearedEvent()))])
        #expect(cleared.items.count == 1)
        #expect(!cleared.items.contains { $0.item.isError })
    }

    @Test func `a user row keeps its preamble stamp`() {
        let stamp = PreambleStamp(text: "- Work in your own worktree.", words: 212)
        let fold = ThreadFold.fold(rows([
            .userText(UserTextEvent(text: "Build it.", preamble: stamp, newPass: true)),
            user("and then")
        ]))
        guard case .user(let first) = fold.items[0].item, case .user(let second) = fold.items[1].item else {
            Issue.record("shape \(fold.items)")
            return
        }
        #expect(first.preamble?.words == 212)
        #expect(first.preamble?.text == "- Work in your own worktree.")
        #expect(first.text == "Build it.")
        #expect(second.preamble == nil)
    }

    @Test func `a plan handoff row carries the build's title and id`() {
        let fold = ThreadFold.fold(rows([
            user("plan it"),
            .planHandoff(PlanHandoffEvent(sessionId: "build-1", title: "Plan the passkey rollout", environmentId: nil, how: .auto))
        ]))
        guard case .system(let line) = fold.items[1].item else {
            Issue.record("shape \(fold.items)")
            return
        }
        #expect(line.kind == .planHandoff)
        #expect(line.text == "Plan the passkey rollout")
        #expect(line.detail == "build-1")
    }

    @Test func `a phase is activity, never a row: the fold adds nothing and the turn stays open`() {
        let fold = ThreadFold.fold(rows([
            user("go"),
            .phase(PhaseEvent(phase: .cliStarting)),
            .phase(PhaseEvent(phase: .retrying, retry: .init(attempt: 3, delayMs: 32_000, reason: "HTTP 429"))),
            .phase(PhaseEvent(phase: nil)),
            answer("done")
        ]))
        #expect(fold.items.count == 2)
        guard case .user = fold.items[0].item, case .assistant = fold.items[1].item else {
            Issue.record("shape \(fold.items)")
            return
        }
        #expect(fold.lastSeq == 5)
    }

    @Test func `host rows carry their event whole: the failure, the notice, the preamble, the handoff's child`() {
        let failure = Failure(kind: .rateLimited, account: "work", summary: "Rate limited", cause: "429 from the API")
        let notice = NoticeEvent(kind: .accountGone, message: "Account work is gone from this host")
        let preamble = PreambleStamp(text: "## Rules\nBe brief.", words: 3)
        let fold = ThreadFold.fold(rows([
            .userText(UserTextEvent(text: "go", preamble: preamble)),
            .error(ErrorEvent(message: "boom", stopped: false, failure: failure)),
            .notice(notice),
            .planHandoff(PlanHandoffEvent(sessionId: "child-1", title: "Build it", how: .auto)),
            .error(ErrorEvent(message: "plain", stopped: true))
        ]))
        guard case .user(let turn) = fold.items[0].item,
              case .system(let failed) = fold.items[1].item,
              case .system(let status) = fold.items[2].item,
              case .system(let handoff) = fold.items[3].item,
              case .system(let plain) = fold.items[4].item else {
            Issue.record("shape \(fold.items)")
            return
        }
        #expect(turn.preamble == preamble)
        #expect(failed.kind == .error && failed.failure == failure && !failed.stopped)
        #expect(status.kind == .status && status.text == notice.message && status.detail == "account-gone" && status.notice == notice)
        #expect(handoff.kind == .planHandoff && handoff.agentId == "child-1" && handoff.text == "Build it")
        #expect(plain.failure == nil && plain.notice == nil && plain.stopped)
    }

    @Test func `a steer's rows land on its turn, the last one winning, an unknown id changing nothing`() {
        let steer = { (state: SteerEvent.State, how: SteerEvent.How?) in AgentEvent.steer(SteerEvent(steerId: "s1", state: state, how: how)) }
        let fold = ThreadFold.fold(rows([
            user("go"),
            answer("working"),
            .userText(UserTextEvent(text: "use the other table", steerId: "s1")),
            steer(.sent, nil),
            .steer(SteerEvent(steerId: "stranger", state: .failed)),
            steer(.received, .nextTurn)
        ]))
        guard case .user(let first) = fold.items[0].item, case .user(let steered) = fold.items[2].item else {
            Issue.record("shape \(fold.items)")
            return
        }
        #expect(first.steerId == nil && first.steer == nil)
        #expect(steered.steerId == "s1")
        #expect(steered.steer == SteerStamp(state: .received, how: .nextTurn, ts: 1_500))
        #expect(fold.items.count == 3)
        #expect(fold.entryID(for: rows([steer(.sent, nil)])[0]) == fold.items[2].id)
    }

    @Test func `a steer's word and its detail say what the desktop says`() {
        let utc = TimeZone(identifier: "UTC")!
        let gb = Locale(identifier: "en_GB")
        let at = 1_793_574_120_000 // 23:02 UTC
        #expect(SteerStamp(state: .sent, ts: at).word == "Sent")
        #expect(SteerStamp(state: .sent, ts: at).detail(timeZone: utc, locale: gb) == "Sent at 23:02")
        #expect(SteerStamp(state: .received, how: .inTurn, ts: at).detail(timeZone: utc, locale: gb) == "Received at 23:02")
        #expect(SteerStamp(state: .received, how: .nextTurn, ts: at).detail(timeZone: utc, locale: gb) == "Received at 23:02, as its own turn")
        #expect(SteerStamp(state: .queued, ts: at).word == "Queued for the next turn")
        #expect(SteerStamp(state: .queued, ts: at).detail(timeZone: utc, locale: gb) == "Queued at 23:02")
        #expect(SteerStamp(state: .failed, reason: "the harness did not start", ts: at).word == "Not delivered")
        #expect(SteerStamp(state: .failed, reason: "the harness did not start", ts: at).detail(timeZone: utc, locale: gb) == "Not delivered: the harness did not start")
        #expect(SteerStamp(state: .unknown("read"), ts: at).word == nil)
        // The clock is the locale's: 12-hour with AM/PM where the locale writes it.
        let us = SteerStamp(state: .sent, ts: at).detail(timeZone: utc, locale: Locale(identifier: "en_US")) ?? ""
        #expect(us.hasPrefix("Sent at 11:02"))
        #expect(us.hasSuffix("PM"))
    }
}
