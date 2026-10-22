import Foundation

/// Counts as a person reads them at a glance, the desktop's way.
public enum CompactNumber {
    /// The desktop's compact token count (formatTokens in lib/contextUsage.ts):
    /// "980", "1.2K", "176K", "1.2M". Anything that is not a count reads "0".
    public static func tokens(_ count: Double) -> String {
        guard count.isFinite, count >= 0 else { return "0" }
        if count < 1_000 { return "\(Int(count.rounded()))" }
        func compact(_ value: Double, _ unit: String) -> String {
            if value < 10 {
                let one = (value * 10).rounded() / 10
                return one == one.rounded() ? "\(Int(one))\(unit)" : "\(one)\(unit)"
            }
            return "\(Int(value.rounded()))\(unit)"
        }
        if count < 1_000_000 { return compact(count / 1_000, "K") }
        return compact(count / 1_000_000, "M")
    }
}
