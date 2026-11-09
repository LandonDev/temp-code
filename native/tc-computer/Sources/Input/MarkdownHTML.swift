import Foundation

/// One inline run of a markdown block: its text and the styles it carries.
struct MarkdownSpan: Equatable, Sendable {
    var text: String
    var strong = false
    var emphasis = false
    var code = false
    var strike = false
    var link: URL?
    var lineBreak = false

    func sameStyle(as other: MarkdownSpan) -> Bool {
        strong == other.strong && emphasis == other.emphasis && code == other.code
            && strike == other.strike && link == other.link && !lineBreak && !other.lineBreak
    }
}

/// A block of a markdown document, the model both the HTML and the RTF renderers read.
indirect enum MarkdownBlock: Equatable, Sendable {
    case heading(level: Int, spans: [MarkdownSpan])
    case paragraph([MarkdownSpan])
    case code(language: String?, text: String)
    /// `start` is the first item's number; AttributedString numbers the rest from it.
    case list(ordered: Bool, start: Int, items: [[MarkdownBlock]])
    case quote([MarkdownBlock])
    case rule
    case table(rows: [MarkdownTableRow])
}

struct MarkdownTableRow: Equatable, Sendable {
    var header: Bool
    var cells: [[MarkdownSpan]]
}

/// The run walk: `AttributedString(markdown:)` runs → `MarkdownBlock`s, built from each run's
/// `presentationIntent` component stack (innermost first, each with an identity).
enum MarkdownBlocks {
    /// nil when the parser throws.
    static func parse(_ markdown: String) -> [MarkdownBlock]? {
        guard let attributed = try? AttributedString(
            markdown: markdown, options: .init(interpretedSyntax: .full))
        else { return nil }
        let root = Node(kind: nil, identity: -1)
        for run in attributed.runs {
            let span = span(of: run, text: String(attributed[run.range].characters))
            var node = root
            let components = run.presentationIntent?.components.reversed() ?? []
            if components.isEmpty {
                // Block HTML and anything else outside every block: one loose node per stretch.
                if let last = root.children.last, last.kind == nil {
                    node = last
                } else {
                    node = Node(kind: nil, identity: -1)
                    root.children.append(node)
                }
            }
            for component in components {
                if let last = node.children.last, last.identity == component.identity, last.kind != nil {
                    node = last
                } else {
                    let child = Node(kind: component.kind, identity: component.identity)
                    node.children.append(child)
                    node = child
                }
            }
            node.append(span)
        }
        return root.children.flatMap(\.blocks)
    }

    private static func span(of run: AttributedString.Runs.Run, text: String) -> MarkdownSpan {
        let inline = run.inlinePresentationIntent ?? []
        var span = MarkdownSpan(text: text)
        span.strong = inline.contains(.stronglyEmphasized)
        span.emphasis = inline.contains(.emphasized)
        span.code = inline.contains(.code)
        span.strike = inline.contains(.strikethrough)
        span.lineBreak = inline.contains(.lineBreak)
        span.link = run.link
        return span
    }

    private final class Node {
        let kind: PresentationIntent.Kind?
        let identity: Int
        var children: [Node] = []
        var spans: [MarkdownSpan] = []

        init(kind: PresentationIntent.Kind?, identity: Int) {
            self.kind = kind
            self.identity = identity
        }

        func append(_ span: MarkdownSpan) {
            if let last = spans.last, last.sameStyle(as: span) {
                spans[spans.count - 1].text += span.text
            } else {
                spans.append(span)
            }
        }

        var text: String { spans.map(\.text).joined() }

        /// The blocks this node stands for; a container the walk does not know gives its children's.
        var blocks: [MarkdownBlock] {
            switch kind {
            case .paragraph?:
                return [.paragraph(spans)]
            case .header(let level)?:
                return [.heading(level: min(max(level, 1), 6), spans: spans)]
            case .codeBlock(let language)?:
                let hint = language?.trimmingCharacters(in: .whitespaces)
                return [.code(language: hint?.isEmpty == false ? hint : nil, text: text)]
            case .thematicBreak?:
                return [.rule]
            case .orderedList?, .unorderedList?:
                let ordered: Bool
                if case .orderedList? = kind { ordered = true } else { ordered = false }
                var start = 1
                if case .listItem(let ordinal)? = children.first?.kind { start = ordinal }
                let items = children.map { item -> [MarkdownBlock] in
                    if case .listItem? = item.kind { return item.childBlocks }
                    return item.blocks
                }
                return [.list(ordered: ordered, start: start, items: items)]
            case .blockQuote?:
                return [.quote(childBlocks)]
            case .table?:
                let rows = children.map { row -> MarkdownTableRow in
                    var header = false
                    if case .tableHeaderRow? = row.kind { header = true }
                    return MarkdownTableRow(header: header, cells: row.children.map(\.spans))
                }
                return [.table(rows: rows)]
            case nil:
                // Block HTML: its text, escaped, as a paragraph.
                var spans = spans
                while let last = spans.last, last.text.hasSuffix("\n") {
                    spans[spans.count - 1].text = String(last.text.dropLast())
                    if spans[spans.count - 1].text.isEmpty { spans.removeLast() }
                }
                return spans.isEmpty ? [] : [.paragraph(spans)]
            default:
                return children.isEmpty ? (spans.isEmpty ? [] : [.paragraph(spans)]) : childBlocks
            }
        }

