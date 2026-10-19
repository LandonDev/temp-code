import Foundation
import TempCodeContract

/// One thread as the shell lists it: its meta, whether its newest work is
/// unseen, and its subagents ranked waiting, failed, working, done.
public struct ThreadItem: Sendable, Hashable, Identifiable {
    public var meta: SessionMeta
    public var unseen: Bool
    public var children: [ThreadItem]

    public init(meta: SessionMeta, unseen: Bool = false, children: [ThreadItem] = []) {
        self.meta = meta
        self.unseen = unseen
        self.children = children
    }

    public var id: String { meta.id }
}

/// A project's live roots (pinned first, then newest first), when it last
/// moved, and how many archived roots its "n archived" row stands for.
public struct ProjectGroup: Sendable, Hashable, Identifiable {
    public var project: ProjectMeta
    public var threads: [ThreadItem]
    /// Newest thread activity, or the project's creation when it has none.
    public var latest: Int
    public var archivedCount: Int

    public init(project: ProjectMeta, threads: [ThreadItem], latest: Int, archivedCount: Int) {
        self.project = project
        self.threads = threads
        self.latest = latest
        self.archivedCount = archivedCount
    }

    public var id: String { project.id }
}

/// What one workspace lists: its chats (threads with no project) first, its
/// live projects by latest activity, and its archived projects at the end.
/// A nil workspace is the home: the chats outside every workspace.
public struct WorkspaceGroups: Sendable, Hashable {
    public var chats: [ThreadItem]
    public var projects: [ProjectGroup]
    public var archived: [ProjectGroup]

    public init(chats: [ThreadItem] = [], projects: [ProjectGroup] = [], archived: [ProjectGroup] = []) {
        self.chats = chats
        self.projects = projects
        self.archived = archived
    }

    public static let empty = WorkspaceGroups()

    public var isEmpty: Bool { chats.isEmpty && projects.isEmpty && archived.isEmpty }
}

/// The desktop's grouping rules (src/renderer/src/lib/workspaceSessions.ts)
/// plus the phone's one addition: pinned threads sort first.
public enum ThreadGroups {
    /// A path as the catalog keys it: no trailing slash.
    public static func normalize(_ path: String) -> String {
        var out = Substring(path)
        while out.count > 1, out.last == "/" { out.removeLast() }
        return out.isEmpty ? "/" : String(out)
    }

    /// Where a session belongs: through its project, else its own workspace,
    /// else the workspace whose path is its cwd (sessions from before ids).
    public static func workspaceId(of session: SessionMeta, projects: [ProjectMeta], workspaces: [WorkspaceMeta]) -> String? {
        if let projectId = session.projectId, let project = projects.first(where: { $0.id == projectId }) {
            return project.workspaceId
        }
        if let workspaceId = session.workspaceId { return workspaceId }
        let cwd = normalize(session.cwd)
        guard cwd != "~" else { return nil }
        return workspaces.first { normalize($0.path) == cwd }?.id
    }

    /// Rows sort by what needs the user first: waiting, failed, working, done.
    public static func rank(_ status: SessionStatus) -> Int {
        switch status {
        case .waiting: 0
        case .error: 1
        case .starting, .running: 2
        default: 3
        }
    }

    public static func sortAgents(_ list: [SessionMeta]) -> [SessionMeta] {
        list.sorted { (rank($0.status), $0.createdAt) < (rank($1.status), $1.createdAt) }
    }

    /// Settled work newer than when the user last looked. A thread with no
    /// mark counts as seen up to `floor` (the pairing), so pairing a host
    /// never lights up its whole history.
    public static func isUnseen(_ meta: SessionMeta, seen: [String: SeenMark], floor: Int) -> Bool {
        guard meta.status == .idle || meta.status == .done else { return false }
        return meta.updatedAt > (seen[meta.id]?.at ?? floor)
    }

    /// Live subagents keyed by parent id, ranked. Archived children stay out.
    public static func children(of metas: [SessionMeta], seen: [String: SeenMark], floor: Int) -> [String: [ThreadItem]] {
        var byParent: [String: [SessionMeta]] = [:]
        for meta in metas {
            guard let parentId = meta.parentId, !meta.archived else { continue }
            byParent[parentId, default: []].append(meta)
        }
        return byParent.mapValues { list in
            sortAgents(list).map { ThreadItem(meta: $0, unseen: isUnseen($0, seen: seen, floor: floor)) }
        }
    }

    /// Pinned first, then newest first.
    static func order(_ items: [ThreadItem]) -> [ThreadItem] {
        items.sorted {
            if $0.meta.pinned != $1.meta.pinned { return $0.meta.pinned }
            return ($0.meta.updatedAt, $0.meta.id) > ($1.meta.updatedAt, $1.meta.id)
        }
    }

    public static func group(_ metas: [SessionMeta], projects: [ProjectMeta], workspaces: [WorkspaceMeta], workspaceId: String?, seen: [String: SeenMark] = [:], floor: Int = 0) -> WorkspaceGroups {
        let here = projects.filter { $0.workspaceId == workspaceId }
        let ids = Set(here.map(\.id))
        let kids = children(of: metas, seen: seen, floor: floor)
        var byProject: [String: [ThreadItem]] = [:]
        var archivedCount: [String: Int] = [:]
        var chats: [ThreadItem] = []

        for meta in metas where meta.parentId == nil {
            guard self.workspaceId(of: meta, projects: projects, workspaces: workspaces) == workspaceId else { continue }
            let projectId = meta.projectId.flatMap { ids.contains($0) ? $0 : nil }
            if meta.archived {
                if let projectId { archivedCount[projectId, default: 0] += 1 }
                continue
            }
            let item = ThreadItem(meta: meta, unseen: isUnseen(meta, seen: seen, floor: floor), children: kids[meta.id] ?? [])
            if let projectId {
                byProject[projectId, default: []].append(item)
            } else {
                chats.append(item)
            }
        }

        let groups = here.map { project -> ProjectGroup in
            let threads = order(byProject[project.id] ?? [])
            let latest = threads.map(\.meta.updatedAt).max() ?? project.createdAt
            return ProjectGroup(project: project, threads: threads, latest: latest, archivedCount: archivedCount[project.id] ?? 0)
        }
        let latestFirst: (ProjectGroup, ProjectGroup) -> Bool = { ($0.latest, $0.project.id) > ($1.latest, $1.project.id) }
        return WorkspaceGroups(
            chats: order(chats),
            projects: groups.filter { !$0.project.archived }.sorted(by: latestFirst),
            archived: groups.filter { $0.project.archived }.sorted(by: latestFirst)
        )
    }

    /// The archived roots of one project, newest first: the "n archived" list.
    public static func archivedThreads(_ metas: [SessionMeta], projectId: String) -> [SessionMeta] {
        metas
            .filter { $0.archived && $0.parentId == nil && $0.projectId == projectId }
            .sorted { ($0.updatedAt, $0.id) > ($1.updatedAt, $1.id) }
    }
}
