import Foundation
import TempCodeContract

/// A root thread with its host and its unseen mark.
public struct HostedItem: Sendable, Hashable, Identifiable {
    public var environmentId: String
    public var item: ThreadItem

    public init(environmentId: String, item: ThreadItem) {
        self.environmentId = environmentId
        self.item = item
    }

    public var id: String { "\(environmentId):\(item.id)" }
}

/// What the strip lists for the open thread: its project (every linked copy
/// mixed), else its workspace's chats, else its host's loose chats.
public struct StripScope: Sendable, Hashable {
    public enum Kind: Sendable, Hashable {
        case project(HomeProject)
        case workspaceChats(HomeWorkspace)
        case hostChats(environmentId: String)
    }

    /// Where the `+` starts a thread: the scope's lead copy. Nil for loose
    /// chats, which have no workspace to start in.
    public struct Lead: Sendable, Hashable {
        public var environmentId: String
        public var workspaceId: String
        public var projectId: String?
    }

    public var kind: Kind
    /// The scope's unarchived roots, every copy's, in any order.
    public var roots: [HostedItem]
    public var lead: Lead?
}

/// One chip of the strip.
public struct StripChip: Sendable, Hashable, Identifiable {
    public var environmentId: String
    public var meta: SessionMeta
    public var selected: Bool
    public var unseen: Bool

    public var id: String { "\(environmentId):\(meta.id)" }
}

/// The desktop's thread strip (ThreadHeaderStrip.tsx): the open thread's
/// project's live roots as chips, freshest first, the open thread kept even
/// when dormant, then `+`. The project's threads, not a set of open tabs.
public enum ThreadStrip {
    /// The scope of a detail route: a thread's project, its workspace's chats
    /// or its host's loose chats; nil for any other route or an unknown thread.
    public nonisolated static func scope(for route: Route?, hosts: [HomeHostInput]) -> StripScope? {
        guard case .thread(let environmentId, let sessionId, _)? = route,
              let host = hosts.first(where: { $0.environmentId == environmentId }),
              let meta = host.sessions.first(where: { $0.id == sessionId }) else { return nil }
        if let projectId = meta.projectId, let project = host.projects.first(where: { $0.id == projectId }),
           let screen = HomeSections.project(ProjectPairs.key(environmentId, project), hosts: hosts) {
            let lead = StripScope.Lead(environmentId: screen.project.environmentId, workspaceId: screen.project.project.workspaceId, projectId: screen.project.project.id)
            return StripScope(kind: .project(screen.project), roots: screen.project.threads.map { HostedItem(environmentId: $0.environmentId, item: $0.item) }, lead: lead)
        }
        if let workspaceId = ThreadGroups.workspaceId(of: meta, projects: host.projects, workspaces: host.workspaces),
           let workspace = HomeSections.workspaces(of: hosts).first(where: { $0.members.contains { $0.environmentId == environmentId && $0.workspace.id == workspaceId } }) {
            let chats = workspace.members.map { member in
                (member.environmentId, hosts.first { $0.environmentId == member.environmentId }.map { chats($0, workspaceId: member.workspace.id) } ?? [])
            }
            let first = workspace.members[0]
            return StripScope(kind: .workspaceChats(workspace), roots: HomeSections.mixed(chats).map { HostedItem(environmentId: $0.environmentId, item: $0.item) }, lead: .init(environmentId: first.environmentId, workspaceId: first.workspace.id, projectId: nil))
        }
        return StripScope(kind: .hostChats(environmentId: environmentId), roots: chats(host, workspaceId: nil).map { HostedItem(environmentId: environmentId, item: $0) }, lead: nil)
    }

    /// The chips: the scope's live roots (`ThreadGroups.isLive`), freshest
    /// first by `updatedAt` then id, with the open thread kept at its recency
    /// slot when it is dormant. Subagents and batch children never appear
    /// (`roots` holds none); archived roots never do.
    public nonisolated static func chips(scope: StripScope, open: Route?) -> [StripChip] {
        var openKey: (environmentId: String, sessionId: String)?
        if case .thread(let environmentId, let sessionId, _)? = open { openKey = (environmentId, sessionId) }
        return scope.roots
            .filter { root in
                !root.item.meta.archived && root.item.meta.parentId == nil
                    && (ThreadGroups.isLive(root.item) || isOpen(root, openKey))
            }
            .sorted { ($0.item.meta.updatedAt, $0.item.meta.id, $0.environmentId) > ($1.item.meta.updatedAt, $1.item.meta.id, $1.environmentId) }
            .map { StripChip(environmentId: $0.environmentId, meta: $0.item.meta, selected: isOpen($0, openKey), unseen: $0.item.unseen) }
    }

    private nonisolated static func isOpen(_ root: HostedItem, _ open: (environmentId: String, sessionId: String)?) -> Bool {
        guard let open else { return false }
        return root.environmentId == open.environmentId && root.item.meta.id == open.sessionId
    }

    private nonisolated static func chats(_ host: HomeHostInput, workspaceId: String?) -> [ThreadItem] {
        ThreadGroups.group(host.sessions, projects: host.projects, workspaces: host.workspaces, workspaceId: workspaceId, seen: host.seen, floor: host.floor).chats
    }
}
