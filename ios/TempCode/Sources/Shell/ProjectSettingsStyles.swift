import SwiftUI

/// The words and the two rows the project settings sections share, so no
/// value is written twice across the sheet, the editor and the sections.
enum SettingsCopy {
    static let useGlobal = "Use global setting"
    static let sameAsPlan = "Same as the plan"
    static let followingGlobal = "Following the global setting."
    static let builtInDefaults = "Built-in defaults."
    static let ownSetting = "This project's own setting."
    static let reviewsFooter = "A second model reads the branch before it lands on the project branch."
    static let plansFooter = "When the planner marks its plan complete, the build starts without a tap; the plan's own model unless one is fixed here."

    /// The second sentence of a section's footer: where its set comes from.
    static func source(follows: Bool, hasGlobal: Bool) -> String {
        follows ? (hasGlobal ? followingGlobal : builtInDefaults) : ownSetting
    }
}

/// "Use global setting": a plain accent button row. A grouped list keeps the
/// system highlight, so the row carries no press scale.
struct FollowRow: View {
    let action: () -> Void

    var body: some View {
        Button(SettingsCopy.useGlobal, action: action)
            .foregroundStyle(Color.accentColor)
    }
}

/// A label with a secondary value trailing, and a small spinner while the
/// value is still on its way.
struct ValueRow: View {
    let label: String
    let value: String
    var loading = false

    var body: some View {
        LabeledContent(label) {
            HStack(spacing: Layout.rowGap) {
                Text(value)
                    .foregroundStyle(.secondary)
                if loading {
                    ProgressView()
                        .controlSize(.small)
                }
            }
        }
    }
}
