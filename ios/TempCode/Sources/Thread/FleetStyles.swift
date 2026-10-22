import SwiftUI
import TempCodeClient
import TempCodeContract

/// The pieces every fleet surface is built from: the desktop's agent row
/// (FleetPanel's AgentRow) made for a phone, its status mark, the provider
/// mark, the one-line meta, the activity line that swaps in place, the
/// stats, and the sectioned list that FleetView and SubagentListScreen share.
/// The master board (thread 16) builds its rows from the same pieces. Every
/// color, radius, length, font step and duration here is the design kit's
/// (`Tint`, `Surface`, `Radius`, `Layout`, `TextStep`, `Motion`); nothing is
/// named twice.

// MARK: - layout

enum FleetLayout {
    /// Where a row's text and its hairline start: the text edge, the mark's
    /// column and the gap after it (40 pt).
    static let textInset: CGFloat = Layout.textEdge + Layout.markWidth + Layout.rowGap
    /// The needs-you field sits this far in from the screen edge and pads
    /// its content by the same amount, so the text keeps the text edge.
    static let fieldInset: CGFloat = Layout.textEdge / 2
}

// MARK: - routes

/// A subagent's detail, pushed from any fleet row: the host it lives on,
/// its id, the root's directory (for the worktree name) and the host's name
/// when it differs from the root's.
struct AgentDetailRoute: Hashable {
    let environmentId: String
    let agentId: String
    var parentCwd: String?
    var hostName: String?
}

extension View {
    /// The fleet's push destinations. Declared by every screen that shows
    /// fleet rows, so a list pushed from a chat still resolves them. The
    /// route names a host; a host gone since the tap shows one line.
    func fleetDestinations(registry: ClientRegistry) -> some View {
        navigationDestination(for: AgentDetailRoute.self) { route in
            if let client = registry.client(route.environmentId) {
                AgentDetailScreen(client: client, agentId: route.agentId, parentCwd: route.parentCwd, hostName: route.hostName)
            } else {
                FleetEmpty(text: "This host is no longer paired")
            }
        }
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
/// the marks' counters stay open whatever their winding. The path grammar
/// is the kit's `SVGPath` (Design/HostMark.swift).
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

/// What leads an agent row (the desktop's StatusGlyph), in the kit's mark
/// column scaled with the title: the spinner while live, the info dot
/// watching, the warning dot waiting, the destructive dot failed, the pause
/// mark paused, a dashed ring queued, a still square once the harness is
/// gone, and a check once settled. Marks cross-fade in a frame that never
/// changes size; `weight` is the weight of the title beside it.
struct AgentStatusMark: View {
    let status: SessionStatus
    var weight: Font.Weight = .regular
    @ScaledMetric(relativeTo: .subheadline) private var column = Layout.markWidth
    @ScaledMetric(relativeTo: .subheadline) private var dot = Layout.dotSize

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
                    .frame(width: dot, height: dot)
                    .transition(.opacity)
            case .paused:
                Image(systemName: "pause.fill")
                    .font(.caption2.weight(weight))
                    .foregroundStyle(Tint.warning)
                    .transition(.opacity)
            case .queued:
                Image(systemName: "circle.dashed")
                    .font(.caption2.weight(weight))
                    .foregroundStyle(Tint.quiet)
                    .transition(.opacity)
            case .stopped:
                // The harness is gone: a still square, the quiet opposite of the spinner.
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(Tint.quiet)
                    .frame(width: dot - 1, height: dot - 1)
                    .transition(.opacity)
            case .check:
                Image(systemName: "checkmark")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Tint.success)
                    .transition(.opacity)
            }
        }
        .frame(width: column, height: column)
        .animation(Motion.crossFade, value: mark)
        .accessibilityLabel(label)
    }

    private enum Mark: Equatable {
        case spinner, dot(Color), paused, queued, stopped, check
    }

    private var mark: Mark {
        switch status {
        case .running, .starting: .spinner
        case .watching: .dot(Tint.info)
        case .waiting: .dot(Tint.warning)
        case .error: .dot(Tint.destructive)
        case .paused: .paused
        case .queued: .queued
        case .stopped: .stopped
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
        case .queued: "Queued"
        case .stopped: "Stopped"
        case .idle, .done, .unknown: "Done"
        }
    }
}

// MARK: - lines

