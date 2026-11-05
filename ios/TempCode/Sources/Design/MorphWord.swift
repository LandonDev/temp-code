import SwiftUI
import TempCodeClient

/// A short line of words that morphs when it changes, the desktop's
/// `MorphText` over the client's `MorphModel`: the old words lift and fade
/// on the swap curve, the new ones rise into their place; a cross-fade under
/// reduced motion. Frames run only while a morph is under way. Kept small so
/// a shared `MorphText` can take its place.
struct MorphWord: View {
    let text: String
    @State private var model: MorphModel?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static func now() -> Double { Date().timeIntervalSinceReferenceDate }

    var body: some View {
        let current = model ?? MorphModel(text, reduced: reduceMotion)
        TimelineView(.animation(paused: current.isStill)) { context in
            let shown = current.at(context.date.timeIntervalSinceReferenceDate)
            let pose = shown.pose(at: context.date.timeIntervalSinceReferenceDate)
            Text(shown.words)
                .offset(y: pose.offset)
                .opacity(pose.opacity)
        }
        .onChange(of: text) { old, next in
            var morph = model ?? MorphModel(old, reduced: reduceMotion)
            morph.set(next, at: Self.now())
            model = morph
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(morph.outDuration + morph.inDuration))
                guard var settled = model else { return }
                settled.tick(at: Self.now())
                model = settled
            }
        }
    }
}

private extension MorphModel {
    var isStill: Bool {
        if case .still = stage { return true }
        return false
    }

    /// The morph moved on to `now`, without touching the stored one.
    func at(_ now: Double) -> MorphModel {
        var copy = self
        copy.tick(at: now)
        return copy
    }
}
