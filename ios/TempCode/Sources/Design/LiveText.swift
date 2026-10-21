import SwiftUI

/// Text that changes while the user looks at it, done the one way the doc
/// allows: digits roll with `numericText` on `Motion.numeric` in tabular
/// figures; a line that is replaced cross-fades with 2 pt of blur and never
/// changes height. A sibling writes `ElapsedText(since:)` and nothing jitters.
extension View {
    /// Counts, elapsed, costs: tabular digits that roll instead of jumping.
    /// `value` is what changes; the animation rides on it.
    func numeric(_ value: some Equatable) -> some View {
        monospacedDigit()
            .contentTransition(.numericText())
            .animation(Motion.numeric, value: value)
    }
}

/// A number that rolls when it changes, in the stamp step (or any step
/// passed in). "3/7", "12", "$0.42": the caller formats, this animates.
struct CountText: View {
    let text: String
    var step: TextStep = .stamp
    var weight: Font.Weight = .regular

    init(_ text: String, step: TextStep = .stamp, weight: Font.Weight = .regular) {
        self.text = text
        self.step = step
        self.weight = weight
    }

    init(_ value: Int, step: TextStep = .stamp, weight: Font.Weight = .regular) {
        self.init(value.formatted(), step: step, weight: weight)
    }

    var body: some View {
        Text(text)
            .textStep(step, weight: weight)
            .numeric(text)
    }
}

/// A running elapsed since `since` (epoch ms), ticking each second in the
/// stamp step. Only live rows use it; a settled row shows `AgoText`.
struct ElapsedText: View {
    let since: Int
    var step: TextStep = .stamp

    init(since: Int, step: TextStep = .stamp) {
        self.since = since
        self.step = step
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let text = TimeFormat.elapsed(since: since, now: context.date)
            Text(text)
                .textStep(step)
                .numeric(text)
        }
    }
}

/// How long ago `ms` (epoch) was, refreshed every 30 s: "now", "3m", "2h", "Oct 3".
struct AgoText: View {
    let ms: Int
    var step: TextStep = .stamp

    init(_ ms: Int, step: TextStep = .stamp) {
        self.ms = ms
        self.step = step
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let text = TimeFormat.ago(ms, now: context.date)
            Text(text)
                .textStep(step)
                .numeric(text)
        }
    }
}

/// A line that is replaced in place (the last activity, a flavour word, a
/// status): the new text cross-fades over the old with 2 pt of blur, and
/// the line keeps one height throughout. `nil` leaves the space empty, at
/// the same height.
struct SwapText: View {
    let text: String?
    var step: TextStep = .meta
    var weight: Font.Weight = .regular
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(_ text: String?, step: TextStep = .meta, weight: Font.Weight = .regular) {
        self.text = text
        self.step = step
        self.weight = weight
    }

    var body: some View {
        ZStack(alignment: .leading) {
            // The sizer: one line of the step, never shown, so the height is fixed.
            Text(" ")
                .textStep(step, weight: weight)
                .hidden()
            if let text {
                Text(text)
                    .textStep(step, weight: weight)
                    .id(text)
                    .transition(Motion.swap(reduced: reduceMotion))
            }
        }
        .lineLimit(1)
        .animation(Motion.crossFade, value: text)
    }
}
