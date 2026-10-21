import SwiftUI

/// The transcript's shared ingredients, the desktop's `index.css` and
/// `chip.ts` in SwiftUI: the content wash a code block or an edit card sits
/// on, the two small pills (a wash, and the near-black one for the primary
/// action), the quiet line's type, the 1 px image outline, and the divider
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
    static let blockRadius: CGFloat = 10
    /// The icon box in an edit card: 20 pt square, 6 pt radius (10 − 4 of padding).
    static let iconBox: CGFloat = 20
    static let iconBoxRadius: CGFloat = 6
}

/// The small action chip of the transcript, the desktop's `CHIP` and
/// `CHIP_ON`: a wash at rest, the near-black fill for the picked answer or
/// the primary action. Full width where the design doc puts actions under a
/// card. Press: scale 0.96 in 160 ms ease-out, like every other control.
struct TranscriptPill: View {
    let title: String
    var prominent = false
    var fill = true
    var busy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if busy {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(prominent ? Surface.background : .primary)
                }
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
            }
            .foregroundStyle(prominent ? Surface.background : .primary)
            .frame(maxWidth: fill ? .infinity : nil, minHeight: 36)
            .padding(.horizontal, 12)
            .background(prominent ? Color.primary : TranscriptStyle.control, in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
        }
        .buttonStyle(.pressable)
    }
}

/// A row-height wash button inside a chip or card (the desktop's `rounded-md
/// bg-content/6 px-1`): the file in a chip, the title of a spawned agent.
struct InlineWash: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(TranscriptStyle.wash, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
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
    @Environment(\.displayScale) private var scale

    func body(content: Content) -> some View {
        content
            .background(TranscriptStyle.wash, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(tint ?? TranscriptStyle.edge, lineWidth: 1 / scale))
    }
}

/// A divider with words in it: "Context compacted · 142k → 38k · 2s", a
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

/// The desktop's `Shimmer` word: a label sweeping light while something runs.
struct ShimmerText: View {
    let text: String
    @State private var phase: CGFloat = -1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Text(text)
            .foregroundStyle(.secondary)
            .overlay {
                if !reduceMotion {
                    GeometryReader { proxy in
                        LinearGradient(colors: [.clear, Color.primary.opacity(0.55), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: proxy.size.width * 0.7)
                            .offset(x: phase * proxy.size.width)
                    }
                    .mask(Text(text))
                }
            }
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.linear(duration: 1.4).repeatForever(autoreverses: false)) { phase = 1 }
            }
    }
}
