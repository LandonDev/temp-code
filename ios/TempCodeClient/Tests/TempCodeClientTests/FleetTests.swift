import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct FleetTests {
    @Test func `rank puts waiting first, then failed, then working, then the rest`() {
        #expect(Fleet.rank(.waiting) == 0)
        #expect(Fleet.rank(.error) == 1)
        #expect(Fleet.rank(.running) == 2)
        #expect(Fleet.rank(.starting) == 2)
        #expect(Fleet.rank(.idle) == 3)
        #expect(Fleet.rank(.paused) == 3)
        #expect(Fleet.rank(nil) == 3)
    }

    @Test func `sorts by rank then age and keeps unarchived children only`() {
        let list = Fleet.sort([
            meta("b", status: .running, createdAt: 5),
            meta("a", status: .idle, createdAt: 1),
            meta("c", status: .running, createdAt: 2),
            meta("d", status: .waiting, createdAt: 9)
        ])
        #expect(list.map(\.id) == ["d", "c", "b", "a"])
        let children = Fleet.children(of: "p", in: [meta("p"), meta("x", parentId: "p"), meta("y", parentId: "p", archived: true), meta("z", parentId: "q")])
        #expect(children.map(\.id) == ["x"])
    }

    @Test func `counts bucket by status`() {
        let counts = Fleet.counts([.running, .starting, .waiting, .error, .idle, .paused, .watching])
        #expect(counts == Fleet.Counts(working: 3, waiting: 1, failed: 1, done: 2))
        #expect(counts.active)
        #expect(!Fleet.counts([.done]).active)
    }

    @Test func `transcript lines name the latest tool, the latest words, the first request`() {
        let items = [
            item(userItem(1, ts: 0, "Refactor the auth module\nwith care")),
            item(textItem(2, "Sure, starting now.\nMore detail.")),
            item(toolItem(3, doneTs: 1, name: "Bash", input: ["command": .string("npm test\n--watch")])),
            item(textItem(4, "hmm", thinking: true))
        ]
        #expect(Fleet.activityLine(items) == "Bash · npm test")
        #expect(Fleet.activityLine(Array(items.prefix(2))) == "Sure, starting now.")
        #expect(Fleet.activityLine(items + [item(errorItem(5, "boom"))]) == "boom")
        #expect(Fleet.activityLine([]) == "")
        #expect(Fleet.activityLine([item(toolItem(1, name: "Read", preview: ToolPreview(kind: .read, path: "src/a.ts", fileName: "a.ts")))]) == "Read · a.ts")
        #expect(Fleet.lastAssistantLine(items) == "Sure, starting now.")
        #expect(Fleet.lastAssistantLine([item(textItem(1, "  "))]) == "")
        #expect(Fleet.taskTitle(items) == "Refactor the auth module")
        #expect(Fleet.taskTitle([]) == "")
    }

    @Test func `the line follows the status`() {
        #expect(Fleet.line(status: .watching, items: []) == Fleet.Line("waiting on background work", tone: .muted))
        let question = item(.question(QuestionItem(seq: 1, ts: 0, request: QuestionRequestEvent(requestId: "r", questions: [.init(question: "Which db?\nmore", options: [])]), answers: nil, resolved: false)))
        #expect(Fleet.line(status: .waiting, items: [question]) == Fleet.Line("has a question — Which db?", tone: .warning))
        let approval = item(.approval(ApprovalItem(seq: 1, ts: 0, request: ApprovalRequestEvent(requestId: "1", toolName: "Bash", title: "rm -rf build"), allowed: nil, auto: false)))
        #expect(Fleet.line(status: .waiting, items: [approval]) == Fleet.Line("waiting for approval — rm -rf build", tone: .warning))
        #expect(Fleet.line(status: .waiting, items: []) == Fleet.Line("waiting for approval", tone: .warning))
        #expect(Fleet.line(status: .error, items: [item(errorItem(1, "Rate limited"))]) == Fleet.Line("Rate limited", tone: .danger))
        #expect(Fleet.line(status: .error, items: []) == Fleet.Line("failed", tone: .danger))
        let tool = item(toolItem(2, name: "Grep", input: ["pattern": .string("foo")]))
        #expect(Fleet.line(status: .running, items: [item(textItem(1, "hi")), tool]) == Fleet.Line("Grep · foo", tone: .muted))
        #expect(Fleet.line(status: .idle, items: [item(textItem(1, "Done.")), tool]) == Fleet.Line("Done.", tone: .muted))
        #expect(Fleet.line(status: .running, items: [tool], compacting: true) == Fleet.Line("compacting the context…", tone: .muted))
    }

    @Test func `stats sum edit previews and read tasks, context and cost`() {
        let items = [
            item(toolItem(1, name: "Edit", preview: editPreview("/a", adds: 10, dels: 4))),
            item(toolItem(2, name: "Edit", preview: editPreview("/b", adds: 2))),
            item(toolItem(3, name: "Read", preview: ToolPreview(kind: .read)))
        ]
        var board = BoardState()
        board.cost = 1.25
        let stats = Fleet.stats(items: items, tasks: .init(done: 2, total: 5), board: board, context: .init(tokens: 50, window: 200))
        #expect(stats == Fleet.Stats(adds: 12, dels: 4, tasksDone: 2, tasksTotal: 5, contextPercent: 25, cost: 1.25))
        var folded = BoardState()
        folded.todos = [TodoItem(content: "a", status: .completed), TodoItem(content: "b", status: .pending)]
        let fallback = Fleet.stats(items: [], tasks: nil, board: folded, context: nil)
        #expect(fallback.tasksDone == 1 && fallback.tasksTotal == 2 && fallback.contextPercent == nil && fallback.cost == nil)
        #expect(Fleet.stats(items: [], tasks: nil, board: nil, context: nil).isEmpty)
    }

    @Test func `a large fleet loads only the rows still working, waiting or failed`() {
        #expect(Fleet.loadsTranscript(status: .done, fleetSize: Fleet.eagerLoad))
        #expect(Fleet.loadsTranscript(status: .idle, fleetSize: 1))
        let big = Fleet.eagerLoad + 1
        #expect(Fleet.loadsTranscript(status: .running, fleetSize: big))
        #expect(Fleet.loadsTranscript(status: .starting, fleetSize: big))
        #expect(Fleet.loadsTranscript(status: .waiting, fleetSize: big))
        #expect(Fleet.loadsTranscript(status: .error, fleetSize: big))
        #expect(!Fleet.loadsTranscript(status: .done, fleetSize: big))
        #expect(!Fleet.loadsTranscript(status: .idle, fleetSize: big))
        #expect(!Fleet.loadsTranscript(status: .watching, fleetSize: big))
    }

    @Test func `sections group running, waiting, then done, rank order inside each`() {
        let agents = [
            meta("done", status: .done, createdAt: 1),
            meta("fail", status: .error, createdAt: 2),
            meta("run2", status: .running, createdAt: 8),
            meta("wait", status: .waiting, createdAt: 3),
            meta("run1", status: .starting, createdAt: 4),
            meta("watch", status: .watching, createdAt: 5),
            meta("idle", status: .idle, createdAt: 6)
        ]
        let sections = Fleet.sections(agents)
        #expect(sections.map(\.group) == [.running, .waiting, .done])
        #expect(sections[0].agents.map(\.id) == ["run1", "run2", "watch"])
        #expect(sections[1].agents.map(\.id) == ["wait"])
        #expect(sections[2].agents.map(\.id) == ["fail", "done", "idle"])
        #expect(Fleet.sections([]).isEmpty)
        #expect(Fleet.sections([meta("a", status: .waiting)]).map(\.group) == [.waiting])
        #expect(Fleet.group(.paused) == .done)
        #expect(Fleet.group(nil) == .done)
    }

    @Test func `the orchestrator line follows its status, then its fleet`() {
        #expect(Fleet.orchestratorLine(status: .running, counts: Fleet.Counts()) == "Orchestrating")
        #expect(Fleet.orchestratorLine(status: .waiting, counts: Fleet.Counts(working: 2)) == "Waiting on you")
        #expect(Fleet.orchestratorLine(status: .idle, counts: Fleet.Counts(working: 1)) == "Waiting on its subagents")
        #expect(Fleet.orchestratorLine(status: .idle, counts: Fleet.Counts(working: 3, waiting: 1)) == "Waiting on its subagents")
        #expect(Fleet.orchestratorLine(status: .done, counts: Fleet.Counts(waiting: 1)) == "A subagent needs you")
        #expect(Fleet.orchestratorLine(status: .done, counts: Fleet.Counts(waiting: 2)) == "Subagents need you")
        #expect(Fleet.orchestratorLine(status: .idle, counts: Fleet.Counts(failed: 1, done: 2)) == "Done, one agent failed")
        #expect(Fleet.orchestratorLine(status: .idle, counts: Fleet.Counts(failed: 2)) == "Done, 2 agents failed")
        #expect(Fleet.orchestratorLine(status: .idle, counts: Fleet.Counts(done: 2)) == "Done")
        #expect(Fleet.orchestratorLine(status: .idle, counts: Fleet.Counts()) == "")
        #expect(Fleet.orchestratorLine(status: .error, counts: Fleet.Counts()) == "Failed")
    }

    @Test func `branch names a worktree, elapsed reads the span`() {
        #expect(Fleet.branch(cwd: "/repo/.claude/worktrees/ios-fleet", parentCwd: "/repo") == "ios-fleet")
        #expect(Fleet.branch(cwd: "/repo", parentCwd: "/repo") == nil)
        #expect(Fleet.branch(cwd: "", parentCwd: "/repo") == nil)
        #expect(Fleet.branch(cwd: "/other", parentCwd: nil) == "other")
        #expect(Fleet.elapsedMs(meta("a", status: .running, createdAt: 1_000), now: 4_500) == 3_500)
        #expect(Fleet.elapsedMs(meta("a", status: .done, createdAt: 1_000, updatedAt: 9_000), now: 50_000) == 8_000)
        #expect(Fleet.elapsedMs(meta("a", status: .done, createdAt: 1_000, updatedAt: 2_000), now: 50_000) == nil)
    }
}
