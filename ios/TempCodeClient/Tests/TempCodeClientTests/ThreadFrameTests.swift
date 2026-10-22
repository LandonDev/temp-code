import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A thread whose fold holds `rows`, for the phase and dot rules.
private func thread(_ events: [AgentEvent]) -> ThreadState {
    var state = ThreadState()
    state.fold = ThreadFold.fold(rows(events))
    return state
}

private let pendingApproval: [AgentEvent] = [
    user("go"),
    .approvalRequest(ApprovalRequestEvent(requestId: "p1", toolName: "Bash", title: "rm -rf build"))
]

@Suite struct ThreadKindTests {
    @Test("nil is a chat; a child is a subagent whatever its type; a master root is a master") func nilIsAChatAChildIsASubagentWhateverItsTypeAMasterRootIsAMaster() {
        #expect(ThreadKind(nil) == .chat)
        #expect(ThreadKind(meta("c", parentId: "p", threadType: .implementation)) == .subagent)
        #expect(ThreadKind(meta("m", threadType: .implementation, isMaster: true)) == .master)
        #expect(ThreadKind(meta("c", parentId: "p", isMaster: true)) == .subagent)
    }

    @Test("each type is its kind", arguments: [
        (ThreadType.chat, ThreadKind.chat), (.planning, .planning), (.projectPlan, .projectPlan),
        (.implementation, .implementation), (.orchestration, .orchestration), (.research, .research),
        (.unknown("debate"), .other("debate"))
    ])
    func eachTypeIsItsKind(type: ThreadType, kind: ThreadKind) {
        #expect(ThreadKind(meta("t", threadType: type)) == kind)
    }

    @Test("a root with no type is a chat") func aRootWithNoTypeIsAChat() {
        #expect(ThreadKind(meta("t")) == .chat)
    }
}

@Suite struct ThreadSegmentTests {
    @Test("every kind lists its segments with the hero first") func everyKindListsItsSegmentsWithTheHeroFirst() {
        #expect(ThreadSegment.segments(for: .implementation) == [.board, .chat])
        #expect(ThreadSegment.segments(for: .planning) == [.plan, .chat])
        #expect(ThreadSegment.segments(for: .projectPlan) == [.plan, .chat])
        #expect(ThreadSegment.segments(for: .orchestration) == [.fleet, .log])
        #expect(ThreadSegment.segments(for: .research) == [.sources, .chat])
        #expect(ThreadSegment.segments(for: .master) == [.board, .chat])
        #expect(ThreadSegment.segments(for: .chat) == [.chat])
        #expect(ThreadSegment.segments(for: .subagent) == [.chat])
        #expect(ThreadSegment.segments(for: .other("debate")) == [.chat])
    }

    @Test("titles and ids") func titlesAndIds() {
        #expect(ThreadSegment.allCases.map(\.title) == ["Board", "Chat", "Plan", "Fleet", "Log", "Sources"])
        #expect(ThreadSegment.sources.id == "sources")
    }
}

@Suite struct ThreadPhaseTests {
    private func phase(_ type: ThreadType?, status: SessionStatus = .idle, events: [AgentEvent] = [], document: String? = nil) -> ThreadPhase {
        ThreadPhase(session: meta("t", status: status, threadType: type), thread: thread(events), document: document)
    }

    @Test("implementation is the board once it has one") func implementationIsTheBoardOnceItHasOne() {
        let segments: [ThreadSegment] = [.board, .chat]
        #expect(phase(.implementation).defaultSegment(in: segments) == .chat)
        let withTodos = phase(.implementation, events: [user("go"), todoWrite("t1", [("Write it", "in_progress")])])
        #expect(withTodos.hasBoard)
        #expect(withTodos.defaultSegment(in: segments) == .board)
    }

    @Test("planning is the plan once the file has content; a project plan the same") func planningIsThePlanOnceTheFileHasContentAProjectPlanTheSame() {
        let segments: [ThreadSegment] = [.plan, .chat]
        #expect(phase(.planning).defaultSegment(in: segments) == .chat)
        #expect(phase(.planning, document: "  \n").defaultSegment(in: segments) == .chat)
        #expect(phase(.planning, document: "# Plan").defaultSegment(in: segments) == .plan)
        #expect(phase(.projectPlan, document: "# Project").defaultSegment(in: segments) == .plan)
    }

