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
