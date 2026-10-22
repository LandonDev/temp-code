import SwiftUI
import TempCodeClient
import TempCodeContract

/// The implementation board's own pieces: the metrics the kit's lengths
/// derive, the pass wheel's colours, the progress line under the goal and
/// the todo status glyph. Motion, text steps, radii and tints are the
/// kit's (Design/); nothing here names a duration or a colour of its own.
enum BoardMetrics {
    /// The running row's field: the text edge less its own padding, so the
    /// glyph column still starts at `Layout.textEdge` (8 of margin + 8 of padding).
    static let fieldPadding: CGFloat = 8
    static let fieldInset: CGFloat = Layout.textEdge - fieldPadding
    /// A trace's leading edge: the text column, less a chip's own 8 pt so the
    /// chip's glyph lands on the column.
    static let traceInset: CGFloat = Layout.textEdge + Layout.glyphWidth + Layout.rowGap - 8
}

/// Every pass wears a colour, the same one in every thread and on the
/// desktop (`ImplementationBoard.passColors`): pass 1 green, pass 2 sky, and
/// so on around the wheel.
enum PassTint {
    static func color(_ passNumber: Int) -> Color {
        color(hex: ImplementationBoard.passColor(passNumber))
    }

    /// "#10b981" → a colour.
    private static func color(hex: String) -> Color {
        let value = UInt64(hex.dropFirst(), radix: 16) ?? 0
        return Color(red: Double((value >> 16) & 0xff) / 255, green: Double((value >> 8) & 0xff) / 255, blue: Double(value & 0xff) / 255)
    }
}

/// The thin line under the goal: a 3 pt track, the done share in the
/// success tint, the task under way as the same tint at 35 % reaching one
/// step further. Reads as a shape at a glance; the count beside it is the
/// only number. The fill moves on the row-expand spring (a value change of
/// a bar: no bounce).
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
            .animation(reduceMotion ? nil : Motion.expand, value: progress.fraction)
            .animation(reduceMotion ? nil : Motion.expand, value: progress.workingFraction)
        }
        .frame(height: 3)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(progress.label) tasks done")
    }
}

/// A todo's state in one glyph: an outlined circle pending, the spinner in
/// the success tint while the harness works on it (a dotted circle when it
/// is in progress but the thread is not running), a filled check once done.
/// The stroke follows the weight of the text beside it (medium on the live
/// row); a state change swaps the glyph with the kit's icon swap: scale
/// 0.25→1, opacity 0→1, blur 4→0 on a 300 ms spring with no bounce, a
/// cross-fade under reduced motion.
struct TodoStatusGlyph: View {
    let status: TodoStatus
    let live: Bool
    @ScaledMetric(relativeTo: .subheadline) private var width = Layout.glyphWidth

    private var key: String { live ? "live" : status.rawValue }

    var body: some View {
        ZStack {
            glyph
                .id(key)
                .iconSwapTransition()
        }
        .font(.subheadline.weight(live ? .medium : .regular))
        .animation(Motion.iconSwap, value: key)
        .frame(width: width)
        .accessibilityHidden(true)
    }

    @ViewBuilder private var glyph: some View {
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
}
