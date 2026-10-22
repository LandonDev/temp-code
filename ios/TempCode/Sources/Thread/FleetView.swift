import SwiftUI
import TempCodeClient
import TempCodeContract

/// The Orchestration thread's hero segment: the goal and what the
/// orchestrator is up to, then its fleet in groups, Running, Waiting,
/// Queued, Done (FleetStyles.swift), gathered from every paired host. Tap a
/// row for the agent's own detail.
struct FleetView: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    let thread: ThreadState
    @Environment(AppModel.self) private var app
    /// DEBUG proof: `TC_TEST_OPEN=agents` pushes the subagent list,
    /// `agent-detail` the first agent's detail, once the fleet is in.
    @State private var launchPush: FleetLaunchPush?

    var body: some View {
        let fleet = FleetGather(registry: app.registry, root: client, rootId: sessionId)
        let counts = Fleet.counts(fleet.agents.map(\.meta.status))
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                FleetGoal(goal: goal, status: effectiveStatus(counts: counts), line: Fleet.orchestratorLine(status: session?.status, counts: counts))
                if fleet.agents.isEmpty, thread.isLoading {
                    FleetLoading()
                } else if fleet.agents.isEmpty {
                    FleetEmpty(text: "No agents yet. The orchestrator's first spawn lands here.")
                } else {
                    FleetSections(agents: fleet.agents, clients: fleet.clients, parentCwd: session?.cwd, hostNames: fleet.hostNames, hostLines: fleet.hostLines)
                }
                if fleet.unpaired > 0 {
                    FleetUnpairedNote(count: fleet.unpaired)
                }
            }
            .padding(.bottom, 24)
        }
        .scrollBounceBehavior(.basedOnSize)
        .fleetDestinations(registry: app.registry)
        .navigationDestination(item: $launchPush) { push in
            switch push {
            case .list:
                SubagentListScreen(client: client, rootSessionId: sessionId)
            case .detail(let route):
                if let host = app.registry.client(route.environmentId) {
                    AgentDetailScreen(client: host, agentId: route.agentId, parentCwd: route.parentCwd, hostName: route.hostName)
                }
            }
        }
        .onChange(of: TestHooks.open == nil ? 0 : fleet.agents.count, initial: true) {
            guard launchPush == nil, let open = TestHooks.open else { return }
            if open == "agents" {
                launchPush = .list
            } else if open == "agent-detail", let first = fleet.agents.first {
                launchPush = .detail(AgentDetailRoute(environmentId: first.environmentId, agentId: first.meta.id, parentCwd: session?.cwd, hostName: first.remote ? fleet.hostNames[first.environmentId] : nil))
            }
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

    /// The mark beside the status line: the orchestrator's own state while
    /// it has one (live, waiting, failed, paused, stopped or queued), else
    /// its fleet's (working shows the spinner, waiting the warning dot), as
    /// the desktop's pulse line does.
    private func effectiveStatus(counts: Fleet.Counts) -> SessionStatus? {
        guard let status = session?.status else { return nil }
        switch status {
        case .running, .starting, .waiting, .error, .paused, .stopped, .queued:
            return status
        case .idle, .done, .watching, .unknown:
            if counts.working > 0 { return .running }
            if counts.waiting > 0 { return .waiting }
            return status
        }
    }
}

enum FleetLaunchPush: Hashable, Identifiable {
    case list
    case detail(AgentDetailRoute)

    var id: Self { self }
}

/// The goal in body text over one status line with its mark; the status
/// line swaps in place as the fleet changes.
private struct FleetGoal: View {
    let goal: String?
    let status: SessionStatus?
    let line: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let goal {
                Text(goal)
                    .font(.body)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !line.isEmpty, let status {
                HStack(spacing: 8) {
                    AgentStatusMark(status: status, weight: .medium)
                    Text(line)
                        .font(TextStep.meta.font.weight(.medium))
                        .foregroundStyle(tone)
                        .monospacedDigit()
                        .lineLimit(1)
                        .id(line)
                        .transition(Motion.swap(reduced: reduceMotion))
                }
                .animation(Motion.crossFade, value: line)
                .accessibilityElement(children: .combine)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Layout.textEdge)
        .padding(.top, 10)
        .padding(.bottom, 14)
    }

    private var tone: Color {
        switch status {
        case .waiting?: Tint.warning
        case .error?: Tint.destructive
        default: Color(.secondaryLabel)
        }
    }
}
