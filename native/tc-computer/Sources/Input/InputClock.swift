#if canImport(Darwin)
import Darwin
#endif
import Dispatch
import Foundation

/// Time as Input reads it; the tests inject a clock they move by hand.
public protocol InputClock: Sendable {
    /// mach_absolute_time on the Mac: the unit of the AX change monitor and of `InputOutcome.lastInputAt`
    func ticks() -> UInt64
    /// monotonic seconds
    func seconds() -> Double
    /// epoch seconds, for the crash ledger's records
    func epochSeconds() -> Double
    /// sleeps; a fake clock advances instead
    func sleep(ms: Int)
    /// `ticks()`' unit: nanoseconds = ticks × numer / denom (mach_timebase_info on the Mac)
    func timebase() -> (numer: UInt32, denom: UInt32)
}

extension InputClock {
    public func timebase() -> (numer: UInt32, denom: UInt32) { (1, 1) }
}

/// One moment read on both clocks, so a later `ticks()` value can be said in epoch milliseconds
/// (a session step's span, read at the moment its person watch armed).
public struct TickEpoch: Equatable, Sendable {
    public let epochMs: Double
    public let ticks: UInt64
    public let numer: UInt32
    public let denom: UInt32

    public init(epochMs: Double, ticks: UInt64, numer: UInt32, denom: UInt32) {
        self.epochMs = epochMs
        self.ticks = ticks
        self.numer = numer
        self.denom = max(denom, 1)
    }

    /// Reads the pair now.
    public static func now(_ clock: InputClock) -> TickEpoch {
        let base = clock.timebase()
        return TickEpoch(epochMs: clock.epochSeconds() * 1000, ticks: clock.ticks(), numer: base.numer, denom: base.denom)
    }

    /// `t` in epoch milliseconds; a tick before the pair counts back from it.
    public func epochMs(of t: UInt64) -> Double {
        let ahead = t >= ticks
        let delta = ahead ? t - ticks : ticks - t
        let ms = Double(delta) * Double(numer) / Double(denom) / 1_000_000
        return ahead ? epochMs + ms : epochMs - ms
    }
}

public struct SystemClock: InputClock {
    public init() {}

    public func ticks() -> UInt64 {
        #if canImport(Darwin)
        mach_absolute_time()
        #else
        DispatchTime.now().uptimeNanoseconds
        #endif
    }

    public func seconds() -> Double {
        Double(DispatchTime.now().uptimeNanoseconds) / 1e9
    }

    public func epochSeconds() -> Double {
        Date().timeIntervalSince1970
    }

    public func sleep(ms: Int) {
        guard ms > 0 else { return }
        Thread.sleep(forTimeInterval: Double(ms) / 1000)
    }

    public func timebase() -> (numer: UInt32, denom: UInt32) {
        #if canImport(Darwin)
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return (info.numer, info.denom)
        #else
        return (1, 1)
        #endif
    }
}
