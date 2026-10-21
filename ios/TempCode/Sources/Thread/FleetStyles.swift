import SwiftUI
import TempCodeClient
import TempCodeContract

/// The pieces every fleet surface is built from: the desktop's agent row
/// (FleetPanel's AgentRow) made for a phone, its status mark, the provider
/// mark, the one-line meta, the activity line that swaps in place, the
/// stats, and the sectioned list that FleetView and SubagentListScreen share.
/// Shared with the Design foundations only through their tokens; nothing
/// here names a color or a duration of its own.

// MARK: - routes

/// A subagent's detail, pushed from any fleet row.
struct AgentDetailRoute: Hashable {
    let agentId: String
    var parentCwd: String?
}

extension View {
    /// The fleet's push destinations. Declared by every screen that shows
    /// fleet rows, so a list pushed from a chat still resolves them.
    func fleetDestinations(client: EnvironmentClient) -> some View {
        navigationDestination(for: AgentDetailRoute.self) { route in
            AgentDetailScreen(client: client, agentId: route.agentId, parentCwd: route.parentCwd)
        }
    }
}

// MARK: - motion

/// Row moves inside a fleet (a row joining Waiting, a row settling into
/// Done): the design doc's needs-you row motion, with its own exit speed.
enum FleetMotion {
    static func rowChange(reduced: Bool) -> AnyTransition {
        if reduced {
            return .asymmetric(
                insertion: .opacity.animation(Motion.rowAppear),
                removal: .opacity.animation(Motion.rowLeave)
            )
        }
        return .asymmetric(
            insertion: .opacity.combined(with: .offset(y: Motion.travel)).animation(Motion.rowAppear),
            removal: .opacity.animation(Motion.rowLeave)
        )
    }
}

// MARK: - marks

/// The provider's own mark (the desktop's HarnessIcon), drawn as a path so
/// it scales with the text beside it and takes the text's color. Providers
/// without a mark here show a generic chip.
struct ProviderGlyph: View {
    let provider: ProviderId
    @ScaledMetric(relativeTo: .footnote) private var size: CGFloat = 12

