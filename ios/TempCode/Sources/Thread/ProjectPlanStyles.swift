import SwiftUI

/// The values of the project-plan screen, named once: the milestone rows
/// under the document's `## Milestones` heading, the progress line, the
/// dependency chips and the options card. Everything sits on the plan page's
/// type (`PlanType`) and the design kit's lengths (`Layout`, `Radius`).
enum ProjectPlanType {
    // MARK: rows

    static let rowMinHeight: CGFloat = Layout.rowHeight
    /// The checkbox column: thread 9's list-marker column, scaled with
    /// `.body`, so the ordinals and the plan's numbered items share an edge.
    static let checkboxColumn: CGFloat = 26
    /// The checkbox glyph matches the body title, regular weight.
    static let checkboxGlyph: Font = .body
    static let checkboxHit: CGFloat = 44
    static let ordinalGap: CGFloat = 8
    static let titleFont: Font = .body
    /// Scope and done-when: one step down, secondary.
    static let detailFont: Font = .footnote
    /// The "Done when" label at the same step, semibold.
    static let detailLabelFont: Font = .footnote.weight(.semibold)
    /// Between the second lines.
    static let detailGap: CGFloat = 4
    static let rowVertical: CGFloat = 8

    // MARK: the progress line

    static let progressHeight: CGFloat = 3
    static let progressBelowHeading: CGFloat = 8
    static let progressBelow: CGFloat = 12

    // MARK: dependency chips

    static let chipFont: Font = .caption2
    /// Scaled with `.caption2`.
    static let chipHeight: CGFloat = 20
    static let chipPadding: CGFloat = 8
    static let chipGap: CGFloat = 6

    // MARK: the options card

    static let cardRadius: CGFloat = Radius.field
    static let cardInset: CGFloat = 12
    static let cardRowMinHeight: CGFloat = Layout.rowHeight
    /// Over the page's block gap, between the last section and the card.
    static let cardAbove: CGFloat = 24
    static let glyphColumn: CGFloat = Layout.glyphWidth
}
