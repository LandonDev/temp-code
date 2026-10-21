import SwiftUI
import TempCodeClient
import TempCodeContract

/// The root's subagents as a list, what the desktop's right sidebar shows:
/// one row per agent through the fleet selector, each pushing the agent's
/// own thread screen (the row's `ThreadScreenRoute` resolves on the thread
/// screen beneath this one in the stack). The orchestration thread owns the
/// full screen at this path; this is the compiling minimum the thread
/// screen's toolbar pushes.
struct SubagentListScreen: View {
    let client: EnvironmentClient
    let rootSessionId: String

    var body: some View {
        let agents = Fleet.children(of: rootSessionId, in: client.sessions)
        List {
            if agents.isEmpty {
                Text("No subagents yet")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
                    .listRowSeparator(.hidden)
            } else {
                FleetRows(agents: agents, client: client)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .navigationTitle("Subagents")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Surface.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .accessibilityIdentifier("subagent-list")
    }
}