        var childBlocks: [MarkdownBlock] {
            var blocks = children.flatMap(\.blocks)
            if !spans.isEmpty { blocks.insert(.paragraph(spans), at: 0) }
            return blocks
        }
    }
}

public enum MarkdownHTML {
    /// markdown → an HTML fragment: every text run escaped, no `style` attributes, no <html>/<body> wrapper
    public static func html(fromMarkdown markdown: String) -> String {
        guard let blocks = MarkdownBlocks.parse(markdown) else {
            return "<p>\(escape(markdown))</p>"
        }
        var out = ""
        for block in blocks { render(block, into: &out) }
        return out
    }

    /// HTML → its plain text: tags stripped, entities decoded (named: amp lt gt quot apos nbsp; numeric &#NN; and &#xHH;), block ends (</p>, <br>, </h1..6>, </li>, </div>, </tr>, </blockquote>, </pre>) as one newline, runs of blank lines collapsed, trimmed
    public static func plainText(fromHTML html: String) -> String {
        var out = ""
        var index = html.startIndex
        while index < html.endIndex {
            let char = html[index]
            if char == "<", let close = html[index...].firstIndex(of: ">") {
                let tag = html[html.index(after: index)..<close]
                out += separator(forTag: tag)
                index = html.index(after: close)
            } else if char == "&", let semi = html[index...].prefix(12).firstIndex(of: ";"),
                let decoded = entity(html[html.index(after: index)..<semi])
            {
                out += decoded
                index = html.index(after: semi)
            } else {
                out.append(char)
                index = html.index(after: index)
            }
        }
        var lines: [Substring] = []
        for line in out.split(separator: "\n", omittingEmptySubsequences: false) {
            var line = line
            while let last = line.last, last == " " || last == "\t" { line = line.dropLast() }
            if !line.isEmpty { lines.append(line) }
        }
        return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: rendering

    private static func render(_ block: MarkdownBlock, into out: inout String) {
        switch block {
        case .heading(let level, let spans):
            out += "<h\(level)>\(inline(spans))</h\(level)>"
        case .paragraph(let spans):
            out += "<p>\(inline(spans))</p>"
        case .code(let language, let text):
            let attribute = language.map { " class=\"language-\(escape($0))\"" } ?? ""
            out += "<pre><code\(attribute)>\(escape(text))</code></pre>"
        case .list(let ordered, let start, let items):
            let tag = ordered ? "ol" : "ul"
            out += ordered && start != 1 ? "<ol start=\"\(start)\">" : "<\(tag)>"
            for item in items {
                out += "<li>"
                // A lone paragraph sits bare in its item, as a tight list renders it.
                let bare = item.filter { if case .paragraph = $0 { true } else { false } }.count == 1
                for child in item {
                    if bare, case .paragraph(let spans) = child {
                        out += inline(spans)
                    } else {
                        render(child, into: &out)
                    }
                }
                out += "</li>"
            }
            out += "</\(tag)>"
        case .quote(let blocks):
            out += "<blockquote>"
            for child in blocks { render(child, into: &out) }
            out += "</blockquote>"
        case .rule:
            out += "<hr>"
        case .table(let rows):
            out += "<table>"
            for row in rows {
                let cell = row.header ? "th" : "td"
                out += "<tr>" + row.cells.map { "<\(cell)>\(inline($0))</\(cell)>" }.joined() + "</tr>"
            }
            out += "</table>"
        }
    }

    private static func inline(_ spans: [MarkdownSpan]) -> String {
        spans.map { span in
            if span.lineBreak { return "<br>" }
            var html = escape(span.text)
            if span.code { html = "<code>\(html)</code>" }
            if span.strike { html = "<del>\(html)</del>" }
            if span.emphasis { html = "<em>\(html)</em>" }
            if span.strong { html = "<strong>\(html)</strong>" }
            if let link = span.link { html = "<a href=\"\(escape(link.absoluteString))\">\(html)</a>" }
            return html
        }.joined()
    }

    static func escape(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.utf8.count)
        for char in text {
            switch char {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            default: out.append(char)
            }
        }
        return out
    }

    // MARK: plain text

    private static let blockEnds: Set<String> = [
        "/p", "br", "br/", "/h1", "/h2", "/h3", "/h4", "/h5", "/h6", "/li", "/div", "/tr",
        "/blockquote", "/pre", "hr", "hr/", "ul", "ol", "table",
    ]

    private static func separator(forTag tag: Substring) -> String {
        let name = tag.trimmingCharacters(in: .whitespaces).lowercased()
            .prefix { !$0.isWhitespace }
        if blockEnds.contains(String(name)) { return "\n" }
        if name == "/td" || name == "/th" { return "\t" }
        return ""
    }

    private static func entity(_ body: Substring) -> String? {
        switch body {
        case "amp": return "&"
        case "lt": return "<"
        case "gt": return ">"
        case "quot": return "\""
        case "apos": return "'"
        case "nbsp": return "\u{00A0}"
        default: break
        }
        guard body.first == "#" else { return nil }
        let digits = body.dropFirst()
        let value: UInt32?
        if digits.first == "x" || digits.first == "X" {
            value = UInt32(digits.dropFirst(), radix: 16)
        } else {
            value = UInt32(digits, radix: 10)
        }
        return value.flatMap(Unicode.Scalar.init).map { String(Character($0)) }
    }
}
