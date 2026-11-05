import SwiftUI
import TempCodeClient
import TempCodeContract

/// One workspace, the way the desktop's middle sidebar shows it: each
/// project as its card (ProjectCardView.swift: the name, the branch line and
/// the lines of what needs saying), which opens the project's every thread
/// (ProjectScreen.swift) or, from a line, that thread; then the workspace's
/// chats (threads with no project) 16 pt under the cards, then the archived
/// projects in one dim row per host. The Chats entry of Home is the same
/// screen with chats alone. Every linked copy reads as one.
struct WorkspaceScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(NewThreadPresenter.self) private var presenter
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.shellPose) private var pose
    let key: String
    var slots = HomeSlots()
    @State private var cues: [String: HomeModel.Cue] = [:]
    @ScaledMetric(relativeTo: .caption) private var cardGap = CardMetrics.gap
    @ScaledMetric(relativeTo: .caption) private var foldGap = CardMetrics.foldGap

    var body: some View {
        let screen = HomeSections.workspace(key, hosts: HomeRows.inputs(model.registry.ordered), shown: shown)
        // The needs-you and failed lines read their cue ("Approve: run bun test") as the rows did.
        let rows = (screen?.projects ?? []).flatMap(cueRows) + (screen?.chats ?? [])
        List {
            if let screen {
                ForEach(screen.projects) { card in
                    ProjectCardView(card: card, selected: pose.isSplit && card.holdsShown, cues: cues, slots: slots, newThread: presenter.compose)
                        .listRowInsets(EdgeInsets(top: cardGap / 2, leading: Layout.textEdge, bottom: cardGap / 2, trailing: Layout.textEdge))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                if !screen.chats.isEmpty {
                    // The Chats entry is chats alone: its title already says so.
                    if screen.workspace != nil, !screen.projects.isEmpty {
                        Text("Chats")
                            .textStep(.meta, weight: .semibold)
                            .accessibilityAddTraits(.isHeader)
                            .listRowInsets(EdgeInsets(top: foldGap - cardGap / 2, leading: Layout.textEdge, bottom: 0, trailing: Layout.textEdge))
                            .listRowSeparator(.hidden)
                    }
                    ForEach(screen.chats) { row in
                        ShellRowView(row: row, cue: ShellCues.cue(for: row, in: cues))
                    }
                }
                if !screen.archivedProjects.isEmpty {
                    ForEach(screen.archivedProjects) { archived in
                        Button { navigator.open(.archivedProjects(environmentId: archived.environmentId, workspaceId: archived.workspace.id)) } label: {
                            HStack(spacing: 6) {
                                DimRow(archived.count == 1 ? "1 archived project" : "\(archived.count) archived projects")
                                HostGlyph(environmentId: archived.environmentId)
                            }
                        }
                        .buttonStyle(.pressable)
                        // Straight after the cards it starts a new group, as the Chats fold does.
                        .padding(.top, screen.chats.isEmpty && !screen.projects.isEmpty && archived.id == screen.archivedProjects.first?.id ? foldGap - cardGap / 2 : 0)
                        .listRowInsets(Layout.rowInsets)
                    }
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if screen?.isEmpty ?? true {
                if let lead {
                    QuietNote(text: "No threads here yet.", action: ("New thread", { presenter.compose(lead.client, lead.workspace, nil) }))
                        .padding(.horizontal, Layout.textEdge)
                } else if screen == nil {
                    ContentUnavailableView("Workspace Not Found", systemImage: "folder")
                }
            }
        }
        .needsYouCues(rows, into: $cues)
        .navigationTitle(title(screen))
        .shellTitleDisplay()
        // The desktop's breadcrumb popover: the title is a menu of every workspace and the Chats
        // entry, the current one checked, in both shapes (one tap to switch a workspace folded too).
        // Omitted with one entry: a menu of one is a dead chevron.
        .modifier(WorkspaceTitleMenu(key: key, entries: HomeSections.home(hosts: HomeRows.inputs(model.registry.ordered)).entries))
        .toolbar {
            if let lead {
                ToolbarItem(placement: .primaryAction) {
                    Button("New Thread", systemImage: "square.and.pencil") { presenter.compose(lead.client, lead.workspace, nil) }
                }
                .highVisibility()
            }
        }
        .listOnScreen("workspace:\(key)")
    }

    /// The thread on screen, which no card reads as unread.
    private var shown: (environmentId: String, sessionId: String)? {
        for client in model.registry.ordered {
            if let id = client.visibleThread { return (client.environment.id, id) }
        }
        return nil
    }

    /// A card's needs-you and failed lines as the rows `needsYouCues` reads.
    private func cueRows(_ card: ProjectCard) -> [ShellRow] {
        card.lines.compactMap { line in
            switch line {
            case .needsYou(let t), .failed(let t): .thread(environmentId: t.environmentId, ThreadItem(meta: t.meta), depth: 0)
            default: nil
            }
        }
    }

    /// The copy a new thread starts on: the first host in registry order.
    private var lead: (client: EnvironmentClient, workspace: WorkspaceMeta)? {
        guard key != HomeSections.chatsKey,
              let workspace = HomeSections.workspaces(of: HomeRows.inputs(model.registry.ordered)).first(where: { $0.id == key }),
              let first = workspace.members.first, let client = model.registry.client(first.environmentId) else { return nil }
        return (client: client, workspace: first.workspace)
    }

    private func title(_ screen: HomeSections.WorkspaceScreen?) -> String {
        if key == HomeSections.chatsKey { return "Chats" }
        return screen?.workspace?.name ?? ""
    }
}

/// `toolbarTitleMenu` listing Home's entries; a pick replaces the sidebar's
/// path with that workspace and leaves the detail alone: the open thread
/// stays, and the strip follows the thread, not the sidebar.
private struct WorkspaceTitleMenu: ViewModifier {
    @Environment(ShellNavigator.self) private var navigator
    let key: String
    let entries: [HomeSections.Entry]
    @State private var opened = false

    func body(content: Content) -> some View {
        if entries.count > 1 {
            content
                .toolbarTitleMenu {
                    ForEach(entries) { entry in
                        Button {
                            navigator.sidebarPath = [.workspace(key: entry.id)]
                        } label: {
                            if entry.id == key {
                                Label(name(entry), systemImage: "checkmark")
                            } else {
                                Text(name(entry))
                            }
                        }
                    }
                }
        } else {
            content
        }
    }

    private func name(_ entry: HomeSections.Entry) -> String {
        switch entry.kind {
        case .workspace(let workspace): workspace.name
        case .chats: "Chats"
        }
    }
}