    @Test("orchestration is the fleet once agents exist") func orchestrationIsTheFleetOnceAgentsExist() {
        let segments: [ThreadSegment] = [.fleet, .log]
        #expect(phase(.orchestration).defaultSegment(in: segments) == .log)
        let spawned = phase(.orchestration, events: [user("go"), .agentSpawned(AgentSpawnedEvent(childSessionId: "c1"))])
        #expect(spawned.hasAgents)
        #expect(spawned.defaultSegment(in: segments) == .fleet)
    }

    @Test("research is the sources once anything landed: a source, an angle or report text") func researchIsTheSourcesOnceAnythingLanded() {
        let segments: [ThreadSegment] = [.sources, .chat]
        let bare = phase(.research)
        #expect(!bare.hasSources)
        #expect(bare.defaultSegment(in: segments) == .chat)
        #expect(phase(.research, document: "# Report\n\nIn progress.").defaultSegment(in: segments) == .sources)
        #expect(phase(.research, events: [user("go"), .agentSpawned(AgentSpawnedEvent(childSessionId: "a1"))]).hasSources)
        #expect(phase(.research, events: [user("go"), .researchSource(ResearchSourceEvent(callId: "r1", query: "bun sqlite", agentId: "a1", agentLabel: "Explorer 1"))]).defaultSegment(in: segments) == .sources)
        let complete = phase(.research, document: "---\nstatus: complete\n---\n# Report")
        #expect(complete.reportComplete)
        #expect(complete.defaultSegment(in: segments) == .sources)
    }

    @Test("a chat and a master take the first segment; running reads running and starting") func aChatAndAMasterTakeTheFirstSegmentRunningReadsRunningAndStarting() {
        #expect(phase(.chat).defaultSegment(in: [.chat]) == .chat)
        #expect(ThreadPhase(session: meta("m", threadType: .chat, isMaster: true), thread: ThreadState(), document: nil).defaultSegment(in: [.chat]) == .chat)
        // A master opens on its board, whatever its type, from the first open.
        #expect(ThreadPhase(session: meta("m", threadType: .chat, isMaster: true), thread: ThreadState(), document: nil).defaultSegment(in: [.board, .chat]) == .board)
        #expect(phase(.chat, status: .running).running)
        #expect(phase(.chat, status: .starting).running)
        #expect(!phase(.chat, status: .watching).running)
    }

    @Test("a waiting planning thread with a question forces the chat") func aWaitingPlanningThreadWithAQuestionForcesTheChat() {
        let waiting = phase(.planning, status: .waiting, events: pendingApproval)
        #expect(waiting.undecidedSeq == 2)
        #expect(waiting.questionForcesChat)
        #expect(!phase(.planning, status: .waiting).questionForcesChat)
        #expect(!phase(.implementation, status: .waiting, events: pendingApproval).questionForcesChat)
    }
}

@Suite struct SegmentRulesTests {
    private func phase(_ type: ThreadType, status: SessionStatus = .idle, events: [AgentEvent] = [], document: String? = nil) -> ThreadPhase {
        ThreadPhase(session: meta("t", status: status, threadType: type), thread: thread(events), document: document)
    }

    @Test("the forced chat wins over a remembered plan; a choice the kind lacks falls to the default") func theForcedChatWinsOverARememberedPlanAChoiceTheKindLacksFallsToTheDefault() {
        let forced = phase(.planning, status: .waiting, events: pendingApproval, document: "# Plan")
        #expect(SegmentRules.segment(chosen: .plan, in: [.plan, .chat], phase: forced) == .chat)
        let plan = phase(.planning, document: "# Plan")
        #expect(SegmentRules.segment(chosen: .chat, in: [.plan, .chat], phase: plan) == .chat)
        #expect(SegmentRules.segment(chosen: .board, in: [.plan, .chat], phase: plan) == .plan)
        #expect(SegmentRules.segment(chosen: nil, in: [.plan, .chat], phase: plan) == .plan)
    }

    @Test("the dot marks an unseen undecided card on the inactive transcript") func theDotMarksAnUnseenUndecidedCardOnTheInactiveTranscript() {
        let segments: [ThreadSegment] = [.plan, .chat]
        let waiting = phase(.research, status: .waiting, events: pendingApproval)
        #expect(SegmentRules.dot(in: segments, phase: waiting, shown: .plan, seen: [:]) == .chat)
        #expect(SegmentRules.dot(in: segments, phase: waiting, shown: .plan, seen: [.chat: 1]) == .chat)
        #expect(SegmentRules.dot(in: segments, phase: waiting, shown: .plan, seen: [.chat: 2]) == nil)
        #expect(SegmentRules.dot(in: segments, phase: waiting, shown: .chat, seen: [:]) == nil)
        #expect(SegmentRules.dot(in: [.board, .chat], phase: waiting, shown: .board, seen: [:]) == nil)
        #expect(SegmentRules.dot(in: [.fleet, .log], phase: waiting, shown: .fleet, seen: [:]) == .log)
        #expect(SegmentRules.dot(in: segments, phase: phase(.research), shown: .plan, seen: [:]) == nil)
    }

