import Foundation

/// A model id as a row reads it: "claude-sonnet-5-5" → "Sonnet 5.5",
/// "gpt-6.1-sol" → "GPT-6.1 Sol". The catalog's own names replace this once a
/// screen has them; the row must read right from the cache before any socket.
public enum ModelName {
    public static func short(_ id: String) -> String {
        var parts = id.split(separator: "-").map(String.init)
        if parts.count > 1, parts[0] == "claude" { parts.removeFirst() }
        // A trailing "5-5" or "4-8" is a version: join it with a dot.
        var out: [String] = []
        for part in parts {
            if let last = out.last, Int(part) != nil, Int(last) != nil {
                out[out.count - 1] = "\(last).\(part)"
            } else {
                out.append(part)
            }
        }
        return out.map { word in
            if word.lowercased().hasPrefix("gpt") { return word.uppercased() }
            if word.first?.isNumber == true { return word }
            return word.prefix(1).uppercased() + word.dropFirst()
        }.joined(separator: " ")
    }
}
