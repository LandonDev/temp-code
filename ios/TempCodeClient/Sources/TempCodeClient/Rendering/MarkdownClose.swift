import Foundation

/// The desktop's `remend` (streamdown's self-healing markdown) for the
/// phone's streaming path: an inline span the stream has opened but not yet
/// closed (`**`, `*`, `_`, `~~`, a code span, a link's text or its address)
/// is closed at the end of the text, so the reveal never shows a raw mark
/// and the styled text only ever grows. "Run **very " reads as "Run
/// **very** " (the closer goes before the trailing whitespace, where it can
/// close), "[the docs](https://ex" as a link, and a mark with nothing after
/// it yet ("Run **") is left out until its first word comes. Only a
/// streaming row's last block is closed; the settled parse never is, so a
/// span the reply really leaves open reads as written once it ends.
public enum MarkdownClose {
    private enum Open {
        case code(run: Int, at: Int)
        case emphasis(Character, count: Int, at: Int)
        case linkText(at: Int)
        case linkURL(at: Int)

        var at: Int {
            switch self {
            case .code(_, let at), .emphasis(_, _, let at), .linkText(let at), .linkURL(let at): at
            }
        }

        /// How many characters the opener takes from `at`.
        var width: Int {
            switch self {
            case .code(let run, _): run
            case .emphasis(_, let count, _): count
            case .linkText: 1
            case .linkURL: 2
            }
        }

        var closer: String {
            switch self {
            case .code(let run, _): String(repeating: "`", count: run)
            case .emphasis(let mark, let count, _): String(repeating: mark, count: count)
            case .linkText: "]()"
            case .linkURL: ")"
            }
        }
    }

    private static let marks: Set<Character> = ["*", "_", "~", "`", "[", "]"]

    /// `text` with its open inline spans closed at the end.
    public static func inline(_ text: String) -> String {
        guard text.contains(where: { marks.contains($0) }) else { return text }
        let all = Array(text)
        var end = all.count
        while end > 0, all[end - 1].isWhitespace { end -= 1 }
        var body = Array(all[..<end])
        var tail = Array(all[end...])
        var stack: [Open] = []
        var i = 0
        while i < body.count {
            let c = body[i]
            if case .code(let run, _)? = stack.last {
                if c == "`" {
                    let length = runLength(body, i)
                    if length == run { stack.removeLast() }
                    i += length
                } else {
                    i += 1
                }
                continue
            }
            if case .linkURL? = stack.last {
                if c == ")" { stack.removeLast() }
                i += 1
                continue
            }
            switch c {
            case "\\":
                i += 2
            case "`":
                let length = runLength(body, i)
                stack.append(.code(run: length, at: i))
                i += length
            case "[":
                stack.append(.linkText(at: i))
                i += 1
            case "]":
                if let open = stack.lastIndex(where: { if case .linkText = $0 { true } else { false } }) {
                    // Marks opened inside the link's text and still open stay literal.
                    stack.removeSubrange(open...)
                    if i + 1 < body.count, body[i + 1] == "(" {
                        stack.append(.linkURL(at: i))
                        i += 2
                        continue
                    }
                }
                i += 1
            case "*", "_", "~":
                let length = runLength(body, i)
                defer { i += length }
                if c == "~", length != 2 { continue }
                let before: Character? = i > 0 ? body[i - 1] : nil
                let after: Character? = i + length < body.count ? body[i + length] : nil
                let wordInside = c == "_" && before.map(isWordChar) == true && after.map(isWordChar) == true
                if wordInside { continue }
                let canClose = before.map { !$0.isWhitespace } ?? false
                // The end of the text is a word still to come: a mark there opens.
                let canOpen = after.map { !$0.isWhitespace } ?? true
                if canClose, let match = matching(c, in: stack) {
                    stack.removeSubrange((match + 1)...)
                    var remaining = length
                    while remaining > 0, case .emphasis(let mark, let count, let at)? = stack.last, mark == c {
                        if count > remaining {
                            stack[stack.count - 1] = .emphasis(mark, count: count - remaining, at: at)
                            remaining = 0
                        } else {
                            stack.removeLast()
                            remaining -= count
                        }
                    }
                    if remaining > 0, canOpen { stack.append(.emphasis(c, count: remaining, at: i + length - remaining)) }
                } else if canOpen {
                    stack.append(.emphasis(c, count: length, at: i))
                }
            default:
                i += 1
            }
        }
        // An opener with nothing after it yet is left out; it comes back with its first word.
        var dropped = false
        while let top = stack.last, top.at + top.width >= body.count {
            // A link's address may be empty: its text is already there.
            if case .linkURL = top { break }
            body.removeSubrange(top.at..<min(body.count, top.at + top.width))
            stack.removeLast()
            dropped = true
        }
        if dropped {
            while let last = body.last, last.isWhitespace { body.removeLast() }
            tail = []
        }
        guard !stack.isEmpty || dropped else { return text }
        return String(body) + stack.reversed().map(\.closer).joined() + String(tail)
    }

    /// A streaming row's last block with its open spans closed: a paragraph,
    /// a heading or a quote whole, a list's last item, a table's last row.
    public static func block(_ block: MarkdownBlock) -> MarkdownBlock {
        switch block {
        case .paragraph(let text): return .paragraph(inline(text))
        case .heading(let level, let text): return .heading(level, inline(text))
        case .quote(let text): return .quote(inline(text))
        case .list(var items, let ordered):
            if let last = items.indices.last { items[last] = inline(items[last]) }
            return .list(items, ordered: ordered)
        case .table(var rows):
            if let last = rows.indices.last { rows[last] = rows[last].map(inline) }
            return .table(rows)
        case .code, .rule: return block
        }
    }

    private static func runLength(_ chars: [Character], _ start: Int) -> Int {
        var end = start
        while end < chars.count, chars[end] == chars[start] { end += 1 }
        return end - start
    }

    /// The open emphasis of `mark` this run closes, below no link's text.
    private static func matching(_ mark: Character, in stack: [Open]) -> Int? {
        for index in stack.indices.reversed() {
            switch stack[index] {
            case .emphasis(let open, _, _) where open == mark: return index
            case .linkText, .linkURL, .code: return nil
            default: continue
            }
        }
        return nil
    }

    private static func isWordChar(_ c: Character) -> Bool { c.isLetter || c.isNumber }
}
