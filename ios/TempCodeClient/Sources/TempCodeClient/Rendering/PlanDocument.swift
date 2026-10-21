import Foundation

/// One item of a plan's list: its inline text, the checkbox when the item
/// is a task, its nesting depth, and its number when the list is ordered.
public struct PlanListItem: Sendable, Hashable {
    public var text: AttributedString
    /// `true` or `false` for a `[x]` / `[ ]` task, nil for a plain item.
    public var checked: Bool?
    /// 0 for a top-level item; each indented list under it adds one.
    public var depth: Int
    public var ordered: Bool
    /// The ordinal shown for an ordered item, counted per depth.
    public var number: Int?

    public init(text: AttributedString, checked: Bool? = nil, depth: Int = 0, ordered: Bool = false, number: Int? = nil) {
        self.text = text
        self.checked = checked
        self.depth = depth
        self.ordered = ordered
        self.number = number
    }
}

/// A pipe table: a header row, body rows padded to the header's width,
/// and the alignment the separator row asked for per column.
public struct PlanTable: Sendable, Hashable {
    public enum Alignment: Sendable, Hashable {
        case leading, center, trailing
    }

    public var header: [AttributedString]
    public var rows: [[AttributedString]]
    public var alignments: [Alignment]

    public init(header: [AttributedString], rows: [[AttributedString]], alignments: [Alignment]) {
        self.header = header
        self.rows = rows
        self.alignments = alignments
    }
}

/// A block of the plan document, inline styling resolved, in the shapes a
/// set page needs beyond the transcript's: nested lists with their depth
/// and ordinals, task checkboxes, and tables.
public enum PlanBlock: Sendable, Hashable {
    case paragraph(AttributedString)
    case heading(Int, AttributedString)
    case list([PlanListItem])
    case code(String, language: String?)
    case quote(AttributedString)
    case rule
    case table(PlanTable)
}

/// The plan or report file as blocks, parsed once per text version.
public struct PlanDocument: Sendable, Hashable {
    public var blocks: [PlanBlock]
    /// The hash of the markdown this came from; a page compares it to know
    /// whether what it holds is the current text or the one before.
    public var textHash: Int

    public init(blocks: [PlanBlock], textHash: Int) {
        self.blocks = blocks
        self.textHash = textHash
    }

    public var isEmpty: Bool { blocks.isEmpty }

    /// The whole parse, synchronous: the plan's block grammar (fences,
    /// headings, rules, pipe tables, quotes, nested and task lists,
    /// paragraphs with soft breaks joined) and inline markdown per block.
    public static func parse(_ md: String) -> PlanDocument {
        var parser = PlanDocumentParser(md)
        return PlanDocument(blocks: parser.run(), textHash: md.hashValue)
    }

    /// The same parse, off the caller's actor.
    @concurrent
    public static func render(_ md: String) async -> PlanDocument {
        parse(md)
    }
}

/// The line-by-line splitter behind `PlanDocument.parse`.
private struct PlanDocumentParser {
    private let lines: [String]
    private var blocks: [PlanBlock] = []
    private var paragraph: [String] = []
    private var quote: [String] = []
    private var list = ListBuilder()

    init(_ md: String) {
        lines = md.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }

