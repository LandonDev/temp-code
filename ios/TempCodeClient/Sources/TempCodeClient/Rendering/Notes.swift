import Foundation
import TempCodeContract

/// One `## Heading` of a thread's notes and the text under it.
public struct NoteSection: Sendable, Hashable {
    public var heading: String
    public var body: String

    public init(heading: String, body: String) {
        self.heading = heading
        self.body = body
    }
}

/// A notes file split: what came before the first heading, then the sections as written.
public struct ParsedNotes: Sendable, Hashable {
    public var preamble: String
    public var sections: [NoteSection]

    public init(preamble: String, sections: [NoteSection]) {
        self.preamble = preamble
        self.sections = sections
    }
}

public enum NotesEditMode: Sendable {
    case replace
    case append
}

/// The Swift port of src/shared/notes.ts: a thread's working notes as text.
/// One markdown file with five fixed headings (Goal, Decisions, State,
/// Pointers, Open questions) that the thread keeps current and the person
/// may edit whole; the host's `session.notes.*` and the `notes` push carry
/// the same text. Pure, regex-free, line for line with the TypeScript.
public enum Notes {
    public static let sections = ["Goal", "Decisions", "State", "Pointers", "Open questions"]

    /// The canonical heading for a name the model or person typed (`state`, `Open Questions`).
    public static func canonical(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = trimmed.lowercased()
        return sections.first { $0.lowercased() == key } ?? trimmed
    }

    /// A `## Heading` line's name, or nil for any other line.
    private static func headingName(_ line: String) -> String? {
        guard line.hasPrefix("##") else { return nil }
        let rest = line.dropFirst(2)
        guard let first = rest.first, first.isWhitespace else { return nil }
        let name = rest.trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? nil : name
    }

    private static func lines(_ text: String) -> [String] {
        text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    }

