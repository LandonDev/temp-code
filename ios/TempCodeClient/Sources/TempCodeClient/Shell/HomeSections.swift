import Foundation
import TempCodeContract

/// One host as Home reads it: value copies of what its `EnvironmentClient`
/// holds, so the builder below is pure and the tests need no socket.
public struct HomeHostInput: Sendable, Hashable {
    public var environmentId: String
    public var name: String
    /// The host gets a status row (`HomeSections.troubled`).
    public var troubled: Bool
    /// The shell has been listed at least once this process.
    public var hasShell: Bool
    /// The pairing time (ms): threads older than it are never unseen.
    public var floor: Int
    public var workspaces: [WorkspaceMeta]
    public var projects: [ProjectMeta]
    public var sessions: [SessionMeta]
    public var seen: [String: SeenMark]
    /// The host's one-off lines (the boot-resume note); empty by default.
    public var notes: [HomeNote]

    public init(environmentId: String, name: String, troubled: Bool = false, hasShell: Bool = true, floor: Int = 0, workspaces: [WorkspaceMeta] = [], projects: [ProjectMeta] = [], sessions: [SessionMeta] = [], seen: [String: SeenMark] = [:], notes: [HomeNote] = []) {
        self.environmentId = environmentId
        self.name = name
        self.troubled = troubled
        self.hasShell = hasShell
        self.floor = floor
        self.workspaces = workspaces
        self.projects = projects
        self.sessions = sessions
        self.seen = seen
        self.notes = notes
    }
}

/// A host's one-off line under its header: "3 threads resumed after restart".
public struct HomeNote: Sendable, Hashable, Identifiable {
    public var id: String
    public var text: String

    public init(id: String, text: String) {
        self.id = id
        self.text = text
    }
}

/// A workspace as Home lists it: one host's, or one copy per host when the
/// same project is paired across hosts.
public struct HomeWorkspace: Sendable, Hashable, Identifiable {
    public struct Member: Sendable, Hashable {
        public var environmentId: String
        public var workspace: WorkspaceMeta

        public init(environmentId: String, workspace: WorkspaceMeta) {
            self.environmentId = environmentId
            self.workspace = workspace
        }
    }

    /// The pairing key; `"<env>:<ws>"` when unpaired. Also the fold key.
    public var id: String
    public var name: String
    public var repo: String?
    public var members: [Member]

    public init(id: String, name: String, repo: String?, members: [Member]) {
        self.id = id
        self.name = name
        self.repo = repo
        self.members = members
    }

    public var isPaired: Bool { members.count > 1 }
}

/// Which workspaces are two copies of one project: the same key for both.
/// The default pairs nothing; the paired-projects thread supplies the
/// selector (same GitHub repo, else same folder name).
public struct HomePairing: Sendable {
    public var key: @Sendable (_ environmentId: String, _ workspace: WorkspaceMeta) -> String

    public init(key: @escaping @Sendable (_ environmentId: String, _ workspace: WorkspaceMeta) -> String) {
        self.key = key
    }

    public static let none = HomePairing { environmentId, workspace in "\(environmentId):\(workspace.id)" }
}

/// One row of Home. Rows carry ids and metas, never a client; the view
/// resolves the host from `environmentId`.
public enum HomeRow: Sendable, Hashable, Identifiable {
    case status(environmentId: String)
    case hostNote(environmentId: String, HomeNote)
    case needsYou(environmentId: String, NeedsYouItem)
    case running(environmentId: String, SessionMeta)
    /// Nothing needs you and nothing runs: one calm line and the way to start a thread.
    case calm(environmentId: String, WorkspaceMeta)
    /// `paired` when the workspace is listed across hosts, so the header names the host.
    case project(environmentId: String, ProjectGroup, paired: Bool)
    case thread(environmentId: String, ThreadItem)
    case moreAgents(environmentId: String, root: SessionMeta, hidden: Int)
    case archivedThreads(environmentId: String, ProjectGroup)
    case archivedProjects(environmentId: String, WorkspaceMeta, count: Int)
    /// An expanded workspace with no thread in it yet.
    case emptyWorkspace(environmentId: String, WorkspaceMeta)
    /// A host with no workspace and no chat: a spinner until `listed`, then the fact and where to fix it.
    case nothing(environmentId: String, name: String, listed: Bool)

    public var id: String {
        switch self {
        case .status(let env): "status:\(env)"
        case .hostNote(let env, let note): "note:\(env):\(note.id)"
        case .needsYou(_, let item): "needs:\(item.id)"
        case .running(_, let meta): "running:\(meta.id)"
        case .calm(let env, _): "calm:\(env)"
        case .project(let env, let group, _): "project:\(env):\(group.id)"
        case .thread(_, let item): "thread:\(item.id)"
        case .moreAgents(_, let root, _): "more:\(root.id)"
        case .archivedThreads(let env, let group): "archived:\(env):\(group.id)"
        case .archivedProjects(let env, let workspace, _): "archived-projects:\(env):\(workspace.id)"
        case .emptyWorkspace(let env, let workspace): "empty:\(env):\(workspace.id)"
        case .nothing(let env, _, _): "nothing:\(env)"
        }
    }

