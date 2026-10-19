import Foundation

/// A heading-led section of a plan or report document.
public struct PlanSection: Sendable, Hashable {
    public var heading: String?
    public var level: Int
    public var body: String

    public init(heading: String?, level: Int, body: String) {
        self.heading = heading
        self.level = level
        self.body = body
    }
}

/// A research report: YAML-ish frontmatter (title, status, summary) plus body.
public struct Report: Sendable, Hashable {
    public var title: String?
    public var status: String?
    public var summary: String?
    public var body: String

    public init(title: String?, status: String?, summary: String?, body: String) {
        self.title = title
        self.status = status
        self.summary = summary
        self.body = body
    }

    public var isComplete: Bool { status == "complete" }
}

/// Pure readers for the plan and report files the views poll (the
/// desktop's planDoc.ts): headings split into sections, the task
/// checklist, the report's frontmatter.
public enum PlanDoc {
    /// Splits markdown into heading-led sections, ignoring headings in fences.
    public static func sections(_ md: String) -> [PlanSection] {
        var out: [PlanSection] = []
        var current = PlanSection(heading: nil, level: 0, body: "")
        var fence = false
        func push() {
            if !current.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { out.append(current) }
        }
        for raw in md.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { fence.toggle() }
            if !fence, let heading = heading(of: line, maxLevel: 3) {
                push()
                current = PlanSection(heading: heading.text, level: heading.level, body: line + "\n")
            } else {
                current.body += line + "\n"
            }
        }
        push()
        return out
    }

    /// The plan's task list: items under a heading that smells like tasks.
    public static func tasks(_ sections: [PlanSection]) -> [String] {
        guard let section = sections.first(where: { section in
            guard let heading = section.heading?.lowercased() else { return false }
            return heading.contains("task") || heading.contains("step") || heading.contains("milestone")
        }) else { return [] }
        return section.body.split(separator: "\n").compactMap { raw in
            guard let text = listItemText(String(raw)) else { return nil }
            var item = text
            for mark in ["[ ] ", "[x] ", "[X] "] where item.hasPrefix(mark) {
                item = String(item.dropFirst(mark.count))
                break
            }
            if item == "[ ]" || item == "[x]" || item == "[X]" { item = "" }
            return item.trimmingCharacters(in: .whitespaces)
        }
    }

    /// Ticked and unticked checklist items across the whole document.
    public static func progress(_ md: String) -> (done: Int, total: Int) {
        var done = 0
        var open = 0
        for raw in md.split(separator: "\n") {
            let trimmed = raw.drop { $0 == " " || $0 == "\t" }
            guard let first = trimmed.first, first == "-" || first == "*" else { continue }
            let rest = trimmed.dropFirst().drop { $0 == " " || $0 == "\t" }
            guard rest.count < trimmed.count - 1 else { continue }
            if rest.lowercased().hasPrefix("[x]") { done += 1 } else if rest.hasPrefix("[ ]") { open += 1 }
        }
        return (done, done + open)
    }

    /// The document's first H1, if any.
    public static func heading(_ md: String) -> String? {
        for raw in md.split(separator: "\n") {
            let line = String(raw)
            if line.hasPrefix("# "), let heading = heading(of: line, maxLevel: 1) { return heading.text }
        }
        return nil
    }

    public static func report(_ md: String) -> Report {
        var frontmatter = ""
        var body = md
        if md.hasPrefix("---\n"), let close = md.range(of: "\n---", range: md.index(md.startIndex, offsetBy: 4)..<md.endIndex) {
            frontmatter = String(md[md.index(md.startIndex, offsetBy: 4)..<close.lowerBound])
            var rest = md[close.upperBound...]
            if rest.hasPrefix("\n") { rest = rest.dropFirst() }
            body = String(rest)
        }
        func field(_ key: String) -> String? {
            for raw in frontmatter.split(separator: "\n") {
                guard raw.hasPrefix(key + ":") else { continue }
                var value = raw.dropFirst(key.count + 1).trimmingCharacters(in: .whitespaces)
                if value.count >= 2, let first = value.first, let last = value.last, first == last, first == "\"" || first == "'" {
                    value = String(value.dropFirst().dropLast())
                }
                return value.isEmpty ? nil : value
            }
            return nil
        }
        return Report(title: field("title") ?? heading(md), status: field("status"), summary: field("summary"), body: body)
    }

    // MARK: - helpers

    private static func heading(of line: String, maxLevel: Int) -> (level: Int, text: String)? {
        var level = 0
        var rest = Substring(line)
        while rest.first == "#", level < maxLevel {
            level += 1
            rest = rest.dropFirst()
        }
        guard level > 0, rest.first != "#", rest.first == " " || rest.first == "\t" else { return nil }
        let text = rest.trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : (level, text)
    }

    /// The text after a list marker ("- ", "* ", "1. ", "2) "), when the line is one.
    private static func listItemText(_ line: String) -> String? {
        let trimmed = line.drop { $0 == " " || $0 == "\t" }
        if let first = trimmed.first, first == "-" || first == "*" {
            let rest = trimmed.dropFirst()
            guard rest.first == " " || rest.first == "\t" else { return nil }
            let text = rest.drop { $0 == " " || $0 == "\t" }
            return text.isEmpty ? nil : String(text)
        }
        let digits = trimmed.prefix { $0.isNumber }
        guard !digits.isEmpty else { return nil }
        let afterDigits = trimmed.dropFirst(digits.count)
        guard let mark = afterDigits.first, mark == "." || mark == ")" else { return nil }
        let rest = afterDigits.dropFirst()
        guard rest.first == " " || rest.first == "\t" else { return nil }
        let text = rest.drop { $0 == " " || $0 == "\t" }
        return text.isEmpty ? nil : String(text)
    }
}
