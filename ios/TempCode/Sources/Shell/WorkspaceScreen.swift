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
    let key: String
    @Binding var path: NavigationPath
    var slots = HomeSlots()
    @State private var cues: [String: HomeModel.Cue] = [:]

    var body: some View {
        let screen = HomeSections.workspace(key, hosts: HomeRows.inputs(model.registry.ordered))
        let rows = (screen?.projects.flatMap(\.rows) ?? []) + (screen?.chats ?? [])
        List {
            if let screen {
                ForEach(screen.projects) { entry in
                    Section {
                        ProjectEntryRow(project: entry.project, slots: slots, path: $path, newThread: presenter.compose)
                        ForEach(entry.rows) { row in
                            ShellRowView(row: row, cue: ShellCues.cue(for: row, in: cues), path: $path)
                        }
                    }
                }
                if !screen.chats.isEmpty {
                    Section {
                        ForEach(screen.chats) { row in
                            ShellRowView(row: row, cue: ShellCues.cue(for: row, in: cues), path: $path)
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
                            Button { path.append(Route.archivedProjects(environmentId: archived.environmentId, workspaceId: archived.workspace.id)) } label: {
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
        .navigationBarTitleDisplayMode(.large)
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
