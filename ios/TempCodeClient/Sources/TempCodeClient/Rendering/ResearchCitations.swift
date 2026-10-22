import Foundation

/// One numbered source of a report: `[n]` in the prose resolves to it.
public struct Citation: Sendable, Hashable, Identifiable {
    public var number: Int
    public var url: String
    public var title: String?

    public init(number: Int, url: String, title: String? = nil) {
        self.number = number
        self.url = url
        self.title = title
    }

    public var id: Int { number }
}

/// What an angle's agent is doing right now, read off its last boarded row.
public enum AngleActivity: Sendable, Hashable {
    /// Its newest query has no source under it yet.
    case searching
    /// It has pages under its newest query and is working through them.
    case reading
}

extension ResearchAngle {
    /// The activity a live angle shows beside its name; nil before it boards anything.
    public var activity: AngleActivity? {
        guard let last = queries.last else { return nil }
        return last.sources.isEmpty ? .searching : .reading
    }
}

extension ResearchBoard {
    /// Every distinct url across the board, in the order it first arrived,
    /// carrying the first title seen for it. The citation index falls back
    /// to this order when the report has no sources list of its own.
    public var uniqueSources: [SourceRow] {
        var seen: Set<String> = []
        var out: [SourceRow] = []
        for angle in angles {
            for group in angle.queries {
                for source in group.sources where seen.insert(source.url).inserted {
                    out.append(source)
                }
            }
        }
        return out
    }

    /// The coverage line under the report pin: "3 sources · 2 searches · 1 of
    /// 2 angles done". Spawned angles count; the root's own research does not.
    /// Empty when nothing has happened yet.
    public static func coverage(sources: Int, searches: Int, angles: Int, done: Int) -> String {
        var parts: [String] = []
        if sources > 0 { parts.append("\(sources) source\(sources == 1 ? "" : "s")") }
        if searches > 0 { parts.append("\(searches) search\(searches == 1 ? "" : "es")") }
        if angles > 0 { parts.append("\(done) of \(angles) angle\(angles == 1 ? "" : "s") done") }
        return parts.joined(separator: " · ")
    }
}

/// The report's citations: `[n]` markers in its prose and the numbered
/// sources list they point at.
public enum ReportCitations {
    /// A `[n]` or `[n, m]` marker in a line of prose; a markdown link's
    /// `[text](url)` is left alone, as is a `[ ]` checkbox.
    public static var marker: Regex<(Substring, Substring)> { /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/ }

    /// The numbers a marker names: "[1]" is [1], "[2, 5]" is [2, 5].
    public static func numbers(in match: Substring) -> [Int] {
        match.split(separator: ",").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
    }

    /// The report body's own sources list, read from the first section whose
    /// heading says Sources or References: one item per line in any of the
    /// shapes an agent writes (`1. [Title](url)`, `[1] url — Title`,
    /// `1. url`). The number is the item's own when it carries one, else its
    /// position in the list. Without such a section, the board's distinct
    /// urls in arrival order stand in, so `[n]` still lands somewhere.
    public static func index(body: String, board: ResearchBoard) -> [Int: Citation] {
        let listed = sourcesList(body)
        if !listed.isEmpty { return Dictionary(listed.map { ($0.number, $0) }, uniquingKeysWith: { first, _ in first }) }
        var out: [Int: Citation] = [:]
        for (offset, source) in board.uniqueSources.enumerated() {
            out[offset + 1] = Citation(number: offset + 1, url: source.url, title: source.title)
        }
        return out
    }

    /// The citations the body lists, in order; empty without a sources section.
    public static func sourcesList(_ body: String) -> [Citation] {
        var inSection = false
        var out: [Citation] = []
        var position = 0
        for raw in body.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("#") {
                let heading = line.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces).lowercased()
                if inSection { break }
                inSection = heading.hasPrefix("source") || heading.hasPrefix("reference") || heading.hasPrefix("citation")
                continue
            }
            guard inSection, !line.isEmpty else { continue }
            guard let item = item(line) else { continue }
            position += 1
            out.append(Citation(number: item.number ?? position, url: item.url, title: item.title))
        }
        return out
    }

    private static var link: Regex<(Substring, Substring, Substring)> { /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/ }
    private static var bareUrl: Regex<Substring> { /https?:\/\/[^\s<>()\]]+/ }

    /// One sources-list line: its number when it leads with one, the first
    /// url on it, and the title (the link text, else the words beside the url).
    static func item(_ line: String) -> (number: Int?, url: String, title: String?)? {
        var rest = Substring(line)
        var number: Int?
        if rest.hasPrefix("["), let close = rest.firstIndex(of: "]"), let n = Int(rest[rest.index(after: rest.startIndex)..<close]) {
            number = n
            rest = rest[rest.index(after: close)...]
        } else {
            let marker = rest.drop { $0 == "-" || $0 == "*" || $0 == "+" || $0 == " " }
            let digits = marker.prefix { $0.isNumber }
            if !digits.isEmpty, let n = Int(digits), let mark = marker.dropFirst(digits.count).first, mark == "." || mark == ")" {
                number = n
                rest = marker.dropFirst(digits.count + 1)
            } else {
                rest = marker
            }
        }
        let text = rest.trimmingCharacters(in: .whitespaces)
        if let match = text.firstMatch(of: link) {
            let title = String(match.1).trimmingCharacters(in: .whitespaces)
            return (number, String(match.2), title.isEmpty ? nil : title)
        }
        guard let match = text.firstMatch(of: bareUrl) else { return nil }
        var url = String(match.0)
        while let last = url.last, ".,;:".contains(last) { url.removeLast() }
        let around = (text[..<match.range.lowerBound] + text[match.range.upperBound...])
            .trimmingCharacters(in: CharacterSet(charactersIn: " -–—:·|,"))
        return (number, url, around.isEmpty ? nil : around)
    }
}