    var body: some View {
        Group {
            switch provider {
            case .claude:
                FilledPaths(paths: [Self.claude])
            case .codex:
                FilledPaths(paths: [Self.codex])
            case .cursor:
                FilledPaths(paths: [Self.cursor])
            default:
                Image(systemName: "cpu")
                    .font(.caption2)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(label)
    }

    private var label: String {
        switch provider {
        case .claude: "Claude"
        case .codex: "Codex"
        case .cursor: "Cursor"
        default: provider.rawValue.prefix(1).uppercased() + provider.rawValue.dropFirst()
        }
    }

    // src/renderer/src/assets/providers/*.svg, each in a 29-unit box.
    private static let claude = "M5.684 19.285L11.397 16.095L11.484 15.805L11.397 15.66H11.107L10.15 15.602L6.902 15.515L4.06 15.37L1.305 15.225L0.609 15.08L0 14.21L0.058 13.775L0.638 13.398L1.479 13.456L3.306 13.601L6.061 13.775L8.062 13.891L11.02 14.239H11.484L11.542 14.036L11.397 13.92L11.281 13.804L8.41 11.89L5.336 9.86L3.712 8.671L2.842 8.091L2.407 7.511L2.233 6.293L3.016 5.423L4.089 5.51L4.35 5.568L5.423 6.409L7.743 8.178L10.73 10.44L11.165 10.788L11.339 10.672L11.368 10.585L11.165 10.266L9.57 7.25L7.83 4.234L7.047 2.987L6.844 2.233C6.757 1.943 6.728 1.653 6.728 1.363L7.598 0.145L8.12 0L9.338 0.174L9.802 0.58L10.556 2.32L11.745 5.017L13.63 8.671L14.21 9.773L14.5 10.759L14.587 11.049H14.79V10.904L14.935 8.816L15.225 6.293L15.515 3.045L15.602 2.117L16.066 1.015L16.936 0.435L17.69 0.754L18.27 1.595L18.183 2.117L17.864 4.35L17.11 7.859L16.675 10.237H16.936L17.226 9.918L18.415 8.352L20.416 5.858L21.286 4.843L22.33 3.77L22.997 3.248H24.244L25.143 4.611L24.737 6.032L23.461 7.656L22.388 9.019L20.851 11.078L19.923 12.731L20.01 12.847H20.213L23.693 12.093L25.549 11.774L27.753 11.397L28.768 11.861L28.884 12.325L28.478 13.311L26.1 13.891L23.316 14.471L19.169 15.428L19.111 15.457L19.169 15.544L21.025 15.718L21.837 15.776H23.809L27.463 16.066L28.42 16.646L28.971 17.429L28.884 18.009L27.405 18.763L25.433 18.299L20.793 17.197L19.227 16.82H18.995V16.936L20.329 18.241L22.736 20.416L25.81 23.229L25.955 23.925L25.578 24.505L25.172 24.447L22.504 22.417L21.46 21.547L19.14 19.575H18.995V19.778L19.517 20.561L22.359 24.824L22.504 26.129L22.301 26.535L21.547 26.825L20.764 26.651L19.082 24.331L17.342 21.721L15.979 19.343L15.834 19.459L14.993 28.217L14.616 28.652L13.746 29L13.021 28.42L12.615 27.55L13.021 25.752L13.485 23.432L13.862 21.576L14.21 19.285L14.413 18.531V18.473H14.21L12.47 20.88L9.86 24.447L7.772 26.651L7.279 26.854L6.409 26.419L6.496 25.607L6.96 24.94L9.86 21.228L11.6 18.937L12.76 17.603L12.731 17.458H12.644L4.988 22.446L3.625 22.62L3.045 22.04L3.103 21.17L3.393 20.88L5.713 19.285H5.684Z"
    private static let codex = "M10.0958 1.51649C11.1796 1.07057 12.3596 0.909459 13.5233 1.0485C15.0233 1.22099 16.3598 1.85848 17.5328 2.96096C17.5478 2.97596 17.5688 2.98645 17.5883 2.99245C17.6095 2.99767 17.6316 2.99767 17.6528 2.99245C19.1778 2.59865 20.792 2.74439 22.2218 3.40495L22.2923 3.43794L22.4663 3.52344C23.963 4.28199 25.1304 5.56192 25.7483 7.12186C26.0619 7.88684 26.2178 8.68333 26.2208 9.51431C26.2434 10.1323 26.1757 10.7503 26.0199 11.3488C26.0122 11.379 26.0123 11.4106 26.0201 11.4408C26.028 11.471 26.0434 11.4987 26.0648 11.5213C26.9559 12.4317 27.5469 13.5162 27.8394 14.7762C28.2729 16.9136 27.8289 18.8411 26.5089 20.5571L26.3049 20.8061C25.4306 21.8068 24.2831 22.5304 23.0033 22.888C22.9756 22.8961 22.9501 22.9107 22.929 22.9305C22.9079 22.9503 22.8917 22.9748 22.8818 23.002C22.5953 23.8285 22.3073 24.5365 21.7718 25.243C20.4218 27.0234 18.4388 28.0119 16.2053 27.9999C14.4248 27.9909 12.8468 27.3399 11.4698 26.0469C11.4491 26.0275 11.4236 26.014 11.3959 26.0077C11.3682 26.0014 11.3394 26.0025 11.3123 26.0109C10.7303 26.1984 10.1423 26.2254 9.50627 26.2179C8.49326 26.2098 7.49546 25.9707 6.58875 25.519C5.63899 25.0483 4.81209 24.3627 4.17374 23.5165C3.94574 23.2135 3.71924 22.9285 3.55274 22.591C3.32543 22.1279 3.1397 21.6455 2.99773 21.1495C2.69803 20.021 2.69081 18.8347 2.97673 17.7026C2.98614 17.6757 2.98922 17.6469 2.98573 17.6186C2.9806 17.5908 2.96635 17.5655 2.94523 17.5466C2.25233 16.8453 1.72274 15.9997 1.39423 15.0702C1.17575 14.4976 1.0487 13.8943 1.01772 13.2822C0.96323 12.4761 1.03458 11.6664 1.22922 10.8823C1.73473 9.21431 2.70223 7.90484 4.12874 6.95536C4.44674 6.74387 4.74824 6.57887 5.03024 6.46038C5.35275 6.32688 5.67525 6.21438 5.99925 6.11988C6.0224 6.1127 6.04342 6.09991 6.06043 6.08263C6.07745 6.06536 6.08992 6.04415 6.09675 6.02089C6.34277 5.13747 6.76584 4.31329 7.34026 3.59844C8.06436 2.67897 9.01345 1.96188 10.0958 1.51649ZM15.3188 17.3636C15.075 17.3773 14.8457 17.4838 14.678 17.6612C14.5103 17.8386 14.4168 18.0735 14.4168 18.3176C14.4168 18.5618 14.5103 18.7966 14.678 18.974C14.8457 19.1514 15.075 19.2579 15.3188 19.2716H20.7728C20.9026 19.2789 21.0325 19.2596 21.1546 19.2149C21.2767 19.1703 21.3883 19.1012 21.4828 19.0119C21.5772 18.9226 21.6525 18.815 21.7039 18.6956C21.7553 18.5762 21.7818 18.4476 21.7818 18.3176C21.7818 18.1876 21.7553 18.059 21.7039 17.9396C21.6525 17.8203 21.5772 17.7126 21.4828 17.6233C21.3883 17.534 21.2767 17.4649 21.1546 17.4203C21.0325 17.3756 20.9026 17.3564 20.7728 17.3636H15.3188ZM9.19276 10.3453C9.06296 10.1339 8.856 9.98123 8.61567 9.91965C8.37534 9.85806 8.12048 9.89237 7.90499 10.0153C7.6895 10.1382 7.53028 10.3402 7.461 10.5784C7.39172 10.8166 7.41781 11.0724 7.53376 11.2918L9.44177 14.6277L7.54276 17.8316C7.47884 17.9395 7.43678 18.0588 7.419 18.1829C7.40122 18.307 7.40805 18.4334 7.43911 18.5549C7.47017 18.6763 7.52485 18.7905 7.60003 18.8908C7.67521 18.9911 7.76941 19.0757 7.87726 19.1396C7.98511 19.2035 8.10449 19.2456 8.22859 19.2633C8.35269 19.2811 8.47908 19.2743 8.60054 19.2432C8.722 19.2122 8.83615 19.1575 8.93648 19.0823C9.03681 19.0071 9.12134 18.9129 9.18526 18.8051L11.3663 15.1227C11.4523 14.9776 11.4983 14.8123 11.4996 14.6437C11.5009 14.4751 11.4575 14.3091 11.3738 14.1627L9.19276 10.3453Z"
    private static let cursor = "M26.5001 6.86227L15.0931 0.161574C14.913 0.055725 14.7086 0 14.5006 0C14.2926 0 14.0882 0.055725 13.908 0.161574L2.49755 6.86227C2.34639 6.95136 2.22087 7.07929 2.13356 7.23325C2.04624 7.38722 2.00018 7.56182 2 7.73958V21.257C2 21.6195 2.19 21.9542 2.49874 22.1355L13.9069 28.8386C14.0871 28.9443 14.2914 29 14.4994 29C14.7074 29 14.9118 28.9443 15.092 28.8386L26.5013 22.1355C26.6528 22.0465 26.7787 21.9184 26.8662 21.7642C26.9538 21.61 26.9999 21.4351 27 21.257V7.74079C26.9997 7.56291 26.9535 7.38823 26.8659 7.23426C26.7784 7.08028 26.6526 6.95242 26.5013 6.86348L26.5001 6.86227ZM25.784 8.28337L14.7702 27.6954C14.6953 27.826 14.4994 27.7728 14.4994 27.6217V14.9104C14.4992 14.7854 14.4667 14.6627 14.4053 14.5545C14.3438 14.4464 14.2554 14.3565 14.1491 14.2941L3.33116 7.93776C3.2041 7.86284 3.25635 7.66224 3.40479 7.66224H25.4325C25.746 7.66224 25.9408 8.00785 25.784 8.28337Z"
}

/// SVG path data filled in a 29-unit box, scaled to the frame; even-odd so
/// the marks' counters stay open whatever their winding.
private struct FilledPaths: View {
    let paths: [String]

    var body: some View {
        FilledShape(paths: paths)
            .fill(style: FillStyle(eoFill: true))
    }
}

private nonisolated struct FilledShape: Shape {
    let paths: [String]

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 29
        var out = Path()
        for d in paths {
            out.addPath(SVGPath.parse(d).applying(CGAffineTransform(scaleX: scale, y: scale)))
        }
        return out
    }
}

/// A subagent's role in the meta line: the design's agent glyphs at the
/// meta's size, in the meta's color.
struct AgentTypeMark: View {
    let type: AgentType

