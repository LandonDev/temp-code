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
}
