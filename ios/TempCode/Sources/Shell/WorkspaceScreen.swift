import SwiftUI
import TempCodeClient
import TempCodeContract

/// One workspace, the way the desktop's middle sidebar shows it: each
/// project as a row that pushes its every thread (ProjectScreen.swift), its
/// active threads nested under it with their subagents and a master's batch
/// one step in, then the workspace's chats (threads with no project), then
/// the archived projects in one dim row per host. The Chats entry of Home is
/// the same screen with chats alone. Every linked copy reads as one.
struct WorkspaceScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(NewThreadPresenter.self) private var presenter
    @Environment(ShellNavigator.self) private var navigator
    let key: String
    var slots = HomeSlots()
    @State private var cues: [String: HomeModel.Cue] = [:]

    var body: some View {
        let screen = HomeSections.workspace(key, hosts: HomeRows.inputs(model.registry.ordered))
        let rows = (screen?.projects.flatMap(\.rows) ?? []) + (screen?.chats ?? [])
        List {
            if let screen {
                ForEach(screen.projects) { entry in
                    Section {
                        ProjectEntryRow(project: entry.project, slots: slots, newThread: presenter.compose)
                        ForEach(entry.rows) { row in
                            ShellRowView(row: row, cue: ShellCues.cue(for: row, in: cues))
                        }
                    }
                }
                if !screen.chats.isEmpty {
                    Section {
                        ForEach(screen.chats) { row in
                            ShellRowView(row: row, cue: ShellCues.cue(for: row, in: cues))
                        }
                    } header: {
                        // The Chats entry is chats alone: its title already says so.
                        if screen.workspace != nil, !screen.projects.isEmpty {
                            Text("Chats")
                                .textStep(.meta, weight: .semibold)
                                .textCase(nil)
                        }
                    }
                }
                if !screen.archivedProjects.isEmpty {
                    Section {
                        ForEach(screen.archivedProjects) { archived in
                            Button { navigator.open(.archivedProjects(environmentId: archived.environmentId, workspaceId: archived.workspace.id)) } label: {
                                HStack(spacing: 6) {
                                    DimRow(archived.count == 1 ? "1 archived project" : "\(archived.count) archived projects")
                                    HostGlyph(environmentId: archived.environmentId)
                                }
                            }
                            .buttonStyle(.pressable)
                            .listRowInsets(Layout.rowInsets)
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .listSectionSpacing(10)
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