    private static func trim(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func parse(_ text: String) -> ParsedNotes {
        var sections: [NoteSection] = []
        var preamble: [String] = []
        var current: (heading: String, body: [String])?
        for line in lines(text) {
            if let name = headingName(line) {
                if let current { sections.append(NoteSection(heading: current.heading, body: trim(current.body.joined(separator: "\n")))) }
                current = (canonical(name), [])
            } else if current != nil {
                current?.body.append(line)
            } else {
                preamble.append(line)
            }
        }
        if let current { sections.append(NoteSection(heading: current.heading, body: trim(current.body.joined(separator: "\n")))) }
        return ParsedNotes(preamble: trim(preamble.joined(separator: "\n")), sections: sections)
    }

    /// The fixed headings first, in their order (duplicates merged), then any the thread added.
    public static func ordered(_ sections: [NoteSection]) -> [NoteSection] {
        var byHeading: [String: String] = [:]
        var extras: [NoteSection] = []
        for section in sections {
            if Self.sections.contains(section.heading) {
                if let previous = byHeading[section.heading] {
                    byHeading[section.heading] = trim("\(previous)\n\n\(section.body)")
                } else {
                    byHeading[section.heading] = section.body
                }
            } else {
                extras.append(section)
            }
        }
        return Self.sections.map { NoteSection(heading: $0, body: byHeading[$0] ?? "") } + extras
    }

    /// Serialize with the fixed headings first, in their order, then any the
    /// thread added; every fixed heading is present even when empty, so a
    /// reader always sees the shape.
    public static func render(_ parsed: ParsedNotes) -> String {
        var parts: [String] = []
        if !parsed.preamble.isEmpty { parts.append(parsed.preamble) }
        for section in ordered(parsed.sections) {
            parts.append(section.body.isEmpty ? "## \(section.heading)" : "## \(section.heading)\n\n\(section.body)")
        }
        return parts.joined(separator: "\n\n") + "\n"
    }

    public static func empty() -> String {
        render(ParsedNotes(preamble: "", sections: []))
    }

    /// True when nothing has been written under any heading.
    public static func isEmpty(_ text: String) -> Bool {
        let parsed = parse(text)
        return parsed.preamble.isEmpty && parsed.sections.allSatisfy { $0.body.isEmpty }
    }

    /// Apply one section edit; a heading the file lacks is created in its
    /// canonical place. `append` adds a paragraph under the heading,
    /// `replace` swaps the whole body.
    public static func apply(_ text: String, section: String, mode: NotesEditMode = .replace, content: String) -> String {
        var parsed = parse(text)
        let heading = canonical(section)
        let content = trim(content.replacingOccurrences(of: "\r\n", with: "\n"))
        if let at = parsed.sections.firstIndex(where: { $0.heading == heading }) {
            let existing = parsed.sections[at].body
            parsed.sections[at].body = mode == .append ? (existing.isEmpty ? content : "\(existing)\n\n\(content)") : content
        } else {
            parsed.sections.append(NoteSection(heading: heading, body: content))
        }
        return render(parsed)
    }

    public static func body(of text: String, section: String) -> String {
        let heading = canonical(section)
        return parse(text).sections.first { $0.heading == heading }?.body ?? ""
    }

    /// The first line under State, stripped of list and checkbox markers:
    /// what a row shows while the thread waits on the person.
    public static func stateLine(_ text: String) -> String? {
        for raw in body(of: text, section: "State").components(separatedBy: "\n") {
            let line = trim(boldLabel(dropCheckbox(dropListMarker(raw))))
            if !line.isEmpty { return line }
        }
        return nil
    }

    /// `^\s*(?:[-*+]|\d+[.)])\s+` removed; the line untouched when it has no marker.
    private static func dropListMarker(_ line: String) -> String {
        var rest = Substring(line).drop { $0 == " " || $0 == "\t" }
        if let first = rest.first, "-*+".contains(first) {
            rest = rest.dropFirst()
        } else {
            let digits = rest.prefix { $0.isNumber }
            guard !digits.isEmpty else { return line }
            let after = rest.dropFirst(digits.count)
            guard let mark = after.first, mark == "." || mark == ")" else { return line }
            rest = after.dropFirst()
        }
        guard let space = rest.first, space.isWhitespace else { return line }
        return String(rest.drop { $0.isWhitespace })
    }

    /// `^\[[ xX]\]\s*` removed.
    private static func dropCheckbox(_ line: String) -> String {
        for mark in ["[ ]", "[x]", "[X]"] where line.hasPrefix(mark) {
            return String(line.dropFirst(mark.count).drop { $0.isWhitespace })
        }
        return line
    }

    /// `^\*\*(.+?)\*\*:?\s*` becomes `$1: `.
    private static func boldLabel(_ line: String) -> String {
        guard line.hasPrefix("**") else { return line }
        let inner = line.dropFirst(2)
        guard let close = inner.range(of: "**"), close.lowerBound > inner.startIndex else { return line }
        let label = inner[inner.startIndex..<close.lowerBound]
        var rest = inner[close.upperBound...]
        if rest.first == ":" { rest = rest.dropFirst() }
        return "\(label): " + rest.drop { $0.isWhitespace }
    }

    /// The notes without their empty headings: what a prompt or a digest embeds.
    public static func compact(_ text: String) -> String {
        let parsed = parse(text)
        var parts: [String] = []
        if !parsed.preamble.isEmpty { parts.append(parsed.preamble) }
        for section in ordered(parsed.sections) where !section.body.isEmpty {
            parts.append("## \(section.heading)\n\n\(section.body)")
        }
        return parts.joined(separator: "\n\n")
    }

    /// Notes inside a larger document: the section headings step down one level.
    public static func demoteHeadings(_ text: String) -> String {
        let demoted = lines(text).map { line -> String in
            guard line.hasPrefix("##"), let first = line.dropFirst(2).first, first.isWhitespace else { return line }
            return "### " + line.dropFirst(2).drop { $0.isWhitespace }
        }
        return trim(demoted.joined(separator: "\n"))
    }

    /// The notes as the first message of a successor thread (notes.ts `notesAsBrief`).
    public static func brief(_ text: String, title: String) -> String {
        let parsed = parse(text)
        var lines: [String] = ["Continue the work of thread \"\(title)\". Its notes, kept by that thread:", ""]
        if !parsed.preamble.isEmpty { lines += [parsed.preamble, ""] }
        for section in parsed.sections where !section.body.isEmpty {
            lines += ["**\(section.heading)**", "", section.body, ""]
        }
        lines.append("Start from State and Open questions; the Pointers name the files and commands that matter.")
        return trim(lines.joined(separator: "\n"))
    }

    /// What the sheet draws: the preamble and the sections in the fixed
    /// order with every fixed heading present; an empty text gives the five
    /// empty headings.
    public static func display(_ text: String) -> ParsedNotes {
        let parsed = parse(text)
        return ParsedNotes(preamble: parsed.preamble, sections: ordered(parsed.sections))
    }

    /// The glyph's dot: notes exist and changed after this device last read them.
    public static func unread(updatedAt: Double?, readAt: Double?) -> Bool {
        guard let updatedAt else { return false }
        return updatedAt > (readAt ?? 0)
    }

    /// Home's second line for a needs-you row: the State line of a waiting
    /// thread, else nil (the cue stays).
    public static func needsYouLine(waiting: Bool, text: String?) -> String? {
        guard waiting, let text else { return nil }
        return stateLine(text)
    }
}