    @Test("weight follows the pill and clamps at the ends") func weightFollowsThePillAndClampsAtTheEnds() {
        #expect(SegmentRules.weight(of: 0, progress: 0, count: 2) == 1)
        #expect(SegmentRules.weight(of: 1, progress: 0, count: 2) == 0)
        #expect(SegmentRules.weight(of: 0, progress: 0.5, count: 2) == 0.5)
        #expect(SegmentRules.weight(of: 1, progress: 0.5, count: 2) == 0.5)
        #expect(SegmentRules.weight(of: 1, progress: 1, count: 2) == 1)
        #expect(SegmentRules.weight(of: 0, progress: -0.2, count: 2) == 1)
        #expect(SegmentRules.weight(of: 1, progress: 1.4, count: 2) == 1)
        #expect(SegmentRules.weight(of: 0, progress: 1.4, count: 2) == 0)
        #expect(SegmentRules.weight(of: 1, progress: 1.25, count: 3) == 0.75)
        #expect(SegmentRules.weight(of: 2, progress: 1.25, count: 3) == 0.25)
        #expect(SegmentRules.weight(of: 0, progress: 1.25, count: 3) == 0)
    }

    @Test("the pill rect is a count-th of the inset width at the clamped offset") func thePillRectIsACountThOfTheInsetWidthAtTheClampedOffset() {
        let size = CGSize(width: 204, height: 32)
        let at0 = SegmentRules.pillRect(progress: 0, count: 2, size: size, inset: 2)
        #expect(at0 == CGRect(x: 2, y: 2, width: 100, height: 28))
        #expect(SegmentRules.pillRect(progress: 0.5, count: 2, size: size, inset: 2).minX == 52)
        #expect(SegmentRules.pillRect(progress: 1, count: 2, size: size, inset: 2).minX == 102)
        #expect(SegmentRules.pillRect(progress: -0.2, count: 2, size: size, inset: 2).minX == 2)
        #expect(SegmentRules.pillRect(progress: 1.4, count: 2, size: size, inset: 2).minX == 102)
        let three = SegmentRules.pillRect(progress: 1.25, count: 3, size: CGSize(width: 304, height: 32), inset: 2)
        #expect(three.width == 100)
        #expect(three.minX == 127)
    }

    @Test("the agents button shows with children and no fleet segment") func theAgentsButtonShowsWithChildrenAndNoFleetSegment() {
        #expect(!SegmentRules.showsAgents(children: 0, segments: [.chat]))
        #expect(!SegmentRules.showsAgents(children: 3, segments: [.fleet, .log]))
        #expect(SegmentRules.showsAgents(children: 1, segments: [.chat]))
        #expect(SegmentRules.showsAgents(children: 2, segments: [.board, .chat]))
    }
}

@Suite struct ThreadHeaderLineTests {
    private typealias Line = ThreadHeaderLine
    /// Type and model, then the account part a routed (Claude) thread always carries.
    private let identity: [Line.Part] = [.type(.implementation), .model("claude-sonnet-5-5")]
    private let type: [Line.Part] = [.type(.implementation), .model("claude-sonnet-5-5"), .account(nil)]

    private func line(_ status: SessionStatus, host: String? = nil, parentId: String? = nil, isMaster: Bool? = nil, activity: String? = nil, busySince: Int? = 500, frozen: Int? = nil, live: Bool? = nil) -> Line {
        Line(session: meta("t", parentId: parentId, status: status, updatedAt: 900, frozenActiveElapsed: frozen, activity: activity, agentType: .reviewer, threadType: .implementation, isMaster: isMaster, busySince: busySince, treeHasLiveWork: live), hostName: host)
    }

