import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func child(_ id: String, environmentId: String = "env_mac", title: String = "Far thread", status: String = "running", threadType: String? = "implementation", seenAt: Double? = nil, linkDown: Bool? = nil) -> BatchState.Children {
    BatchState.Children(sessionId: id, environmentId: environmentId, title: title, status: status, threadType: threadType, provider: "codex", model: "gpt-6.1-sol", seenAt: seenAt, linkDown: linkDown)
}

private func spec(_ id: String, _ kind: BatchStepKind, name: String? = nil, run: String? = nil) -> BatchStepSpec {
    BatchStepSpec(id: id, name: name ?? id.capitalized, kind: kind, run: run)
}

private var utc: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
}

@Suite struct MasterBoardChildrenTests {
    @Test("the batch is the unarchived roots carrying the master's id, oldest first; a subagent is left out") func children() {
        let metas = [
            meta("b", createdAt: 20, masterId: "m"),
            meta("a", createdAt: 10, masterId: "m"),
            meta("gone", archived: true, createdAt: 5, masterId: "m"),
            meta("sub", parentId: "a", createdAt: 30, masterId: "m"),
            meta("other", createdAt: 1, masterId: "m2"),
            meta("m", isMaster: true)
        ]
        #expect(MasterBoard.children(of: "m", in: metas).map(\.id) == ["a", "b"])
    }

    @Test("a build takes its plan's row and title; the plan is never a second row") func foldsAPlanAndItsBuild() {
        let plan = meta("plan", createdAt: 5, title: "Pricing survey", threadType: .planning, masterId: "m")
        let build = meta("build", createdAt: 30, title: "Implement it", threadType: .implementation, masterId: "m", planThreadId: "plan")
        let other = meta("x", createdAt: 10, title: "Live strip", threadType: .implementation, masterId: "m")
        let rows = MasterBoard.foldRows(children: [plan, other, build], all: [plan, other, build], masterId: "m")
        #expect(rows.map(\.key) == ["plan", "x"])
        #expect(rows[0].title == "Pricing survey")
        #expect(rows[0].sessionId == "build")
        #expect(rows[0].plan?.id == "plan")
        #expect(rows[0].createdAt == 5)
    }

    @Test("an archived plan still lends its title; a plan in another batch does not fold") func archivedAndForeignPlans() {
        let archived = meta("plan", archived: true, createdAt: 1, title: "Old plan", threadType: .planning, masterId: "m")
        let build = meta("build", createdAt: 9, title: "Build", masterId: "m", planThreadId: "plan")
        let foreignPlan = meta("p2", createdAt: 2, title: "Elsewhere", threadType: .planning, masterId: "other")
        let foreignBuild = meta("b2", createdAt: 3, title: "Own row", masterId: "m", planThreadId: "p2")
        let rows = MasterBoard.foldRows(children: [build, foreignBuild], all: [archived, build, foreignPlan, foreignBuild], masterId: "m")
        #expect(rows.map(\.key) == ["plan", "b2"])
        #expect(rows[0].title == "Old plan")
        #expect(rows[1].title == "Own row")
        #expect(rows[1].plan == nil)
    }

    @Test("a far child appends as its own row keyed by host and id") func remoteRows() {
        let local = meta("a", createdAt: 10, masterId: "m")
        let far = MasterBoard.RemoteChild(child: child("f1", seenAt: 5), meta: nil)
        let rows = MasterBoard.foldRows(children: [local], all: [local], masterId: "m", remote: [far])
        #expect(rows.map(\.key) == ["env_mac:f1", "a"])
        #expect(rows[0].environmentId == "env_mac")
        #expect(rows[0].batchKey == "env_mac:f1")
        #expect(rows[0].status == .running)
        #expect(rows[0].threadType == .implementation)
        #expect(rows[1].batchKey == "a")
    }

    @Test("remote children drop this host's entries and take the paired host's meta") func remoteChildren() {
        var state = BatchState.empty(masterId: "m")
        state = BatchState(masterId: "m", rules: state.rules, steps: state.steps, landed: [], pending: [], held: [], blocked: nil, finishedAt: nil, children: [child("l1", environmentId: "env_box"), child("f1"), child("f2")])
        let paired = meta("f1", status: .waiting, title: "Paired title")
        let remote = MasterBoard.remoteChildren(state, localHost: "env_box") { env, id in env == "env_mac" && id == "f1" ? paired : nil }
        #expect(remote.map(\.child.sessionId) == ["f1", "f2"])
        #expect(remote[0].status == .waiting)
        #expect(remote[0].title == "Paired title")
        #expect(remote[1].meta == nil)
        #expect(remote[1].title == "Far thread")
    }
}