// MARK: - the citation pass over a rendered document

extension ReportCitations {
    /// The scheme a superscript's link carries when the number resolves; the host is the number.
    public static let scheme = "tempcode-cite"
    /// The scheme of a number the report never lists: styled dim, linked nowhere.
    public static let missingScheme = "tempcode-cite-missing"

    /// Every `[n]` marker in the document's prose becomes a thin space and
    /// the numbers, each a run linked by scheme: `tempcode-cite://n` when
    /// `citations[n]` exists, `tempcode-cite-missing://n` otherwise. Code
    /// blocks and rules pass through, as does any block kind this pass does
    /// not know. No fonts or colors: the app styles the runs by scheme.
    public static func decorate(_ document: MarkdownDocument, citations: [Int: Citation]) -> MarkdownDocument {
        let blocks = document.blocks.map { block -> RenderedBlock in
            switch block {
            case .paragraph(let text): .paragraph(cite(text, citations: citations))
            case .heading(let level, let text): .heading(level, cite(text, citations: citations))
            case .list(let items, let ordered): .list(items.map { cite($0, citations: citations) }, ordered: ordered)
            case .quote(let text): .quote(cite(text, citations: citations))
            default: block
            }
        }
        return MarkdownDocument(blocks: blocks, textHash: document.textHash)
    }

    /// One line of prose with its markers replaced; a marker inside inline
    /// code (`rows[0]` is an index) is left as written.
    public static func cite(_ text: AttributedString, citations: [Int: Citation]) -> AttributedString {
        var styled = text
        let plain = String(styled.characters)
        for match in plain.matches(of: marker).reversed() {
            let numbers = Self.numbers(in: match.1)
            guard !numbers.isEmpty else { continue }
            let start = styled.characters.index(styled.startIndex, offsetBy: plain.distance(from: plain.startIndex, to: match.range.lowerBound))
            let end = styled.characters.index(start, offsetBy: plain.distance(from: match.range.lowerBound, to: match.range.upperBound))
            if styled[start..<end].runs.contains(where: { $0.inlinePresentationIntent?.contains(.code) == true }) { continue }
            var replacement = AttributedString("\u{2009}")
            for (offset, number) in numbers.enumerated() {
                if offset > 0 { replacement.append(AttributedString(",")) }
                var mark = AttributedString("\(number)")
                mark.link = URL(string: "\(citations[number] == nil ? missingScheme : scheme)://\(number)")
                replacement.append(mark)
            }
            styled.replaceSubrange(start..<end, with: replacement)
        }
        return styled
    }
}

/// How the report's blocks are laid out as a document: the title once, the
/// sources list as rows, the rest in runs of ordinary blocks.
public enum ReportLayout {
    public enum Piece: Sendable, Hashable {
        /// Consecutive ordinary blocks, rendered by the one markdown renderer.
        case blocks([RenderedBlock])
        /// The sources list as numbered reading-list rows.
        case sources([Citation])
    }

    /// Drops a leading H1 equal to the title (the lede shows it), swaps the
    /// one list under the first Sources / References / Citations heading for
    /// the citations it names when the counts match, and groups consecutive
    /// blocks so the view renders few block views. Anything else stays as
    /// the agent wrote it.
    public static func pieces(_ blocks: [RenderedBlock], title: String?, listed: [Citation]) -> [Piece] {
        var out: [Piece] = []
        var run: [RenderedBlock] = []
        var underSources = false
        var swapped = false
        func flush() {
            if !run.isEmpty { out.append(.blocks(run)) }
            run = []
        }
        for (index, block) in blocks.enumerated() {
            switch block {
            case .heading(let level, let text):
                let heading = String(text.characters).trimmingCharacters(in: .whitespaces)
                if index == 0, level == 1, let title, heading == title.trimmingCharacters(in: .whitespaces) { continue }
                let lower = heading.lowercased()
                underSources = !swapped && (lower.hasPrefix("source") || lower.hasPrefix("reference") || lower.hasPrefix("citation"))
                run.append(block)
            case .list(let items, _) where underSources && !listed.isEmpty && items.count == listed.count:
                flush()
                out.append(.sources(listed))
                underSources = false
                swapped = true
            default:
                run.append(block)
            }
        }
        flush()
        return out
    }
}
