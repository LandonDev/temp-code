import Foundation
import TempCodeClient
import TempCodeContract

/// Home as one flat list, built from every host's shell and the remembered
/// folds. Pure, so the view's body is one ForEach over stable ids.
enum HomeRow: Identifiable {
    case status(EnvironmentClient)
    case title(String)
    case needsYou(EnvironmentClient, NeedsYouItem)
    case running(EnvironmentClient, SessionMeta)
    case host(EnvironmentClient)
    case workspace(EnvironmentClient, WorkspaceMeta, collapsed: Bool)
    case project(EnvironmentClient, ProjectGroup)
    case thread(EnvironmentClient, ThreadItem)
    case moreAgents(EnvironmentClient, root: SessionMeta, hidden: Int)
    case archivedThreads(EnvironmentClient, ProjectGroup)
    case archivedProjects(EnvironmentClient, WorkspaceMeta, count: Int)
    case nothing(EnvironmentClient)

    var id: String {
        switch self {
        case .status(let client): "status:\(client.environment.id)"
        case .title(let title): "title:\(title)"
        case .needsYou(_, let item): "needs:\(item.id)"
        case .running(_, let meta): "running:\(meta.id)"
        case .host(let client): "host:\(client.environment.id)"
        case .workspace(let client, let workspace, _): "workspace:\(client.environment.id):\(workspace.id)"
        case .project(let client, let group): "project:\(client.environment.id):\(group.id)"
        case .thread(_, let item): "thread:\(item.id)"
        case .moreAgents(_, let root, _): "more:\(root.id)"
        case .archivedThreads(let client, let group): "archived:\(client.environment.id):\(group.id)"
        case .archivedProjects(let client, let workspace, _): "archived-projects:\(client.environment.id):\(workspace.id)"
        case .nothing(let client): "nothing:\(client.environment.id)"
        }
    }
}

enum HomeRows {
    /// Settled subagents shown under a root before the "n more" row.
    static let settledShown = 3

    static func foldKey(_ client: EnvironmentClient, _ workspace: WorkspaceMeta) -> String {
        "\(client.environment.id):\(workspace.id)"
    }

    /// A host that gets a status row: refused, offline, between retries, or
    /// one that could not be reached since launch (connecting with a retry pending).
    static func troubled(_ status: EnvironmentStatus) -> Bool {
        switch status.transport {
        case .unauthorized, .offline, .reconnecting: true
        case .connecting: status.nextRetryAt != nil && status.attempts > 0
        case .open, .suspended: false
        }
    }

    static func build(clients: [EnvironmentClient], folded: Set<String>) -> [HomeRow] {
        var rows: [HomeRow] = []
        for client in clients where troubled(client.status) {
            rows.append(.status(client))
        }

        let needs = clients
            .flatMap { client in HomeModel.needsYou(client.sessions).map { (client, $0) } }
            .sorted { ($0.1.since, $0.1.id) < ($1.1.since, $1.1.id) }
        if !needs.isEmpty {
            rows.append(.title("Needs you"))
            rows += needs.map { .needsYou($0.0, $0.1) }
        }

        let running = clients
            .flatMap { client in HomeModel.running(client.sessions).map { (client, $0) } }
            .sorted { ($0.1.updatedAt, $0.1.id) > ($1.1.updatedAt, $1.1.id) }
        if !running.isEmpty {
            rows.append(.title("Running"))
            rows += running.map { .running($0.0, $0.1) }
        }

        for client in clients {
            if clients.count > 1 { rows.append(.host(client)) }
            let floor = Int(client.environment.addedAt)
            let loose = ThreadGroups.group(client.sessions, projects: client.projects, workspaces: client.workspaces, workspaceId: nil, seen: client.seen, floor: floor).chats
            if !loose.isEmpty {
                rows.append(.title("Chats"))
                rows += threadRows(client, loose)
            }
            if client.workspaces.isEmpty, loose.isEmpty {
                rows.append(.nothing(client))
                continue
            }
            for workspace in client.workspaces {
                let groups = ThreadGroups.group(client.sessions, projects: client.projects, workspaces: client.workspaces, workspaceId: workspace.id, seen: client.seen, floor: floor)
                let collapsed = folded.contains(foldKey(client, workspace))
                rows.append(.workspace(client, workspace, collapsed: collapsed))
                if collapsed { continue }
                rows += threadRows(client, groups.chats)
                for group in groups.projects {
                    rows.append(.project(client, group))
                    rows += threadRows(client, group.threads)
                    if group.archivedCount > 0 { rows.append(.archivedThreads(client, group)) }
                }
                if !groups.archived.isEmpty {
                    rows.append(.archivedProjects(client, workspace, count: groups.archived.count))
                }
            }
        }
        return rows
    }

    /// A root, then its subagents: every live or needs-you one, a few
    /// settled ones, and one dim row for the rest.
    static func threadRows(_ client: EnvironmentClient, _ items: [ThreadItem]) -> [HomeRow] {
        var rows: [HomeRow] = []
        for item in items {
            rows.append(.thread(client, item))
            var settled = 0
            var hidden = 0
            for child in item.children {
                if ThreadGroups.rank(child.meta.status) < 3 {
                    rows.append(.thread(client, child))
                } else if settled < settledShown {
                    settled += 1
                    rows.append(.thread(client, child))
                } else {
                    hidden += 1
                }
            }
            if hidden > 0 { rows.append(.moreAgents(client, root: item.meta, hidden: hidden)) }
        }
        return rows
    }
}
