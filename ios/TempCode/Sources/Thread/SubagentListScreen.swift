import SwiftUI
import TempCodeClient
import TempCodeContract

/// The desktop's subagent panel (the right sidebar's FleetPanel) as a
/// screen: every child of `rootSessionId` in its groups, Running then
/// Waiting then Done, each row the agent's mark, title, meta, latest line
/// and figures, live as the host streams. Nothing to pull; it updates in
/// place. The section headers carry the counts; the bar names the thread.
/// Tap pushes the agent's detail. Pushed from a thread's toolbar.
struct SubagentListScreen: View {
    let client: EnvironmentClient
    let rootSessionId: String

    var body: some View {
        let agents = Fleet.children(of: rootSessionId, in: client.sessions)
        let root = client.session(rootSessionId)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
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
        .fleetDestinations(client: client)
        .environment(\.markdownScope, MarkdownScope(environmentId: client.environment.id, sessionId: rootSessionId))
    }
}
