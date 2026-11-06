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