/// Provider mark, role, model and effort, plus the worktree when the agent
/// has one and the host when it is not the root's: one dim line, the
/// desktop's "claude · implementer · Opus 5.5 · high".
struct AgentMetaLine: View {
    let agent: SessionMeta
    var branch: String?
    var host: String?

    var body: some View {
        HStack(spacing: 5) {
            ProviderGlyph(provider: agent.provider)
            MetaGlyph(agent.agentType.symbol, label: agent.agentType.label)
            Text(ModelName.short(agent.model))
            if !agent.reasoning.rawValue.isEmpty {
                Separator()
                Text(agent.reasoning.rawValue)
            }
            if let branch {
                Separator()
                MetaGlyph("arrow.triangle.branch", label: "Worktree")
                Text(branch)
            }
            if let host {
                Separator()
                MetaGlyph("desktopcomputer", label: "Host")
                Text(host)
            }
        }
        .textStep(.meta)
        .lineLimit(1)
        .accessibilityElement(children: .combine)
    }

    private struct Separator: View {
        var body: some View {
            Text("·").foregroundStyle(.tertiary)
        }
    }
}

/// The agent's latest line, replaced in place: the kit's swap (a 150 ms
/// cross-fade with 2 pt of blur) over a hidden one-line sizer, so the row
/// keeps one height whatever the text. Empty while live reads "starting
/// up"; empty and settled takes the same room. `override` (a remote host's
/// transport line) wins over the agent's own line.
struct ActivityLine: View {
    let line: Fleet.Line
    let live: Bool
    var override: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var overridden: String? {
        guard let override, !override.isEmpty else { return nil }
        return override
    }

    private var starting: Bool { overridden == nil && line.text.isEmpty && live }

    private var text: String {
        if let overridden { return overridden }
        return starting ? "starting up" : line.text
    }

    private var tone: Color {
        if overridden != nil || line.text.isEmpty { return Color(.tertiaryLabel) }
        return switch line.tone {
        case .warning: Tint.warning
        case .danger: Tint.destructive
        case .muted: Color(.secondaryLabel)
        }
    }

    var body: some View {
        let shown = text
        ZStack(alignment: .leading) {
            // The sizer: one line of the step, never shown, so the height is fixed.
            Text(" ")
                .font(TextStep.meta.font)
                .hidden()
            if !shown.isEmpty {
                Text(shown)
                    .italic(starting)
                    .font(TextStep.meta.font)
                    .foregroundStyle(tone)
                    .id(shown)
                    .transition(Motion.swap(reduced: reduceMotion))
            }
        }
        .lineLimit(1)
        .animation(Motion.crossFade, value: shown)
        .accessibilityHidden(shown.isEmpty)
    }
}

/// "+12 −3 · 3/7 tasks · 42%", quiet and tabular (the desktop's
/// AgentStatsLine); the context reading turns warning at 85 %.
struct AgentStatsLine: View {
    let stats: Fleet.Stats

    private var hasDiff: Bool { stats.adds > 0 || stats.dels > 0 }

    var body: some View {
        HStack(spacing: 6) {
            if hasDiff {
                ChangeStat(adds: stats.adds, dels: stats.dels)
            }
            if stats.tasksTotal > 0 {
                if hasDiff { Dot() }
                Text("\(stats.tasksDone)/\(stats.tasksTotal) tasks")
            }
            if let pct = stats.contextPercent {
                if hasDiff || stats.tasksTotal > 0 { Dot() }
                Text("\(pct)%")
                    .foregroundStyle(pct >= 85 ? Tint.warning : Color(.tertiaryLabel))
            }
        }
        .font(.caption)
        .foregroundStyle(.tertiary)
        .lineLimit(1)
        .numeric(stats)
        .accessibilityElement(children: .combine)
    }

    private struct Dot: View {
        var body: some View {
            Text("·").foregroundStyle(.quaternary)
        }
    }
}

/// Elapsed over cost, trailing-aligned, every digit tabular and rolling as
/// it changes. Deliberately `caption`, one step above the kit's stamp:
/// `caption2 tertiary` fails the contrast floor on the needs-you tint.
struct AgentFigures: View {
    let elapsedMs: Int?
    let cost: Double?

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            if let elapsedMs {
                Text(TimeFormat.duration(ms: elapsedMs))
                    .foregroundStyle(.secondary)
                    .numeric(elapsedMs / 1000)
            }
            if let cost {
                Text(cost, format: .currency(code: "USD").precision(.fractionLength(2)))
                    .foregroundStyle(.tertiary)
                    .numeric(cost)
            }
        }
        .font(.caption)
        .lineLimit(1)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - the row