    /// The host the row belongs to.
    public var environmentId: String {
        switch self {
        case .status(let env), .hostNote(let env, _), .needsYou(let env, _), .running(let env, _), .calm(let env, _),
             .project(let env, _, _), .thread(let env, _), .moreAgents(let env, _, _), .archivedThreads(let env, _),
             .archivedProjects(let env, _, _), .emptyWorkspace(let env, _), .nothing(let env, _, _):
            env
        }
    }

    /// Rows that come and go because of an event (a host dropping, a thread
    /// needing you, a note after a restart) and so arrive with the row motion.
    /// A thread starting is routine: running rows change without one.
    public var isEvent: Bool {
        switch self {
        case .status, .hostNote, .needsYou: true
        default: false
        }
    }
}

/// A section of Home: its header and its rows, with a stable id.
public struct HomeSection: Sendable, Hashable, Identifiable {
    public enum Header: Sendable, Hashable {
        case none
        /// "Needs you", "Running".
        case title(String)
        /// With several hosts, the host's name and connection dot over its workspaces.
        case host(environmentId: String, name: String)
        /// The host's loose chats: a workspace-level group with no fold.
        case chats(environmentId: String)
        /// A workspace: logo, name, repo; the fold, and the count while folded.
        case workspace(HomeWorkspace, collapsed: Bool, threads: Int)
    }

    public var id: String
    public var header: Header
    public var rows: [HomeRow]

    public init(id: String, header: Header, rows: [HomeRow]) {
        self.id = id
        self.header = header
        self.rows = rows
    }
}

/// Home's sections from every host's shell and the remembered folds. Pure
/// over value inputs, so the view's body is one ForEach over stable ids and
/// the tests run anywhere.
public enum HomeSections {
    /// Settled subagents shown under a root before the "n more" row.
    public static let settledShown = 3

    /// A host that gets a status row: refused, offline, between retries, or
    /// one that could not be reached since launch (connecting with a retry pending).
    public nonisolated static func troubled(_ status: EnvironmentStatus) -> Bool {
        switch status.transport {
        case .unauthorized, .offline, .reconnecting: true
        case .connecting: status.nextRetryAt != nil && status.attempts > 0
        case .open, .suspended: false
        }
    }

    /// What `folded` remembers a workspace by: its pairing key, so folding a
    /// paired workspace folds both copies.
    public nonisolated static func foldKey(_ workspace: HomeWorkspace) -> String {
        workspace.id
    }

    public nonisolated static func build(hosts: [HomeHostInput], folded: Set<String>, pairing: HomePairing = .none) -> [HomeSection] {
        var sections: [HomeSection] = []

        let status = hosts.filter(\.troubled).map { HomeRow.status(environmentId: $0.environmentId) }
        if !status.isEmpty { sections.append(HomeSection(id: "status", header: .none, rows: status)) }

        let needs = hosts
            .flatMap { host in HomeModel.needsYou(host.sessions).map { (host.environmentId, $0) } }
            .sorted { ($0.1.since, $0.1.id) < ($1.1.since, $1.1.id) }
        if !needs.isEmpty {
            sections.append(HomeSection(id: "needs", header: .title("Needs you"), rows: needs.map { .needsYou(environmentId: $0.0, $0.1) }))
        }

        let running = hosts
            .flatMap { host in HomeModel.running(host.sessions).map { (host.environmentId, $0) } }
            .sorted { ($0.1.updatedAt, $0.1.id) > ($1.1.updatedAt, $1.1.id) }
        if !running.isEmpty {
            sections.append(HomeSection(id: "running", header: .title("Running"), rows: running.map { .running(environmentId: $0.0, $0.1) }))
        }

        // Quiet is a state too: say so once, with the one thing to do from here.
        if needs.isEmpty, running.isEmpty, let calm = hosts.first(where: { $0.hasShell && !$0.workspaces.isEmpty }), let workspace = calm.workspaces.first {
            sections.append(HomeSection(id: "calm", header: .none, rows: [.calm(environmentId: calm.environmentId, workspace)]))
        }

        // Workspaces keyed through the pairing; a key on more than one host is
        // one workspace, listed before any host so it is never under one host's name.
        let (paired, unpaired) = workspaces(of: hosts, pairing: pairing)
        for workspace in paired {
            sections.append(workspaceSection(workspace, hosts: hosts, folded: folded))
        }

        for host in hosts {
            let env = host.environmentId
            let notes = host.notes.map { HomeRow.hostNote(environmentId: env, $0) }
            if hosts.count > 1 {
                sections.append(HomeSection(id: "host:\(env)", header: .host(environmentId: env, name: host.name), rows: notes))
            } else if !notes.isEmpty {
                sections.append(HomeSection(id: "notes:\(env)", header: .none, rows: notes))
            }
            let loose = ThreadGroups.group(host.sessions, projects: host.projects, workspaces: host.workspaces, workspaceId: nil, seen: host.seen, floor: host.floor).chats
            if !loose.isEmpty {
                sections.append(HomeSection(id: "chats:\(env)", header: .chats(environmentId: env), rows: threadRows(env, loose)))
            }
            if host.workspaces.isEmpty, loose.isEmpty {
                sections.append(HomeSection(id: "nothing:\(env)", header: .none, rows: [.nothing(environmentId: env, name: host.name, listed: host.hasShell)]))
                continue
            }
            for workspace in unpaired where workspace.members.first?.environmentId == env {
                sections.append(workspaceSection(workspace, hosts: hosts, folded: folded))
            }
        }
        return sections
    }

