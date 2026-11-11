import Foundation

/// A value that goes round for good: where it starts, then legs, each to a
/// value over a time on a curve (nil is linear). The working mark's dots and
/// the shimmer's band are loops. The app hands one to Core Animation as a
/// keyframe animation (`values`, `keyTimes`, a curve per leg, `period`), so
/// the render server moves it and no frame of it runs on the main thread;
/// `value(at:)` is the same path worked out here, for the tests.
public struct MotionLoop: Sendable, Equatable {
    public struct Leg: Sendable, Equatable {
        public var value: Double
        public var duration: Double
        public var curve: MotionValues.Curve?

        public init(_ value: Double, _ duration: Double, _ curve: MotionValues.Curve? = nil) {
            self.value = value
            self.duration = duration
            self.curve = curve
        }
    }

    public var start: Double
    public var legs: [Leg]

    public init(start: Double, legs: [Leg]) {
        self.start = start
        self.legs = legs
    }

    /// One time round, in seconds.
    public var period: Double { legs.reduce(0) { $0 + $1.duration } }

    /// The start, then each leg's end.
    public var values: [Double] { [start] + legs.map(\.value) }

    /// When each of `values` is reached, as a share of the period: 0 first, 1 last.
    public var keyTimes: [Double] {
        let period = period
        guard period > 0 else { return values.map { _ in 0 } }
        var at = 0.0
        var times = [0.0]
        for leg in legs {
            at += leg.duration
            times.append(min(1, at / period))
        }
        times[times.count - 1] = 1
        return times
    }

    /// The loop with every value multiplied (a share of a width, in points).
    public func scaled(by factor: Double) -> MotionLoop {
        MotionLoop(start: start * factor, legs: legs.map { Leg($0.value * factor, $0.duration, $0.curve) })
    }

    /// The value `time` seconds in, on any round.
    public func value(at time: Double) -> Double {
        let period = period
        guard period > 0 else { return start }
        var left = time.truncatingRemainder(dividingBy: period)
        if left < 0 { left += period }
        var from = start
        for leg in legs {
            if left <= leg.duration, leg.duration > 0 {
                let share = left / leg.duration
                return from + (leg.value - from) * (leg.curve?.value(at: share) ?? share)
            }
            left -= leg.duration
            from = leg.value
        }
        return from
    }
}

extension MotionValues {
    /// One dot of the working mark (MARK in lib/ease.ts): from `rest` it
    /// gathers to `gathered` by `gather` of the period on the breathing
    /// curve, holds, and parts again from `part`.
    public static func markLoop(rest: Double, gathered: Double, gather: Double, part: Double) -> MotionLoop {
        MotionLoop(start: rest, legs: [
            .init(gathered, markPeriod * gather, easeBreathe),
            .init(gathered, markPeriod * (part - gather)),
            .init(rest, markPeriod * (1 - part), easeBreathe),
        ])
    }

    /// The shimmer's band (SHIMMER in lib/ease.ts), as a share of the words'
    /// width either side of them: off the words until `shimmerStart` of the
    /// period, across them on the sweep curve by `shimmerEnd`, then off the
    /// other side until the period ends.
    public static let shimmerLoop = MotionLoop(start: -1, legs: [
        .init(-1, shimmerPeriod * shimmerStart),
        .init(1, shimmerPeriod * (shimmerEnd - shimmerStart), shimmerSweep),
        .init(1, shimmerPeriod * (1 - shimmerEnd)),
    ])
}