    var body: some View {
        Image(systemName: type.symbol)
            .font(.caption2)
            .accessibilityLabel(type.label)
    }
}

/// What leads an agent row (the desktop's StatusGlyph): the spinner while
/// live, the warning dot waiting, the destructive dot failed, the info dot
/// watching, the pause mark paused, and a check once settled. Marks
/// cross-fade in a frame that never changes size.
struct AgentStatusMark: View {
    let status: SessionStatus
    @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 16

    var body: some View {
        ZStack {
            switch mark {
            case .spinner:
                ProgressView()
                    .controlSize(.mini)
                    .transition(.opacity)
            case .dot(let color):
                Circle()
                    .fill(color)
                    .frame(width: size * 0.44, height: size * 0.44)
                    .transition(.opacity)
            case .paused:
                Image(systemName: "pause.fill")
                    .font(.caption2)
                    .foregroundStyle(Tint.warning)
                    .transition(.opacity)
            case .check:
                Image(systemName: "checkmark")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Tint.success)
                    .transition(.opacity)
            }
        }
        .frame(width: size, height: size)
        .animation(Motion.crossFade, value: mark)
        .accessibilityLabel(label)
    }

    private enum Mark: Equatable {
        case spinner, dot(Color), paused, check
    }

    private var mark: Mark {
        switch status {
        case .running, .starting: .spinner
        case .watching: .dot(Tint.info)
        case .waiting: .dot(Tint.warning)
        case .error: .dot(Tint.destructive)
        case .paused: .paused
        case .idle, .done, .unknown: .check
        }
    }

