import Foundation
import TempCodeContract

// The diff screen's model: the lines, the hunks they fall into, and the
// column's geometry from fixed heights. Nothing here draws; the screen reads
// these so every row, header, gutter and jump agrees on one number, and the
// package's tests can reach every rule.

/// One line of a unified diff. `oldNo` is the old-side number of a deleted
/// line; `newNo` the new-side number of an added or kept line, as the host's
/// preview numbers them and as the desktop's DiffBody shows them.
public struct DiffLine: Hashable, Identifiable, Sendable {
    public enum Kind: Hashable, Sendable { case add, del, context }

    public let id: Int
    public let kind: Kind
    public let oldNo: Int?
    public let newNo: Int?
    public let text: String

    public init(id: Int, kind: Kind, oldNo: Int?, newNo: Int?, text: String) {
        self.id = id
        self.kind = kind
        self.oldNo = oldNo
        self.newNo = newNo
        self.text = text
    }

    /// The number the gutter shows: the old side for a delete, else the new.
    public var number: Int? { kind == .del ? oldNo : newNo }

    /// The line as a unified diff writes it.
    public var unified: String {
        switch kind {
        case .add: "+" + text
        case .del: "-" + text
        case .context: " " + text
        }
    }
}

/// A run of lines the diff shows together: between two hunks the file has
/// lines the edit never touched.
public struct DiffHunk: Hashable, Identifiable, Sendable {
    public let id: Int
    /// The file, when the document spans several (a pull request's patch).
    public let file: String?
    public let lines: [DiffLine]
    public let adds: Int
    public let dels: Int
    /// The longest line in mono columns (a non-ASCII scalar counts two), for
    /// the horizontal reach.
    public let widestChars: Int

    public init(id: Int, file: String?, lines: [DiffLine]) {
        self.id = id
        self.file = file
        self.lines = lines
        adds = lines.count { $0.kind == .add }
        dels = lines.count { $0.kind == .del }
        widestChars = lines.map { line in line.text.unicodeScalars.reduce(0) { $0 + ($1.isASCII ? 1 : 2) } }.max() ?? 0
    }

    /// "12–40" on the new side when the hunk kept or added lines, else the
    /// old side it removed.
    public var range: String {
        let new = lines.compactMap(\.newNo)
        if let first = new.first, let last = new.last {
            return first == last ? "Line \(first)" : "Lines \(first)–\(last)"
        }
        let old = lines.compactMap(\.oldNo)
        if let first = old.first, let last = old.last {
            return first == last ? "Line \(first) removed" : "Lines \(first)–\(last) removed"
        }
        return "Lines"
    }

    public var unified: String { lines.map(\.unified).joined(separator: "\n") }

    public var accessibilityLabel: String {
        var parts = [range]
        if let file { parts.insert(Board.fileName(file), at: 0) }
        if adds > 0 { parts.append("\(adds) added") }
        if dels > 0 { parts.append("\(dels) removed") }
        return parts.joined(separator: ", ")
    }
}

/// The whole change the screen shows, split into hunks.
public struct DiffDocument: Hashable, Sendable {
    public let hunks: [DiffHunk]
    public let adds: Int
    public let dels: Int
    /// Digits of the widest line number, for the gutter's width.
    public let digits: Int
    public var lineCount: Int { hunks.reduce(0) { $0 + $1.lines.count } }
    public var isEmpty: Bool { hunks.isEmpty }
    /// Several files in one document: a pull request's patch.
    public var multiFile: Bool { Set(hunks.compactMap(\.file)).count > 1 }

    public init(hunks: [DiffHunk]) {
        self.hunks = hunks
        adds = hunks.reduce(0) { $0 + $1.adds }
        dels = hunks.reduce(0) { $0 + $1.dels }
        let widest = hunks.lazy.flatMap(\.lines).compactMap(\.number).max() ?? 0
        digits = max(2, String(widest).count)
    }

    /// A tab is four columns in a mono row; `Text` would draw it as a wide blank.
    public static func tidy(_ text: String) -> String {
        text.contains("\t") ? text.replacingOccurrences(of: "\t", with: "    ") : text
    }

    /// The host's preview lines of one or more edits to one file, in order.
    /// A jump or a step back on the new side starts a hunk, as the desktop's
    /// `previewToRows` draws a gap there; every edit starts one too. A line
    /// of a kind this build does not know draws as context.
    public static func from(edits: [[ToolPreview.Line]]) -> DiffDocument {
        var hunks: [DiffHunk] = []
        var current: [DiffLine] = []
        /// Deletions wait for the next numbered line: a replacement's deletes
        /// belong with its adds, on whichever side of a boundary those fall.
        var pendingDels: [DiffLine] = []
        var lastNew: Int?
        var id = 0
        func close() {
            current += pendingDels
            pendingDels = []
            if !current.isEmpty { hunks.append(DiffHunk(id: hunks.count, file: nil, lines: current)) }
            current = []
            lastNew = nil
        }
        for lines in edits {
            close()
            for line in lines {
                let number = line.number.flatMap { Int(exactly: $0) }
                switch line.kind {
                case .del:
                    pendingDels.append(DiffLine(id: id, kind: .del, oldNo: number, newNo: nil, text: tidy(line.text)))
                case .add, .context, .unknown:
                    if let number, let last = lastNew, number != last + 1 {
                        let held = pendingDels
                        pendingDels = []
                        close()
                        current = held
                    } else {
                        current += pendingDels
                        pendingDels = []
                    }
                    current.append(DiffLine(id: id, kind: line.kind == .add ? .add : .context, oldNo: nil, newNo: number, text: tidy(line.text)))
                    if let number { lastNew = number }
                }
                id += 1
            }
        }
        close()
        return DiffDocument(hunks: hunks)
    }

