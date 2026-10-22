import SwiftUI
import TempCodeClient
import TempCodeContract

/// The desktop's subagent panel (the right sidebar's FleetPanel) as a
/// screen: every child of `rootSessionId` on every paired host, in its
/// groups, Running, Waiting, Queued, Done, each row the agent's mark,
/// title, meta, latest line and figures, live as the hosts stream. Nothing
/// to pull; it updates in place. The section headers carry the counts; the
/// bar names the thread. Agents on a host this phone is not paired with are
/// counted once at the foot. Tap pushes the agent's detail, read from the
/// agent's own host. Pushed from a thread's toolbar.
struct SubagentListScreen: View {
    let client: EnvironmentClient
    let rootSessionId: String
    @Environment(AppModel.self) private var app

    var body: some View {
        let fleet = FleetGather(registry: app.registry, root: client, rootId: rootSessionId)
        let root = client.session(rootSessionId)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if fleet.agents.isEmpty {
                    FleetEmpty(text: "No subagents yet. They appear here the moment the thread spawns one.")
                } else {
                    FleetSections(agents: fleet.agents, clients: fleet.clients, parentCwd: root?.cwd, hostNames: fleet.hostNames, hostLines: fleet.hostLines)
                }
                if fleet.unpaired > 0 {
                    FleetUnpairedNote(count: fleet.unpaired)
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
                    if let root, !root.title.isEmpty {
                        Text(root.title)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .toolbarBackground(Surface.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .fleetDestinations(registry: app.registry)
        .environment(\.markdownScope, MarkdownScope(environmentId: client.environment.id, sessionId: rootSessionId))
        // The root's rows name the hosts its agents were spawned on; hold them open while the list shows.
        .onAppear { Task { await client.openThread(rootSessionId) } }
        .onDisappear { client.closeThread(rootSessionId) }
    }
}