    private var label: String {
        switch status {
        case .running, .starting: "Running"
        case .watching: "Watching"
        case .waiting: "Needs you"
        case .error: "Failed"
        case .paused: "Paused"
        case .idle, .done, .unknown: "Done"
        }
    }
}

// MARK: - lines

/// Provider mark, role, model and effort, plus the worktree when the agent
/// has one: one dim line, the desktop's "claude · implementer · Opus 5.5 · high".
struct AgentMetaLine: View {
    let agent: SessionMeta
    var branch: String?

    var body: some View {
        HStack(spacing: 5) {
            ProviderGlyph(provider: agent.provider)
            AgentTypeMark(type: agent.agentType)
            Text(ModelName.short(agent.model))
            if !agent.reasoning.rawValue.isEmpty {
                Text("·")
                    .foregroundStyle(.tertiary)
                Text(agent.reasoning.rawValue)
            }
            if let branch {
                Text("·")
                    .foregroundStyle(.tertiary)
                Image(systemName: "arrow.triangle.branch")
                    .font(.caption2)
                Text(branch)
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .accessibilityElement(children: .combine)
    }
}

/// The agent's latest line, replaced in place: a 150 ms cross-fade with
/// 2 pt of blur in a frame of fixed height, so the row never moves. Empty
/// while live reads "starting up"; empty and settled takes the same room.
struct ActivityLine: View {
    let line: Fleet.Line
    let live: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .footnote) private var height: CGFloat = 18

    var body: some View {
        let text = line.text.isEmpty ? (live ? "starting up" : "") : line.text
        ZStack(alignment: .leading) {
            Text(text.isEmpty ? " " : text)
                .font(.footnote)
                .italic(line.text.isEmpty && live)
                .foregroundStyle(tone)
                .lineLimit(1)
                .id(text)
                .transition(Motion.swap(reduced: reduceMotion))
        }
        .frame(height: height, alignment: .leading)
        .clipped()
        .animation(Motion.crossFade, value: text)
        .accessibilityHidden(text.isEmpty)
    }

    private var tone: Color {
        if line.text.isEmpty { return Color(.tertiaryLabel) }
        switch line.tone {
        case .warning: return Tint.warning
        case .danger: return Tint.destructive
        case .muted: return Color(.secondaryLabel)
        }
    }
}

/// "+12 −3 · 3/7 tasks · 42%", quiet and tabular (the desktop's AgentStatsLine).
struct AgentStatsLine: View {
    let stats: Fleet.Stats

