import SwiftUI
import TempCodeClient
import TempCodeContract

/// One project's every thread, every linked copy's mixed by recency: the
/// active ones first (what the workspace screen nests under the project),
/// then the dormant ones, pinned first and newest first within each, each
/// with its subagents and a master's batch one step in; the archived roots
/// in one dim row per host at the end. The bar holds the plan chip, New
/// Thread and the project's menu.
struct ProjectScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(NewThreadPresenter.self) private var presenter
    let key: String
    @Binding var path: NavigationPath
    var slots = HomeSlots()
    @State private var cues: [String: HomeModel.Cue] = [:]

    var body: some View {
        let screen = HomeSections.project(key, hosts: HomeRows.inputs(model.registry.ordered))
        List {
            if let screen {
                Section {
                    ForEach(screen.active) { row in
                        ShellRowView(row: row, cue: ShellCues.cue(for: row, in: cues), path: $path)
                    }
                }
                if !screen.dormant.isEmpty {
                    Section {
                        ForEach(screen.dormant) { row in
                            ShellRowView(row: row, cue: ShellCues.cue(for: row, in: cues), path: $path)
                        }
                    } header: {
                        if !screen.active.isEmpty {
                            Text("Dormant")
                                .textStep(.meta, weight: .semibold)
                                .textCase(nil)
                        }
                    }
                }
                if !screen.archived.isEmpty {
                    Section {
                        ForEach(screen.archived) { archived in
                            Button { path.append(Route.archivedThreads(environmentId: archived.environmentId, projectId: archived.projectId)) } label: {
                                HStack(spacing: 6) {
                                    DimRow(archived.count == 1 ? "1 archived" : "\(archived.count) archived")
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
            if let screen, screen.isEmpty, let lead = lead(screen) {
                QuietNote(text: "No threads here yet.", action: ("New thread", { presenter.compose(lead.client, lead.workspace, screen.project.project) }))
                    .padding(.horizontal, Layout.textEdge)
            } else if screen == nil {
                ContentUnavailableView("Project Not Found", systemImage: "folder")
            }
        }
        .needsYouCues((screen?.active ?? []) + (screen?.dormant ?? []), into: $cues)
        .navigationTitle(screen?.project.project.name ?? "")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            if let screen, let lead = lead(screen) {
                // Three items, not a group: the chip is the first to overflow, New Thread and the menu stay.
                if let trailing = slots.projectTrailing {
                    ToolbarItem(placement: .primaryAction) {
                        trailing(lead.client, screen.project.project)
                            .environment(\.inBar, true)
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("New Thread", systemImage: "square.and.pencil") { presenter.compose(lead.client, lead.workspace, screen.project.project) }
                }
                .highVisibility()
                if slots.hasProjectMenu {
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            ProjectMenuContent(project: screen.project, slots: slots, newThread: presenter.compose)
                        } label: {
                            Image(systemName: GlassMetrics.moreSymbol)
                        }
                        .accessibilityLabel("\(screen.project.project.name) menu")
                    }
                    .highVisibility()
                }
            }
        }
        .listOnScreen("project:\(key)")
    }

    /// The lead copy (the first host in registry order) and its workspace: where a new thread starts.
    private func lead(_ screen: HomeSections.ProjectScreen) -> (client: EnvironmentClient, workspace: WorkspaceMeta)? {
        let project = screen.project.project
        guard let client = model.registry.client(screen.project.environmentId),
              let workspace = client.workspaces.first(where: { $0.id == project.workspaceId }) else { return nil }
        return (client: client, workspace: workspace)
    }
}
