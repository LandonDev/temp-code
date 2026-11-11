import Foundation

/// When a clock on screen draws again (`Tick` in the app): at the next
/// whole period on the wall clock, so every clock steps on the same
/// instant and a "12s" turns to "13s" as the second does.
public enum TickRule {
    /// A wait is never shorter than this: a tick that lands a hair early
    /// would otherwise be followed by another at once.
    public static let floor = 0.05

    /// Seconds from `now` (epoch seconds) to the next multiple of `period`.
    public static func wait(now: Double, period: Double) -> Double {
        guard period > 0 else { return floor }
        let into = now.truncatingRemainder(dividingBy: period)
        let left = period - (into < 0 ? into + period : into)
        return max(floor, left)
    }
}