    @Test("the mark and the parts by status", arguments: [SessionStatus.starting, .idle, .running, .waiting, .watching, .paused, .stopped, .queued, .error, .done, .unknown("odd")])
    func theMarkAndThePartsByStatus(status: SessionStatus) {
        let line = self.line(status, frozen: 4_000)
        switch status {
        case .running, .starting:
            #expect(line.mark == .spinner)
            #expect(line.parts == type + [.elapsed(since: 500)])
            #expect(line.live)
        case .watching:
            #expect(line.mark == .dot(.info))
            #expect(line.parts == type + [.elapsed(since: 500)])
            #expect(line.live)
        case .waiting:
            #expect(line.mark == .dot(.warning))
            #expect(line.parts == type)
            #expect(!line.live)
        case .error:
            #expect(line.mark == .dot(.destructive))
            #expect(line.parts == type)
        case .paused:
            #expect(line.mark == .paused)
            #expect(line.parts == type + [.frozen(ms: 4_000)])
            #expect(!line.live)
        case .queued:
            #expect(line.mark == .dot(.tertiary))
            #expect(line.parts == [.words("Queued")])
        case .stopped:
            #expect(line.mark == .stopped)
            #expect(line.parts == [.words("Stopped", detail: "The harness is gone")])
        case .idle, .done, .unknown:
            #expect(line.mark == .empty)
            #expect(line.parts == type)
            #expect(!line.live)
        }
    }

    @Test("the host leads only when given, and withoutHost drops it") func theHostLeadsOnlyWhenGivenAndWithouthostDropsIt() {
        let with = line(.running, host: "box")
        #expect(with.parts == [.host("box")] + type + [.elapsed(since: 500)])
        #expect(with.withoutHost == type + [.elapsed(since: 500)])
        #expect(line(.running).parts.first == .type(.implementation))
        #expect(with.compact == identity)
    }

    @Test("compact is the words alone for queued and stopped") func compactIsTheWordsAloneForQueuedAndStopped() {
        #expect(line(.queued, host: "box", activity: "Queued · waiting for Add the billing export").compact == [.words("Queued")])
        #expect(line(.stopped, host: "box").compact == [.words("Stopped")])
    }

    @Test("queued takes the host's reason as its detail when the activity starts with Queued") func queuedTakesTheHostSActivityLineWhenItStartsWithQueued() {
        #expect(line(.queued, activity: "Queued · waiting for Add the billing export (paused)").parts == [.words("Queued", detail: "Waiting for Add the billing export (paused)")])
        #expect(line(.queued, activity: "Reading files").parts == [.words("Queued")])
        #expect(line(.queued, host: "box", activity: "Queued · waiting for X").parts == [.host("box"), .words("Queued", detail: "Waiting for X")])
    }

    @Test("a subagent names its role; a master says so before its type") func aSubagentNamesItsRoleAMasterSaysSoBeforeItsType() {
        #expect(line(.idle, parentId: "p").parts == [.agent(.reviewer), .model("claude-sonnet-5-5"), .account(nil)])
        #expect(line(.idle, parentId: "p", isMaster: true).parts.first == .agent(.reviewer))
        #expect(line(.idle, isMaster: true).parts == [.master] + type)
        #expect(line(.idle, host: "box", isMaster: true).parts == [.host("box"), .master] + type)
    }

    @Test("paused shows the frozen elapsed only when the host has one") func pausedShowsTheFrozenElapsedOnlyWhenTheHostHasOne() {
        #expect(line(.paused, frozen: 61_000).parts == type + [.frozen(ms: 61_000)])
        #expect(line(.paused).parts == type)
    }

    @Test("the elapsed starts at busySince, else at the last update") func theElapsedStartsAtBusysinceElseAtTheLastUpdate() {
        #expect(line(.running, busySince: nil).parts.last == .elapsed(since: 900))
    }

    @Test("an idle root whose subagents still work shows the spinner with no elapsed") func anIdleRootWhoseSubagentsStillWorkShowsTheSpinnerWithNoElapsed() {
        let tree = line(.idle, live: true)
        #expect(tree.mark == .spinner)
        #expect(tree.parts == type)
        #expect(!tree.live)
        #expect(line(.done, live: false).mark == .empty)
    }

    @Test("a root with no type reads as a chat") func aRootWithNoTypeReadsAsAChat() {
        let chat = Line(session: meta("t", status: .idle), hostName: nil)
        #expect(chat.parts == [.type(.chat), .model("claude-sonnet-5-5"), .account(nil)])
    }

    @Test("the account part follows the model for a routed provider and names the thread's account") func theAccountPartFollowsTheModel() {
        let routed = Line(session: meta("t", status: .idle, account: "work@example.com"), hostName: nil)
        #expect(routed.parts == [.type(.chat), .model("claude-sonnet-5-5"), .account("work@example.com")])
        #expect(routed.compact == [.type(.chat), .model("claude-sonnet-5-5")])
        let cursor = Line(session: meta("t", status: .idle, provider: .cursor), hostName: nil)
        #expect(cursor.parts == [.type(.chat), .model("claude-sonnet-5-5")])
    }
}
