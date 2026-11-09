@testable import Capture
import Testing

@Suite struct FrameGateTests {
    @Test func twoGoOutThenTheNextIsHeld() {
        var gate = FrameGate<String>(slots: 2, starveAfterMs: 5_000)
        #expect(gate.offer("a") == "a")
        #expect(gate.sent(atMs: 0) == 1)
        #expect(gate.offer("b") == "b")
        #expect(gate.sent(atMs: 10) == 2)
        #expect(gate.offer("c") == nil)
        #expect(gate.outstanding == 2)
        #expect(gate.hasHeld)
    }

    @Test func aNewerHoldReplacesTheOlder() {
        var gate = FrameGate<String>(slots: 2, starveAfterMs: 5_000)
        _ = gate.offer("a"); _ = gate.sent(atMs: 0)
        _ = gate.offer("b"); _ = gate.sent(atMs: 0)
        #expect(gate.offer("c") == nil)
        #expect(gate.offer("d") == nil)
        let ack = gate.ack(1, atMs: 50)
        #expect(ack.send == "d")
        #expect(!ack.resume)
        #expect(gate.sent(atMs: 50) == 3)
        #expect(!gate.hasHeld)
    }

    @Test func anAckFreesASlotForTheNextSample() {
        var gate = FrameGate<String>(slots: 2, starveAfterMs: 5_000)
        _ = gate.offer("a"); _ = gate.sent(atMs: 0)
        _ = gate.offer("b"); _ = gate.sent(atMs: 0)
        #expect(gate.ack(2, atMs: 40).send == nil)
        #expect(gate.outstanding == 0, "an ack covers every earlier frame")
        #expect(gate.offer("c") == "c")
    }

    @Test func anUnknownOrRepeatedAckChangesNothing() {
        var gate = FrameGate<String>(slots: 2, starveAfterMs: 5_000)
        _ = gate.offer("a"); _ = gate.sent(atMs: 0)
        _ = gate.offer("b"); _ = gate.sent(atMs: 0)
        _ = gate.offer("c")
        #expect(gate.ack(0, atMs: 10).send == nil)
        #expect(gate.ack(9, atMs: 10).send == nil, "a seq never sent is unknown")
        #expect(gate.outstanding == 2)
        #expect(gate.ack(1, atMs: 10).send == "c")
        _ = gate.sent(atMs: 10)
        let repeated = gate.ack(1, atMs: 20)
        #expect(repeated.send == nil)
        #expect(gate.outstanding == 2)
    }

    @Test func aDroppedFrameFreesItsSlot() {
        var gate = FrameGate<String>(slots: 2, starveAfterMs: 5_000)
        _ = gate.offer("a"); _ = gate.sent(atMs: 0)
        #expect(gate.offer("b") == "b")
        #expect(gate.notSent() == nil)
        #expect(gate.outstanding == 1)
        #expect(gate.offer("c") == "c")
        #expect(gate.sent(atMs: 5) == 2, "a dropped frame takes no seq")
    }

    @Test func oneFrameUnackedForFiveSecondsStarvesTheStreamOnce() {
        var gate = FrameGate<String>(slots: 2, starveAfterMs: 5_000)
        _ = gate.offer("still"); _ = gate.sent(atMs: 1_000)
        for now in stride(from: 1_000.0, to: 6_000, by: 1_000) { #expect(gate.tick(atMs: now) == false) }
        #expect(gate.tick(atMs: 6_000) == true)
        #expect(gate.starved)
        #expect(gate.tick(atMs: 7_000) == false)
    }

    @Test func anAckWhileStarvedResumesAndRestartsTheClock() {
        var gate = FrameGate<String>(slots: 2, starveAfterMs: 5_000)
        _ = gate.offer("a"); _ = gate.sent(atMs: 0)
        _ = gate.offer("b"); _ = gate.sent(atMs: 100)
        _ = gate.offer("held")
        #expect(gate.tick(atMs: 5_000) == true)
        let ack = gate.ack(1, atMs: 9_000)
        #expect(ack.resume)
        #expect(ack.send == "held")
        #expect(!gate.starved)
        _ = gate.sent(atMs: 9_000)
        #expect(gate.tick(atMs: 13_999) == false, "frame 2's clock restarted at the resume")
        #expect(gate.tick(atMs: 14_000) == true)
    }

    @Test func seqsGrowFromOne() {
        var gate = FrameGate<Int>(slots: 2, starveAfterMs: 5_000)
        var seqs: [Int] = []
        for n in 0..<10 {
            if gate.offer(n) != nil { seqs.append(gate.sent(atMs: Double(n))) }
            if let send = gate.ack(seqs.last ?? 0, atMs: Double(n)).send { _ = send; seqs.append(gate.sent(atMs: Double(n))) }
        }
        #expect(seqs == Array(1...seqs.count))
    }
}