    var body: some View {
        HStack(spacing: 6) {
            if stats.adds > 0 || stats.dels > 0 {
                ChangeStat(adds: stats.adds, dels: stats.dels)
                    .font(.caption)
            }
            if stats.tasksTotal > 0 {
                if stats.adds > 0 || stats.dels > 0 { Dot() }
                Text("\(stats.tasksDone)/\(stats.tasksTotal) tasks")
                    .contentTransition(.numericText())
            }
            if let pct = stats.contextPercent {
                if stats.tasksTotal > 0 || stats.adds > 0 || stats.dels > 0 { Dot() }
                Text("\(pct)%")
                    .foregroundStyle(pct >= 85 ? Tint.warning : Color(.tertiaryLabel))
                    .contentTransition(.numericText())
            }
        }
        .font(.caption)
        .monospacedDigit()
        .foregroundStyle(.tertiary)
        .lineLimit(1)
        .animation(Motion.crossFade, value: stats)
    }

    private struct Dot: View {
        var body: some View {
            Text("·").foregroundStyle(.quaternary)
        }
    }
}

/// Elapsed over cost, right-aligned, every digit tabular, every change
/// rolling as numeric text.
struct AgentFigures: View {
    let elapsedMs: Int?
    let cost: Double?

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            if let elapsedMs {
                Text(TimeFormat.duration(ms: elapsedMs))
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText())
                    .animation(Motion.crossFade, value: elapsedMs / 1000)
            }
            if let cost {
                Text(cost, format: .currency(code: "USD").precision(.fractionLength(2)))
                    .foregroundStyle(.tertiary)
                    .contentTransition(.numericText())
                    .animation(Motion.crossFade, value: cost)
            }
        }
        .font(.caption)
        .monospacedDigit()
        .lineLimit(1)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - the row

/// One subagent: mark, title with the elapsed time on its line, the meta,
/// the activity line, the stats. A waiting row sits on the needs-you tint
/// in a rounded field inset from the edge; every row keeps its text at the
/// 16 pt edge. Tap pushes the agent's detail.
struct AgentRow: View {
    let agent: SessionMeta
    let client: EnvironmentClient
    let fleetSize: Int
    let now: Date
    var parentCwd: String?

