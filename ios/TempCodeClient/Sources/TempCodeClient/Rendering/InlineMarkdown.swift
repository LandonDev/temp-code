import Foundation

/// A line of markdown as plain words, for a place that draws text and not
/// markdown (a project card's detail): links keep their text, code spans
/// their contents, and emphasis markers go. Underscores inside a word
/// (`snake_case`) stay.
public enum InlineMarkdown {
    private nonisolated(unsafe) static let rules: [(NSRegularExpression, String)] = [
        (#"!?\[([^\]]*)\]\([^)]*\)"#, "$1"),
        (#"`+([^`]*)`+"#, "$1"),
        (#"(\*\*|__)(?=\S)(.+?)(?<=\S)\1"#, "$2"),
        (#"(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])"#, "$1"),
        (#"(?<!\w)_(?=\S)(.+?)(?<=\S)_(?!\w)"#, "$1"),
        (#"~~(.+?)~~"#, "$1")
    ].map { (try! NSRegularExpression(pattern: $0.0), $0.1) }

    public nonisolated static func plain(_ text: String) -> String {
        rules.reduce(text) { text, rule in
            rule.0.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: rule.1)
        }
    }
}