/// One subagent: mark, title with the figures on its line, the meta, the
/// activity line, the stats. A waiting row sits on the needs-you tint in a
/// rounded field inset from the edge; every row keeps its text at the text
/// edge. A live row's figures tick on their own one-second clock; nothing
/// else in the row re-renders on the tick. A remote agent's row names its
/// host and, while that host is not open (`hostLine`), shows the host's
/// transport line in place of its activity; any row whose host is away
/// keeps its figures still. Tap pushes the agent's detail. `client` is the
/// agent's own host's client.
struct AgentRow: View {
    let agent: Fleet.Agent
    let client: EnvironmentClient
    let fleetSize: Int
    var parentCwd: String?
    var hostName: String?
    var hostLine: String?

    var body: some View {
        let meta = agent.meta
        let child = client.threads[meta.id]
        let items = child?.fold.items ?? []
        let live = Fleet.isLive(meta.status)
        let emphasized = live || meta.status == .waiting || meta.status == .error || meta.status == .stopped
        let line = Fleet.line(status: meta.status, items: items, compacting: child?.fold.board.compacting ?? false, activity: meta.activity)
        let stats = Fleet.stats(items: items, tasks: meta.tasks, board: child?.fold.board, context: meta.context)
        let waiting = meta.status == .waiting
        let away = hostLine != nil
        let cost = child?.fold.board.cost
        NavigationLink(value: AgentDetailRoute(environmentId: agent.environmentId, agentId: meta.id, parentCwd: parentCwd, hostName: agent.remote ? hostName : nil)) {
            HStack(alignment: .top, spacing: Layout.rowGap) {
                AgentStatusMark(status: meta.status, weight: emphasized ? .medium : .regular)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(meta.title.isEmpty ? "Subagent" : meta.title)
                            .font(TextStep.title.font.weight(emphasized ? .medium : .regular))
                            .foregroundStyle(emphasized ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        if live, !away {
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                AgentFigures(elapsedMs: Fleet.elapsedMs(meta, now: Int(context.date.timeIntervalSince1970 * 1000)), cost: cost)
                            }
                        } else {
                            // Settled, or a host that is away: the clock stands at what the host last said.
                            AgentFigures(elapsedMs: Fleet.elapsedMs(meta, now: away ? meta.updatedAt : Int(Date.now.timeIntervalSince1970 * 1000)), cost: cost)
                        }
                    }
                    AgentMetaLine(agent: meta, branch: Fleet.branch(cwd: meta.cwd, parentCwd: parentCwd), host: agent.remote ? hostName : nil)
                    ActivityLine(line: line, live: live, override: agent.remote ? hostLine : nil)
                    if !stats.isEmpty {
                        AgentStatsLine(stats: stats)
                    }
                }
            }
            .padding(.vertical, 10)
            .padding(.horizontal, FleetLayout.fieldInset)
            .background(waiting ? Surface.needsYou : .clear, in: RoundedRectangle.rowCorner)
            .padding(.horizontal, FleetLayout.fieldInset)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .animation(Motion.crossFade, value: waiting)
        .onAppear {
            guard Fleet.loadsTranscript(status: meta.status, fleetSize: fleetSize) else { return }
            Task { await client.openThread(meta.id) }
        }
        .onDisappear {
            guard Fleet.loadsTranscript(status: meta.status, fleetSize: fleetSize) else { return }
            client.closeThread(meta.id)
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the agent")
    }
}

// MARK: - the sections

/// The fleet in its groups, Running, Waiting, Queued, Done, each under the
/// kit's section header with its count; hairlines between rows, inset to
/// the text edge. Rows that change group move with the kit's row motion,
/// and nothing moves on the first non-empty paint. `clients` is keyed by
/// host id, as are the host names (shown on remote rows) and the transport
/// lines of hosts that are not open. Meant for a LazyVStack.
struct FleetSections: View {
    let agents: [Fleet.Agent]
    let clients: [String: EnvironmentClient]
    var parentCwd: String?
    var hostNames: [String: String] = [:]
    var hostLines: [String: String] = [:]
    /// The first non-empty list has rendered: moves animate from here on.
    @State private var painted = false

