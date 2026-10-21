import SwiftUI
import TempCodeClient
import TempCodeContract

/// The implementation board's own pieces: its motion values, the progress
/// line under the goal, the todo status glyph and the swap between its
/// states. Shared tokens live in Design/; these are the board's alone.
enum BoardMotion {
    /// A status glyph trading places (circle → spinner → check): scale 0.25→1,
    /// opacity 0→1, blur 4→0 pt, a spring with no bounce.
    static let iconSwap: Animation = .spring(duration: 0.3, bounce: 0)
    static let iconSwapScale: CGFloat = 0.25
    static let iconSwapBlur: CGFloat = 4

    /// The progress fill reaching its new share: the row-expand spring.
    static let progress: Animation = Motion.expand

    /// The expand chevron's quarter turn rides the expand spring.
    static let chevron: Animation = Motion.expand

    /// The running row's field appearing on a row: the 150 ms cross-fade.
    static let field: Animation = Motion.crossFade

    /// An icon's swap: scale, opacity and blur together; opacity only under reduced motion.
    static func swap(reduced: Bool) -> AnyTransition {
        reduced
            ? .opacity
            : .modifier(active: IconSwap(scale: iconSwapScale, opacity: 0, blur: iconSwapBlur), identity: IconSwap(scale: 1, opacity: 1, blur: 0))
    }

    private struct IconSwap: ViewModifier {
        let scale: CGFloat
        let opacity: Double
        let blur: CGFloat

        func body(content: Content) -> some View {
            content
                .scaleEffect(scale)
                .opacity(opacity)
                .blur(radius: blur)
        }
    }
}

/// The board's metrics, scaled with the text they sit beside.
enum BoardMetrics {
    /// The status glyph's column; the text starts after it and a 10 pt gap.
    static let glyphColumn: CGFloat = 20
    static let glyphGap: CGFloat = 10
    /// The running row's field: the screen inset less 8, so the glyph column
    /// still starts 16 pt from the edge (8 of margin + 8 of padding).
    static let fieldInset: CGFloat = 8
    static let fieldPadding: CGFloat = 8
    /// A trace's leading edge: the text column, less a chip's own 8 pt.
    static let traceInset: CGFloat = 16 + glyphColumn + glyphGap - 8
}

/// The thin line under the goal: a 3 pt track, the done share in the
/// success tint, the task under way as the same tint at 35 % reaching one
/// step further. Reads as a shape at a glance; the count beside it is the
/// only number.
struct ProgressLine: View {
    let progress: BoardProgress
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(Color(.quaternarySystemFill))
                Capsule()
                    .fill(Tint.success.opacity(0.35))
                    .frame(width: max(0, width * progress.workingFraction))
                Capsule()
                    .fill(Tint.success)
                    .frame(width: max(0, width * progress.fraction))
            }
            .animation(reduceMotion ? nil : BoardMotion.progress, value: progress.fraction)
            .animation(reduceMotion ? nil : BoardMotion.progress, value: progress.workingFraction)
        }
        .frame(height: 3)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(progress.label) tasks done")
    }
}

/// A todo's state in one glyph: an outlined circle pending, the spinner in
/// the success tint while the harness works on it (a dotted circle when it
/// is in progress but the thread is not running), a filled check once done.
/// Stroke follows the regular weight of the text beside it; a state change
/// swaps the glyph with scale, opacity and blur together.
struct TodoStatusGlyph: View {
    let status: TodoStatus
    let live: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var key: String { live ? "live" : status.rawValue }

    var body: some View {
        ZStack {
            switch status {
            case .pending:
                Image(systemName: "circle")
                    .foregroundStyle(.tertiary)
            case .inProgress:
                if live {
                    ProgressView()
                        .controlSize(.small)
                        .tint(Tint.success)
                } else {
                    Image(systemName: "circle.dotted")
                        .foregroundStyle(.secondary)
                }
            case .completed:
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(Tint.success)
            }
        }
        .font(.subheadline)
        .id(key)
        .transition(BoardMotion.swap(reduced: reduceMotion))
        .animation(BoardMotion.iconSwap, value: key)
        .frame(width: BoardMetrics.glyphColumn)
        .accessibilityHidden(true)
    }
}
