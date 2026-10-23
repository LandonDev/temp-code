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

/// A host's running threads as one Live Activity (Shared/ThreadActivityViews.swift).
///
/// One thread: the running row. Lock screen, the card; compact leading the
/// type glyph while the thread is at work or held and the mark of its final
/// state once it settled, compact trailing the tally or the clock, minimal
/// the status dot, expanded the card's rows across the island's regions.
/// Every presentation deep-links to the thread and the row the state names.
///
/// Two or more: the lock screen lists them, needs-you first, each row opening
/// its thread and the card opening Home. Compact leading is the spinner with
/// the count at work, compact trailing the raised hand with the count that
/// needs the person (else the longest-running clock), minimal the raised hand
/// or the count at work, expanded the count and the clock on top with a line
/// per thread below; the keyline turns the needs-you color while anyone waits.
struct ThreadActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ThreadActivityAttributes.self) { context in
            ThreadActivityLockScreen(attributes: context.attributes, state: context.state)
        } dynamicIsland: { context in
            if context.state.isGroup {
                return Self.group(attributes: context.attributes, state: context.state)
            }
            let single = context.attributes.single(context.state)
            return Self.single(attributes: single.attributes, state: single.state)
        }
    }

    private static func single(attributes: ThreadActivityAttributes, state: ThreadActivityAttributes.ContentState) -> DynamicIsland {
        DynamicIsland {
            DynamicIslandExpandedRegion(.leading) {
                TypeGlyph(type: attributes.threadType, weight: .semibold)
                    .padding(.leading, 4)
                    .padding(.top, 3)
            }
            DynamicIslandExpandedRegion(.center) {
                Text(state.title ?? attributes.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .padding(.top, 2)
            }
            DynamicIslandExpandedRegion(.trailing) {
                ActivityElapsedText(state: state)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.trailing, 4)
                    .padding(.top, 3)
            }
            DynamicIslandExpandedRegion(.bottom) {
                ActivityExpandedBottom(type: attributes.threadType, state: state)
            }
        } compactLeading: {
            ActivityCompactLeading(type: attributes.threadType, state: state)
        } compactTrailing: {
            ActivityCompactTrailing(type: attributes.threadType, state: state)
        } minimal: {
            ActivityMinimal(type: attributes.threadType, state: state)
        }
        .widgetURL(attributes.url(seq: state.seq))
        .keylineTint(attributes.threadType.tint)
    }

    private static func group(attributes: ThreadActivityAttributes, state: ThreadActivityAttributes.ContentState) -> DynamicIsland {
        DynamicIsland {
            DynamicIslandExpandedRegion(.leading) {
                ActivityGroupHeadline(state: state)
                    .padding(.leading, 4)
                    .padding(.top, 3)
            }
            DynamicIslandExpandedRegion(.trailing) {
                ActivityElapsedText(state: state.longestRunning)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.trailing, 4)
                    .padding(.top, 3)
            }
            DynamicIslandExpandedRegion(.bottom) {
                ActivityGroupExpandedBottom(attributes: attributes, state: state)
            }
        } compactLeading: {
            ActivityGroupLeading(state: state)
        } compactTrailing: {
            ActivityGroupTrailing(state: state)
        } minimal: {
            ActivityGroupMinimal(state: state)
        }
        .widgetURL(ThreadActivityAttributes.homeURL)
        .keylineTint(state.groupTint)
    }
}
