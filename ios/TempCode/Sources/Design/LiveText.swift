import SwiftUI

/// Text that changes in place while the screen shows: a line that swaps, a
/// count that rolls, a span that ticks. Each one carries the doc's motion
/// and its tabular digits, so a sibling writes `ElapsedText(since:)` and
/// nothing jitters.
extension View {
    /// Digits roll on change (`contentTransition(.numericText())`) over
    /// `Motion.numeric`, in tabular figures. `value` is what changes.
    func numeric(_ value: some Equatable) -> some View {
        monospacedDigit()
            .contentTransition(.numericText())
            .animation(Motion.numeric, value: value)
    }
}

/// A line replaced in place: the new text cross-fades in over 150 ms with
/// 2 pt of blur, the old one out, and the line never changes height.
struct SwapText: View {
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        ZStack(alignment: .leading) {
            Text(text)
                .id(text)
                .transition(Motion.swap(reduced: reduceMotion))
        }
        .animation(Motion.crossFade, value: text)
    }
}

/// A count whose digits roll toward the new value.
struct CountText: View {
    let value: Int

    init(_ value: Int) {
        self.value = value
    }

    var body: some View {
        Text(value, format: .number)
            .monospacedDigit()
            .contentTransition(.numericText(value: Double(value)))
            .animation(Motion.numeric, value: value)
    }
}

/// A running span since `since` (epoch ms) that ticks each second: "12s", "3m 4s".
struct ElapsedText: View {
    let since: Int

    init(since: Int) {
        self.since = since
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(TimeFormat.elapsed(since: since, now: context.date))
                .numeric(context.date)
        }
    }
}

/// How long ago `ms` (epoch) was, refreshed every half minute: "now", "3m", "2h", "Oct 3".
struct AgoText: View {
    let ms: Int

    init(_ ms: Int) {
        self.ms = ms
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            Text(TimeFormat.ago(ms, now: context.date))
                .monospacedDigit()
        }
    }
}
