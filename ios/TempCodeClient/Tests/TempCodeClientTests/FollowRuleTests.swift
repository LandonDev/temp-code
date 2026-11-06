import Testing
@testable import TempCodeClient

@Suite struct FollowRuleMovingTests {
    @Test func `the top sentinel loads a page only for a reader who went up to it, or content too short to fill the screen`() {
        // The reader scrolled up, or a finger is on the list: the page joins above.
        #expect(SentinelReach.of(atBottom: false, readerMoving: false, contentFills: true) == .page)
        #expect(SentinelReach.of(atBottom: true, readerMoving: true, contentFills: true) == .page)
        // At the bottom, still, the list threw its offset: pin, no page above the reader.
        #expect(SentinelReach.of(atBottom: true, readerMoving: false, contentFills: true) == .pin)
        // A short thread shows the sentinel at rest: its page loads, the reader stays at the bottom.
        #expect(SentinelReach.of(atBottom: true, readerMoving: false, contentFills: false) == .pageAtBottom)
    }

    @Test func `rows changing never pin under the reader's own scroll`() {
        #expect(FollowRule.write(for: .rowsChanged, atBottom: true) == .pin)
        #expect(FollowRule.write(for: .rowsChanged, atBottom: true, readerMoving: true) == .none)
        #expect(FollowRule.write(for: .rowsChanged, atBottom: false, readerMoving: false) == .none)
    }

    @MainActor @Test func `pins asked in one turn coalesce into one, asking the rule again when it runs`() {
        let pins = PinQueue()
        #expect(pins.ask())
        #expect(!pins.ask())
        #expect(!pins.ask())
        var writes = 0
        pins.run({ true }) { writes += 1 }
        #expect(writes == 1 && pins.ran == 1 && !pins.queued)
        // The reader put a finger down before the turn came: nothing is written.
        #expect(pins.ask())
        pins.run({ false }) { writes += 1 }
        #expect(writes == 1)
        #expect(pins.ask())
    }
}

@Suite struct FollowRuleHandGlideTests {
    @Test func `a hand's resize follows at the bottom on its spring and leaves a reader up alone`() {
        #expect(FollowRule.write(for: .handResize, atBottom: true) == .glide)
        #expect(FollowRule.write(for: .handResize, atBottom: false) == .none)
        #expect(FollowRule.write(for: .handResize, atBottom: true, readerMoving: true) == .none)
        #expect(FollowRule.write(for: .handResize, atBottom: true, reflowHeld: true) == .none)
    }

    @Test func `nothing pins while the glide runs, and the reader's place holds through it`() {
        #expect(FollowRule.write(for: .rowsChanged, atBottom: true, gliding: true) == .none)
        // The growth below a reader at the bottom reads as off the bottom mid-glide: held, no pin.
        #expect(FollowRule.atBottom(was: true, geometry: false, readerMoving: false, offBottomWrite: false, gliding: true) == (true, false))
        // A reader up stays up even when the fold's shrink brings the end into view mid-glide.
        #expect(FollowRule.atBottom(was: false, geometry: true, readerMoving: false, offBottomWrite: false, gliding: true) == (false, false))
        // The reader's own scroll still decides.
        #expect(FollowRule.atBottom(was: true, geometry: false, readerMoving: true, offBottomWrite: false, gliding: true) == (false, false))
        // Once it is over the growth under them pins again.
        #expect(FollowRule.atBottom(was: true, geometry: false, readerMoving: false, offBottomWrite: false) == (true, true))
    }

    @Test func `the glide runs from the tap to the layout spring's settle, extended by a second tap`() {
        var glide = HandGlide()
        #expect(!glide.active(at: 0))
        glide.begin(at: 10)
        #expect(glide.active(at: 10 + MotionValues.layout))
        #expect(!glide.active(at: 10 + MotionValues.layout + HandGlide.slack))
        #expect(abs(glide.remaining(at: 10.1) - (MotionValues.layout + HandGlide.slack - 0.1)) < 1e-9)
        glide.begin(at: 10.2)
        #expect(glide.active(at: 10.2 + MotionValues.layout))
        // An earlier tap never shortens it.
        glide.begin(at: 9)
        #expect(glide.until == 10.2 + MotionValues.layout + HandGlide.slack)
        #expect(glide.remaining(at: 100) == 0)
    }
}
