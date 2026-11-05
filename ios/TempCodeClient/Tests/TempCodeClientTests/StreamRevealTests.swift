import Foundation
import Testing
@testable import TempCodeClient

/// The phrase fade's ledger (streamReveal.ts on the phone) and the drain
/// the closing line waits on (revealDrain.ts).
@Suite struct StreamRevealTests {
    @Test func `nothing fades before arming; after it each new step fades in linearly`() {
        var reveal = StreamReveal()
        #expect(reveal.observe("Hello", now: 0).map(\.opacity) == [1])
        reveal.arm()
        let first = reveal.observe("Hello world", now: 1)
        #expect(first.map(\.text) == ["Hello", " world"])
        #expect(first.last?.opacity == 0)
        let later = reveal.observe("Hello world", now: 1 + MotionValues.revealFade / 2)
        #expect(abs((later.last?.opacity ?? 0) - 0.5) < 1e-9)
    }

    @Test func `a step past its fade merges into the settled prefix`() {
        var reveal = StreamReveal()
        reveal.arm()
        _ = reveal.observe("one", now: 0)
        let settled = reveal.observe("one two", now: 1)
        #expect(settled.first?.text == "one")
        let done = reveal.observe("one two", now: 1 + MotionValues.revealFade)
        #expect(done.map(\.text) == ["one two"])
    }

    @Test func `only young steps get segments, at most four`() {
        var reveal = StreamReveal()
        reveal.arm()
        var text = "w"
        for i in 0..<8 {
            text += " w\(i)"
            _ = reveal.observe(text, now: Double(i) * 0.05)
        }
        let segments = reveal.observe(text, now: 0.36)
        #expect(segments.count == 1 + StreamReveal.maxYoung)
        #expect(segments.map(\.text).joined() == text)
    }

    @Test func `a block reparsed into another shape fades in whole`() {
        var reveal = StreamReveal()
        reveal.arm()
        _ = reveal.observe("Some text", now: 0)
        let table = reveal.observe("| a | b |", now: 1)
        #expect(table.count == 1)
        #expect(table[0].opacity == 0)
    }

    @Test func `reduced motion builds no segments`() {
        var reveal = StreamReveal()
        reveal.arm()
        #expect(reveal.observe("Hello world", now: 1, reduced: true) == [StreamReveal.Segment(text: "Hello world", opacity: 1, at: -.infinity)])
    }

    @Test func `the row keeps fading until its last step's fade is done`() {
        var reveal = StreamReveal()
        reveal.arm()
        _ = reveal.observe("a b", now: 2)
        #expect(reveal.fading(now: 2.1))
        #expect(!reveal.fading(now: 2 + MotionValues.revealFade))
    }
}

@Suite struct RevealDrainTests {
    @Test func `a turn reveals while any of its rows does`() {
        var drain = RevealDrain()
        drain.report(turn: "t1", row: "a", on: true)
        drain.report(turn: "t1", row: "b", on: true)
        #expect(drain.isRevealing("t1"))
        drain.report(turn: "t1", row: "a", on: false)
        #expect(drain.isRevealing("t1"))
        drain.report(turn: "t1", row: "b", on: false)
        #expect(!drain.isRevealing("t1"))
        #expect(!drain.isRevealing("t2"))
    }
}