    var body: some View {
        let sections = Fleet.sections(agents)
        let signature = sections.map { "\($0.group.rawValue):\($0.agents.map(\.id).joined(separator: ","))" }.joined(separator: "|")
        rows(sections)
            .animation(Motion.rowAppear, value: painted ? signature : "")
        .onChange(of: agents.isEmpty, initial: true) { _, empty in
            if !empty, !painted { painted = true }
        }
    }

    @ViewBuilder
    private func rows(_ sections: [Fleet.AgentSection]) -> some View {
        ForEach(sections) { section in
            SectionHeader(section.group.title) {
                CountText(section.agents.count)
            }
            .rowAppearTransition()
            ForEach(Array(section.agents.enumerated()), id: \.element.id) { index, agent in
                if index > 0 {
                    Hairline(inset: FleetLayout.textInset)
                        .transition(.opacity)
                }
                if let client = clients[agent.environmentId] {
                    AgentRow(agent: agent, client: client, fleetSize: agents.count, parentCwd: parentCwd, hostName: hostNames[agent.environmentId], hostLine: hostLines[agent.environmentId])
                        .rowAppearTransition()
                }
            }
        }
    }
}

/// The rows alone, in rank order with hairlines between them, for a board
/// that has its own header over them (the implementation board's Agents
/// section). Every agent is local to `client`.
struct FleetRows: View {
    let agents: [SessionMeta]
    let client: EnvironmentClient
    var parentCwd: String?

    var body: some View {
        let ranked = Fleet.sort(agents).map { Fleet.Agent(meta: $0, environmentId: client.environment.id, remote: false) }
        ForEach(Array(ranked.enumerated()), id: \.element.id) { index, agent in
            if index > 0 {
                Hairline(inset: FleetLayout.textInset)
            }
            AgentRow(agent: agent, client: client, fleetSize: ranked.count, parentCwd: parentCwd)
        }
    }
}

/// What a fleet shows while its first rows are on the way.
struct FleetLoading: View {
    var body: some View {
        ProgressView()
            .controlSize(.small)
            .frame(maxWidth: .infinity)
            .padding(.top, 48)
            .accessibilityLabel("Loading the fleet")
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
        .padding(.horizontal, Layout.textEdge * 2)
    }
}

/// One line at the foot of a fleet: agents the root spawned on a host this
/// phone is not paired with, counted once. Not tappable: pairing is in Settings.
struct FleetUnpairedNote: View {
    let count: Int

    var body: some View {
        HStack(spacing: 5) {
            MetaGlyph("desktopcomputer", label: "Host")
            Text(count == 1 ? "1 agent runs on a host this phone is not paired with" : "\(count) agents run on hosts this phone is not paired with")
        }
        .textStep(.meta)
        .lineLimit(2)
        .padding(.horizontal, Layout.textEdge)
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - the hosts

/// What a fleet surface reads off the registry in one pass: the root's
/// children on every paired host (the root's host first), the client of
/// each host by id, the hosts' names, the transport line of every host
/// that is not open ("Reconnecting in 12 s", "Offline"), and how many
/// agents the root spawned on hosts this phone is not paired with.
@MainActor
struct FleetGather {
    let agents: [Fleet.Agent]
    let clients: [String: EnvironmentClient]
    let hostNames: [String: String]
    let hostLines: [String: String]
    let unpaired: Int

    init(registry: ClientRegistry, root client: EnvironmentClient, rootId: String) {
        var ordered = registry.ordered
        if !ordered.contains(where: { $0 === client }) { ordered.insert(client, at: 0) }
        let hosts = ordered.map { Fleet.Host(id: $0.environment.id, name: $0.environment.name, sessions: $0.sessions) }
        agents = Fleet.gather(rootId: rootId, rootHost: client.environment.id, hosts: hosts)
        clients = Dictionary(ordered.map { ($0.environment.id, $0) }, uniquingKeysWith: { first, _ in first })
        hostNames = Dictionary(ordered.map { ($0.environment.id, $0.environment.name) }, uniquingKeysWith: { first, _ in first })
        let now = Date().timeIntervalSince1970 * 1000
        var lines: [String: String] = [:]
        for host in ordered {
            if let block = Actions.block(status: host.status, environment: host.environment, needs: .read) {
                lines[host.environment.id] = block.text(now: now)
            }
        }
        hostLines = lines
        unpaired = Fleet.unpaired(rows: client.threads[rootId]?.rows ?? [], paired: Set(hosts.map(\.id)))
    }
}
