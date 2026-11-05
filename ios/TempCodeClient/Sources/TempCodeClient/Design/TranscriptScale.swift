import Foundation

/// The transcript's type and lengths as numbers, the desktop's ladder on
/// iOS text styles (docs/IOS-DESIGN.md "Visual system"). The app's
/// `TranscriptType` and `TranscriptMetrics` (Design/Tokens.swift) turn these
/// into fonts and frames; every size scales with Dynamic Type relative to
/// its style, and a line height keeps its ratio to the size, so a row height
/// is a minimum and never a clip.
public struct TypeSpec: Sendable, Equatable {
    /// The iOS text style a size scales with.
    public enum Style: String, Sendable {
        case subheadline, footnote, caption, callout
    }

    public enum Weight: String, Sendable {
        case regular, medium, semibold
    }

    public let style: Style
    /// The size at the default text size, in points.
    public let size: Double
    /// The line box at the default text size, in points.
    public let lineHeight: Double
    public let weight: Weight
    /// Tracking in em.
    public let tracking: Double
    public let mono: Bool

    public init(_ style: Style, _ size: Double, _ lineHeight: Double, weight: Weight = .regular, tracking: Double = 0, mono: Bool = false) {
        self.style = style
        self.size = size
        self.lineHeight = lineHeight
        self.weight = weight
        self.tracking = tracking
        self.mono = mono
    }

    /// The line box once Dynamic Type has scaled the size to `scaledSize`.
    public func lineHeight(atSize scaledSize: Double) -> Double {
        lineHeight * scaledSize / size
    }

    /// The spacing to add under a font whose natural line is `fontLine` so
    /// its lines sit `lineHeight(atSize:)` apart; never negative.
    public func lineSpacing(atSize scaledSize: Double, fontLine: Double) -> Double {
        max(0, lineHeight(atSize: scaledSize) - fontLine)
    }
}

public enum TranscriptScale {
    /// The agent's prose: 15 on 22.
    public static let prose = TypeSpec(.subheadline, 15, 22)
    /// Actions, the working and closing line, notices, a group's line and its cells: 13 on 20.
    public static let line = TypeSpec(.footnote, 13, 20)
    /// The steer word, the slot, the composer's row, a card's lines: 12 on 16.
    public static let detail = TypeSpec(.caption, 12, 16)
    /// A fence in the prose: 14 on 20 mono.
    public static let code = TypeSpec(.subheadline, 14, 20, mono: true)
    /// A command, its output, a diff: 12 on 20 mono.
    public static let rowCode = TypeSpec(.caption, 12, 20, mono: true)
    public static let proseH1 = TypeSpec(.subheadline, 17, 24, weight: .semibold, tracking: -0.01)
    public static let proseH2 = TypeSpec(.subheadline, 16, 22, weight: .semibold)
    public static let proseH3 = TypeSpec(.subheadline, 15, 22, weight: .semibold)
    /// A plan, a report, notes: 16 on 24.
    public static let document = TypeSpec(.callout, 16, 24)
    public static let documentH1 = TypeSpec(.callout, 20, 26, weight: .semibold, tracking: -0.01)
    public static let documentH2 = TypeSpec(.callout, 17, 24, weight: .semibold, tracking: -0.01)
    public static let documentH3 = TypeSpec(.callout, 16, 24, weight: .medium)

    /// Every token by name, for the tests and the guard.
    public static let all: [String: TypeSpec] = [
        "prose": prose, "line": line, "detail": detail, "code": code, "rowCode": rowCode,
        "proseH1": proseH1, "proseH2": proseH2, "proseH3": proseH3,
        "document": document, "documentH1": documentH1, "documentH2": documentH2, "documentH3": documentH3,
    ]
}

/// The transcript's lengths in points, the desktop's `ROW_GAP`, `STEP_LINE`
/// and composer numbers. Heights are minimums that grow with the text.
public enum TranscriptLengths {
    /// A lone row, the working and closing line, a group's line.
    public static let line: Double = 28
    /// A row inside an open group's table.
    public static let tableRow: Double = 32
    /// The glyph's slot, the gap after it, between two words of a row, after a value.
    public static let glyphSlot: Double = 14
    public static let glyphGap: Double = 8
    public static let wordGap: Double = 4
    public static let afterValue: Double = 8
    /// A table row's words from the frame.
    public static let tableInset: Double = 12
    public static let tableRadius: Double = 12
    public static let bodyRadius: Double = 8
    public static let bubbleRadius: Double = 12

    /// Above the first row, between turns, a bubble and its reply, two
    /// blocks, two lines, a line and the closing line, under the last row.
    public static let gapFirst: Double = 16
    public static let gapTurn: Double = 32
    public static let gapReply: Double = 16
    public static let gapBlock: Double = 12
    public static let gapLine: Double = 4
    public static let gapClosing: Double = 8
    public static let gapLast: Double = 16

    /// A bubble is at most this share of the column, padded 12 × 8.
    public static let bubbleMaxShare: Double = 0.85
    public static let bubblePaddingH: Double = 12
    public static let bubblePaddingV: Double = 8

    /// The transcript's column and a document's.
    public static let column: Double = 768
    public static let documentColumn: Double = 640

    /// The slot above the composer, the row under it, a control in either, the empty box.
    public static let slot: Double = 28
    public static let composerRow: Double = 24
    public static let composerControl: Double = 28
    public static let composerBox: Double = 46
    /// Every touch control reaches at least this.
    public static let hitArea: Double = 44
}
