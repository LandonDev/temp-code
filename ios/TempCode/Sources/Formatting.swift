import Foundation
import TempCodeContract

enum Formatting {
    static func bytes(_ count: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(count), countStyle: .file)
    }

    static func tokens(_ count: Double) -> String {
        count >= 1_000 ? "\(Int((count / 1_000).rounded()))k" : "\(Int(count))"
    }

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    static func relative(ms: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        if Date().timeIntervalSince(date) < 60 { return "now" }
        return relativeFormatter.localizedString(for: date, relativeTo: Date())
    }

    /// JSON as a person reads it: sorted keys, two-space indent.
    static func pretty(_ value: JSONValue) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(value) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
}