@Suite struct MasterBoardGroupTests {
    @Test("every status lands in its group") func groups() {
        #expect(MasterBoard.group(of: .waiting) == .needsYou)
        #expect(MasterBoard.group(of: .error) == .needsYou)
        for status: SessionStatus in [.starting, .running, .watching, .paused] { #expect(MasterBoard.group(of: status) == .running) }
        #expect(MasterBoard.group(of: .queued) == .queued)
        for status: SessionStatus in [.idle, .done, .stopped, .unknown("later")] { #expect(MasterBoard.group(of: status) == .done) }
        #expect(MasterBoard.Group.allCases.map(\.label) == ["Needs you", "Running", "Queued", "Done"])
    }

    @Test("sections keep the group order and drop empty ones; counts count every group") func sectionsAndCounts() {
        let metas = [meta("d", status: .idle, createdAt: 1, masterId: "m"), meta("w", status: .waiting, createdAt: 2, masterId: "m"), meta("r", status: .running, createdAt: 3, masterId: "m")]
        let rows = MasterBoard.foldRows(children: metas, all: metas, masterId: "m")
        #expect(MasterBoard.sections(rows).map(\.id) == [.needsYou, .running, .done])
        let counts = MasterBoard.counts(rows)
        #expect(counts[.needsYou] == 1 && counts[.running] == 1 && counts[.queued] == 0 && counts[.done] == 1)
    }
}

@Suite struct MasterBoardWordsTests {
    @Test("type words and the landed clock") func words() {
        #expect(MasterBoard.typeWord(.implementation) == "Implementation")
        #expect(MasterBoard.typeWord(.planning) == "Plan")
        #expect(MasterBoard.typeWord(.projectPlan) == "Project plan")
        #expect(MasterBoard.typeWord(.orchestration) == "Orchestration")
        #expect(MasterBoard.typeWord(.research) == "Research")
        #expect(MasterBoard.typeWord(.chat) == "Chat")
        #expect(MasterBoard.typeWord(nil) == "")
        #expect(MasterBoard.typeWord(.unknown("debate")) == "")
        // 2026-10-22 07:05:00 UTC
        #expect(MasterBoard.clockTime(1_792_652_700_000, calendar: utc) == "07:05")
    }

    @Test("the what line follows the status") func whatLine() {
        let question = Fleet.Line("has a question — scope?", tone: .warning)
        let blank = Fleet.Line("", tone: .muted)
        #expect(MasterBoard.whatLine(status: .waiting, activity: nil, updatedAt: 0, line: question, landed: false) == MasterBoard.WhatLine(text: "has a question — scope?", tone: .warning))
        #expect(MasterBoard.whatLine(status: .waiting, activity: nil, updatedAt: 0, line: blank, landed: false) == nil)
        #expect(MasterBoard.whatLine(status: .paused, activity: "x", updatedAt: 0, line: blank, landed: false)?.text == "Paused")
        #expect(MasterBoard.whatLine(status: .queued, activity: " Queued · waiting for Live strip ", updatedAt: 0, line: blank, landed: false)?.text == "Queued · waiting for Live strip")
        #expect(MasterBoard.whatLine(status: .running, activity: nil, updatedAt: 0, line: Fleet.Line("Read · Strip.swift", tone: .muted), landed: false)?.text == "Read · Strip.swift")
        #expect(MasterBoard.whatLine(status: .stopped, activity: nil, updatedAt: 0, line: blank, landed: false)?.text == "Stopped")
        #expect(MasterBoard.whatLine(status: .idle, activity: nil, updatedAt: 1_792_652_700_000, line: blank, landed: true, calendar: utc)?.text == "Landed 07:05")
        #expect(MasterBoard.whatLine(status: .idle, activity: nil, updatedAt: 0, line: blank, landed: false) == nil)
    }

    @Test("a far row whose host is away reads out of reach") func remoteLine() {
        let away = MasterBoard.foldRows(children: [], all: [], masterId: "m", remote: [MasterBoard.RemoteChild(child: child("f", linkDown: true), meta: nil)])[0]
        let near = MasterBoard.foldRows(children: [], all: [], masterId: "m", remote: [MasterBoard.RemoteChild(child: child("f"), meta: nil)])[0]
        #expect(MasterBoard.remoteLine(away, hostName: "Mac") == MasterBoard.WhatLine(text: "Out of reach on Mac", tone: .danger))
        #expect(MasterBoard.remoteLine(near, hostName: "Mac") == nil)
    }

    @Test("the body by type: tasks, a summary that never repeats the what line, nothing for chat") func body() {
        let todos = [TodoItem(content: "a", status: .completed)]
        let said = [item(textItem(1, "The comparison is half done."))]
        #expect(MasterBoard.body(.implementation, todos: todos, items: [], what: nil) == .tasks(todos))
        #expect(MasterBoard.body(.implementation, todos: [], items: [], what: nil) == nil)
        #expect(MasterBoard.body(.research, todos: [], items: [], notesState: "- Two stores left\n", what: nil) == .summary("Two stores left"))
        #expect(MasterBoard.body(.research, todos: [], items: [], notesState: "- Two stores left", what: "Two stores left") == nil)
        #expect(MasterBoard.body(.orchestration, todos: [], items: said, what: nil) == .summary("The comparison is half done."))
        #expect(MasterBoard.body(.chat, todos: todos, items: said, what: nil) == nil)
        #expect(MasterBoard.body(.planning, todos: todos, items: said, what: nil) == nil)
    }

    @Test("tasks open while the thread works; the tally reads the fold, then the host") func tally() {
        #expect(MasterBoard.tasksOpenByDefault(.running))
        #expect(MasterBoard.tasksOpenByDefault(.waiting))
        #expect(!MasterBoard.tasksOpenByDefault(.idle))
        let todos = [TodoItem(content: "a", status: .completed), TodoItem(content: "b", status: .inProgress), TodoItem(content: "c", status: .pending)]
        #expect(MasterBoard.tally(todos: todos, tasks: SessionMeta.Tasks(done: 9, total: 9))?.text == "1/3")
        #expect(MasterBoard.tally(todos: [], tasks: SessionMeta.Tasks(done: 2, total: 5))?.text == "2/5")
        #expect(MasterBoard.tally(todos: [], tasks: nil) == nil)
        #expect(MasterBoard.mergedLine(landed: 2, pending: 8) == "2 of 10 landed")
    }

    @Test("the rules read as one sentence") func rulesSentence() {
        let land = spec("land", .land)
        #expect(MasterBoard.rulesSentence(BatchRules(land: .asTheyFinish, steps: [land, spec("gate", .gate), spec("release", .release), spec("deploy", .deploy, name: "Deploy to the box")], then: .notify)) == "Branches land as they finish, then Gate, Release and Deploy to the box. Then you are notified.")
        #expect(MasterBoard.rulesSentence(BatchRules(land: .allAtOnce, steps: [land, spec("gate", .gate)], then: .notify)) == "Branches land together once every thread is done, then Gate. Then you are notified.")
        #expect(MasterBoard.rulesSentence(BatchRules(land: .asTheyFinish, steps: [], then: .archiveChildren)) == "The branches are left unmerged, nothing runs after. Then the threads are archived.")
        #expect(MasterBoard.rulesSentence(BatchRules(land: .asTheyFinish, steps: [land, spec("smoke", .shell, name: "  "), spec("gate", .gate)], then: .notify)) == "Branches land as they finish, then smoke and Gate. Then you are notified.")
    }

    @Test("what blocks the end") func blockedLine() {
        func state(_ blocked: BatchState.Blocked?) -> BatchState {
            let e = BatchState.empty(masterId: "m")
            return BatchState(masterId: "m", rules: e.rules, steps: e.steps, landed: [], pending: [], held: [], blocked: blocked, finishedAt: nil)
        }
        let titles = ["a": "Live strip", "env_mac:f": "Far build"]
        #expect(MasterBoard.blockedLine(state(nil), titleOf: { titles[$0] }, hostName: { _ in nil }) == nil)
        #expect(MasterBoard.blockedLine(state(.init(sessionId: "a", why: .errored)), titleOf: { titles[$0] }, hostName: { _ in nil }) == "Blocked: Live strip errored")
        #expect(MasterBoard.blockedLine(state(.init(sessionId: "zz", why: .stopped)), titleOf: { titles[$0] }, hostName: { _ in nil }) == "Blocked: a thread stopped")
        #expect(MasterBoard.blockedLine(state(.init(sessionId: "a", why: .failed)), titleOf: { titles[$0] }, hostName: { _ in nil }) == "Blocked: Live strip failed")
        #expect(MasterBoard.blockedLine(state(.init(sessionId: "env_mac:f", why: .unreachable, environmentId: "env_mac")), titleOf: { titles[$0] }, hostName: { $0 == "env_mac" ? "Mac" : nil }) == "Blocked: Far build is out of reach on Mac")
    }

    @Test("the empty batch is the default rules with three pending steps") func emptyBatch() {
        let empty = BatchState.empty(masterId: "m")
        #expect(empty.rules.steps.map(\.id) == ["land", "gate", "release"])
        #expect(empty.steps.map(\.status) == [.pending, .pending, .pending])
        #expect(empty.landed.isEmpty && empty.blocked == nil)
    }
}

@Suite struct MasterBoardAgentsTests {
    @Test("a row counts its whole tree by the parentId chain, archived agents left out, their own children kept") func nestedAndArchived() {
        let metas = [
            meta("c", createdAt: 1, masterId: "m"),
            meta("a1", parentId: "c", status: .running),
            meta("a11", parentId: "a1", status: .waiting),
            meta("a111", parentId: "a11", status: .error),
            meta("a2", parentId: "c", status: .idle),
            meta("gone", parentId: "c", status: .running, archived: true),
            meta("kept", parentId: "gone", status: .done),
            meta("x", parentId: "other", status: .running)
        ]
        let index = Dictionary(grouping: metas.filter { $0.parentId != nil }, by: { $0.parentId ?? "" })
        #expect(Set(MasterBoard.subtree(of: "c", index: index).map(\.id)) == ["a1", "a11", "a111", "a2", "kept"])
        let summary = MasterBoard.agentSummary(MasterBoard.subtree(of: "c", index: index))
        #expect(summary == MasterBoard.AgentSummary(total: 5, working: 1, waiting: 1, failed: 1))
        #expect(summary?.text == "5 agents · 1 working · 1 needs approval · 1 failed")
        #expect(summary?.parts.map(\.tone) == [.muted, .muted, .warning, .danger])
    }

    @Test("only the nonzero live states are said; done ones are in the count; none is nil") func words() {
        #expect(MasterBoard.agentSummary([]) == nil)
        #expect(MasterBoard.agentSummary([meta("a", status: .done)])?.text == "1 agent")
        #expect(MasterBoard.agentSummary([meta("a", status: .running), meta("b", status: .watching), meta("c", status: .idle)])?.text == "3 agents · 2 working")
    }

    @Test("a far child counts from its own host's sessions; a row with none is absent") func farHost() {
        let local = meta("c", createdAt: 1, masterId: "m")
        let lonely = meta("d", createdAt: 2, masterId: "m")
        let far = MasterBoard.RemoteChild(child: BatchState.Children(sessionId: "f1", environmentId: "env_box", title: "Far", status: "running", threadType: "implementation", provider: "codex", model: "gpt-6.1-sol", seenAt: 3, linkDown: nil), meta: nil)
        let rows = MasterBoard.foldRows(children: [local, lonely], all: [local, lonely], masterId: "m", remote: [far])
        let here = [local, lonely, meta("a", parentId: "c", status: .running), meta("f1-clash", parentId: "f1", status: .running)]
        let box = [meta("b1", parentId: "f1", status: .waiting), meta("b11", parentId: "b1", status: .running)]
        let summaries = MasterBoard.agentSummaries(rows) { $0 == "env_box" ? box : here }
        #expect(summaries["c"]?.text == "1 agent · 1 working")
        #expect(summaries["d"] == nil)
        #expect(summaries["env_box:f1"]?.text == "2 agents · 1 working · 1 needs approval")
    }
}
