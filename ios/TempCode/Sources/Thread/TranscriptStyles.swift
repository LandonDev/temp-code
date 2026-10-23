import SwiftUI

/// The transcript's shared ingredients, the desktop's `index.css` and
/// `chip.ts` in SwiftUI: the content wash a code block or an edit card sits
/// on, the quiet line's type, the 1 px image outline, and the divider
/// a compaction or a handoff sits in. Shared across every row kind so the
/// transcript reads as one surface; lifted into Design/ at integration.
enum TranscriptStyle {
    /// A block that sits on the page: the desktop's `bg-content/6`.
    static let wash = Color.primary.opacity(0.06)
    /// A control at rest: the desktop's `bg-content/10`.
    static let control = Color.primary.opacity(0.10)
    /// The border every bordered block shares: the desktop's `border-content/10`.
    static let edge = Color.primary.opacity(0.10)
    /// Images carry a 1 px outline: pure black in light, pure white in dark, at 10 %.
    static let imageOutline = Color.primary.opacity(0.10)
    /// The desktop's 10 px block radius (code blocks, edit cards, chip bodies).
    static let blockRadius = Radius.block
    /// The icon box in an edit card: 20 pt square, 6 pt radius (10 − 4 of padding).
    static let iconBox: CGFloat = 20
    static let iconBoxRadius = Radius.inner
}

/// A row-height wash button inside a chip or card (the desktop's `rounded-md
/// bg-content/6 px-1`): the file in a chip, the title of a spawned agent.
struct InlineWash: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(TranscriptStyle.wash, in: .corner(Radius.inner))
    }
}

extension View {
    func inlineWash() -> some View { modifier(InlineWash()) }

    /// A bordered block: the wash, a hairline edge, the 10 pt radius.
    func transcriptBlock(radius: CGFloat = TranscriptStyle.blockRadius, tint: Color? = nil) -> some View {
        modifier(TranscriptBlock(radius: radius, tint: tint))
    }
}

private struct TranscriptBlock: ViewModifier {
    let radius: CGFloat
    let tint: Color?

    func body(content: Content) -> some View {
        content
            .background(TranscriptStyle.wash, in: .corner(radius))
            .hairlineBorder(RoundedRectangle.corner(radius), color: tint ?? TranscriptStyle.edge)
    }
}

/// A divider with words in it: "Context compacted", then "142k → 38k" and "2s" quieter, a
/// handoff. Hairlines either side, the text in the quiet step.
struct LabeledDivider<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        HStack(spacing: 12) {
            Hairline().frame(minWidth: 16)
            content
                .font(.footnote)
                .lineLimit(1)
                .layoutPriority(1)
            Hairline().frame(minWidth: 16)
        }
        .padding(.vertical, 10)
    }
}

/// The desktop's `Shimmer` (`.shimmer-text` in index.css): the words at 40 %
/// of the text colour with a band of full colour sweeping left to right
/// through them, 1.4 s a pass, linear, without a pause. The band's half
/// width is 2 pt per character, as the desktop's `--spread`. The sweep is a
/// gradient's offset under the text's own mask, read off a `TimelineView`,
/// so a frame moves one layer and lays nothing out; it stops while the row
/// is off screen. Reduce Motion holds the words still in the dim step.
struct ShimmerText: View {
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let period: TimeInterval = 1.4

    var body: some View {
        if reduceMotion {
            Text(text).foregroundStyle(.secondary)
        } else {
            Text(text)
                .foregroundStyle(Color.primary.opacity(0.4))
                .overlay {
                    GeometryReader { proxy in
                        let width = proxy.size.width
                        let spread = min(CGFloat(text.count) * 2, width)
                        TimelineView(.animation) { context in
                            let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: Self.period) / Self.period
                            // The band's centre runs from a quarter width before the words to a quarter past them.
                            let centre = (CGFloat(phase) * 1.5 - 0.25) * width
                            LinearGradient(colors: [.primary.opacity(0), .primary, .primary.opacity(0)], startPoint: .leading, endPoint: .trailing)
                                .frame(width: spread * 2)
                                .offset(x: centre - spread)
                        }
                    }
                    .mask { Text(text) }
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
        }
    }
}
