import SwiftUI
import TempCodeClient
import UIKit

// The diff screen's measurements and colors. The model and its parsers are
// the client package's `DiffDocument`; this file keeps what needs UIKit.

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

    /// The column's geometry from these heights: where each hunk starts and
    /// which one the viewport's top is in.
    var layout: DiffLayout { DiffLayout(rowHeight: rowHeight, headerHeight: headerHeight) }

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

/// The diff's own motion, named as the kit names its rows: nothing in the
/// screen inlines a curve or a duration.
enum DiffMotion {
    /// Previous and next hunk: 250 ms on the strong ease-out `(0.23, 1, 0.32, 1)`
    /// to the header's exact offset.
    static let jump: Animation = .timingCurve(0.23, 1, 0.32, 1, duration: 0.25)

    /// The finger on a hunk: an interactive spring, so a hunk caught
    /// mid-settle blends to the finger instead of jumping.
    static let track: Animation = .interactiveSpring(response: 0.15, dampingFraction: 0.86, blendDuration: 0.25)

    /// The settle after a release: no bounce, 0.35 s plus 0.4 ms per point
    /// of travel, never past 0.6 s, so a long flick glides and a nudge stops.
    static func settle(travel: CGFloat) -> Animation {
        .spring(duration: min(0.6, 0.35 + travel * 0.0004), bounce: 0)
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
