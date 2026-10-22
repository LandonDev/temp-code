import SwiftUI

/// The type and spacing of a set document: the plan page and the research
/// report. Headings step down from `title` to `headline`, each with more
/// space above than below; prose is `body` with a 4 pt lead; mono is one
/// step down (`callout`), the same step inline code takes in the transcript.
/// Lives beside the plan screen so the design foundations can lift it.
enum PlanType {
    /// The widest measure a page takes; on a phone the width is the measure.
    static let measure: CGFloat = 640
    /// The page's horizontal inset: the text edge every block aligns to.
    static let inset: CGFloat = 20
    /// Above the first block and below the last.
    static let pageTop: CGFloat = 12
    static let pageBottom: CGFloat = 32

    /// Between two blocks of prose.
    static let gap: CGFloat = 12
    /// Between the items of one list.
    static let itemGap: CGFloat = 6
    /// Extra lead for prose lines, on top of the font's own.
    static let lineSpacing: CGFloat = 4

    static func heading(_ level: Int) -> Font {
        switch level {
        case 1: .title.weight(.bold)
        case 2: .title2.weight(.semibold)
        case 3: .title3.weight(.semibold)
        default: .headline
        }
    }

    /// Large headings tighten by about −0.02 em of their point size: title
    /// (28 pt) −0.5, title2 (22 pt) −0.4, title3 (20 pt) −0.3 (a touch under
    /// the rule, next to body); headline and body 0.
    static func tracking(_ level: Int) -> CGFloat {
        switch level {
        case 1: -0.5
        case 2: -0.4
        case 3: -0.3
        default: 0
        }
    }

    /// Space above a heading, over the block gap: more than below it, more
    /// the larger it is.
    static func spaceAbove(_ level: Int) -> CGFloat {
        switch level {
        case 1: 16
        case 2: 14
        case 3: 10
        default: 6
        }
    }

    /// Space a heading leaves before the block under it, over the gap.
    static let spaceBelowHeading: CGFloat = -4

    /// A rule's breathing room on both sides.
    static let ruleInset: CGFloat = 6

    /// Code and tables: one step down from body.
    static let mono: Font.TextStyle = .callout
    static let table: Font = .subheadline

    /// A code block folds past this many lines.
    static let codeFold = 40
    /// Inside a code block, around the text.
    static let codePadding: CGFloat = 10
    /// A table cell longer than a short phrase wraps at this width.
    static let cellWrap: CGFloat = 280
    static let cellWrapAfter = 40
    /// The status and action row above the first block.
    static let headerHeight: CGFloat = 32
    static let headerBelow: CGFloat = 8
}