    /// A unified patch (`diff --git`, `@@ -a,b +c,d @@`), one or many files:
    /// what the Inbox gets for a pull request. `file` keeps that one file of
    /// a many-file patch, its hunks with no file of their own (the title
    /// names it); a file the patch lacks gives an empty document.
    public static func from(patch: String, file: String? = nil) -> DiffDocument {
        var hunks: [DiffHunk] = []
        var current: [DiffLine] = []
        var currentFile: String?
        var oldNo = 1
        var newNo = 1
        /// Lines the `@@` header promised on each side; the hunk ends when
        /// both are spent, so a `+++ ` or `--- ` line inside it is content.
        var oldLeft = 0
        var newLeft = 0
        var id = 0
        var inHunk: Bool { oldLeft > 0 || newLeft > 0 }
        func close() {
            if !current.isEmpty { hunks.append(DiffHunk(id: hunks.count, file: currentFile, lines: current)) }
            current = []
        }
        /// "-12,7" → (12, 7); "-12" → (12, 1); the token ends at the space.
        func range(_ text: Substring, after mark: Character) -> (start: Int, count: Int)? {
            guard let at = text.firstIndex(of: mark) else { return nil }
            let token = text[text.index(after: at)...].prefix { $0 != " " }
            let parts = token.split(separator: ",", maxSplits: 1)
            let start = parts.first.flatMap { Int($0) } ?? 1
            let count = parts.count > 1 ? (Int(parts[1]) ?? 1) : 1
            return (start, count)
        }
        for raw in patch.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            // A truncated patch may run out before the counts do: a new file
            // or hunk header always ends the one before it.
            if inHunk, line.hasPrefix("diff --git ") || line.hasPrefix("@@") {
                oldLeft = 0
                newLeft = 0
            }
            if inHunk {
                if line.hasPrefix("\\") { continue }
                if line.hasPrefix("+") {
                    current.append(DiffLine(id: id, kind: .add, oldNo: nil, newNo: newNo, text: tidy(String(line.dropFirst()))))
                    newNo += 1
                    newLeft -= 1
                } else if line.hasPrefix("-") {
                    current.append(DiffLine(id: id, kind: .del, oldNo: oldNo, newNo: nil, text: tidy(String(line.dropFirst()))))
                    oldNo += 1
                    oldLeft -= 1
                } else {
                    current.append(DiffLine(id: id, kind: .context, oldNo: oldNo, newNo: newNo, text: tidy(String(line.dropFirst(line.hasPrefix(" ") ? 1 : 0)))))
                    oldNo += 1
                    newNo += 1
                    oldLeft -= 1
                    newLeft -= 1
                }
                id += 1
                continue
            }
            if line.hasPrefix("diff --git ") {
                close()
                currentFile = line.split(separator: " ").last.map { String($0.dropFirst($0.hasPrefix("b/") ? 2 : 0)) }
                continue
            }
            if line.hasPrefix("+++ ") {
                let named = line.dropFirst(4)
                if named != "/dev/null" { currentFile = String(named.dropFirst(named.hasPrefix("b/") ? 2 : 0)) }
                continue
            }
            if line.hasPrefix("@@") {
                close()
                let header = line.dropFirst(2)
                let old = range(header, after: "-") ?? (1, 1)
                let new = range(header, after: "+") ?? (1, 1)
                oldNo = old.start
                newNo = new.start
                oldLeft = old.count
                newLeft = new.count
                continue
            }
        }
        close()
        if let file {
            hunks = hunks.filter { $0.file == file }.enumerated().map { DiffHunk(id: $0.offset, file: nil, lines: $0.element.lines) }
        }
        return DiffDocument(hunks: hunks)
    }
}

/// The column's geometry from fixed row and header heights: pure, so the
/// position indicator, the jump and the tests agree on one number.
public struct DiffLayout: Hashable, Sendable {
    public let rowHeight: CGFloat
    public let headerHeight: CGFloat

    public init(rowHeight: CGFloat, headerHeight: CGFloat) {
        self.rowHeight = rowHeight
        self.headerHeight = headerHeight
    }

    /// The height one hunk takes: its header and its rows.
    public func height(_ hunk: DiffHunk) -> CGFloat {
        headerHeight + CGFloat(hunk.lines.count) * rowHeight
    }

    /// The whole column's height.
    public func height(_ document: DiffDocument) -> CGFloat {
        document.hunks.reduce(0) { $0 + height($1) }
    }

    /// Where each hunk's header starts in the column: what the position in
    /// the bottom bar reads and where next and previous hunk scroll to.
    public func hunkStarts(_ document: DiffDocument) -> [CGFloat] {
        var starts: [CGFloat] = []
        var y: CGFloat = 0
        for hunk in document.hunks {
            starts.append(y)
            y += height(hunk)
        }
        return starts
    }

    /// The hunk whose header is at or above the top of the viewport; 0 when
    /// the document is empty.
    public func hunkIndex(at y: CGFloat, starts: [CGFloat]) -> Int {
        var low = 0
        var high = starts.count - 1
        var found = 0
        while low <= high {
            let mid = (low + high) / 2
            if starts[mid] <= y + 1 {
                found = mid
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        return found
    }
}