    var body: some View {
        let child = client.threads[agent.id]
        let items = child?.fold.items ?? []
        let live = Fleet.isLive(agent.status)
        let settled = Fleet.group(agent.status) == .done && agent.status != .error
        let line = Fleet.line(status: agent.status, items: items, compacting: child?.fold.board.compacting ?? false)
        let stats = Fleet.stats(items: items, tasks: agent.tasks, board: child?.fold.board, context: agent.context)
        let waiting = agent.status == .waiting
        NavigationLink(value: AgentDetailRoute(agentId: agent.id, parentCwd: parentCwd)) {
            HStack(alignment: .top, spacing: 12) {
                AgentStatusMark(status: agent.status)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(agent.title.isEmpty ? "Subagent" : agent.title)
                            .font(.subheadline.weight(settled ? .regular : .medium))
                            .foregroundStyle(settled ? .secondary : .primary)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        AgentFigures(elapsedMs: Fleet.elapsedMs(agent, now: Int(now.timeIntervalSince1970 * 1000)), cost: child?.fold.board.cost)
                    }
                    AgentMetaLine(agent: agent, branch: Fleet.branch(cwd: agent.cwd, parentCwd: parentCwd))
                    ActivityLine(line: line, live: live)
                    if !stats.isEmpty {
                        AgentStatsLine(stats: stats)
                    }
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 10)
            .background(waiting ? Surface.needsYou : .clear, in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
            .padding(.horizontal, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .animation(Motion.crossFade, value: waiting)
        .onAppear {
            guard Fleet.loadsTranscript(status: agent.status, fleetSize: fleetSize) else { return }
            Task { await client.openThread(agent.id) }
        }
        .onDisappear {
            guard Fleet.loadsTranscript(status: agent.status, fleetSize: fleetSize) else { return }
            client.closeThread(agent.id)
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the agent")
    }
}

// MARK: - the sections

/// The fleet in its groups, Running then Waiting then Done, each under the
/// design's section header with its count; hairlines between rows, inset
/// to the text edge. One clock ticks for every live row. Rows that change
/// group move with the needs-you motion. Meant for a LazyVStack.
struct FleetSections: View {
    let agents: [SessionMeta]
    let client: EnvironmentClient
    var parentCwd: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let sections = Fleet.sections(agents)
        let anyLive = agents.contains { Fleet.isLive($0.status) }
        let signature = sections.map { "\($0.group.rawValue):\($0.agents.map(\.id).joined(separator: ","))" }.joined(separator: "|")
        Group {
            if anyLive {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    rows(sections, now: context.date)
                }
            } else {
                rows(sections, now: .now)
            }
        }
        .animation(reduceMotion ? Motion.rowLeave : Motion.rowAppear, value: signature)
    }

    private func rows(_ sections: [Fleet.Section], now: Date) -> some View {
        ForEach(sections) { section in
            SectionHeader(section.group.title) {
                Text("\(section.agents.count)")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
                    .contentTransition(.numericText())
            }
            .accessibilityAddTraits(.isHeader)
            .transition(FleetMotion.rowChange(reduced: reduceMotion))
            ForEach(Array(section.agents.enumerated()), id: \.element.id) { index, agent in
                if index > 0 {
                    Hairline()
                        .padding(.leading, 44)
                        .transition(.opacity)
                }
                AgentRow(agent: agent, client: client, fleetSize: agents.count, now: now, parentCwd: parentCwd)
                    .transition(FleetMotion.rowChange(reduced: reduceMotion))
            }
        }
    }
}

/// The rows alone, in rank order with hairlines between them, for a
/// board that has its own header over them (the implementation board's
/// Agents section).
struct FleetRows: View {
    let agents: [SessionMeta]
    let client: EnvironmentClient
    var parentCwd: String?

    var body: some View {
        let ranked = Fleet.sort(agents)
        let anyLive = ranked.contains { Fleet.isLive($0.status) }
        if anyLive {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                rows(ranked, now: context.date)
            }
        } else {
            rows(ranked, now: .now)
        }
    }

    private func rows(_ ranked: [SessionMeta], now: Date) -> some View {
        ForEach(Array(ranked.enumerated()), id: \.element.id) { index, agent in
            if index > 0 {
                Hairline()
                    .padding(.leading, 44)
            }
            AgentRow(agent: agent, client: client, fleetSize: ranked.count, now: now, parentCwd: parentCwd)
        }
    }
}

/// What a fleet shows before any agent exists.
struct FleetEmpty: View {
    let text: String

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "person.2")
                .font(.title3)
                .foregroundStyle(.tertiary)
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 48)
        .padding(.horizontal, 32)
    }
}
