import Foundation
import Testing
@testable import TempCodeClient

/// The working line's loops as keyframes (`MotionLoop`): what Core
/// Animation is handed, and the path it draws.
@Suite struct MotionLoopTests {
    @Test func `key times run from 0 to 1 in step with the legs`() {
        let loop = MotionLoop(start: 0, legs: [.init(1, 1), .init(1, 2), .init(0, 1)])
        #expect(loop.period == 4)
        #expect(loop.values == [0, 1, 1, 0])
        #expect(loop.keyTimes == [0, 0.25, 0.75, 1])
        // Thirds do not add up to 1 in floating point; the last key is 1 all the same.
        let thirds = MotionLoop(start: 0, legs: [.init(1, 0.1), .init(2, 0.1), .init(3, 0.1)])
        #expect(thirds.keyTimes.first == 0 && thirds.keyTimes.last == 1)
        #expect(thirds.keyTimes == thirds.keyTimes.sorted())
        #expect(MotionLoop(start: 2, legs: []).value(at: 5) == 2)
    }

    @Test func `a loop's value follows its legs and comes round`() {
        let loop = MotionLoop(start: 0, legs: [.init(10, 1), .init(10, 1), .init(0, 2)])
        #expect(loop.value(at: 0) == 0)
        #expect(loop.value(at: 0.5) == 5)
        #expect(loop.value(at: 1.5) == 10)
        #expect(loop.value(at: 3) == 5)
        #expect(loop.value(at: 4.5) == 5, "the second round")
        #expect(loop.scaled(by: 2).value(at: 0.5) == 10)
        #expect(loop.scaled(by: 2).keyTimes == loop.keyTimes)
        // A curved leg starts and ends where a linear one does.
        let eased = MotionLoop(start: 0, legs: [.init(1, 1, MotionValues.easeBreathe)])
        #expect(eased.value(at: 0) == 0)
        #expect(abs(eased.value(at: 0.5) - 0.5) < 0.01, "the breathing curve is symmetric")
        #expect(eased.value(at: 0.25) < 0.25, "and slow out of the gate")
    }

    @Test func `the mark's dots gather, hold and part once a period, the right one behind the left`() {
        let left = MotionValues.markLoop(rest: -MotionValues.markSpread, gathered: -1, gather: MotionValues.markGather, part: MotionValues.markPart)
        let right = MotionValues.markLoop(rest: MotionValues.markSpread, gathered: 1, gather: MotionValues.markLagGather, part: MotionValues.markLagPart)
        for loop in [left, right] {
            #expect(abs(loop.period - MotionValues.markPeriod) < 1e-9)
            #expect(loop.values.first == loop.values.last, "back at rest, so the round joins")
            #expect(loop.legs.map { $0.curve != nil } == [true, false, true])
        }
        #expect(abs(left.keyTimes[1] - MotionValues.markGather) < 1e-9 && abs(left.keyTimes[2] - MotionValues.markPart) < 1e-9)
        #expect(right.keyTimes[1] > left.keyTimes[1])
        // Held gathered between the two.
        let held = MotionValues.markPeriod * (MotionValues.markGather + MotionValues.markPart) / 2
        #expect(left.value(at: held) == -1)
    }

    @Test func `the shimmer's band waits off the words, crosses them and waits again`() {
        let loop = MotionValues.shimmerLoop
        #expect(abs(loop.period - MotionValues.shimmerPeriod) < 1e-9)
        #expect(loop.values == [-1, -1, 1, 1])
        #expect(abs(loop.keyTimes[1] - MotionValues.shimmerStart) < 1e-9 && abs(loop.keyTimes[2] - MotionValues.shimmerEnd) < 1e-9)
        #expect(loop.value(at: 0.1) == -1)
        #expect(loop.value(at: MotionValues.shimmerPeriod - 0.1) == 1)
        let middle = loop.value(at: MotionValues.shimmerPeriod / 2)
        #expect(middle > -1 && middle < 1)
    }
}
