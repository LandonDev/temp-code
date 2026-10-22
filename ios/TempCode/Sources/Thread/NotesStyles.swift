import SwiftUI

/// The notes page's measure and spacing, beside the plan page's; the sheet
/// reads nothing else by number.
enum NotesStyles {
    static let measure: CGFloat = 640
    static let inset: CGFloat = 20
    static let pageTop: CGFloat = 12
    static let pageBottom: CGFloat = 32
    /// Between two sections.
    static let sectionGap: CGFloat = 20
    /// Between a heading and its body.
    static let headingGap: CGFloat = 8
    /// The glyph's "changed" dot.
    static let dot: CGFloat = 6

    /// Each section's slot in the markdown cache: even, below the plan
    /// document's and the report's, inside the thread's scope, never a row's seq.
    static func seq(_ sessionId: String, _ index: Int) -> Int {
        ThreadCaches.documentSeq(sessionId) - 2 * (index + 1)
    }
}
