import Testing
@testable import TempCodeClient

@Suite struct BackoffTests {
    let policy = BackoffPolicy.standard

    @Test func `the band around each attempt doubles from one second`() {
        #expect(policy.delay(attempt: 0, random: 0.5) == 1_000)
        #expect(policy.delay(attempt: 1, random: 0.5) == 2_000)
        #expect(policy.delay(attempt: 4, random: 0.5) == 16_000)
    }

    @Test(arguments: 0..<20)
    func `jitter stays inside ±25 % and under the cap`(attempt: Int) {
        let center = min(300_000.0, 1_000.0 * Double(1 << attempt))
        let low = policy.delay(attempt: attempt, random: 0)
        let high = policy.delay(attempt: attempt, random: 0.999_999)
        #expect(low == min(300_000, (center * 0.75).rounded()))
        #expect(high <= 300_000)
        #expect(high >= low)
        #expect(high <= (center * 1.25).rounded())
    }

    @Test func `the cap holds past the thirtieth attempt`() {
        #expect(policy.delay(attempt: 30, random: 1) == 300_000)
        #expect(policy.delay(attempt: 100, random: 0) == 225_000)
    }
}

@Suite struct ManualClockTests {
    @Test func `a sleeper wakes only when time reaches its deadline`() async throws {
        let clock = ManualClock()
        let woke = Mutex(false)
        let sleeper = Task {
            try await clock.sleep(ms: 500)
            woke.withLock { $0 = true }
        }
        await clock.settle()
        #expect(clock.pendingSleeps == 1)
        await clock.advance(ms: 499)
        #expect(woke.withLock { $0 } == false)
        await clock.advance(ms: 1)
        try await sleeper.value
        #expect(woke.withLock { $0 } == true)
        #expect(clock.now == 500)
    }

    @Test func `cancelling a sleeper throws and frees its slot`() async {
        let clock = ManualClock()
        let sleeper = Task { try await clock.sleep(ms: 10_000) }
        await clock.settle()
        sleeper.cancel()
        await #expect(throws: CancellationError.self) { try await sleeper.value }
        #expect(clock.pendingSleeps == 0)
    }

    @Test func `random values play back in order and the last repeats`() {
        let clock = ManualClock(random: [0.1, 0.9])
        #expect(clock.random() == 0.1)
        #expect(clock.random() == 0.9)
        #expect(clock.random() == 0.9)
    }
}

import Synchronization
