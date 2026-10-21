import Foundation
import TempCodeContract

/// Sizes, token counts and JSON as a person reads them. Times live in
/// Design/TimeFormat.swift; `relative` is `TimeFormat.ago` under its old name.
enum Formatting {
    static func bytes(_ count: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .file)
    }

    /// The desktop's compact token count (formatTokens in lib/contextUsage.ts):
    /// "980", "1.2K", "176K", "1.2M".
    static func tokens(_ count: Double) -> String {
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

    static func relative(ms: Int) -> String {
        TimeFormat.ago(ms)
    }

    /// JSON as a person reads it: sorted keys, two-space indent.
    static func pretty(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(value) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
}
