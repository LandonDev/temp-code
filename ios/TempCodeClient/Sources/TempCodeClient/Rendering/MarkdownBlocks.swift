import Foundation

/// A block of the agent's prose, so a view can give code, lists and
/// headings their own shape while inline markdown stays inline.
public enum MarkdownBlock: Sendable, Hashable {
    case paragraph(String)
    case heading(Int, String)
    case list([String], ordered: Bool)
    case code(String, language: String?)
    case quote(String)
    case rule
}

public enum MarkdownBlocks {
    /// Splits markdown into blocks: fenced code, headings, lists, quotes,
    /// rules, and paragraphs separated by blank lines.
    public static func split(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var list: (items: [String], ordered: Bool)?
        var quote: [String] = []
        var code: (lines: [String], language: String?, fence: String)?

        func flushParagraph() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
            paragraph = []
        }
        func flushList() {
            if let list, !list.items.isEmpty { blocks.append(.list(list.items, ordered: list.ordered)) }
            list = nil
        }
        func flushQuote() {
            if !quote.isEmpty { blocks.append(.quote(quote.joined(separator: "\n"))) }
            quote = []
        }
        func flushAll() {
            flushParagraph()
            flushList()
            flushQuote()
        }

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(rawLine)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if var open = code {
                if trimmed.hasPrefix(open.fence) {
                    blocks.append(.code(open.lines.joined(separator: "\n"), language: open.language))
                    code = nil
                } else {
                    open.lines.append(line)
                    code = open
                }
                continue
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushAll()
                let fence = String(trimmed.prefix(3))
                let language = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                code = ([], language.isEmpty ? nil : language, fence)
                continue
            }
            if trimmed.isEmpty {
                flushAll()
                continue
            }
            if let heading = heading(trimmed) {
                flushAll()
                blocks.append(.heading(heading.level, heading.text))
                continue
            }
            if isRule(trimmed) {
                flushAll()
                blocks.append(.rule)
                continue
            }
            if trimmed.hasPrefix(">") {
                flushParagraph()
                flushList()
                quote.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
                continue
            }
            if let item = listItem(line) {
                flushParagraph()
                flushQuote()
                if list == nil || list?.ordered != item.ordered {
                    flushList()
                    list = ([], item.ordered)
                }
                list?.items.append(item.text)
                continue
            }
            if list != nil, line.first?.isWhitespace == true, var items = list?.items, !items.isEmpty {
                // An indented continuation belongs to the last item.
                items[items.count - 1] += "\n" + trimmed
                list?.items = items
                continue
            }
            flushList()
            flushQuote()
            paragraph.append(line)
        }
        if let open = code { blocks.append(.code(open.lines.joined(separator: "\n"), language: open.language)) }
        flushAll()
        return blocks
    }

    /// Inline markdown (bold, italics, code, links) as attributed text;
    /// text that is not valid markdown comes back plain.
    public static func inline(_ text: String) -> AttributedString {
        var options = AttributedString.MarkdownParsingOptions()
        options.interpretedSyntax = .inlineOnlyPreservingWhitespace
        options.failurePolicy = .returnPartiallyParsedIfPossible
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }

    private static func heading(_ line: String) -> (level: Int, text: String)? {
        var level = 0
        var rest = Substring(line)
        while rest.first == "#", level < 6 {
            level += 1
            rest = rest.dropFirst()
        }
        guard level > 0, rest.first == " " || rest.first == "\t" else { return nil }
        return (level, rest.trimmingCharacters(in: .whitespaces))
    }

    private static func isRule(_ line: String) -> Bool {
        let set = Set(line.filter { !$0.isWhitespace })
        return line.count >= 3 && set.count == 1 && (set.first == "-" || set.first == "*" || set.first == "_") && line.filter({ !$0.isWhitespace }).count >= 3
    }

    private static func listItem(_ line: String) -> (text: String, ordered: Bool)? {
        let trimmed = line.drop { $0 == " " || $0 == "\t" }
        guard line.count - trimmed.count < 8 else { return nil }
        if let first = trimmed.first, "-*+".contains(first), trimmed.dropFirst().first == " " {
            return (String(trimmed.dropFirst(2)), false)
        }
        let digits = trimmed.prefix { $0.isNumber }
        guard !digits.isEmpty, digits.count <= 3 else { return nil }
        let afterDigits = trimmed.dropFirst(digits.count)
        guard let mark = afterDigits.first, mark == "." || mark == ")", afterDigits.dropFirst().first == " " else { return nil }
        return (String(afterDigits.dropFirst(2)), true)
    }
}
