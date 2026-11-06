import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// What the transcript and the dock do at rest and per push: the fade's
/// timeline ends with its youngest run, and the dock reads three fields.
@Suite struct WorkAtRestTests {
    @Test func `the fade ends with its youngest run, and nothing ticks past it`() {
        let runs = [RevealSegment(from: 0, to: 4, bornAt: nil), RevealSegment(from: 4, to: 8, bornAt: 10), RevealSegment(from: 8, to: 9, bornAt: 10.2)]
        #expect(RevealSegment.fadeEnd(runs) == 10.2 + StreamRevealLedger.fade)
        #expect(RevealSegment.fadeEnd([RevealSegment(from: 0, to: 4, bornAt: nil)]) == nil)
        let end = 10.2 + StreamRevealLedger.fade
        let ticks = RevealSegment.fadeTicks(from: 10.2, until: end, every: StreamRevealLedger.fade / 12)
        #expect(ticks.first == 10.2)
        #expect(ticks.last == end)
        #expect(ticks.count == 13)
        // Past its end, or with nothing young: no redraw at all.
        #expect(RevealSegment.fadeTicks(from: end + 1, until: end, every: 0.1).isEmpty)
        #expect(RevealSegment.fadeTicks(from: 0, until: 0, every: 0.1).isEmpty)
    }

    @Test func `the dock reads the send, the click and the compaction, and a streamed word changes none`() {
        var thread = ThreadState()
        let before = DockState(thread)
        thread.append([EventRow(sessionId: "s", seq: 1, ts: 1_000, event: .assistantText(AssistantTextEvent(text: "word ", delta: true, msgId: "m", blockIndex: 0)))], trim: false)
        #expect(DockState(thread) == before)
        thread.sending = true
        thread.sentAt = 5
        #expect(DockState(thread) == DockState(sending: true, sentAt: 5, compacting: false))
    }
}
