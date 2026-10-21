import SwiftUI
import TempCodeClient
import TempCodeContract

/// The Orchestration thread's hero segment: the goal and what the
/// orchestrator is up to, then its fleet in groups, Running then Waiting
/// then Done (FleetStyles.swift). Tap a row for the agent's own detail.
struct FleetView: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    let thread: ThreadState
    /// DEBUG proof: `TC_TEST_OPEN=agents` pushes the subagent list,
    /// `agent-detail` the first agent's detail, once the fleet is in.
    @State private var launchPush: FleetLaunchPush?

    var body: some View {
        let agents = Fleet.children(of: sessionId, in: client.sessions)
        let counts = Fleet.counts(agents.map(\.status))
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                FleetGoal(goal: goal, status: effectiveStatus(counts: counts), line: Fleet.orchestratorLine(status: session?.status, counts: counts))
                if agents.isEmpty {
                    FleetEmpty(text: thread.isLoading ? "Loading the fleet…" : "No agents yet. The orchestrator's first spawn lands here.")
                } else {
                    FleetSections(agents: agents, client: client, parentCwd: session?.cwd)
                }
            }
            .padding(.bottom, 24)
        }
        .scrollBounceBehavior(.basedOnSize)
        .fleetDestinations(client: client)
        .navigationDestination(item: $launchPush) { push in
            switch push {
            case .list: SubagentListScreen(client: client, rootSessionId: sessionId)
            case .detail(let id): AgentDetailScreen(client: client, agentId: id, parentCwd: session?.cwd)
            }
        }
        .onChange(of: TestHooks.open == nil ? 0 : agents.count, initial: true) {
            guard launchPush == nil, let open = TestHooks.open else { return }
            if open == "agents" {
                launchPush = .list
            } else if open == "agent-detail", let first = agents.first {
                launchPush = .detail(first.id)
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
    /// it has one, else its fleet's (working shows the spinner, waiting the
    /// warning dot), as the desktop's pulse line does.
    private func effectiveStatus(counts: Fleet.Counts) -> SessionStatus? {
        guard let status = session?.status else { return nil }
        if Fleet.isLive(status) || status == .waiting || status == .error || status == .paused { return status }
        if counts.working > 0 { return .running }
        if counts.waiting > 0 { return .waiting }
        return status
    }
}

enum FleetLaunchPush: Hashable, Identifiable {
    case list
    case detail(String)

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
                    AgentStatusMark(status: status)
                    Text(line)
                        .font(.footnote.weight(.medium))
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
        .padding(.horizontal, 16)
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
