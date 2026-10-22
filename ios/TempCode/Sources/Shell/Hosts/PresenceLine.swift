import SwiftUI
import TempCodeClient

/// One dim line of presence, cross-fading 150 ms in place on a change
/// (`Motion.crossFade`, with blur; opacity alone under reduced motion) and
/// never on first paint. `nil` draws nothing, at zero height: a paired host's
/// row gains no empty line. The line prints a time at most, so it re-renders
/// once a minute, never per frame.
struct PresenceLine: View {
    /// The text for `now`; nil draws nothing.
    let text: (Date) -> String?
    var step: TextStep = .meta
    @State private var painted = false

    init(step: TextStep = .meta, text: @escaping (Date) -> String?) {
        self.text = text
        self.step = step
    }

    var body: some View {
        TimelineView(.everyMinute) { context in
            let line = text(context.date)
            ZStack(alignment: .leading) {
                if let line {
                    Text(line)
                        .textStep(step)
                        .lineLimit(1)
                        .id(line)
                        .swapTransition()
                }
            }
            .animation(painted ? Motion.crossFade : nil, value: line)
        }
        .task { painted = true }
    }
}

/// Home's host header, under the name: "through box" and the presence for a
/// relayed host ("through box · locked since 9:14"); nothing for a paired one.
struct HostSubline: View {
    let client: EnvironmentClient
    let carrierName: String?

    var body: some View {
        if client.environment.isRelayed {
            PresenceLine(step: .stamp) { now in
                guard let presence = client.presence else { return carrierName.map { "through \($0)" } }
                return RelayWords.subline(presence, carrierName: carrierName ?? "", lockedSince: client.stateSince, now: now)
            }
        }
    }
}

/// The working strip's idle slot: the locked line ("The Mac is locked since
/// 9:14"), nothing in any other state and nothing on a paired host. Asleep
/// and unreachable speak through the composer's block line instead, so the
/// row says nothing twice. Drawn in the strip's own line shape so the fade
/// the strip runs on its phase carries it.
struct RelayStripLine: View {
    let client: EnvironmentClient

    var body: some View {
        if client.environment.isRelayed, let presence = client.presence {
            TimelineView(.everyMinute) { context in
                if let line = RelayWords.stripLine(presence, lockedSince: client.stateSince, now: context.date) {
                    HStack(spacing: 8) {
                        Text(line)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .font(.footnote)
                    .padding(.horizontal, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(.opacity)
                } else {
                    Color.clear
                }
            }
        } else {
            Color.clear
        }
    }
}
