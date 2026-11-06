import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func session(_ id: String, status: SessionStatus, parentId: String? = nil, masterId: String? = nil, archived: Bool = false, threadType: ThreadType? = .implementation, isMaster: Bool? = nil) -> SessionMeta {
    SessionMeta(id: id, parentId: parentId, projectId: "p1", workspaceId: nil, threadType: threadType, planPath: nil, provider: .claude, model: "claude-sonnet-5-5", reasoning: .low, agentType: .implementer, title: id, cwd: "/tmp/repo", status: status, pinned: false, archived: archived, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, isMaster: isMaster, masterId: masterId, createdAt: 1, updatedAt: 1)
}

@Suite struct ComposerRulesTests {
    @Test func `a photo is content: alone in the box mid-turn it steers, and the button acts once it is on the host`() {
        #expect(ComposerRules.intent(status: .running, sending: false, hasText: false, hasPhotos: true) == .steer)
        #expect(ComposerRules.intent(status: .running, sending: false, hasText: false, hasPhotos: false) == .pause)
        #expect(ComposerRules.intent(status: .idle, sending: false, hasText: false, hasPhotos: true) == .send)
        #expect(ComposerRules.offersQueue(status: .running, sending: false, hasText: false, hasPhotos: true))
        #expect(ComposerRules.enabled(.steer, hasText: false, hasPhotos: true, photosSettled: true, inFlight: false))
        #expect(ComposerRules.enabled(.steer, hasText: false, hasPhotos: true, photosSettled: false, inFlight: false) == false)
        #expect(ComposerRules.enabled(.send, hasText: false, hasPhotos: false, photosSettled: true, inFlight: false) == false)
    }

    @Test func `a turn is open while the host runs, starts or waits, or a send of this device's is out; watching is not`() {
        #expect(ComposerRules.busy(status: .running, sending: false))
        #expect(ComposerRules.busy(status: .starting, sending: false))
        #expect(ComposerRules.busy(status: .waiting, sending: false), "a turn waiting on the person is still mid-turn")
        #expect(ComposerRules.busy(status: .idle, sending: true))
        #expect(ComposerRules.busy(status: .watching, sending: false) == false, "a watching master's button is Send")
        for status: SessionStatus in [.idle, .done, .error, .stopped, .queued, .paused] {
            #expect(ComposerRules.busy(status: status, sending: false) == false, "\(status)")
        }
        #expect(ComposerRules.busy(status: nil, sending: false) == false)
    }

    @Test func `the button is the desktop's SendButton: Send, steer mid-turn with text, Pause mid-turn with the box empty`() {
        #expect(ComposerRules.intent(status: .idle, sending: false, hasText: true) == .send)
        #expect(ComposerRules.intent(status: .idle, sending: false, hasText: false) == .send, "an empty idle box is Send, off")
        #expect(ComposerRules.intent(status: .watching, sending: false, hasText: true) == .send)
        #expect(ComposerRules.intent(status: .done, sending: false, hasText: true) == .send)
        #expect(ComposerRules.intent(status: .running, sending: false, hasText: true) == .steer)
        #expect(ComposerRules.intent(status: .waiting, sending: false, hasText: true) == .steer)
        #expect(ComposerRules.intent(status: .idle, sending: true, hasText: true) == .steer, "a send still out is mid-turn")
        #expect(ComposerRules.intent(status: .running, sending: false, hasText: false) == .pause)
        #expect(ComposerRules.intent(status: .starting, sending: false, hasText: false) == .pause)
        #expect(ComposerRules.intent(status: .paused, sending: false, hasText: true) == .queue, "a paused thread's text goes on Continue")
        #expect(ComposerRules.intent(status: .paused, sending: false, hasText: false) == .queue)
    }

    @Test func `a long press mid-turn with text queues for the next turn, and only there`() {
        #expect(ComposerRules.offersQueue(status: .running, sending: false, hasText: true))
        #expect(ComposerRules.intent(status: .running, sending: false, hasText: true, holding: true) == .queue, "the queue glyph until release")
        #expect(ComposerRules.offersQueue(status: .running, sending: false, hasText: false) == false, "an empty box pauses")
        #expect(ComposerRules.offersQueue(status: .idle, sending: false, hasText: true) == false, "no turn to queue behind")
        #expect(ComposerRules.offersQueue(status: .paused, sending: false, hasText: true) == false, "a paused tap already queues")
        #expect(ComposerRules.intent(status: .running, sending: false, hasText: false, holding: true) == .pause, "a hold never turns Pause into a queue")
        #expect(ComposerRules.intent(status: .idle, sending: false, hasText: true, holding: true) == .send)
        #expect(ComposerRules.queueHold == 0.5)
    }

