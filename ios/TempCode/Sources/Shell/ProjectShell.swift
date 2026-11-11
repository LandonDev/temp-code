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
/// With no thread open the shell is the project's draft: an empty body and
/// the draft composer at its foot (`DraftComposer`), on the transcript's
/// column and edges.
struct ProjectShell: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    let key: String
    let thread: String?
    let seq: Int?
    var slots = HomeSlots()
    /// The scope and its strip, worked out off this body (`KeptScope`): the
    /// shell reads that the scope exists and its name, so a meta from
    /// another thread, on this host or any other, runs nothing here.
    @State private var kept = KeptScope()

    var body: some View {
        let _ = PerfCounters.bump(.projectShellBody)
        let registry = model.registry
        let summary = kept.summary(key: key, thread: thread, registry: registry)
        let shown = thread.flatMap(ShellPaths.split)
        VStack(spacing: 0) {
            if summary != nil {
                ThreadStripView(kept: kept, key: key, thread: thread)
            }
            if let shown, let client = registry.client(shown.environmentId) {
                ThreadScreen(client: client, sessionId: shown.sessionId, targetSeq: seq, shellTitle: summary?.name)
                    .id(thread)
            } else if summary != nil {
                ShellDraftBody(kept: kept, key: key, thread: thread, slots: slots)
            } else if registry.ordered.contains(where: { !$0.hasShell }) {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("Project Not Found", systemImage: "folder")
            }
        }
        .background(Surface.background)
        .onChange(of: thread, initial: true) { ShellLandingStore.shared.remember(.project(key: key, thread: thread)) }
        .task(id: "\(key)|\(thread ?? "")") { await kept.follow(key: key, thread: thread, registry: registry) }
    }
}

/// The draft shown while no thread is open, once the scope is known.
private struct ShellDraftBody: View {
    @Environment(AppModel.self) private var model
    let kept: KeptScope
    let key: String
    let thread: String?
    let slots: HomeSlots

    var body: some View {
        if let scope = kept.scope(key: key, thread: thread, registry: model.registry) {
            ShellDraft(scope: scope, slots: slots)
        }
    }
}

/// The shell with no thread open: the project's name in the bar with its
/// plan chip and menu, an empty body, and the draft composer.
private struct ShellDraft: View {
    @Environment(AppModel.self) private var model
    @Environment(\.shellPose) private var pose
    @Environment(NewThreadPresenter.self) private var presenter
    let scope: StripScope
    let slots: HomeSlots

    var body: some View {
        let lead = lead
        Color.clear
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .tcBottomBar(fade: false) {
                DraftComposer(scope: scope)
                    .frame(maxWidth: ReadingMeasure.columnFrame(width: .infinity))
                    .frame(maxWidth: .infinity)
            }
        .navigationTitle(scope.name)
        .navigationBarTitleDisplayMode(.inline)
        // As on a thread: outside the split the tab bar gives the composer the screen's foot.
        .toolbar(pose.isSplit ? .automatic : .hidden, for: .tabBar)
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
