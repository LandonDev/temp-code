import ActivityKit
import SwiftUI
import TempCodeContract
import WidgetKit

@main
struct TempCodeActivityBundle: WidgetBundle {
    var body: some Widget {
        ThreadActivityWidget()
    }
}

/// The working strip as a Live Activity: the lock screen banner carries the
/// glyph, the title and the strip line; the Dynamic Island shows the glyph
/// and the elapsed time compact, the same line expanded. Only what the strip
/// shows, in the strip's steps; nothing new visually.
struct ThreadActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ThreadActivityAttributes.self) { context in
            ThreadActivityBanner(attributes: context.attributes, state: context.state)
                .widgetURL(context.attributes.url(seq: context.state.seq))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    TypeGlyph(type: context.attributes.threadType, weight: .semibold)
                        .padding(.leading, 4)
                        .padding(.top, 2)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    StripLine(sessionId: context.attributes.sessionId, state: context.state)
                        .padding(.horizontal, 4)
                }
            } compactLeading: {
                TypeGlyph(type: context.attributes.threadType, weight: .semibold)
            } compactTrailing: {
                CompactMark(state: context.state)
            } minimal: {
                TypeGlyph(type: context.attributes.threadType, weight: .semibold)
            }
            .widgetURL(context.attributes.url(seq: context.state.seq))
        }
    }
}

/// The lock screen banner: a thread row's shape, the strip line under the title.
struct ThreadActivityBanner: View {
    let attributes: ThreadActivityAttributes
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            TypeGlyph(type: attributes.threadType, weight: .semibold)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text(attributes.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                StripLine(sessionId: attributes.sessionId, state: state)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .activityBackgroundTint(nil)
    }
}

/// The strip's content: the flavour word (or the settled phase) in the
/// secondary step, the elapsed time in tabular digits in the tertiary step.
/// A working thread's clock runs on the device; a paused or settled one is
/// frozen at the state's time, so the final state reads as it was.
struct StripLine: View {
    let sessionId: String
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 8) {
            if state.phase == .working {
                ProgressView()
                    .controlSize(.mini)
            } else {
                Circle()
                    .fill(state.phase.tint)
                    .frame(width: 7, height: 7)
                    .frame(width: 14, height: 14)
            }
            Text(state.phase == .working ? Flavour.word(seed: sessionId, now: Double(state.ts) / 1000) : state.phase.label)
                .foregroundStyle(.secondary)
            ElapsedText(state: state)
                .foregroundStyle(.tertiary)
            Spacer(minLength: 0)
        }
        .font(.footnote)
        .lineLimit(1)
    }
}

/// The compact trailing slot: the running clock, or the settled phase's dot.
struct CompactMark: View {
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        if state.phase == .working {
            ElapsedText(state: state)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 48)
        } else {
            Circle()
                .fill(state.phase.tint)
                .frame(width: 7, height: 7)
        }
    }
}

struct ElapsedText: View {
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        let since = Date(timeIntervalSince1970: Double(state.since) / 1000)
        let frozen = Date(timeIntervalSince1970: Double(state.ts) / 1000)
        Text(timerInterval: since...Date.distantFuture, pauseTime: state.phase == .working ? nil : max(since, frozen), countsDown: false, showsHours: true)
            .monospacedDigit()
    }
}

extension ThreadActivityAttributes.Phase {
    /// The status dot's colors: waiting warning, paused warning, failed destructive, finished success.
    var tint: Color {
        switch self {
        case .working: Tint.info
        case .paused, .waiting: Tint.warning
        case .finished: Tint.success
        case .failed: Tint.destructive
        }
    }
}
