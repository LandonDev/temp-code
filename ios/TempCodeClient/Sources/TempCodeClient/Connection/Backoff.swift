import Foundation

/// The retry policy of the desktop runtime (supervisor.ts BACKOFF): 1 s
/// doubling to a 5 min cap, ±25 % jitter, and the attempt count resets only
/// after a session has stayed up for 30 s.
public struct BackoffPolicy: Sendable, Hashable {
    public var baseMs: Double
    public var capMs: Double
    public var resetAfterMs: Double
    public var jitter: Double

    public init(baseMs: Double = 1_000, capMs: Double = 300_000, resetAfterMs: Double = 30_000, jitter: Double = 0.25) {
        self.baseMs = baseMs
        self.capMs = capMs
        self.resetAfterMs = resetAfterMs
        self.jitter = jitter
    }

    public static let standard = BackoffPolicy()

    /// The delay before attempt `attempt` (0-based: after that many failures),
    /// with `random` in `0..<1` placing it inside the jitter band.
    public func delay(attempt: Int, random: Double) -> Double {
        let exponent = Double(min(attempt, 40))
        let raw = min(capMs, baseMs * pow(2, exponent))
        let jittered = raw * (1 - jitter + 2 * jitter * random)
        return min(capMs, max(0, jittered.rounded()))
    }
}
