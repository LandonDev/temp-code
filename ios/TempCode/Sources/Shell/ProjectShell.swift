import SwiftUI
import TempCodeClient
import TempCodeContract

/// A project's place in the detail column, the desktop's project home: the
/// strip on top (every root of the project on every linked copy, or a
/// workspace's loose chats), under it the thread its chip selects, or the
/// project's draft when none is open. A chip's tap swaps the thread under
/// the strip; the shell keeps its identity (`ShellPaths.identity(of:)`), so
/// the strip keeps its scroll. A subagent pushes over the shell on the
/// detail's stack. What the shell shows is remembered under the scope's key
/// (`ShellLandingStore`), which a card's tap comes back to (`ShellPaths.land`).
/// Until the project's draft lands (B4), the draft is an empty body whose New
/// Thread opens the new-thread sheet.
struct ProjectShell: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    let key: String
    let thread: String?
    let seq: Int?
    var slots = HomeSlots()

    var body: some View {
        let hosts = HomeRows.inputs(model.registry.ordered)
        let scope = ThreadStrip.scope(key: key, hosts: hosts)
        let shown = thread.flatMap(ShellPaths.split)
        VStack(spacing: 0) {
            if let scope {
                ThreadStripView(scope: scope, shown: shown)
            }
            if let shown, let client = model.registry.client(shown.environmentId) {
                ThreadScreen(client: client, sessionId: shown.sessionId, targetSeq: seq)
                    .id(thread)
            } else if let scope {
                ShellDraftBody(scope: scope, slots: slots)
            } else if model.registry.ordered.contains(where: { !$0.hasShell }) {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("Project Not Found", systemImage: "folder")
            }
        }
        .background(Surface.background)
        .onChange(of: thread, initial: true) { ShellLandingStore.shared.remember(.project(key: key, thread: thread)) }
    }
}

/// The shell with no thread open: the project's name in the bar with its
/// plan chip and menu, and one New Thread.
private struct ShellDraftBody: View {
    @Environment(AppModel.self) private var model
    @Environment(NewThreadPresenter.self) private var presenter
    let scope: StripScope
    let slots: HomeSlots

    var body: some View {
        let lead = lead
        VStack {
            if let lead {
                Button("New Thread") { presenter.compose(lead.client, lead.workspace, lead.project) }
                    .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle(scope.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if case .project(let project) = scope.kind, let lead {
                if let trailing = slots.projectTrailing {
                    ToolbarItem(placement: .primaryAction) {
                        trailing(lead.client, project.project)
                            .environment(\.inBar, true)
                    }
                }
                if slots.hasProjectMenu {
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            ProjectMenuContent(project: project, slots: slots, newThread: presenter.compose)
                        } label: {
                            Image(systemName: GlassMetrics.moreSymbol)
                        }
                        .accessibilityLabel("\(project.project.name) menu")
                    }
                    .highVisibility()
                }
            }
        }
    }

    /// Where New Thread starts: the scope's lead copy.
    private var lead: (client: EnvironmentClient, workspace: WorkspaceMeta, project: ProjectMeta?)? {
        guard let lead = scope.lead, let client = model.registry.client(lead.environmentId),
              let workspace = client.workspaces.first(where: { $0.id == lead.workspaceId }) else { return nil }
        return (client, workspace, lead.projectId.flatMap { id in client.projects.first { $0.id == id } })
    }
}
