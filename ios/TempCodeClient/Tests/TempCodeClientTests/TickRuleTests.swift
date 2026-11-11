import Foundation
import Testing
@testable import TempCodeClient

/// When an on-screen clock draws again (`TickRule`).
@Suite struct TickRuleTests {
    @Test func `a clock waits to the next whole period on the wall clock`() {
        #expect(abs(TickRule.wait(now: 100.25, period: 1) - 0.75) < 1e-9)
        #expect(abs(TickRule.wait(now: 100.0, period: 1) - 1) < 1e-9)
        #expect(abs(TickRule.wait(now: 95, period: 30) - 25) < 1e-9)
        #expect(abs(TickRule.wait(now: 120, period: 30) - 30) < 1e-9)
        // Two clocks asked a moment apart wake on the same instant.
        #expect(abs((100.2 + TickRule.wait(now: 100.2, period: 1)) - (100.7 + TickRule.wait(now: 100.7, period: 1))) < 1e-9)
    }

    @Test func `a wait is never a hair, and a period of nothing does not spin`() {
        #expect(TickRule.wait(now: 100.999, period: 1) == TickRule.floor)
        #expect(TickRule.wait(now: 100, period: 0) == TickRule.floor)
        #expect(TickRule.wait(now: -0.25, period: 1) > 0)
    }
}
