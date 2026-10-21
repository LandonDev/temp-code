import SwiftUI
import TempCodeClient
import TempCodeContract

/// The desktop's subagent panel (the right sidebar's FleetPanel) as a
/// screen: every child of `rootSessionId` in its groups, Running then
/// Waiting then Done, each row the agent's mark, title, meta, latest line
/// and figures, live as the host streams. Nothing to pull; it updates in
/// place. Tap pushes the agent's detail. Pushed from a thread's toolbar.
struct SubagentListScreen: View {
    let client: EnvironmentClient
    let rootSessionId: String

    var body: some View {
        let agents = Fleet.children(of: rootSessionId, in: client.sessions)
        let root = client.session(rootSessionId)
        let counts = Fleet.counts(agents.map(\.status))
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: .sectionHeaders) {
                if agents.isEmpty {
                    FleetEmpty(text: "No subagents yet. They appear here the moment the thread spawns one.")
                } else {
                    FleetSections(agents: agents, client: client, parentCwd: root?.cwd)
                }
            }
            .padding(.bottom, 24)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(Surface.background)
        .navigationTitle("Subagents")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text("Subagents")
                        .font(.headline)
                    Text(summary(counts, total: agents.count))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .animation(Motion.crossFade, value: counts)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .toolbarBackground(Surface.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .fleetDestinations(client: client)
        .environment(\.markdownScope, MarkdownScope(environmentId: client.environment.id, sessionId: rootSessionId))
    }

    /// "3 working · 1 waiting · 2 done" under the title; the root's name when idle.
    private func summary(_ counts: Fleet.Counts, total: Int) -> String {
        var parts: [String] = []
        if counts.working > 0 { parts.append("\(counts.working) working") }
        if counts.waiting > 0 { parts.append("\(counts.waiting) waiting") }
        if counts.failed > 0 { parts.append("\(counts.failed) failed") }
        if counts.done > 0 { parts.append("\(counts.done) done") }
        if parts.isEmpty { return total == 1 ? "1 agent" : "\(total) agents" }
        return parts.joined(separator: " · ")
    }
}
