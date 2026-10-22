import SwiftUI
import TempCodeClient

/// The segmented control under the header. The raised pill is bound to the
/// pager: `progress` is the pager's offset in pages, so during a swipe the
/// pill follows the finger and on a tap it settles with the drawer curve the
/// screen animates the page with. Each label's color follows the same
/// offset (a primary copy over a secondary one, weighted by how much of the
/// pill is under it), so the recolor is one movement with the pill, never a
/// swap of two states. A warning dot beside the inactive segment's label
/// marks a new needs-you card there; the label itself never moves. The
/// geometry is `SegmentRules`; this file only draws it.
struct SegmentBar: View {
    let segments: [ThreadSegment]
    let selected: ThreadSegment
    let dot: ThreadSegment?
    /// The pager's offset in pages, 0 ... segments.count - 1, continuous.
    let progress: CGFloat
    let onSelect: (ThreadSegment) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    /// The needs-you dot and its gap from the label, scaling with the label.
    @ScaledMetric(relativeTo: .subheadline) private var dotSize: CGFloat = 6
    @ScaledMetric(relativeTo: .subheadline) private var dotGap: CGFloat = 4

    /// Concentric: the track's radius is the pill's plus the inset between them.
    static let inset: CGFloat = 2
    static let pillRadius: CGFloat = 7
    static let trackRadius = Radius.around(pillRadius, padding: inset)
    static let height: CGFloat = 32

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(segments.enumerated()), id: \.element) { index, segment in
                Button {
                    onSelect(segment)
                } label: {
                    label(segment, weight: SegmentRules.weight(of: index, progress: progress, count: segments.count))
                        .frame(maxWidth: .infinity, minHeight: Self.height - 2 * Self.inset)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.pressable)
                .accessibilityLabel(segment.title)
                .accessibilityValue(segment == dot ? "Needs you" : "")
                .accessibilityAddTraits(segment == selected ? [.isSelected] : [])
                .accessibilityIdentifier("segment-\(segment.rawValue)")
            }
        }
        .padding(Self.inset)
        .animation(reduceMotion ? Motion.crossFade : Motion.expand, value: dot)
        .background { pill }
        .background(Surface.fill, in: RoundedRectangle.corner(Self.trackRadius))
        .padding(.horizontal, Layout.textEdge)
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Segment")
        .accessibilityIdentifier("thread-segments")
    }

    /// The label: the primary copy fades in over the secondary one as the
    /// pill arrives, the two sharing one press scale. The dot hangs off the
    /// text's trailing edge so the text never moves when it appears.
    private func label(_ segment: ThreadSegment, weight: CGFloat) -> some View {
        ZStack {
            Text(segment.title)
                .foregroundStyle(.secondary)
                .opacity(1 - weight)
                .accessibilityHidden(true)
            Text(segment.title)
                .foregroundStyle(.primary)
                .opacity(weight)
                .accessibilityHidden(true)
        }
        .font(.subheadline.weight(.medium))
        .lineLimit(1)
        .overlay(alignment: .trailing) {
            if segment == dot {
                Circle()
                    .fill(Tint.warning)
                    .frame(width: dotSize, height: dotSize)
                    .offset(x: dotSize + dotGap)
                    .transition(dotTransition)
                    .accessibilityHidden(true)
            }
        }
    }

    /// The raised pill: the raised step with a soft offset shadow in light, the step alone in dark.
    private var pill: some View {
        GeometryReader { geometry in
            let rect = SegmentRules.pillRect(progress: progress, count: segments.count, size: geometry.size, inset: Self.inset)
            RoundedRectangle.corner(Self.pillRadius)
                .fill(Surface.raised)
                .shadow(color: .black.opacity(scheme == .dark ? 0 : 0.12), radius: 2, y: 1)
                .frame(width: rect.width, height: rect.height)
                .offset(x: rect.minX, y: rect.minY)
        }
    }

    /// The dot appears like an icon trading state (scale, opacity and blur on
    /// `Motion.expand`, no bounce) and leaves by opacity; reduced motion fades both ways.
    private var dotTransition: AnyTransition {
        reduceMotion
            ? .opacity
            : .asymmetric(
                insertion: .modifier(active: DotIn(scale: 0.25, blur: 4, opacity: 0), identity: DotIn(scale: 1, blur: 0, opacity: 1)),
                removal: .opacity.animation(Motion.rowLeave)
            )
    }

    private struct DotIn: ViewModifier {
        let scale: CGFloat
        let blur: CGFloat
        let opacity: Double

        func body(content: Content) -> some View {
            content.scaleEffect(scale).blur(radius: blur).opacity(opacity)
        }
    }
}
