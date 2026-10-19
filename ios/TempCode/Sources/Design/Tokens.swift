import SwiftUI

/// The visual system of docs/IOS-DESIGN.md: system colors by meaning, three
/// text steps, three radii, hairlines. Nothing else in the app names a color.
enum Tint {
    /// Chat type, starting and watching dots.
    static let info = Color(.systemBlue)
    /// Implementation type, `+n`, completed.
    static let success = Color(.systemGreen)
    /// Orchestration type, waiting, paused, the needs-you tint.
    static let warning = Color(.systemOrange)
    /// Errors, `−m`, failed tools.
    static let destructive = Color(.systemRed)
    /// Planning type.
    static let violet = Color(.systemPurple)
    /// Research type.
    static let cyan = Color(.systemCyan)
}

enum Surface {
    /// Content.
    static let background = Color(.systemBackground)
    /// Section headers, fields, the composer bar: the one gray step.
    static let chrome = Color(.secondarySystemBackground)
    /// Sheets and cards that float.
    static let raised = Color(.tertiarySystemBackground)
    static let hairline = Color(.separator)
    /// The needs-you row: warning at 8 %.
    static let needsYou = Tint.warning.opacity(0.08)
}

enum Radius {
    /// Chips and rows.
    static let row: CGFloat = 8
    /// Fields and cards: a row plus 4 pt of padding.
    static let field: CGFloat = 12
    /// Sheets.
    static let sheet: CGFloat = 16
}

/// A one-pixel rule in `separator`; the caller insets it to the text edge.
struct Hairline: View {
    @Environment(\.displayScale) private var scale

    var body: some View {
        Surface.hairline.frame(height: 1 / scale)
    }
}
