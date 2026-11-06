import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// Agents in the run (agentTitle.ts, agentSteps.ts, the agents cue) on the phone.
@Suite struct AgentTitleTests {
    @Test func `the store's title first, then the spawn's, the stamp, the task, a subagent`() {
        let store: (String) -> String? = { $0 == "c1" ? "Review the payment flow" : nil }
        #expect(AgentTitle.of("env_abc:c1", titleOf: store).title == "Review the payment flow")
        #expect(AgentTitle.of("c2", titleOf: store, inputTitle: "Map the plugin", stamped: "Other").title == "Map the plugin")
        #expect(AgentTitle.of("c2", titleOf: store, stamped: "Stamped name").title == "Stamped name")
        let task = AgentTitle.of("c2", titleOf: store, task: "Read every file\nand report")
        #expect(task.title == "Read every file")
        #expect(!task.named)
        #expect(AgentTitle.of(nil, titleOf: store).title == "a subagent")
    }

    @Test func `a long title is cut at a word past 48`() {
        let long = AgentTitle.of("c", titleOf: { _ in "Review the payment flow and every webhook it calls on the way out" })
        #expect(long.title.count <= AgentTitle.max)
        #expect(long.title.hasSuffix("…"))
        #expect(long.full.hasPrefix("Review the payment flow and every"))
    }
}

@Suite struct AgentStepsTests {
    private func wait(_ ids: [String], output: String? = nil, running: Bool = false) -> ToolItem {
        ToolItem(seq: 1, ts: 0, callId: "w", name: "mcp__orchestrator__wait_for_agent", display: nil, input: .object(["agentIds": .array(ids.map(JSONValue.string))]), partial: false, preview: nil, parentCallId: nil, inputOmitted: false, output: output.map(BodyState.whole) ?? .none, status: running ? .running : .done, reauth: nil)
    }

    @Test func `a wait names its agents once each, in order`() {
        #expect(WaitSteps.ids(wait(["a", "b", "a"])) == ["a", "b"])
        #expect(WaitSteps.isWait(wait([])))
    }

