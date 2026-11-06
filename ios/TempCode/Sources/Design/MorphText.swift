import SwiftUI
import TempCodeClient

/// Words replacing words in place when a state changes (the working line's
/// phases, the working line becoming its closing line), the desktop's
/// `MorphText` and the client package's `MorphModel`: the old words lift
/// 3 pt and fade over `swapOut`, and only then do the new rise from 3 pt
/// below over `base`, both on the swap curve, so two sets of words are
/// never drawn in one place. While the new words arrive the box glides its
/// width from where it stood to theirs: they are laid out at their own
/// width and clipped by the box, never cut with an ellipsis mid-glide.
/// Keyed by `key`: new words under the same key (a count, a seconds
/// figure, a sentence growing) are drawn at once, and nothing moves on
/// mount. Reduced motion fades out, then in, `fast` each, with no lift and
/// no glide.
struct MorphText<Value: Equatable, Content: View>: View {
    let key: String
    let value: Value
    @ViewBuilder let content: (Value) -> Content

    @Environment(\.accessibilityReduceMotion) private var reduced
    private enum Stage { case still, leaving, arriving }
    @State private var stage = Stage.still
    /// The words still on screen while they leave; nil draws `value`.
    @State private var leaving: Value?
    @State private var offset: CGFloat = 0
    @State private var opacity: Double = 1
    /// The box's width while a morph runs; nil is the words' own.
    @State private var boxWidth: CGFloat?
    @State private var shownWidth: CGFloat = 0
    @State private var targetWidth: CGFloat = 0
    /// A newer morph makes an older one's completion stale.
    @State private var generation = 0

    private struct Keyed: Equatable {
        let key: String
        let value: Value
    }

    var body: some View {
        content(leaving ?? value)
            .lineLimit(1)
            .fixedSize(horizontal: stage == .arriving && !reduced, vertical: false)
            .offset(y: offset)
            .opacity(opacity)
            .frame(width: boxWidth, alignment: .leading)
            .clipped()
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { shownWidth = $0 }
            // The arriving words at the width they will take, never shown: the
            // glide's end. Measured behind the box, never sizing it, so the box
            // keeps the old words' width until the glide carries it over.
            .background(alignment: .leading) {
                content(value)
                    .lineLimit(1)
                    .fixedSize()
                    .environment(\.measuring, true)
                    .hidden()
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { targetWidth = $0 }
                    .accessibilityHidden(true)
            }
            .onChange(of: Keyed(key: key, value: value)) { old, new in
            guard old.key != new.key else { return }
            morph(from: old.value)
        }
    }

    private func morph(from old: Value) {
        generation += 1
        // A morph already leaving takes the newest words when it arrives.
        guard stage != .leaving else { return }
        Motion.withoutAnimation {
            leaving = old
            boxWidth = reduced ? nil : shownWidth
        }
        stage = .leaving
        withAnimation(reduced ? Motion.fast : Motion.swapOut) {
            offset = reduced ? 0 : -Motion.morphLift
            opacity = 0
        } completion: {
            arrive()
        }
    }

    private func arrive() {
        let current = generation
        Motion.withoutAnimation {
            leaving = nil
            stage = .arriving
            offset = reduced ? 0 : Motion.morphLift
        }
        withAnimation(reduced ? Motion.fast : Motion.swapIn) {
            offset = 0
            opacity = 1
            if !reduced { boxWidth = targetWidth }
        } completion: {
            guard current == generation else { return }
            stage = .still
            Motion.withoutAnimation { boxWidth = nil }
        }
    }
}

extension EnvironmentValues {
    /// Drawn only to be measured (`MorphText`'s glide target): nothing in it loops.
    @Entry var measuring = false
}