    /// Every workspace keyed by `pairing`, in first-seen order: the paired
    /// ones (members on more than one host) and the rest, one member each.
    nonisolated static func workspaces(of hosts: [HomeHostInput], pairing: HomePairing) -> (paired: [HomeWorkspace], unpaired: [HomeWorkspace]) {
        var order: [String] = []
        var byKey: [String: HomeWorkspace] = [:]
        for host in hosts {
            for workspace in host.workspaces {
                let key = pairing.key(host.environmentId, workspace)
                let member = HomeWorkspace.Member(environmentId: host.environmentId, workspace: workspace)
                if var known = byKey[key] {
                    // One copy per host: a second workspace of the same host under one key stays its own.
                    if known.members.contains(where: { $0.environmentId == host.environmentId }) {
                        let own = "\(host.environmentId):\(workspace.id)"
                        order.append(own)
                        byKey[own] = HomeWorkspace(id: own, name: workspace.name, repo: workspace.githubRepo, members: [member])
                        continue
                    }
                    known.members.append(member)
                    if known.repo == nil { known.repo = workspace.githubRepo }
                    byKey[key] = known
                } else {
                    order.append(key)
                    byKey[key] = HomeWorkspace(id: key, name: workspace.name, repo: workspace.githubRepo, members: [member])
                }
            }
        }
        let all = order.compactMap { byKey[$0] }
        return (all.filter(\.isPaired), all.filter { !$0.isPaired })
    }

    /// A workspace's section: the fold row as its header, and under it (when
    /// open) every member's chats, projects and archived rows in member order.
    nonisolated static func workspaceSection(_ workspace: HomeWorkspace, hosts: [HomeHostInput], folded: Set<String>) -> HomeSection {
        let collapsed = folded.contains(foldKey(workspace))
        var threads = 0
        var rows: [HomeRow] = []
        for member in workspace.members {
            guard let host = hosts.first(where: { $0.environmentId == member.environmentId }) else { continue }
            let env = host.environmentId
            let groups = ThreadGroups.group(host.sessions, projects: host.projects, workspaces: host.workspaces, workspaceId: member.workspace.id, seen: host.seen, floor: host.floor)
            threads += groups.chats.count + groups.projects.reduce(0) { $0 + $1.threads.count }
            guard !collapsed else { continue }
            rows += threadRows(env, groups.chats)
            for group in groups.projects {
                rows.append(.project(environmentId: env, group, paired: workspace.isPaired))
                rows += threadRows(env, group.threads)
                if group.archivedCount > 0 { rows.append(.archivedThreads(environmentId: env, group)) }
            }
            if !groups.archived.isEmpty {
                rows.append(.archivedProjects(environmentId: env, member.workspace, count: groups.archived.count))
            }
        }
        if !collapsed, rows.isEmpty, let first = workspace.members.first {
            rows.append(.emptyWorkspace(environmentId: first.environmentId, first.workspace))
        }
        return HomeSection(id: "workspace:\(workspace.id)", header: .workspace(workspace, collapsed: collapsed, threads: threads), rows: rows)
    }

    /// A root, then whatever fills its `children`, nested one step in: every
    /// live or needs-you one, a few settled ones, and one dim row for the rest.
    public nonisolated static func threadRows(_ environmentId: String, _ items: [ThreadItem]) -> [HomeRow] {
        var rows: [HomeRow] = []
        for item in items {
            rows.append(.thread(environmentId: environmentId, item))
            var settled = 0
            var hidden = 0
            for child in item.children {
                if ThreadGroups.rank(child.meta.status) < 3 {
                    rows.append(.thread(environmentId: environmentId, child))
                } else if settled < settledShown {
                    settled += 1
                    rows.append(.thread(environmentId: environmentId, child))
                } else {
                    hidden += 1
                }
            }
            if hidden > 0 { rows.append(.moreAgents(environmentId: environmentId, root: item.meta, hidden: hidden)) }
        }
        return rows
    }
}
