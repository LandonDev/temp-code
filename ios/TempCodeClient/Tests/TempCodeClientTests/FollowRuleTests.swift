import Testing
@testable import TempCodeClient

@Suite struct FollowRuleMovingTests {
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