    @Test func `a settled wait returns each agent that settled; anything else leaves nothing`() {
        let done = wait(["a", "b"], output: #"[{"agentId":"a","status":"idle"},{"agentId":"b","status":"timeout"}]"#)
        #expect(WaitSteps.outcomes(done) == [WaitSteps.Outcome(id: "a", status: "idle")])
        #expect(WaitSteps.outcomes(wait(["a"], output: "not json")).isEmpty)
        #expect(WaitSteps.outcomes(wait(["a"], running: true)).isEmpty)
        #expect(WaitSteps.outcomes(wait(["a"], output: #"{"agentId":"a","status":"failed"}"#)) == [WaitSteps.Outcome(id: "a", status: "failed")])
    }

    @Test func `the open wait is the last one with nothing after it that speaks or runs`() {
        let open = ThreadEntry(item: .tool(wait(["a"], running: true)))
        #expect(WaitSteps.openWait([open]) != nil)
        let prose = ThreadEntry(item: textItem(2, "still going"))
        #expect(WaitSteps.openWait([open, prose]) == nil)
        let running = ThreadEntry(item: toolItem(3, name: "Bash"))
        #expect(WaitSteps.openWait([open, running]) == nil)
        let asking = ThreadEntry(item: .approval(ApprovalItem(seq: 4, ts: 4, request: ApprovalRequestEvent(requestId: "r", toolName: "Bash"), allowed: nil, auto: false)))
        #expect(WaitSteps.openWait([open, asking]) == nil)
        let decided = ThreadEntry(item: .approval(ApprovalItem(seq: 4, ts: 4, request: ApprovalRequestEvent(requestId: "r", toolName: "Bash"), allowed: true, auto: false)))
        #expect(WaitSteps.openWait([open, decided]) != nil)
    }

    @Test func `the working line's wait comes from the turn's open wait, never the meta`() {
        let one = ThreadEntry(item: .tool(wait(["env_box:c1"], running: true)))
        #expect(WaitSteps.waitOn([one]) { $0 == "c1" ? "Review the flow" : nil } == "Review the flow")
        #expect(WaitSteps.waitOn([ThreadEntry(item: .tool(wait(["a", "b"], running: true)))]) == "2 subagents")
        let returned = ThreadEntry(item: .tool(wait(["a"], output: #"{"agentId":"a","status":"idle"}"#)))
        #expect(WaitSteps.waitOn([returned]) == nil)
        let phase = LinePhase.of(turn: [one], activity: nil, waitOn: WaitSteps.waitOn([one]) { _ in "Review the flow" })
        #expect(phase.verb == "Waiting on" && phase.object == "Review the flow")
    }

    @Test func `the step's word by status`() {
        #expect(WaitSteps.word("idle") == "Finished")
        #expect(WaitSteps.word("error") == "Failed")
        #expect(WaitSteps.word("waiting") == "Needs you")
        #expect(WaitSteps.word("stopped") == "Stopped")
        #expect(WaitSteps.word("paused") == "Paused")
    }
}

@Suite struct AgentsCueTests {
    @Test func `waiting leads, then working, then queued, at any depth`() {
        let metas = [
            meta("root", status: .running),
            meta("a", parentId: "root", status: .running),
            meta("b", parentId: "a", status: .waiting),
            meta("c", parentId: "root", status: .queued),
            meta("d", parentId: "root", status: .idle),
        ]
        let cue = AgentsCue.of(rootId: "root", metas: metas, rootRunning: false)
        #expect(cue?.state == .waiting)
        #expect(cue?.total == 3)
        #expect(cue?.label == "1 needs you")
        #expect(cue?.line == "Agents: 1 needs you, 1 working, 1 queued")
    }

    @Test func `working is still while the thread's own turn runs`() {
        let metas = [meta("root", status: .running), meta("a", parentId: "root", status: .running)]
        #expect(AgentsCue.of(rootId: "root", metas: metas, rootRunning: true)?.still == true)
        #expect(AgentsCue.of(rootId: "root", metas: metas, rootRunning: false)?.still == false)
        #expect(AgentsCue.of(rootId: "root", metas: metas, rootRunning: true)?.label == "1 agent")
    }

    @Test func `a batch thread and an archived agent are not counted, its children are`() {
        let metas = [
            meta("root", status: .watching, isMaster: true),
            meta("batch", status: .running, masterId: "root"),
            meta("gone", parentId: "root", status: .running, archived: true),
            meta("kid", parentId: "gone", status: .running),
        ]
        let cue = AgentsCue.of(rootId: "root", metas: metas, rootRunning: false)
        #expect(cue?.working == 1)
        #expect(AgentsCue.of(rootId: "root", metas: [meta("root")], rootRunning: false) == nil)
    }
}

@Suite struct FoldedStepTests {
    private func line(_ kind: SystemLine.Kind, _ text: String = "x", detail: String? = nil, notice: NoticeEvent? = nil) -> SystemLine {
        SystemLine(seq: 1, ts: 0, kind: kind, text: text, detail: detail, stopped: false, notice: notice)
    }
    private func notice(_ kind: NoticeKind, _ message: String = "x", gate: GateNotice? = nil, review: ReviewOutcome? = nil) -> SystemLine {
        let verdict = review.map { ReviewNotice(runId: "r", provider: "codex", model: "m", outcome: $0, branch: "b", target: "master", blocking: [], minor: [], merged: $0 != .held, pushed: false) }
        return line(.status, message, notice: NoticeEvent(kind: kind, message: message, review: verdict, gate: gate))
    }

    @Test func `a report, a spawn, a task, the pass and the hand-off fold into the run`() {
        for kind in [SystemLine.Kind.agentReport, .agentSpawned, .backgroundTask, .turnPass, .planHandoff] {
            #expect(FoldedStep.isFolded(line(kind)), "\(kind)")
        }
        for kind in [SystemLine.Kind.error, .plan, .goal, .unknown] {
            #expect(!FoldedStep.isFolded(line(kind)), "\(kind)")
        }
    }

    @Test func `a gate, a merged review, an away line and a batch merge are steps; a held review and Batch done are rows`() {
        #expect(FoldedStep.isFolded(notice(.gate, gate: GateNotice(step: .gate, branch: "b", ok: false, log: "", at: 0))))
        #expect(FoldedStep.isFolded(notice(.review, review: .pass)))
        #expect(FoldedStep.isFolded(notice(.review, review: .mergedAnyway)))
        #expect(!FoldedStep.isFolded(notice(.review, review: .held)))
        #expect(FoldedStep.isFolded(notice(.away)))
        #expect(FoldedStep.isFolded(notice(.batch, "Merged by the batch: ui-3")))
        #expect(!FoldedStep.isFolded(notice(.batch, "Batch done: 3 landed")))
        #expect(!FoldedStep.isFolded(notice(.accountGone)))
        #expect(!FoldedStep.isFolded(notice(.planBuild)))
        #expect(!FoldedStep.isFolded(line(.status, "The host restarted during your turn")))
    }

    @Test func `a wait draws a row per agent it returned on, a batch spawn a row per child`() {
        let wait = ToolItem(seq: 1, ts: 0, callId: "w", name: "mcp__orchestrator__wait_for_agent", display: nil, input: .object(["agentIds": .array([.string("a"), .string("b")])]), partial: false, preview: nil, parentCallId: nil, inputOmitted: false, output: .whole(#"[{"agentId":"a","status":"idle"},{"agentId":"b","status":"failed"}]"#), status: .done, reauth: nil)
        #expect(FoldedStep.rows(ThreadEntry(item: .tool(wait))) == 2)
        #expect(FoldedStep.failures(ThreadEntry(item: .tool(wait))) == 1)
        var batch = ToolItem(seq: 2, ts: 0, callId: "s", name: "mcp__orchestrator__spawn_agent", display: nil, input: .object(["agents": .array([.object(["title": .string("One"), "task": .string("a")]), .object(["task": .string("Second task\nmore")])])]), partial: false, preview: nil, parentCallId: nil, inputOmitted: false, output: .none, status: .done, reauth: nil)
        #expect(FoldedStep.rows(ThreadEntry(item: .tool(batch))) == 1)
        batch.spawned = ["c1", "c2"]
        #expect(FoldedStep.isBatchSpawn(batch))
        #expect(FoldedStep.rows(ThreadEntry(item: .tool(batch))) == 2)
        let names = FoldedStep.spawnedNames(batch)
        #expect(names.map(\.id) == ["c1", "c2"])
        #expect(names[0].name == SpawnedName(title: "One", task: "a"))
        #expect(names[1].name == SpawnedName(title: nil, task: "Second task\nmore"))
    }

    @Test func `a wait is no step while open or when it returned on nobody`() {
        func wait(_ output: String?, running: Bool = false) -> ToolItem {
            ToolItem(seq: 1, ts: 0, callId: "w", name: "app.wait_for_agent", display: nil, input: .object(["agentId": .string("a")]), partial: false, preview: nil, parentCallId: nil, inputOmitted: false, output: output.map(BodyState.whole) ?? .none, status: running ? .running : .done, reauth: nil)
        }
        #expect(WaitSteps.isHidden(wait(nil, running: true)))
        #expect(WaitSteps.isHidden(wait(#"{"status":"steered","message":"hi"}"#)))
        #expect(!WaitSteps.isHidden(wait(#"{"agentId":"a","status":"done"}"#)))
    }
}
