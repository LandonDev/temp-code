import SwiftUI

/// The notes page's measure and spacing: the plan page's own (PlanType), plus
/// what the sections add. The sheet reads nothing else by number.
enum NotesStyles {
    static let measure = PlanType.measure
    static let inset = PlanType.inset
    static let pageTop = PlanType.pageTop
    static let pageBottom = PlanType.pageBottom
    /// Between two sections.
    static let sectionGap: CGFloat = 20
    /// Between a heading and its body.
    static let headingGap: CGFloat = 8
    /// The glyph's "changed" dot.
    static let dot: CGFloat = 6

    /// A section body's slot in the plan pages' cache: the host, the thread and the heading.
    static func key(_ environmentId: String, _ sessionId: String, _ heading: String) -> String {
        "notes/\(environmentId)/\(sessionId)/\(heading)"
    }
}
