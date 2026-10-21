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

/// The running row as a Live Activity. Lock screen: the card
/// (Shared/ThreadActivityViews.swift). Dynamic Island: compact leading is
/// the type glyph, compact trailing the tally or the clock, minimal the
/// status dot, expanded the card's rows across the island's regions. Every
/// presentation deep-links to the thread and the row the state names.
struct ThreadActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ThreadActivityAttributes.self) { context in
            ThreadActivityCard(attributes: context.attributes, state: context.state)
                .widgetURL(context.attributes.url(seq: context.state.seq))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    TypeGlyph(type: context.attributes.threadType, weight: .semibold)
                        .padding(.leading, 4)
                        .padding(.top, 3)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.title ?? context.attributes.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                        .padding(.top, 2)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    ElapsedText(state: context.state)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.trailing, 4)
                        .padding(.top, 3)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    ActivityExpandedBottom(type: context.attributes.threadType, state: context.state)
                }
            } compactLeading: {
                TypeGlyph(type: context.attributes.threadType, weight: .semibold)
            } compactTrailing: {
                ActivityCompactTrailing(type: context.attributes.threadType, state: context.state)
            } minimal: {
                ActivityMinimal(type: context.attributes.threadType, state: context.state)
            }
            .widgetURL(context.attributes.url(seq: context.state.seq))
            .keylineTint(context.attributes.threadType.tint)
        }
    }
}
