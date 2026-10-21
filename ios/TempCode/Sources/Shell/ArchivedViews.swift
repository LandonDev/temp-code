import SwiftUI
import TempCodeClient
import TempCodeContract

/// A project's archived roots, newest first, on the same grouped card as Home.
struct ArchivedThreadsView: View {
    let client: EnvironmentClient
    let projectId: String
    @Binding var path: NavigationPath

    var body: some View {
        let project = client.projects.first { $0.id == projectId }
        let threads = ThreadGroups.archivedThreads(client.sessions, projectId: projectId)
        List {
            Section {
                ForEach(threads, id: \.id) { meta in
                    ThreadButton(client: client, sessionId: meta.id, model: ThreadRowModel(session: meta), path: $path)
                }
            } header: {
                if let project {
                    ArchivedHeader(name: project.name, branch: project.branch, worktree: project.mode == .worktree)
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if threads.isEmpty {
                ContentUnavailableView {
                    Label("Nothing archived", systemImage: "archivebox")
                } description: {
                    Text("Threads you archive in \(project?.name ?? "this project") end up here.")
                }
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
                Section {
                    ForEach(group.threads) { item in
                        ThreadButton(client: client, sessionId: item.id, model: ThreadRowModel(session: item.meta, unseen: item.unseen), path: $path)
                    }
                    if group.archivedCount > 0 {
                        Button { path.append(Route.archivedThreads(environmentId: client.environment.id, projectId: group.id)) } label: {
                            DimRow(group.archivedCount == 1 ? "1 archived" : "\(group.archivedCount) archived")
                        }
                        .buttonStyle(.pressable)
                    }
                } header: {
                    ArchivedHeader(name: group.project.name, branch: group.project.branch, worktree: group.project.mode == .worktree)
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if groups.isEmpty {
                ContentUnavailableView {
                    Label("No archived projects", systemImage: "archivebox")
                } description: {
                    Text("Projects you archive in this workspace end up here.")
                }
            }
        }
        .navigationTitle("Archived projects")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// A project's name as a grouped header: the worktree mark and the branch dim after it.
private struct ArchivedHeader: View {
    let name: String
    let branch: String?
    let worktree: Bool

    var body: some View {
        HStack(spacing: 6) {
            Text(name)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if worktree {
                Image(systemName: "arrow.triangle.branch")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityLabel("Worktree")
            }
            if let branch {
                Text(branch)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .layoutPriority(-1)
            }
        }
        .textCase(nil)
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
        .modifier(RowActionsIfKnown(client: client, sessionId: sessionId))
    }
}

/// The row actions when the client still lists the thread.
private struct RowActionsIfKnown: ViewModifier {
    let client: EnvironmentClient
    let sessionId: String

    func body(content: Content) -> some View {
        if let meta = client.session(sessionId) {
            content.threadRowActions(client: client, meta: meta)
        } else {
            content
        }
    }
}
