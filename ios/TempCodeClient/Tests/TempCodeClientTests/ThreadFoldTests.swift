import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct ThreadFoldTests {
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
        let gate = NoticeEvent.Gate(step: .typecheck, branch: "feature", ok: true, log: "", at: 1_200)
        let fold = ThreadFold.fold(rows([
            user("go"),
            .notice(NoticeEvent(kind: "gate", message: "Typecheck passed on feature", gate: gate)),
            .notice(NoticeEvent(kind: "account-gone", message: "Account a is gone from this host"))
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
            .notice(NoticeEvent(kind: "gate", message: "Typecheck passed on ios/export", gate: gate)),
            .notice(NoticeEvent(kind: "batch", message: "Merged by the batch"))
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
            .notice(NoticeEvent(kind: "review", message: "held one", review: held("r1"))),
            .notice(NoticeEvent(kind: "review", message: "held two", review: held("r2"))),
            .notice(NoticeEvent(kind: "review", message: "Merged anyway", review: over))
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
}
