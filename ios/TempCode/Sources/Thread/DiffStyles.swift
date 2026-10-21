import SwiftUI
import TempCodeClient
import TempCodeContract
import UIKit

// The diff screen's model and its measurements. Nothing here draws; the
// screen reads these so every row, header and gutter agrees on one number.

/// One line of a unified diff. `oldNo` is the old-side number of a deleted
/// line; `newNo` the new-side number of an added or kept line, as the host's
/// preview numbers them and as the desktop's DiffBody shows them.
nonisolated struct DiffLine: Hashable, Identifiable, Sendable {
    nonisolated enum Kind: Hashable, Sendable { case add, del, context }

    let id: Int
    let kind: Kind
    let oldNo: Int?
    let newNo: Int?
    let text: String

    /// The number the gutter shows: the old side for a delete, else the new.
    var number: Int? { kind == .del ? oldNo : newNo }

    /// The line as a unified diff writes it.
    var unified: String {
        switch kind {
        case .add: "+" + text
        case .del: "-" + text
        case .context: " " + text
        }
    }
}

/// A run of lines the diff shows together: between two hunks the file has
/// lines the edit never touched.
nonisolated struct DiffHunk: Hashable, Identifiable, Sendable {
    let id: Int
    /// The file, when the document spans several (a pull request's patch).
    let file: String?
    let lines: [DiffLine]
    let adds: Int
    let dels: Int
    /// The longest line in mono columns (a non-ASCII scalar counts two), for
    /// the horizontal reach.
    let widestChars: Int

    init(id: Int, file: String?, lines: [DiffLine]) {
        self.id = id
        self.file = file
        self.lines = lines
        adds = lines.count { $0.kind == .add }
        dels = lines.count { $0.kind == .del }
        widestChars = lines.map { line in line.text.unicodeScalars.reduce(0) { $0 + ($1.isASCII ? 1 : 2) } }.max() ?? 0
    }

    /// "12–40" on the new side when the hunk kept or added lines, else the
    /// old side it removed.
    var range: String {
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

    var unified: String { lines.map(\.unified).joined(separator: "\n") }

    var accessibilityLabel: String {
        var parts = [range]
        if let file { parts.insert(Board.fileName(file), at: 0) }
        if adds > 0 { parts.append("\(adds) added") }
        if dels > 0 { parts.append("\(dels) removed") }
        return parts.joined(separator: ", ")
    }
}

/// The whole change the screen shows, split into hunks.
nonisolated struct DiffDocument: Hashable, Sendable {
    let hunks: [DiffHunk]
    let adds: Int
    let dels: Int
    /// Digits of the widest line number, for the gutter's width.
    let digits: Int
    var lineCount: Int { hunks.reduce(0) { $0 + $1.lines.count } }
    var isEmpty: Bool { hunks.isEmpty }
    /// Several files in one document: a pull request's patch.
    var multiFile: Bool { Set(hunks.compactMap(\.file)).count > 1 }

    init(hunks: [DiffHunk]) {
        self.hunks = hunks
        adds = hunks.reduce(0) { $0 + $1.adds }
        dels = hunks.reduce(0) { $0 + $1.dels }
        let widest = hunks.lazy.flatMap(\.lines).compactMap(\.number).max() ?? 0
        digits = max(2, String(widest).count)
    }

    /// A tab is four columns in a mono row; `Text` would draw it as a wide blank.
    static func tidy(_ text: String) -> String {
        text.contains("\t") ? text.replacingOccurrences(of: "\t", with: "    ") : text
    }

    /// The host's preview lines of one or more edits to one file, in order.
    /// A jump or a step back on the new side starts a hunk, as the desktop's
    /// `previewToRows` draws a gap there; every edit starts one too.
    static func from(edits: [[ToolPreview.Line]]) -> DiffDocument {
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
    /// what the Inbox gets for a pull request.
    static func from(patch: String) -> DiffDocument {
        var hunks: [DiffHunk] = []
        var current: [DiffLine] = []
        var file: String?
        var oldNo = 1
        var newNo = 1
        /// Lines the `@@` header promised on each side; the hunk ends when
        /// both are spent, so a `+++ ` or `--- ` line inside it is content.
        var oldLeft = 0
        var newLeft = 0
        var id = 0
        var inHunk: Bool { oldLeft > 0 || newLeft > 0 }
        func close() {
            if !current.isEmpty { hunks.append(DiffHunk(id: hunks.count, file: file, lines: current)) }
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
                file = line.split(separator: " ").last.map { String($0.dropFirst($0.hasPrefix("b/") ? 2 : 0)) }
                continue
            }
            if line.hasPrefix("+++ ") {
                let named = line.dropFirst(4)
                if named != "/dev/null" { file = String(named.dropFirst(named.hasPrefix("b/") ? 2 : 0)) }
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
        return DiffDocument(hunks: hunks)
    }
}

/// The measurements one Dynamic Type size gives the diff: the mono step
/// (`footnote`, one below the `subheadline` rows), its advance width, and
/// the row height every line and the shimmer share.
struct DiffMetrics: Equatable {
    let pointSize: CGFloat
    let charWidth: CGFloat
    let rowHeight: CGFloat
    /// A hunk's sticky header: the footnote line with 10 pt around it, never under 28.
    let headerHeight: CGFloat

    init(size: DynamicTypeSize) {
        let traits = UITraitCollection(preferredContentSizeCategory: size.contentSizeCategory)
        pointSize = UIFont.preferredFont(forTextStyle: .footnote, compatibleWith: traits).pointSize
        let font = UIFont.monospacedSystemFont(ofSize: pointSize, weight: .regular)
        charWidth = ceil(("0" as NSString).size(withAttributes: [.font: font]).width * 2) / 2
        rowHeight = ceil(font.lineHeight) + 4
        headerHeight = max(28, ceil(UIFont.preferredFont(forTextStyle: .footnote, compatibleWith: traits).lineHeight) + 10)
    }

    /// Where each hunk's header starts in the column, every row and header
    /// being a fixed height: what the position in the bottom bar reads.
    func hunkStarts(_ document: DiffDocument) -> [CGFloat] {
        var starts: [CGFloat] = []
        var y: CGFloat = 0
        for hunk in document.hunks {
            starts.append(y)
            y += headerHeight + CGFloat(hunk.lines.count) * rowHeight
        }
        return starts
    }

    /// The hunk whose header is at or above the top of the viewport.
    func hunkIndex(at y: CGFloat, starts: [CGFloat]) -> Int {
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

    /// The pinned gutter: 8 pt, the widest number right-aligned, 6 pt, the
    /// sign in one character, 6 pt.
    func gutterWidth(digits: Int) -> CGFloat {
        8 + CGFloat(max(digits, 2)) * charWidth + 6 + charWidth + 6
    }

    func numberWidth(digits: Int) -> CGFloat {
        CGFloat(max(digits, 2)) * charWidth
    }
}

extension DynamicTypeSize {
    var contentSizeCategory: UIContentSizeCategory {
        switch self {
        case .xSmall: .extraSmall
        case .small: .small
        case .medium: .medium
        case .large: .large
        case .xLarge: .extraLarge
        case .xxLarge: .extraExtraLarge
        case .xxxLarge: .extraExtraExtraLarge
        case .accessibility1: .accessibilityMedium
        case .accessibility2: .accessibilityLarge
        case .accessibility3: .accessibilityExtraLarge
        case .accessibility4: .accessibilityExtraExtraLarge
        case .accessibility5: .accessibilityExtraExtraExtraLarge
        @unknown default: .large
        }
    }
}

/// The desktop's line tints: success and destructive at 10 % behind the
/// line, a 2 pt bar of the full color on the leading edge, the sign bold in
/// the color, context text at 70 %.
enum DiffPalette {
    static let tint: Double = 0.10
    static let bar: CGFloat = 2
    static let contextOpacity: Double = 0.7

    static func color(_ kind: DiffLine.Kind) -> Color? {
        switch kind {
        case .add: Tint.success
        case .del: Tint.destructive
        case .context: nil
        }
    }

    static func sign(_ kind: DiffLine.Kind) -> String {
        switch kind {
        case .add: "+"
        case .del: "−"
        case .context: ""
        }
    }
}
