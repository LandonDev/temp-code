import SwiftUI
import TempCodeClient
import TempCodeContract

/// A project's archived roots, newest first.
struct ArchivedThreadsView: View {
    let client: EnvironmentClient
    let projectId: String
    @Binding var path: NavigationPath

    var body: some View {
        let project = client.projects.first { $0.id == projectId }
        let threads = ThreadGroups.archivedThreads(client.sessions, projectId: projectId)
        List {
            if let project {
                SectionHeader(project.name, branch: project.branch, worktree: project.mode == .worktree)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
            }
            ForEach(threads, id: \.id) { meta in
                ThreadButton(client: client, sessionId: meta.id, model: ThreadRowModel(session: meta), path: $path)
            }
        }
        .listStyle(.plain)
        .overlay {
            if threads.isEmpty {
                ContentUnavailableView("Nothing archived", systemImage: "archivebox")
            }
        }
        .navigationTitle("Archived")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// A workspace's archived projects, each with the threads it still holds.
struct ArchivedProjectsView: View {
    let client: EnvironmentClient
    let workspaceId: String
    @Binding var path: NavigationPath

    var body: some View {
        let groups = ThreadGroups.group(client.sessions, projects: client.projects, workspaces: client.workspaces, workspaceId: workspaceId, seen: client.seen, floor: Int(client.environment.addedAt)).archived
        List {
            ForEach(groups) { group in
                SectionHeader(group.project.name, branch: group.project.branch, worktree: group.project.mode == .worktree)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                ForEach(group.threads) { item in
                    ThreadButton(client: client, sessionId: item.id, model: ThreadRowModel(session: item.meta, unseen: item.unseen), path: $path)
                }
                if group.archivedCount > 0 {
                    Button { path.append(Route.archivedThreads(environmentId: client.environment.id, projectId: group.id)) } label: {
                        DimRow(group.archivedCount == 1 ? "1 archived" : "\(group.archivedCount) archived")
                    }
                    .buttonStyle(.pressable)
                    .listRowInsets(rowInsets)
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if groups.isEmpty {
                ContentUnavailableView("No archived projects", systemImage: "archivebox")
            }
        }
        .navigationTitle("Archived projects")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// A thread row that pushes its thread.
struct ThreadButton: View {
    let client: EnvironmentClient
    let sessionId: String
    let model: ThreadRowModel
    @Binding var path: NavigationPath
    var seq: Int? = nil

    var body: some View {
        Button { path.append(Route.thread(environmentId: client.environment.id, sessionId: sessionId, seq: seq)) } label: {
            ThreadRow(row: model)
        }
        .buttonStyle(.pressable)
        .listRowInsets(rowInsets)
    }
}