    mutating func run() -> [PlanBlock] {
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushAll()
                let fence = String(trimmed.prefix(3))
                let language = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                var j = i + 1
                while j < lines.count, !lines[j].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    body.append(lines[j])
                    j += 1
                }
                if j >= lines.count {
                    // Unclosed: the file ends inside the fence; drop the blank tail.
                    while body.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { body.removeLast() }
                }
                blocks.append(.code(body.joined(separator: "\n"), language: language.isEmpty ? nil : language))
                i = j + 1
                continue
            }
            if trimmed.isEmpty {
                flushAll()
                i += 1
                continue
            }
            if let heading = Self.heading(trimmed) {
                flushAll()
                blocks.append(.heading(heading.level, MarkdownBlocks.inline(heading.text)))
                i += 1
                continue
            }
            if Self.isRule(trimmed) {
                flushAll()
                blocks.append(.rule)
                i += 1
                continue
            }
            if trimmed.hasPrefix("|"), i + 1 < lines.count, Self.isSeparator(lines[i + 1]) {
                flushAll()
                let header = Self.cells(trimmed)
                let alignments = Self.alignments(lines[i + 1], count: header.count)
                var rows: [[AttributedString]] = []
                var j = i + 2
                while j < lines.count {
                    let row = lines[j].trimmingCharacters(in: .whitespaces)
                    guard !row.isEmpty, row.contains("|") else { break }
                    var cells = Self.cells(row)
                    if cells.count > header.count { cells = Array(cells.prefix(header.count)) }
                    while cells.count < header.count { cells.append("") }
                    rows.append(cells.map(MarkdownBlocks.inline))
                    j += 1
                }
                blocks.append(.table(PlanTable(header: header.map(MarkdownBlocks.inline), rows: rows, alignments: alignments)))
                i = j
                continue
            }
            if trimmed.hasPrefix(">") {
                flushParagraph()
                flushList()
                quote.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
                i += 1
                continue
            }
            if let item = Self.listItem(line) {
                flushParagraph()
                flushQuote()
                list.add(indent: item.indent, ordered: item.ordered, start: item.number, text: item.text)
                i += 1
                continue
            }
            if !list.isEmpty {
                // A line under a list item with no blank between continues it,
                // indented or not.
                list.continueLast(trimmed)
                i += 1
                continue
            }
            flushList()
            flushQuote()
            paragraph.append(line)
            i += 1
        }
        flushAll()
        return blocks
    }

    // MARK: - flushing

    private mutating func flushParagraph() {
        guard !paragraph.isEmpty else { return }
        blocks.append(.paragraph(MarkdownBlocks.inline(Self.joinSoft(paragraph))))
        paragraph = []
    }

    private mutating func flushQuote() {
        guard !quote.isEmpty else { return }
        blocks.append(.quote(MarkdownBlocks.inline(Self.joinSoft(quote))))
        quote = []
    }

    private mutating func flushList() {
        guard !list.isEmpty else { return }
        blocks.append(.list(list.items()))
        list = ListBuilder()
    }

    private mutating func flushAll() {
        flushParagraph()
        flushList()
        flushQuote()
    }

    // MARK: - lists

    private struct ListBuilder {
        private struct Raw {
            var text: String
            var checked: Bool?
            var depth: Int
            var ordered: Bool
            var number: Int?
        }

        private var raws: [Raw] = []
        private var stack: [Int] = []
        private var counters: [Int] = []

        var isEmpty: Bool { raws.isEmpty }

        /// `start` is the number the source wrote: it is honoured for the
        /// first ordered item at a depth (so a list a blank line split
        /// continues its count) and ignored after it (so `1.` repeated
        /// still counts up).
        mutating func add(indent: Int, ordered: Bool, start: Int?, text: String) {
            while let last = stack.last, last > indent { stack.removeLast() }
            if stack.isEmpty || stack[stack.count - 1] < indent { stack.append(indent) }
            let depth = stack.count - 1
            if counters.count > depth + 1 { counters.removeSubrange((depth + 1)...) }
            while counters.count <= depth { counters.append(0) }
            counters[depth] = ordered ? (counters[depth] == 0 ? max(start ?? 1, 1) : counters[depth] + 1) : 0
            let (checked, body) = Self.checklist(text)
            raws.append(Raw(text: body, checked: checked, depth: depth, ordered: ordered, number: ordered ? counters[depth] : nil))
        }

        mutating func continueLast(_ text: String) {
            guard !raws.isEmpty else { return }
            raws[raws.count - 1].text = PlanDocumentParser.joinSoft([raws[raws.count - 1].text, text])
        }

        func items() -> [PlanListItem] {
            raws.map { PlanListItem(text: MarkdownBlocks.inline($0.text), checked: $0.checked, depth: $0.depth, ordered: $0.ordered, number: $0.number) }
        }

        /// "[x] Ship it" is a done task, "[ ] Ship it" an open one.
        private static func checklist(_ text: String) -> (Bool?, String) {
            for (mark, checked) in [("[ ]", false), ("[x]", true), ("[X]", true)] {
                if text == mark { return (checked, "") }
                if text.hasPrefix(mark + " ") { return (checked, String(text.dropFirst(mark.count + 1))) }
            }
            return (nil, text)
        }
    }

    /// A list item: its indent in columns (a tab is four), whether it is
    /// ordered (and the number written), and the text after the marker.
    private static func listItem(_ line: String) -> (indent: Int, ordered: Bool, number: Int?, text: String)? {
        var indent = 0
        var rest = Substring(line)
        while let first = rest.first, first == " " || first == "\t" {
            indent += first == "\t" ? 4 : 1
            rest = rest.dropFirst()
        }
        guard indent < 16 else { return nil }
        if let first = rest.first, "-*+".contains(first), rest.dropFirst().first == " " {
            return (indent, false, nil, String(rest.dropFirst(2)))
        }
        let digits = rest.prefix { $0.isNumber }
        guard !digits.isEmpty, digits.count <= 3 else { return nil }
        let afterDigits = rest.dropFirst(digits.count)
        guard let mark = afterDigits.first, mark == "." || mark == ")", afterDigits.dropFirst().first == " " else { return nil }
        return (indent, true, Int(digits), String(afterDigits.dropFirst(2)))
    }

    // MARK: - lines

    /// Source lines of one paragraph joined the way markdown reads them: a
    /// soft break is a space, a line ending in two spaces or a backslash
    /// keeps its break.
    fileprivate static func joinSoft(_ lines: [String]) -> String {
        var out = ""
        for (index, raw) in lines.enumerated() {
            var line = raw.trimmingCharacters(in: .whitespaces)
            let hard = raw.hasSuffix("  ") || line.hasSuffix("\\")
            if line.hasSuffix("\\") { line.removeLast() }
            if index > 0 { out += out.hasSuffix("\n") ? "" : " " }
            out += line
            if hard, index < lines.count - 1 { out += "\n" }
        }
        return out
    }

    private static func heading(_ line: String) -> (level: Int, text: String)? {
        var level = 0
        var rest = Substring(line)
        while rest.first == "#", level < 6 {
            level += 1
            rest = rest.dropFirst()
        }
        guard level > 0, rest.first == " " || rest.first == "\t" else { return nil }
        var text = rest.trimmingCharacters(in: .whitespaces)
        // A closing run of hashes after a space is decoration; "C#" keeps its hash.
        let closing = text.reversed().prefix { $0 == "#" }.count
        if closing > 0, closing < text.count, text[text.index(text.endIndex, offsetBy: -closing - 1)] == " " {
            text.removeLast(closing)
            text = text.trimmingCharacters(in: .whitespaces)
        }
        return text.isEmpty ? nil : (level, text)
    }

    private static func isRule(_ line: String) -> Bool {
        let marks = line.filter { !$0.isWhitespace }
        let set = Set(marks)
        return marks.count >= 3 && set.count == 1 && (set.first == "-" || set.first == "*" || set.first == "_")
    }

    // MARK: - tables

    /// The cells of a pipe row, outer pipes dropped, `\|` kept as a pipe.
    private static func cells(_ line: String) -> [String] {
        var text = Substring(line.trimmingCharacters(in: .whitespaces))
        if text.hasPrefix("|") { text = text.dropFirst() }
        if text.hasSuffix("|"), !text.hasSuffix("\\|") { text = text.dropLast() }
        var out: [String] = []
        var current = ""
        var escaped = false
        for character in text {
            if escaped {
                // Only a pipe is unescaped here; other escapes are inline markdown's.
                if character != "|" { current.append("\\") }
                current.append(character)
                escaped = false
            } else if character == "\\" {
                escaped = true
            } else if character == "|" {
                out.append(current)
                current = ""
            } else {
                current.append(character)
            }
        }
        if escaped { current.append("\\") }
        out.append(current)
        return out.map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// `| --- | :---: | ---: |`: every cell is dashes with optional colons.
    private static func isSeparator(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("-"), trimmed.contains("|") || trimmed.hasPrefix(":") else { return false }
        let parts = cells(trimmed)
        guard !parts.isEmpty else { return false }
        return parts.allSatisfy { cell in
            var dashes = Substring(cell)
            if dashes.hasPrefix(":") { dashes = dashes.dropFirst() }
            if dashes.hasSuffix(":") { dashes = dashes.dropLast() }
            return !dashes.isEmpty && dashes.allSatisfy { $0 == "-" }
        }
    }

    private static func alignments(_ separator: String, count: Int) -> [PlanTable.Alignment] {
        var out: [PlanTable.Alignment] = cells(separator).map { cell in
            let leading = cell.hasPrefix(":")
            let trailing = cell.hasSuffix(":")
            if leading, trailing { return .center }
            if trailing { return .trailing }
            return .leading
        }
        if out.count > count { out = Array(out.prefix(count)) }
        while out.count < count { out.append(.leading) }
        return out
    }
}
