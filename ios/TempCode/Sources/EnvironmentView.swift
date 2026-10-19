import SwiftUI
import TempCodeClient
import TempCodeContract

/// One host: its threads, grouped by project, newest first.
struct EnvironmentView: View {
    let client: EnvironmentClient

    var body: some View {
        let groups = ThreadGroups.build(projects: client.projects, workspaces: client.workspaces, sessions: client.sessions)
        VStack(spacing: 0) {
            StatusLine(client: client)
            if groups.isEmpty {
                if client.hasShell || client.status.transport == .open {
                    ContentUnavailableView("No threads", systemImage: "bubble.left.and.text.bubble.right")
                } else {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
            } else {
                List {
                    ForEach(groups) { group in
                        Section {
                            ForEach(group.sessions, id: \.id) { session in
                                NavigationLink(value: ThreadRoute(environmentId: client.environment.id, sessionId: session.id)) {
                                    ThreadRow(session: session)
                                }
                                .accessibilityIdentifier("thread-row")
                            }
                        } header: {
                            HStack(spacing: 6) {
                                Text(group.title)
                                if let branch = group.branch {
                                    Text(branch)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
            }
        }
        .animation(.default, value: client.status.transport)
        .navigationTitle(client.environment.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct ThreadRoute: Hashable {
    let environmentId: String
    let sessionId: String
}

struct ThreadRow: View {
    let session: SessionMeta

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            ThreadStatusGlyph(session: session)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 3) {
                Text(session.title.isEmpty ? "Untitled" : session.title)
                    .lineLimit(2)
                if let line = subtitle {
                    Text(line)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            Text(Formatting.relative(ms: session.updatedAt))
                .font(.caption)
                .foregroundStyle(.tertiary)
                .monospacedDigit()
        }
        .padding(.vertical, 2)
    }

    private var subtitle: String? {
        if let activity = session.activity, !activity.isEmpty { return activity }
        if let tasks = session.tasks, tasks.total > 0 {
            return tasks.current.map { "\(tasks.done)/\(tasks.total) · \($0)" } ?? "\(tasks.done)/\(tasks.total) tasks"
        }
        return nil
    }
}

/// The thread's state at a glance: busy, needs you, failed. Idle shows nothing.
struct ThreadStatusGlyph: View {
    let session: SessionMeta

    var body: some View {
        switch kind {
        case .working:
            ProgressView()
                .controlSize(.mini)
        case .needsYou:
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(.orange)
                .font(.subheadline)
        case .failed:
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(.red)
                .font(.subheadline)
        case .idle:
            Color.clear
                .frame(width: 16, height: 16)
        }
    }

    private enum Kind { case working, needsYou, failed, idle }

    private var kind: Kind {
        switch session.status {
        case .running, .starting: .working
        case .waiting: .needsYou
        case .error: .failed
        default: session.treeHasLiveWork == true ? .working : .idle
        }
    }
}

/// Sessions under their project (else their workspace, else "Other"),
/// projects ordered by their newest session.
struct ThreadGroups {
    struct Group: Identifiable {
        let id: String
        let title: String
        let branch: String?
        var sessions: [SessionMeta]
    }

    static func build(projects: [ProjectMeta], workspaces: [WorkspaceMeta], sessions: [SessionMeta]) -> [Group] {
        let projectById = Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0) })
        let workspaceById = Dictionary(uniqueKeysWithValues: workspaces.map { ($0.id, $0) })
        var groups: [String: Group] = [:]
        var order: [String] = []
        for session in sessions where !session.archived && session.parentId == nil {
            let key: String
            let title: String
            var branch: String?
            if let projectId = session.projectId, let project = projectById[projectId] {
                key = "p:\(projectId)"
                title = project.name
                branch = project.branch
            } else if let workspaceId = session.workspaceId, let workspace = workspaceById[workspaceId] {
                key = "w:\(workspaceId)"
                title = workspace.name
            } else {
                key = "other"
                title = "Other"
            }
            if groups[key] == nil {
                groups[key] = Group(id: key, title: title, branch: branch, sessions: [])
                order.append(key)
            }
            groups[key]?.sessions.append(session)
        }
        return order.compactMap { groups[$0] }
    }
}
