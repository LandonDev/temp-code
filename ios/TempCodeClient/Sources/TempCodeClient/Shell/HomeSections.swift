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
    /// The carrier's environment id for a host reached through another (the
    /// Mac through the box); nil for a host paired directly.
    public var via: String?

    public init(environmentId: String, name: String, troubled: Bool = false, hasShell: Bool = true, floor: Int = 0, workspaces: [WorkspaceMeta] = [], projects: [ProjectMeta] = [], sessions: [SessionMeta] = [], seen: [String: SeenMark] = [:], notes: [HomeNote] = [], via: String? = nil) {
        self.via = via
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
/// hosts linked their copies (the same `linkId`).
public struct HomeWorkspace: Sendable, Hashable, Identifiable {
    public struct Member: Sendable, Hashable {
        public var environmentId: String
        public var workspace: WorkspaceMeta

        public init(environmentId: String, workspace: WorkspaceMeta) {
            self.environmentId = environmentId
            self.workspace = workspace
        }
    }

    /// The fold key (`ProjectPairs.key`): "link:<linkId>", or "<env>:<ws>" when unlinked.
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

/// A project as Home lists it: one row for every host's copy of it (the same
/// `linkId`), its threads mixed by recency. The lead member (the first host
/// in registry order) is the one the header's plus and menu act on.
public struct HomeProject: Sendable, Hashable, Identifiable {
    public struct Member: Sendable, Hashable {
        public var environmentId: String
        public var group: ProjectGroup

        public init(environmentId: String, group: ProjectGroup) {
            self.environmentId = environmentId
            self.group = group
        }
    }

    /// The fold key (`ProjectPairs.key`): "link:<linkId>", or "<env>:<project id>".
    public var id: String
    public var members: [Member]

    public init(id: String, members: [Member]) {
        self.id = id
        self.members = members
    }

    /// The lead copy: what the header draws.
    public var project: ProjectMeta { members[0].group.project }
    public var environmentId: String { members[0].environmentId }
    public var isLinked: Bool { members.count > 1 }
    /// Newest thread activity across every copy.
    public var latest: Int { members.map(\.group.latest).max() ?? 0 }
    /// Every copy's live roots, pinned first, then newest first, each with its host.
    public var threads: [(environmentId: String, item: ThreadItem)] {
        HomeSections.mixed(members.map { ($0.environmentId, $0.group.threads) })
    }
    public var threadCount: Int { members.reduce(0) { $0 + $1.group.threads.count } }
}

/// A session with the host it lives on.
public struct HostedSession: Sendable, Hashable, Identifiable {
    public var environmentId: String
    public var meta: SessionMeta

    public init(environmentId: String, meta: SessionMeta) {
        self.environmentId = environmentId
        self.meta = meta
    }

    public var id: String { "\(environmentId):\(meta.id)" }
}

/// The desktop rail's one mark per workspace (or project), loudest first:
/// paused, needs you (waiting on an answer, or failed), working, unread,
/// else none. The rules are useProjectSignals.ts `workspaceRailStatuses`
/// over projectCardModel.ts `projectCardStatus`, so the phone and the
/// desktop never disagree about a workspace.
public enum RailStatus: Sendable, Hashable {
    case paused(count: Int)
    case needsYou(count: Int)
    /// The working roots, newest first: the row names the first.
    case busy(running: [HostedSession])
    case unread(count: Int)

    /// Threads in the dominant bucket.
    public var count: Int {
        switch self {
        case .paused(let count), .needsYou(let count), .unread(let count): count
        case .busy(let running): running.count
        }
    }

    /// The dominant bucket over a set of roots; nil when nothing is going on.
    /// `seen` and `floor` give each root's host's seen marks and pairing time.
    public static func of(_ roots: [HostedSession], seen: (String) -> [String: SeenMark], floor: (String) -> Int) -> RailStatus? {
        var paused = 0, waiting = 0, failed = 0, unread = 0
        var running: [HostedSession] = []
        for root in roots {
            let meta = root.meta
            let canContinue = meta.treeCanContinue == true
            let liveWork = meta.treeHasLiveWork == true
            if meta.status == .paused || meta.treeHasPaused == true {
                paused += 1
                continue
            }
            if meta.status != .waiting, !canContinue, meta.status == .running || meta.status == .starting || liveWork {
                running.append(root)
            }
            if !canContinue, meta.status == .waiting { waiting += 1 }
            if !liveWork, meta.status == .error || canContinue { failed += 1 }
            if !canContinue, !liveWork, ThreadGroups.isUnseen(meta, seen: seen(root.environmentId), floor: floor(root.environmentId)) { unread += 1 }
        }
        if paused > 0 { return .paused(count: paused) }
        if waiting + failed > 0 { return .needsYou(count: waiting + failed) }
        if !running.isEmpty { return .busy(running: running.sorted { ($0.meta.updatedAt, $0.id) > ($1.meta.updatedAt, $1.id) }) }
        if unread > 0 { return .unread(count: unread) }
        return nil
    }
}

/// One row of a thread list: a thread at its depth (0 a root, 1 a subagent
/// or a master's batch thread, 2 a batch thread's subagent), or the dim
/// "n more" row for the settled children left out.
public enum ShellRow: Sendable, Hashable, Identifiable {
    case thread(environmentId: String, ThreadItem, depth: Int)
    case more(environmentId: String, root: SessionMeta, hidden: Int)

    public var id: String {
        switch self {
        case .thread(let env, let item, _): "thread:\(env):\(item.id)"
        case .more(let env, let root, _): "more:\(env):\(root.id)"
        }
    }

    public var environmentId: String {
        switch self {
        case .thread(let env, _, _), .more(let env, _, _): env
        }
    }
}

/// Home's three levels, shaped like the desktop's sidebar: the workspaces
/// with their state (the far-left column), one workspace's projects with
/// their active threads and its stray chats (the middle sidebar), and one
/// project's every thread. Pure over value inputs, so each screen's body is
/// one ForEach over stable ids.
public enum HomeSections {
    /// The key of the "Chats" entry: the threads outside every workspace.
    public static let chatsKey = "chats"
    /// Settled children shown under a row before the "n more" row.
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

    // MARK: Level 1, Home: the workspaces

    /// One row of Home: a workspace (every linked copy as one), or the Chats entry.
    public struct Entry: Sendable, Hashable, Identifiable {
        public enum Kind: Sendable, Hashable {
            case workspace(HomeWorkspace)
            case chats
        }

        /// The workspace's key (`ProjectPairs.key`), or `chatsKey`.
        public var id: String
        public var kind: Kind
        public var status: RailStatus?
        /// The hosts the entry spans, for the offline tint.
        public var environmentIds: [String]
    }

    /// A host's own lines on Home: its status row while in trouble, its
    /// one-off notes, and the empty state when it lists nothing.
    public struct HostLines: Sendable, Hashable, Identifiable {
        public var environmentId: String
        public var name: String
        public var status: Bool
        public var notes: [HomeNote]
        /// No workspace and no chat: a spinner until `listed`, then the fact.
        public var nothing: Bool
        public var listed: Bool

        public var id: String { environmentId }
    }

    public struct Home: Sendable, Hashable {
        public var entries: [Entry]
        public var hosts: [HostLines]
    }

    public nonisolated static func home(hosts: [HomeHostInput]) -> Home {
        // A host the box relays folds under the box's own row while the box is in trouble:
        // one card says the box is down, not one per host behind it.
        let troubledIds = Set(hosts.filter(\.troubled).map(\.environmentId))
        let lines = hosts.map { host in
            let loose = host.sessions.contains { $0.parentId == nil && !$0.archived && ThreadGroups.workspaceId(of: $0, projects: host.projects, workspaces: host.workspaces) == nil }
            return HostLines(
                environmentId: host.environmentId,
                name: host.name,
                status: host.troubled && !(host.via.map(troubledIds.contains) ?? false),
                notes: host.notes,
                nothing: host.workspaces.isEmpty && !loose,
                listed: host.hasShell
            )
        }

        var entries: [Entry] = []
        let chats = hosts.flatMap { host in roots(host, workspaceId: nil) }
        if !chats.isEmpty {
            entries.append(Entry(id: chatsKey, kind: .chats, status: status(chats, hosts: hosts), environmentIds: Array(Set(chats.map(\.environmentId))).sorted()))
        }
        for workspace in workspaces(of: hosts) {
            let threads = workspace.members.flatMap { member in
                hosts.first { $0.environmentId == member.environmentId }.map { roots($0, workspaceId: member.workspace.id) } ?? []
            }
            entries.append(Entry(id: workspace.id, kind: .workspace(workspace), status: status(threads, hosts: hosts), environmentIds: workspace.members.map(\.environmentId)))
        }
        return Home(entries: entries, hosts: lines)
    }

    // MARK: Level 2, a workspace: projects with their active threads, then the stray chats

    /// A project row on the workspace screen: the project and the rows of its
    /// active threads nested under it (their own marks are its state).
    public struct ProjectEntry: Sendable, Hashable, Identifiable {
        public var project: HomeProject
        public var rows: [ShellRow]

        public var id: String { project.id }
    }

    /// The "n archived projects" row of one host's copy.
    public struct ArchivedProjects: Sendable, Hashable, Identifiable {
        public var environmentId: String
        public var workspace: WorkspaceMeta
        public var count: Int

        public var id: String { "\(environmentId):\(workspace.id)" }
    }

    public struct WorkspaceScreen: Sendable, Hashable {
        /// Nil for the Chats entry.
        public var workspace: HomeWorkspace?
        public var projects: [ProjectEntry]
        /// The threads with no project, every one of them, newest first.
        public var chats: [ShellRow]
        public var archivedProjects: [ArchivedProjects]

        public var isEmpty: Bool { projects.isEmpty && chats.isEmpty && archivedProjects.isEmpty }
    }

    /// The workspace screen for an entry's key; nil when no host lists it.
    public nonisolated static func workspace(_ key: String, hosts: [HomeHostInput]) -> WorkspaceScreen? {
        if key == chatsKey {
            let chats = hosts.map { host in
                (host.environmentId, ThreadGroups.group(host.sessions, projects: host.projects, workspaces: host.workspaces, workspaceId: nil, seen: host.seen, floor: host.floor).chats)
            }
            return WorkspaceScreen(workspace: nil, projects: [], chats: rows(mixed(chats)), archivedProjects: [])
        }
        guard let workspace = workspaces(of: hosts).first(where: { $0.id == key }) else { return nil }
        var chats: [(String, [ThreadItem])] = []
        var projects: [(String, ProjectGroup)] = []
        var archived: [ArchivedProjects] = []
        for member in workspace.members {
            guard let host = hosts.first(where: { $0.environmentId == member.environmentId }) else { continue }
            let groups = ThreadGroups.group(host.sessions, projects: host.projects, workspaces: host.workspaces, workspaceId: member.workspace.id, seen: host.seen, floor: host.floor)
            chats.append((host.environmentId, groups.chats))
            projects += groups.projects.map { (host.environmentId, $0) }
            if !groups.archived.isEmpty { archived.append(ArchivedProjects(environmentId: host.environmentId, workspace: member.workspace, count: groups.archived.count)) }
        }
        let linked = fold(projects, key: { ProjectPairs.key($0, $1.project) }, own: { "\($0):\($1.project.id)" }) { key, members in
            HomeProject(id: key, members: members.map { HomeProject.Member(environmentId: $0.0, group: $0.1) })
        }
        .sorted { ($0.latest, $0.id) > ($1.latest, $1.id) }
        let entries = linked.map { project in
            ProjectEntry(project: project, rows: rows(project.threads.filter { isActive($0.item) }))
        }
        return WorkspaceScreen(workspace: workspace, projects: entries, chats: rows(mixed(chats)), archivedProjects: archived)
    }

    // MARK: Level 3, a project: every thread

    /// The "n archived" row of one host's copy.
    public struct ArchivedThreads: Sendable, Hashable, Identifiable {
        public var environmentId: String
        public var projectId: String
        public var count: Int

        public var id: String { "\(environmentId):\(projectId)" }
    }

    public struct ProjectScreen: Sendable, Hashable {
        public var project: HomeProject
        /// The threads the workspace screen shows under the project.
        public var active: [ShellRow]
        /// Settled and seen: the rest, newest first.
        public var dormant: [ShellRow]
        public var archived: [ArchivedThreads]

        public var isEmpty: Bool { active.isEmpty && dormant.isEmpty && archived.isEmpty }
    }

    /// The project screen for a project row's key (`HomeProject.id`); nil when no host lists it.
    public nonisolated static func project(_ key: String, hosts: [HomeHostInput]) -> ProjectScreen? {
        var members: [HomeProject.Member] = []
        for host in hosts {
            let env = host.environmentId
            guard let project = host.projects.first(where: { ProjectPairs.key(env, $0) == key }) ?? host.projects.first(where: { "\(env):\($0.id)" == key }) else { continue }
            let groups = ThreadGroups.group(host.sessions, projects: host.projects, workspaces: host.workspaces, workspaceId: project.workspaceId, seen: host.seen, floor: host.floor)
            if let group = (groups.projects + groups.archived).first(where: { $0.id == project.id }) {
                members.append(HomeProject.Member(environmentId: env, group: group))
            }
        }
        guard !members.isEmpty else { return nil }
        let project = HomeProject(id: key, members: members)
        let threads = project.threads
        return ProjectScreen(
            project: project,
            active: rows(threads.filter { isActive($0.item) }),
            dormant: rows(threads.filter { !isActive($0.item) }),
            archived: members.filter { $0.group.archivedCount > 0 }.map { ArchivedThreads(environmentId: $0.environmentId, projectId: $0.group.id, count: $0.group.archivedCount) }
        )
    }

    // MARK: The rules

    /// What the middle sidebar keeps in view (threadStripModel.ts
    /// `isLiveThread`, and pinned, which "Archive dormant" spares): anything
    /// not settled and seen, or with live, paused or failed work in its tree.
    public nonisolated static func isActive(_ item: ThreadItem) -> Bool {
        let meta = item.meta
        return meta.pinned
            || (meta.status != .idle && meta.status != .done)
            || meta.treeHasLiveWork == true
            || meta.treeHasPaused == true
            || meta.treeCanContinue == true
            || item.unseen
    }

    /// Roots of several hosts in the order given, each with what is housed
    /// under it (subagents, a master's batch) one step in per level: every
    /// live or needs-you child, a few settled ones, and one dim row for the rest.
    public nonisolated static func rows(_ items: [(environmentId: String, item: ThreadItem)]) -> [ShellRow] {
        var out: [ShellRow] = []
        for entry in items { append(entry.item, environmentId: entry.environmentId, depth: 0, into: &out) }
        return out
    }

    private nonisolated static func append(_ item: ThreadItem, environmentId: String, depth: Int, into rows: inout [ShellRow]) {
        rows.append(.thread(environmentId: environmentId, item, depth: depth))
        var settled = 0
        var hidden = 0
        for child in item.children {
            if ThreadGroups.rank(child.meta.status) < 3 {
                append(child, environmentId: environmentId, depth: depth + 1, into: &rows)
            } else if settled < settledShown {
                settled += 1
                append(child, environmentId: environmentId, depth: depth + 1, into: &rows)
            } else {
                hidden += 1
            }
        }
        if hidden > 0 { rows.append(.more(environmentId: environmentId, root: item.meta, hidden: hidden)) }
    }

    /// One host's unarchived roots in a workspace (nil: outside every
    /// workspace), leaving out the threads of archived projects, as the
    /// desktop's status fold does.
    nonisolated static func roots(_ host: HomeHostInput, workspaceId: String?) -> [HostedSession] {
        let archivedProjects = Set(host.projects.filter(\.archived).map(\.id))
        return host.sessions.compactMap { meta in
            guard meta.parentId == nil, !meta.archived, !(meta.projectId.map(archivedProjects.contains) ?? false),
                  ThreadGroups.workspaceId(of: meta, projects: host.projects, workspaces: host.workspaces) == workspaceId else { return nil }
            return HostedSession(environmentId: host.environmentId, meta: meta)
        }
    }

    nonisolated static func status(_ roots: [HostedSession], hosts: [HomeHostInput]) -> RailStatus? {
        RailStatus.of(
            roots,
            seen: { env in hosts.first { $0.environmentId == env }?.seen ?? [:] },
            floor: { env in hosts.first { $0.environmentId == env }?.floor ?? 0 }
        )
    }

    /// Every workspace keyed by its link (`ProjectPairs.key`), in first-seen
    /// order across the hosts in registry order: a link on several hosts is
    /// one workspace with a member per host.
    public nonisolated static func workspaces(of hosts: [HomeHostInput]) -> [HomeWorkspace] {
        fold(hosts.flatMap { host in host.workspaces.map { (host.environmentId, $0) } }, key: { ProjectPairs.key($0, $1) }, own: { "\($0):\($1.id)" }) { key, members in
            HomeWorkspace(id: key, name: members[0].1.name, repo: members.lazy.compactMap { $0.1.githubRepo }.first, members: members.map { HomeWorkspace.Member(environmentId: $0.0, workspace: $0.1) })
        }
    }

    /// Folds rows of several hosts by `key`, in first-seen order, one member
    /// per host: a second row of one host under a key already holding that
    /// host stays its own, under `own`.
    nonisolated static func fold<Row, Out>(_ rows: [(String, Row)], key: (String, Row) -> String, own: (String, Row) -> String, make: (String, [(String, Row)]) -> Out) -> [Out] {
        var order: [String] = []
        var byKey: [String: [(String, Row)]] = [:]
        for row in rows {
            var rowKey = key(row.0, row.1)
            if byKey[rowKey]?.contains(where: { $0.0 == row.0 }) == true { rowKey = own(row.0, row.1) }
            if byKey[rowKey] == nil { order.append(rowKey) }
            byKey[rowKey, default: []].append(row)
        }
        return order.map { make($0, byKey[$0] ?? []) }
    }

    /// Several hosts' roots as one list: pinned first, then newest first, each with its host.
    public nonisolated static func mixed(_ lists: [(String, [ThreadItem])]) -> [(environmentId: String, item: ThreadItem)] {
        lists
            .flatMap { list in list.1.map { (environmentId: list.0, item: $0) } }
            .sorted {
                if $0.item.meta.pinned != $1.item.meta.pinned { return $0.item.meta.pinned }
                return ($0.item.meta.updatedAt, $0.item.meta.id, $0.environmentId) > ($1.item.meta.updatedAt, $1.item.meta.id, $1.environmentId)
            }
    }
}
