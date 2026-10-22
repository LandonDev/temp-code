import Foundation
import TempCodeClient
import TempCodeContract

/// Sizes and JSON as a person reads them. Times, token counts and model names
/// live in the client package's `Design/` (`TimeFormat`, `CompactNumber`,
/// `ModelName`), where they are unit-tested; `tokens` and `relative` forward
/// there under their old names.
enum Formatting {
    static func bytes(_ count: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .file)
    }

    /// `CompactNumber.tokens`: "980", "1.2K", "176K", "1.2M".
    static func tokens(_ count: Double) -> String {
        CompactNumber.tokens(count)
    }

    /// `TimeFormat.ago`: "now", "3m", "2h", "5d", "Oct 3".
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