    @Test func `Pause acts on an empty box; the rest wait for text and the photos; nothing acts twice`() {
        #expect(ComposerRules.enabled(.pause, hasText: false, photosSettled: false, inFlight: false))
        #expect(ComposerRules.enabled(.pause, hasText: false, photosSettled: true, inFlight: true) == false)
        for intent: ComposerIntent in [.send, .steer, .queue] {
            #expect(ComposerRules.enabled(intent, hasText: true, photosSettled: true, inFlight: false), "\(intent)")
            #expect(ComposerRules.enabled(intent, hasText: false, photosSettled: true, inFlight: false) == false, "\(intent)")
            #expect(ComposerRules.enabled(intent, hasText: true, photosSettled: false, inFlight: false) == false, "\(intent): a photo still going up")
            #expect(ComposerRules.enabled(intent, hasText: true, photosSettled: true, inFlight: true) == false, "\(intent)")
        }
    }

    @Test func `each intent names itself`() {
        #expect(ComposerIntent.send.label == "Send")
        #expect(ComposerIntent.steer.label == "Steer")
        #expect(ComposerIntent.queue.label == "Queue for the next turn")
        #expect(ComposerIntent.pause.label == "Pause")
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

@Suite struct ComposerSlotTests {
    @Test func `a slot that takes room has its own solid band; with none the composer floats on the fade`() {
        #expect(ComposerSlot.backing(occupies: true) == .solid)
        #expect(ComposerSlot.backing(occupies: false) == .fade)
        // A locked relayed host's line takes room at compact width even with nothing else in the slot.
        let occupies = ComposerSlot.occupies(.empty, regularWidth: false, relayLine: true)
        #expect(ComposerSlot.backing(occupies: occupies) == .solid)
        #expect(ComposerSlot.backing(occupies: ComposerSlot.occupies(.empty, regularWidth: false)) == .fade)
    }

    @Test func `the slot is the desktop's composerSlotOf: the timer while a turn works or waits, the held rows, nothing else`() {
        #expect(ComposerSlot(status: .running, sending: false) == .timer)
        #expect(ComposerSlot(status: .starting, sending: false) == .timer)
        #expect(ComposerSlot(status: .waiting, sending: false) == .timer, "a turn waiting on the person keeps its clock")
        #expect(ComposerSlot(status: .paused, sending: false) == .paused)
        #expect(ComposerSlot(status: .paused, sending: true) == .paused, "paused wins over a send in flight")
        #expect(ComposerSlot(status: .stopped, sending: true) == .stopped)
        #expect(ComposerSlot(status: .queued, sending: true) == .queued)
        for status: SessionStatus in [.idle, .done, .error, .watching] {
            #expect(ComposerSlot(status: status, sending: false) == .empty, "\(status): nothing for watching, failed, idle or done")
            #expect(ComposerSlot(status: status, sending: true) == .timer, "\(status): the click opens the timer")
        }
        #expect(ComposerSlot(status: nil, sending: false) == .empty)
        #expect(ComposerSlot.timer.hasContent && !ComposerSlot.empty.hasContent)
        #expect(ComposerSlot.paused.isHeld && ComposerSlot.stopped.isHeld && ComposerSlot.queued.isHeld && !ComposerSlot.timer.isHeld)
    }

    @Test func `the clock counts from the click and never steps back to the host's later stamp`() {
        // Clicked at 10 000; the host stamped busySince 10 250 after the round trip.
        #expect(ComposerSlot.turnStart(sentAt: 10_000, busySince: 10_250) == 10_000)
        #expect(ComposerSlot.turnStart(sentAt: nil, busySince: 10_250) == 10_250, "a turn another device started")
        #expect(ComposerSlot.turnStart(sentAt: 10_000, busySince: 10_250, sentTurn: 10_250) == 10_000, "the turn the click opened keeps the click")
        #expect(ComposerSlot.turnStart(sentAt: 10_000, busySince: 90_000, sentTurn: 10_250) == 90_000, "a later turn never times from an old click")
        #expect(ComposerSlot.elapsedMs(.timer, sentAt: 10_000, busySince: 10_250, frozen: nil, now: 13_000) == 3_000)
        #expect(ComposerSlot.elapsedMs(.timer, sentAt: 10_000, busySince: 10_250, frozen: nil, now: 10_900) == nil, "under a second shows no time")
        #expect(ComposerSlot.elapsedMs(.timer, sentAt: nil, busySince: nil, frozen: nil, now: 13_000) == nil)
        #expect(ComposerSlot.elapsedMs(.timer, sentAt: 20_000, busySince: nil, frozen: nil, now: 13_000) == nil, "a clock ahead of the device reads zero")
        #expect(ComposerSlot.elapsedMs(.paused, sentAt: 10_000, busySince: 10_250, frozen: 42_000, now: 99_000) == 42_000, "a pause freezes the span")
        #expect(ComposerSlot.elapsedMs(.stopped, sentAt: nil, busySince: nil, frozen: 0, now: 99_000) == nil)
        #expect(ComposerSlot.elapsedMs(.queued, sentAt: nil, busySince: 5, frozen: 7, now: 99_000) == nil)
        #expect(ComposerSlot.elapsedMs(.empty, sentAt: 1, busySince: 5, frozen: 7, now: 99_000) == nil)
    }

    @Test func `at regular width the slot keeps its 28 pt; at compact width it takes room only with something to show`() {
        #expect(ComposerSlot.occupies(.empty, regularWidth: true))
        #expect(ComposerSlot.occupies(.timer, regularWidth: true))
        #expect(ComposerSlot.occupies(.empty, regularWidth: false) == false)
        #expect(ComposerSlot.occupies(.timer, regularWidth: false))
        #expect(ComposerSlot.occupies(.queued, regularWidth: false))
        #expect(ComposerSlot.occupies(.empty, regularWidth: false, relayLine: true), "a locked relayed host's line")
        #expect(TranscriptLengths.slot == 28)
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
        #expect(ComposerSlot.batchPaused(of: "m", in: sessions) == 2)
        #expect(ComposerSlot.batchPaused(of: "other", in: sessions) == 1)
        #expect(ComposerSlot.batchPaused(of: "none", in: sessions) == 0)
        #expect(ComposerSlot.batchPaused(of: "m", in: []) == 0)
    }
}

@Suite struct ComposerHeightTests {
    @Test func `the empty box is 46 pt: 8 pt and a 1 pt ring around the 28 pt line, the field 3 pt inside it`() {
        #expect(ComposerHeight.height(lines: 1) == 46)
        #expect(ComposerHeight.height(lines: 1) == TranscriptLengths.composerBox)
        #expect(ComposerHeight.fieldPad * 2 + ComposerHeight.line == ComposerHeight.control, "the field's first line centres on the controls' line")
        #expect(ComposerHeight.radius == 12)
        #expect(ComposerHeight.side == 6 && ComposerHeight.edge == 8)
    }

    @Test func `each further line grows the box by 22 pt up to 160, then the field scrolls`() {
        #expect(ComposerHeight.height(lines: 2) == 68)
        #expect(ComposerHeight.height(lines: 3) == 90)
        #expect(ComposerHeight.height(lines: 6) == 156)
        #expect(ComposerHeight.maxLines == 6)
        #expect(ComposerHeight.height(lines: 7) == 160)
        #expect(ComposerHeight.height(lines: 40) == 160)
        #expect(ComposerHeight.scrolls(lines: 6) == false)
        #expect(ComposerHeight.scrolls(lines: 7))
        #expect(ComposerHeight.height(lines: 0) == 46 - 22, "no lines is no box; the field always holds one")
    }

    @Test func `a keystroke snaps the height, a paste of more than one line eases it`() {
        #expect(ComposerHeight.eases(from: "hello", to: "hello!") == false)
        #expect(ComposerHeight.eases(from: "hello", to: "hello\n") == false, "Return is a keystroke")
        #expect(ComposerHeight.eases(from: "hello", to: "hello world") == false, "a one-line paste")
        #expect(ComposerHeight.eases(from: "", to: "one\ntwo"), "a two-line paste")
        #expect(ComposerHeight.eases(from: "a", to: "a\nb\nc"))
        #expect(ComposerHeight.eases(from: "one\ntwo", to: "") == false, "the clear after a send snaps")
        #expect(ComposerHeight.eases(from: "one\ntwo", to: "one") == false)
    }
}
