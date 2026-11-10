import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct GroupPhraseTests {
    private let cwd = PhraseFixture.cwd
    private func say(_ tools: [ToolItem], live: Bool? = nil) -> String {
        GroupPhrase.of(tools.map(GroupStep.tool), cwd: cwd, live: live, titleOf: { ["a": "Port the view", "b": "Fix the fold", "c": "Write the docs", "t": "UI 3: subagent spawns"][$0] })
    }
    private func orch(_ name: String, _ input: JSONValue = .object([:]), id: String = "1", output: String? = nil) -> ToolItem { PhraseFixture.call("mcp__orchestrator__\(name)", input, id: id, output: output) }
    private func spawn(_ agent: String) -> ToolItem { orch("spawn_agent", .object(["task": .string("x")]), id: "s:\(agent)", output: "{\"agentId\":\"\(agent)\"}") }
    private func waited(_ output: String) -> ToolItem { orch("wait_for_agent", .object(["agentId": .string("a")]), id: "w", output: output) }

    @Test func `joins phrases with commas and lowers all but the first`() {
        #expect(say([PhraseFixture.write("src/diag.ts"), PhraseFixture.bash("make")]) == "Created diag.ts, ran a command")
        #expect(say([PhraseFixture.read("src/lib/a.ts"), PhraseFixture.read("src/lib/b.ts"), PhraseFixture.read("src/lib/c.ts"), PhraseFixture.edit("src/types.ts")]) == "Read 3 files in src/lib, edited types.ts")
    }

    @Test func `says three phrases then how many more`() {
        #expect(say([PhraseFixture.read("a.ts"), PhraseFixture.edit("b.ts"), PhraseFixture.grep("token"), PhraseFixture.call("mcp__app__app_start_thread")]) == "Read a.ts, edited b.ts, searched for token and 1 more")
    }

    @Test func `speaks in the present tense while live`() {
        #expect(say([PhraseFixture.write("src/diag.ts"), PhraseFixture.bash("npm test")], live: true) == "Creating diag.ts, running the tests")
        #expect(say([PhraseFixture.write("a.ts"), PhraseFixture.call("Bash", .object(["command": .string("npm test")]), live: true)]) == "Creating a.ts, running the tests")
    }

    @Test func `says a repeated phrase once`() {
        #expect(say([PhraseFixture.read("a.ts"), PhraseFixture.bash("npm test", id: "t1"), PhraseFixture.read("a.ts", id: "again"), PhraseFixture.bash("npm test", id: "t2")]) == "Read a.ts, ran the tests")
    }

    @Test func `folds reads by folder or project and uses the basename for one`() {
        #expect(say([PhraseFixture.read("src/lib/a.ts"), PhraseFixture.read("README.md")]) == "Read monocode files")
        #expect(say([PhraseFixture.read("src/a.ts"), PhraseFixture.read("src/a.ts", id: "again")]) == "Read a.ts")
        #expect(say([PhraseFixture.read("a.ts"), PhraseFixture.call("Read", .object(["file_path": .string("/etc/hosts")]))]) == "Read 2 files")
        #expect(GroupPhrase.readsPhrase(["a.ts", "b.ts"], cwd: nil, live: false) == "Read 2 files")
    }

    @Test func `folds edits per verb in first appearance order`() {
        #expect(say([PhraseFixture.edit("a.ts"), PhraseFixture.edit("b.ts"), PhraseFixture.edit("c.ts")]) == "Edited 3 files")
        #expect(say([PhraseFixture.write("a.ts"), PhraseFixture.edit("b.ts")]) == "Created a.ts, edited b.ts")
        let remove = PhraseFixture.call("apply_patch", .array([PhraseFixture.change("\(cwd)/old.ts", "delete")]))
        #expect(say([remove]) == "Deleted old.ts")
        let patch = PhraseFixture.call("apply_patch", .array([PhraseFixture.change("x.ts", "delete"), PhraseFixture.change("a.ts", "add"), PhraseFixture.change("b.ts", "update"), PhraseFixture.change("x.ts", "delete")]))
        #expect(say([patch]) == "Deleted x.ts, created a.ts, edited b.ts")
        #expect(say([patch], live: true) == "Deleting x.ts, creating a.ts, editing b.ts")
        #expect(say([PhraseFixture.edit("a.ts"), PhraseFixture.edit("a.ts")]) == "Edited a.ts")
    }

    @Test func `counts a stretch of commands or searches`() {
        #expect(say([PhraseFixture.bash("ls"), PhraseFixture.bash("pwd"), PhraseFixture.bash("whoami")]) == "Ran 3 commands")
        #expect(say([PhraseFixture.grep("a"), PhraseFixture.grep("b")]) == "Ran 2 searches")
        #expect(say([PhraseFixture.grep("a"), PhraseFixture.call("Glob", .object(["pattern": .string("*.swift")]))], live: true) == "Running 2 searches")
    }

    @Test func `never prints a failure count or a separator dot`() {
        #expect(say([PhraseFixture.call("Bash", .object(["command": .string("npm test")]), failed: true)]) == "Ran the tests")
        let line = say([PhraseFixture.bash("git status && npm test && bun run build")])
        #expect(!line.contains("·") && !line.contains("+") && !line.contains("failed"))
    }

    @Test func `says one clause per command so parts never read as calls`() {
        #expect(say([PhraseFixture.read("a.ts"), PhraseFixture.bash("git status && npm test")]) == "Read a.ts, checked git status")
        #expect(say([PhraseFixture.bash("git status && npm test")], live: true) == "Checking git status")
    }

    @Test func `keeps a described command whole including its commas`() {
        #expect(say([PhraseFixture.call("Bash", .object(["command": .string("make"), "description": .string("Run the build, then sign")]))]) == "Ran the build, then sign")
    }

    @Test func `falls back for an unnamed call and returns empty for no steps`() {
        #expect(GroupPhrase.of([]) == "")
        let unknown = PhraseFixture.call("", preview: ToolPreview(kind: .unknown("other"), title: "Working"))
        #expect(say([unknown]) == "Ran 1 tool")
        #expect(say([unknown, unknown]) == "Ran 2 tools")
        #expect(say([unknown], live: true) == "Working")
        // GroupStep has no assistant or user case, so non-tool input is excluded by its type.
    }

    @Test func `create means a file that did not exist before`() {
        #expect(say([PhraseFixture.write("a.ts")]) == "Created a.ts")
        #expect(say([PhraseFixture.write("a.ts", output: "The file /x/a.ts has been updated successfully.")]) == "Edited a.ts")
        #expect(say([PhraseFixture.edit("a.ts")]) == "Edited a.ts")
    }

    @Test func `commonDir is the shared folder or empty at the root`() {
        #expect(GroupPhrase.commonDir(["src/lib/a.ts", "src/lib/b/c.ts"]) == "src/lib")
        #expect(GroupPhrase.commonDir(["a.ts", "src/b.ts"]) == "")
        #expect(GroupPhrase.commonDir([]) == "")
    }

    @Test func `spawn agent names one by title and a stretch by count`() {
        // ToolItem has no spawned stamp; the same id is available in its result.
        #expect(say([spawn("a")]) == "Spawned “Port the view”")
        #expect(say([spawn("a")], live: true) == "Spawning “Port the view”")
        #expect(say([spawn("a"), spawn("b"), spawn("c")]) == "Spawned 3 agents")
        #expect(say([orch("spawn_agent", .object(["agents": .array([.object([:]), .object([:]), .object([:])])]))]) == "Spawned 3 agents")
    }

    @Test func `starts a thread by title and a stretch by count`() {
        func start(_ id: String, _ title: String) -> ToolItem { PhraseFixture.call("mcp__app__app_start_thread", .object(["threadType": .string("planning"), "title": .string(title)]), id: id) }
        #expect(say([start("1", "UI 3: subagent spawns")]) == "Started thread “UI 3: subagent spawns”")
        #expect(say([start("1", "A"), start("2", "B"), start("3", "C"), start("4", "D")]) == "Started 4 threads")
        #expect(say([start("1", "A")], live: true) == "Starting thread “A”")
    }

    @Test func `send check answer and interrupt count distinct agents`() {
        func call(_ name: String, _ agent: String, _ id: String) -> ToolItem { orch(name, .object(["agentId": .string(agent)]), id: id) }
        #expect(say([call("send_to_agent", "a", "1")]) == "Messaged “Port the view”")
        #expect(say([call("send_to_agent", "a", "1"), call("send_to_agent", "b", "2")]) == "Messaged 2 agents")
        #expect(say([call("check_agent", "a", "1"), call("check_agent", "b", "2"), call("check_agent", "c", "3")]) == "Checked 3 agents")
        #expect(say([call("answer_agent", "a", "1")]) == "Answered “Port the view”")
        #expect(say([call("interrupt_agent", "a", "1"), call("interrupt_agent", "b", "2")]) == "Stopped 2 agents")
        #expect(say([call("send_to_agent", "a", "1"), call("send_to_agent", "a", "2")]) == "Messaged “Port the view”")
    }

    @Test func `a returned wait names the agents it heard from`() {
        #expect(say([waited(#"{"agentId":"a","status":"idle","reply":"done"}"#)]) == "Heard from “Port the view”")
        #expect(say([waited(#"{"agentId":"env_mac:a","status":"done"}"#)]) == "Heard from “Port the view”")
        #expect(say([waited(#"[{"agentId":"a","status":"done"},{"agentId":"b","status":"failed"},{"agentId":"c","status":"done"}]"#)]) == "Heard from 3 agents")
        #expect(say([spawn("a"), waited(#"{"status":"steered","message":"hi"}"#)]) == "Spawned “Port the view”")
        #expect(say([waited("not json"), PhraseFixture.read("a.ts")]) == "Read a.ts")
    }

    @Test func `app bookkeeping is said once`() {
        let notes = PhraseFixture.call("mcp__app__update_notes", .object(["section": .string("State")]))
        #expect(say([notes, notes]) == "Updated the notes")
        #expect(say([PhraseFixture.call("app.batch_rules", .object(["steps": .array([])]))]) == "Set the batch steps")
        #expect(say([PhraseFixture.call("mcp__app__plan_complete")]) == "Marked the plan complete")
        #expect(say([PhraseFixture.call("TodoWrite"), PhraseFixture.call("TodoWrite")]) == "Updated todos")
    }

    @Test func `merge branch names the branch and counts a stretch`() {
        func merge(_ branch: String) -> ToolItem { PhraseFixture.call("mcp__app__merge_branch", .object(["branch": .string(branch)]), id: "m:\(branch)") }
        #expect(say([merge("ui-3")]) == "Merged ui-3")
        #expect(say([merge("ui-3")], live: true) == "Merging ui-3")
        #expect(say([merge("ui-3"), merge("ui-4")]) == "Merged 2 branches")
        #expect(say([merge("ui-3"), merge("ui-3")]) == "Merged ui-3")
    }

    @Test func `TaskCreate and TaskUpdate count calls`() {
        func create(_ id: String) -> ToolItem { PhraseFixture.call("TaskCreate", .object(["subject": .string("x")]), id: id) }
        func update(_ id: String) -> ToolItem { PhraseFixture.call("TaskUpdate", .object(["taskId": .string(id)]), id: "u\(id)") }
        #expect(say([create("1")]) == "Added a task")
        #expect(say([create("1"), create("2"), create("3")]) == "Added 3 tasks")
        #expect(say([update("1"), update("2"), update("3"), update("4")]) == "Updated 4 tasks")
        #expect(say([update("1")], live: true) == "Updating a task")
    }

    @Test func `each phrase stops at 48 characters and agent titles at 24`() {
        let title = String(repeating: "a", count: 30)
        let tool = orch("spawn_agent", .object(["title": .string(title)]))
        #expect(say([tool]) == "Spawned “\(String(repeating: "a", count: 23))…”")
        #expect(say([PhraseFixture.call("Long" + String(repeating: "x", count: 80))]).count == 48)
    }

    // Refused-call cases need the approval decision, which ToolItem does not carry.
    // Host steps (A8): reports, tasks, gates, reviews, the pass, the hand-off, a batch merge, away.
    private let titles = ["a": "Port the view", "b": "Fix the fold", "c": "Write the docs"]
    private func sayAll(_ steps: [GroupStep], live: Bool? = nil, titleOf: ((String) -> String?)? = nil) -> String {
        GroupPhrase.of(steps, cwd: cwd, live: live, titleOf: titleOf ?? { self.titles[$0] })
    }
    private func line(_ kind: SystemLine.Kind, _ text: String = "", detail: String? = nil, agentId: String? = nil, notice: NoticeEvent? = nil, batch: Bool = false) -> GroupStep {
        var line = SystemLine(seq: 9, ts: 0, kind: kind, text: text, detail: detail, stopped: false, agentId: agentId, notice: notice)
        line.batch = batch
        return .system(line)
    }
    private func report(_ id: String, title: String = "Batch", status: String = "done", batch: Bool = false) -> GroupStep {
        line(.agentReport, title, detail: status, agentId: id, batch: batch)
    }
    private func task(_ label: String, _ status: String = "completed") -> GroupStep { line(.backgroundTask, label, detail: status) }
    private func notice(_ kind: NoticeKind, _ message: String = "x", gate: GateNotice? = nil, review: ReviewNotice? = nil, away: AwayNotice? = nil) -> GroupStep {
        line(.status, message, detail: kind.rawValue, notice: NoticeEvent(kind: kind, message: message, review: review, gate: gate, away: away))
    }

    @Test func `a report is heard from; the batch's report reads as the batch`() {
        #expect(sayAll([report("a")]) == "Heard from “Port the view”")
        #expect(sayAll([report("a"), report("b"), report("c")]) == "Heard from 3 agents")
        #expect(sayAll([report("self", batch: true)]) == "Heard from the batch")
    }

    @Test func `a wait that returned is heard from the agents it returned on, with the reports`() {
        #expect(sayAll([.tool(waited(#"{"agentId":"a","status":"idle"}"#)), report("a")]) == "Heard from “Port the view”")
        #expect(sayAll([.tool(waited(#"{"agentId":"a","status":"idle"}"#)), report("b")]) == "Heard from 2 agents")
    }

    @Test func `a master's run reads as one line`() {
        #expect(sayAll([.tool(spawn("a")), .tool(waited(#"{"agentId":"a","status":"idle"}"#)), report("a")]) == "Spawned “Port the view”, heard from “Port the view”")
    }

    @Test func `a thread the store does not know is named by the report in the run`() {
        #expect(sayAll([.tool(spawn("x")), report("x", title: "Far child")], titleOf: { _ in nil }) == "Spawned “Far child”, heard from “Far child”")
    }

    @Test func `a spawn the host stamped is named by its child`() {
        var stamped = orch("spawn_agent", .object(["task": .string("x")]), id: "s")
        stamped.spawned = ["b"]
        #expect(sayAll([.tool(stamped)]) == "Spawned “Fix the fold”")
        #expect(sayAll([line(.agentSpawned, agentId: "c")]) == "Spawned “Write the docs”")
    }

    @Test func `a finished background task`() {
        #expect(sayAll([task("lint")]) == "Lint finished")
        #expect(sayAll([task("lint", "failed")]) == "Lint failed")
        #expect(sayAll([task("lint"), task("lint")]) == "2 tasks finished")
    }

    @Test func `gate, review, pass, hand-off, batch merge, away`() {
        func gate(_ ok: Bool, _ step: GateStep = .gate) -> GroupStep { notice(.gate, gate: GateNotice(step: step, branch: "ui-3", ok: ok, log: "", at: 0)) }
        #expect(sayAll([gate(true)]) == "Gate passed")
        #expect(sayAll([gate(false)]) == "Gate failed on ui-3")
        #expect(sayAll([gate(true, .release)]) == "Release passed")
        func review(_ outcome: ReviewOutcome) -> GroupStep {
            notice(.review, review: ReviewNotice(runId: "r", provider: "codex", model: "m", outcome: outcome, branch: "b", target: "master", blocking: [], minor: [], merged: true, pushed: false))
        }
        #expect(sayAll([review(.pass)]) == "Review passed")
        #expect(sayAll([review(.timeout)]) == "Review timed out")
        #expect(sayAll([line(.turnPass, "Notes")]) == "Ran the pass")
        #expect(sayAll([line(.planHandoff, "T", agentId: "x")]) == "Started the build")
        #expect(sayAll([notice(.batch, "Merged by the batch: ui-3")]) == "Merged by the batch")
        #expect(sayAll([notice(.away, away: AwayNotice(kind: .decision, text: "x"))]) == "Decided without asking")
        #expect(sayAll([notice(.away, away: AwayNotice(kind: .question, text: "x"))]) == "Answered for you")
        #expect(sayAll([notice(.away, away: AwayNotice(kind: .approval, text: "x"))]) == "Skipped an approval")
        #expect(sayAll([notice(.away, away: AwayNotice(kind: .allowed, text: "x"))]) == "Allowed for you")
    }

    @Test func `a wake: two reports, a task, then calls`() {
        #expect(sayAll([report("a"), report("b"), task("deploy"), .tool(PhraseFixture.bash("git log"))]) == "Heard from 2 agents, deploy finished, read git history")
    }
}
