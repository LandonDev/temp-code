import ComputerProtocol
import Foundation

/// What the escape tap does with one key event (P1, docs/computer-protocol.md §8): the person's own
/// Escape is taken, and its first key down is told to the host; everything else passes untouched,
/// our own marked Escape included.
public enum EscapeFilter {
    public enum Decision: Equatable, Sendable {
        case pass
        /// the event goes no further; `press` when it is a key down the host is told of
        case take(press: Bool)
    }

    /// `marked`: the event carries `TC_EVENT_MARK` in `eventSourceUserData`. A held key's
    /// autorepeat is taken too but told once, on the first down.
    public static func decide(keycode: Int64, marked: Bool, down: Bool, autorepeat: Bool = false) -> Decision {
        guard keycode == Int64(ComputerDefaults.EscapeWatch.keycode), !marked else { return .pass }
        return .take(press: down && !autorepeat)
    }
}

/// The watch's lease: the host renews it while the session is held, and the tap ends on its own
/// once a renewal is late. Times are epoch milliseconds.
public struct EscapeLease: Equatable, Sendable {
    public private(set) var until: Double?

    public init() {}

    /// The host's `leaseMs`, held to the wire's bounds; absent takes the default.
    public static func clamp(_ leaseMs: Int?) -> Int {
        let ms = leaseMs ?? ComputerDefaults.EscapeWatch.leaseMs
        return min(max(ms, ComputerDefaults.EscapeWatch.minLeaseMs), ComputerDefaults.EscapeWatch.maxLeaseMs)
    }

    public var on: Bool { until != nil }

    /// `escape.watch { on: true }`: starts the lease or moves its end.
    public mutating func renew(now: Double, leaseMs: Int?) {
        until = now + Double(Self.clamp(leaseMs))
    }

    public mutating func end() { until = nil }

    /// True when the lease ran out unrenewed; the lease is then over.
    public mutating func lapsed(now: Double) -> Bool {
        guard let until, now >= until else { return false }
        self.until = nil
        return true
    }
}
