import Foundation
import TempCodeClient
import TempCodeContract

/// Home as native sections, built from every host's shell and the remembered
/// folds. Pure, so the view's body is one ForEach over stable ids.
struct HomeSection: Identifiable {
    enum Header: Hashable {
        case none
        /// "Needs you", "Running", "Chats".
        case title(String)
        /// With several hosts, the host's name and connection dot over its workspaces.
        case host(EnvironmentClient)
        /// A workspace: logo, name, repo; the fold, and the count while folded.
        case workspace(EnvironmentClient, WorkspaceMeta, collapsed: Bool, threads: Int)

        static func == (a: Header, b: Header) -> Bool { a.key == b.key }
        func hash(into hasher: inout Hasher) { hasher.combine(key) }

        private var key: String {
            switch self {
            case .none: "none"
            case .title(let title): "title:\(title)"
            case .host(let client): "host:\(client.environment.id)"
            case .workspace(let client, let workspace, let collapsed, let threads): "workspace:\(client.environment.id):\(workspace.id):\(collapsed):\(threads)"
            }
        }
    }

    let id: String
    var header: Header
    var rows: [HomeRow]
}

enum HomeRow: Identifiable {
    case status(EnvironmentClient)
    case needsYou(EnvironmentClient, NeedsYouItem)
    case running(EnvironmentClient, SessionMeta)
    /// Nothing needs you and nothing runs: one calm line and the way to start a thread.
    case calm(EnvironmentClient, WorkspaceMeta)
    case project(EnvironmentClient, ProjectGroup)
    case thread(EnvironmentClient, ThreadItem)
    case moreAgents(EnvironmentClient, root: SessionMeta, hidden: Int)
    case archivedThreads(EnvironmentClient, ProjectGroup)
    case archivedProjects(EnvironmentClient, WorkspaceMeta, count: Int)
    /// An expanded workspace with no thread in it yet.
    case emptyWorkspace(EnvironmentClient, WorkspaceMeta)
    /// A host with no workspace and no chat: the fact and the place to fix it, or a spinner until it is listed.
    case nothing(EnvironmentClient)

    var id: String {
        switch self {
        case .status(let client): "status:\(client.environment.id)"
        case .needsYou(_, let item): "needs:\(item.id)"
        case .running(_, let meta): "running:\(meta.id)"
        case .calm(let client, _): "calm:\(client.environment.id)"
        case .project(let client, let group): "project:\(client.environment.id):\(group.id)"
        case .thread(_, let item): "thread:\(item.id)"
        case .moreAgents(_, let root, _): "more:\(root.id)"
        case .archivedThreads(let client, let group): "archived:\(client.environment.id):\(group.id)"
        case .archivedProjects(let client, let workspace, _): "archived-projects:\(client.environment.id):\(workspace.id)"
        case .emptyWorkspace(let client, let workspace): "empty:\(client.environment.id):\(workspace.id)"
        case .nothing(let client): "nothing:\(client.environment.id)"
        }
    }

    /// Rows that come and go because of an event (a host dropping, a thread
    /// needing you) and so arrive with the needs-you motion.
    var isEvent: Bool {
        switch self {
        case .status, .needsYou: true
        default: false
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

    static func build(clients: [EnvironmentClient], folded: Set<String>) -> [HomeSection] {
        var sections: [HomeSection] = []
        let status = clients.filter { troubled($0.status) }.map { HomeRow.status($0) }
        if !status.isEmpty { sections.append(HomeSection(id: "status", header: .none, rows: status)) }

        let needs = clients
            .flatMap { client in HomeModel.needsYou(client.sessions).map { (client, $0) } }
            .sorted { ($0.1.since, $0.1.id) < ($1.1.since, $1.1.id) }
        if !needs.isEmpty {
            sections.append(HomeSection(id: "needs", header: .title("Needs you"), rows: needs.map { .needsYou($0.0, $0.1) }))
        }

        let running = clients
            .flatMap { client in HomeModel.running(client.sessions).map { (client, $0) } }
            .sorted { ($0.1.updatedAt, $0.1.id) > ($1.1.updatedAt, $1.1.id) }
        if !running.isEmpty {
            sections.append(HomeSection(id: "running", header: .title("Running"), rows: running.map { .running($0.0, $0.1) }))
        }

        // Quiet is a state too: say so once, with the one thing to do from here.
        if needs.isEmpty, running.isEmpty, let calm = clients.first(where: { $0.hasShell && !$0.workspaces.isEmpty }), let workspace = calm.workspaces.first {
            sections.append(HomeSection(id: "calm", header: .none, rows: [.calm(calm, workspace)]))
        }

        for client in clients {
            let host = client.environment.id
            if clients.count > 1 { sections.append(HomeSection(id: "host:\(host)", header: .host(client), rows: [])) }
            let floor = Int(client.environment.addedAt)
            let loose = ThreadGroups.group(client.sessions, projects: client.projects, workspaces: client.workspaces, workspaceId: nil, seen: client.seen, floor: floor).chats
            if !loose.isEmpty {
                sections.append(HomeSection(id: "chats:\(host)", header: .title("Chats"), rows: threadRows(client, loose)))
            }
            if client.workspaces.isEmpty, loose.isEmpty {
                sections.append(HomeSection(id: "nothing:\(host)", header: .none, rows: [.nothing(client)]))
                continue
            }
            for workspace in client.workspaces {
                let groups = ThreadGroups.group(client.sessions, projects: client.projects, workspaces: client.workspaces, workspaceId: workspace.id, seen: client.seen, floor: floor)
                let collapsed = folded.contains(foldKey(client, workspace))
                let threads = groups.chats.count + groups.projects.reduce(0) { $0 + $1.threads.count }
                var rows: [HomeRow] = []
                if !collapsed {
                    rows += threadRows(client, groups.chats)
                    for group in groups.projects {
                        rows.append(.project(client, group))
                        rows += threadRows(client, group.threads)
                        if group.archivedCount > 0 { rows.append(.archivedThreads(client, group)) }
                    }
                    if !groups.archived.isEmpty {
                        rows.append(.archivedProjects(client, workspace, count: groups.archived.count))
                    }
                    if rows.isEmpty { rows.append(.emptyWorkspace(client, workspace)) }
                }
                sections.append(HomeSection(id: "workspace:\(host):\(workspace.id)", header: .workspace(client, workspace, collapsed: collapsed, threads: threads), rows: rows))
            }
        }
        return sections
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
