import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func session(_ id: String, status: SessionStatus, parentId: String? = nil, masterId: String? = nil, archived: Bool = false, threadType: ThreadType? = .implementation, isMaster: Bool? = nil) -> SessionMeta {
    SessionMeta(id: id, parentId: parentId, projectId: "p1", workspaceId: nil, threadType: threadType, planPath: nil, provider: .claude, model: "claude-sonnet-5-5", reasoning: .low, agentType: .implementer, title: id, cwd: "/tmp/repo", status: status, pinned: false, archived: archived, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, isMaster: isMaster, masterId: masterId, createdAt: 1, updatedAt: 1)
}

@Suite struct WorkingPhaseTests {
    @Test func `the strip's phase follows the status, with a send of this device's bridging to the turn`() {
        #expect(WorkingPhase(status: .paused, sending: false) == .paused)
        #expect(WorkingPhase(status: .paused, sending: true) == .paused, "paused wins over a send in flight")
        #expect(WorkingPhase(status: .stopped, sending: false) == .stopped)
        #expect(WorkingPhase(status: .stopped, sending: true) == .stopped)
        #expect(WorkingPhase(status: .queued, sending: false) == .queued)
        #expect(WorkingPhase(status: .queued, sending: true) == .queued)
        #expect(WorkingPhase(status: .running, sending: false) == .working)
        #expect(WorkingPhase(status: .running, sending: true) == .working, "the host started the turn: no Sending… over a spinner")
        #expect(WorkingPhase(status: .starting, sending: true) == .sending)
        #expect(WorkingPhase(status: .starting, sending: false) == .working)
    }

    @Test func `idle, waiting, watching, done, error and no session are idle, or Sending… while a send is out`() {
        for status in [SessionStatus.idle, .waiting, .watching, .done, .error, .unknown("later")] {
            #expect(WorkingPhase(status: status, sending: false) == .idle, "\(status)")
            #expect(WorkingPhase(status: status, sending: true) == .sending, "\(status)")
        }
        #expect(WorkingPhase(status: nil, sending: false) == .idle)
        #expect(WorkingPhase(status: nil, sending: true) == .sending)
    }

    @Test func `the paused master's batch line counts its paused roots: unarchived, carrying its id, roots only`() {
        let sessions = [
            session("m", status: .paused, isMaster: true),
            session("a", status: .paused, masterId: "m"),
            session("b", status: .paused, masterId: "m"),
            session("c", status: .running, masterId: "m"),
            session("d", status: .paused, masterId: "m", archived: true),
            session("e", status: .paused, parentId: "a", masterId: "m"),
            session("f", status: .paused, masterId: "other"),
            session("g", status: .paused)
        ]
        #expect(WorkingPhase.batchPaused(of: "m", in: sessions) == 2)
        #expect(WorkingPhase.batchPaused(of: "other", in: sessions) == 1)
        #expect(WorkingPhase.batchPaused(of: "none", in: sessions) == 0)
        #expect(WorkingPhase.batchPaused(of: "m", in: []) == 0)
    }
}

@Suite struct ComposerRulesTests {
    @Test func `running is the host's running or starting, or a send of this device's; watching is not running`() {
        #expect(ComposerRules.running(status: .running, sending: false))
        #expect(ComposerRules.running(status: .starting, sending: false))
        #expect(ComposerRules.running(status: .idle, sending: true))
        #expect(ComposerRules.running(status: .watching, sending: false) == false, "a watching master's button is Send")
        #expect(ComposerRules.running(status: .waiting, sending: false) == false)
        #expect(ComposerRules.running(status: .paused, sending: false) == false)
        #expect(ComposerRules.running(status: .queued, sending: false) == false)
        #expect(ComposerRules.running(status: nil, sending: false) == false)
    }

    @Test func `the button stops only while a turn runs and the box is empty; text always sends`() {
        #expect(ComposerRules.stops(running: true, hasText: false))
        #expect(ComposerRules.stops(running: true, hasText: true) == false, "a master mid-turn with text steers")
        #expect(ComposerRules.stops(running: false, hasText: false) == false)
        #expect(ComposerRules.stops(running: false, hasText: true) == false)
    }

    @Test func `the placeholder: Steer for a root that takes direction or a master, Message the agent for a subagent`() {
        #expect(ComposerRules.placeholder(for: nil) == "Message")
        #expect(ComposerRules.placeholder(for: session("s", status: .idle, threadType: .chat)) == "Message")
        #expect(ComposerRules.placeholder(for: session("s", status: .idle, threadType: .planning)) == "Message")
        #expect(ComposerRules.placeholder(for: session("s", status: .idle, threadType: .implementation)) == "Steer")
        #expect(ComposerRules.placeholder(for: session("s", status: .idle, threadType: .orchestration)) == "Steer")
        #expect(ComposerRules.placeholder(for: session("s", status: .idle, threadType: .chat, isMaster: true)) == "Steer", "a master of any type")
        #expect(ComposerRules.placeholder(for: session("s", status: .idle, parentId: "root", threadType: nil)) == "Message the agent")
        #expect(ComposerRules.placeholder(for: session("s", status: .idle, parentId: "root", threadType: .implementation)) == "Message the agent", "a subagent is never steered")
    }
}
