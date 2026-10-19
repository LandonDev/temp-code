import SwiftUI
import TempCodeClient
import TempCodeContract

/// The fleet as full-width rows under the goal line and the orchestrator's
/// status. Tap a row for the agent's own transcript.
struct FleetView: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    let thread: ThreadState

    var body: some View {
        let agents = Fleet.children(of: sessionId, in: client.sessions)
        let counts = Fleet.counts(agents.map(\.status))
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    if let goal = goal {
                        Text(goal)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                    }
                    if !agents.isEmpty {
                        Text(countsLine(counts))
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                            .monospacedDigit()
                            .contentTransition(.numericText())
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                if agents.isEmpty {
                    HStack {
                        Spacer()
                        Text("No agents yet")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        Spacer()
                    }
                    .padding(.top, 40)
                } else {
                    FleetRows(agents: agents, client: client)
                }
            }
            .padding(.bottom, 16)
        }
    }

    /// The latest request, else the first.
    private var goal: String? {
        let items = thread.fold.items
        for entry in items.reversed() {
            if case .user(let turn) = entry.item, !turn.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return Board.firstLine(turn.text) }
        }
        let first = Fleet.taskTitle(items)
        return first.isEmpty ? nil : first
    }

    private func countsLine(_ counts: Fleet.Counts) -> String {
        var parts: [String] = []
        if counts.working > 0 { parts.append("\(counts.working) working") }
        if counts.waiting > 0 { parts.append("\(counts.waiting) waiting") }
        if counts.failed > 0 { parts.append("\(counts.failed) failed") }
        if counts.done > 0 { parts.append("\(counts.done) done") }
        return parts.joined(separator: " · ")
    }
}

struct FleetRows: View {
    let agents: [SessionMeta]
    let client: EnvironmentClient

    var body: some View {
        ForEach(agents, id: \.id) { agent in
            FleetRow(agent: agent, client: client, fleetSize: agents.count)
        }
    }
}

/// One subagent: status, role glyph, title, provider and model dim, the
/// last tool line cross-fading in place, its stats, elapsed and cost.
struct FleetRow: View {
    let agent: SessionMeta
    let client: EnvironmentClient
    let fleetSize: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let child = client.threads[agent.id]
        let items = child?.fold.items ?? []
        let live = Fleet.isLive(agent.status)
        let idle = !live && agent.status != .waiting && agent.status != .error && agent.status != .watching
        let line = Fleet.line(status: agent.status, items: items, compacting: child?.fold.board.compacting ?? false)
        let stats = Fleet.stats(items: items, tasks: agent.tasks, board: child?.fold.board, context: agent.context)
        NavigationLink(value: ThreadScreenRoute(sessionId: agent.id)) {
            HStack(alignment: .top, spacing: 10) {
                StatusDot(status: agent.status, running: live)
                    .padding(.top, 3)
                AgentGlyph(type: agent.agentType)
                VStack(alignment: .leading, spacing: 3) {
                    Text(agent.title.isEmpty ? "Subagent" : agent.title)
                        .font(.subheadline.weight(idle ? .regular : .medium))
                        .foregroundStyle(idle ? .secondary : .primary)
                        .lineLimit(1)
                    Text("\(agent.provider.rawValue) · \(ModelName.short(agent.model))" + (agent.reasoning.rawValue.isEmpty ? "" : " · \(agent.reasoning.rawValue)"))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    ZStack(alignment: .leading) {
                        Text(line.text.isEmpty ? (live ? "starting up" : " ") : line.text)
                            .font(.footnote)
                            .foregroundStyle(tone(line.tone, empty: line.text.isEmpty))
                            .lineLimit(1)
                            .id(line.text)
                            .transition(Motion.swap(reduced: reduceMotion))
                    }
                    .frame(height: 18, alignment: .leading)
                    .animation(Motion.crossFade, value: line.text)
                    if !stats.isEmpty {
                        StatsLine(stats: stats)
                    }
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 3) {
                    if live {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Text(TimeFormat.elapsed(since: agent.createdAt, now: context.date))
                                .contentTransition(.numericText())
                        }
                    } else if agent.updatedAt - agent.createdAt > 2_000 {
                        Text(TimeFormat.duration(ms: agent.updatedAt - agent.createdAt))
                    }
                    if let cost = child?.fold.board.cost {
                        Text(cost, format: .currency(code: "USD").precision(.fractionLength(2)))
                    }
                }
                .font(.caption2)
                .monospacedDigit()
                .foregroundStyle(.tertiary)
                .padding(.top, 2)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(minHeight: 44)
            .background(agent.status == .waiting ? Surface.needsYou : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .onAppear {
            guard Fleet.loadsTranscript(status: agent.status, fleetSize: fleetSize) else { return }
            Task { await client.openThread(agent.id) }
        }
        .onDisappear {
            guard Fleet.loadsTranscript(status: agent.status, fleetSize: fleetSize) else { return }
            client.closeThread(agent.id)
        }
        .accessibilityElement(children: .combine)
    }

    private func tone(_ tone: Fleet.Tone, empty: Bool) -> Color {
        if empty { return Color(.tertiaryLabel) }
        switch tone {
        case .warning: return Tint.warning
        case .danger: return Tint.destructive
        case .muted: return Color(.secondaryLabel)
        }
    }
}

/// "+12 −3 · 3/7 tasks · 42%", quiet and tabular.
private struct StatsLine: View {
    let stats: Fleet.Stats

    var body: some View {
        HStack(spacing: 6) {
            if stats.adds > 0 || stats.dels > 0 {
                ChangeStat(adds: stats.adds, dels: stats.dels)
                    .font(.caption2)
            }
            if stats.tasksTotal > 0 {
                if stats.adds > 0 || stats.dels > 0 { Text("·") }
                Text("\(stats.tasksDone)/\(stats.tasksTotal) tasks")
            }
            if let pct = stats.contextPercent {
                if stats.tasksTotal > 0 || stats.adds > 0 || stats.dels > 0 { Text("·") }
                Text("\(pct)%")
                    .foregroundStyle(pct >= 85 ? Tint.warning : Color(.tertiaryLabel))
            }
        }
        .font(.caption2)
        .monospacedDigit()
        .foregroundStyle(.tertiary)
        .lineLimit(1)
    }
}
