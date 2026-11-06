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

/// What a strip holds, the desktop's `StripScope`: a project's roots (every
/// linked copy mixed), or a workspace's loose chats (every linked copy).
/// The chats outside every workspace have no strip: they are Home's Chats.
public struct StripScope: Sendable, Hashable {
    public enum Kind: Sendable, Hashable {
        case project(HomeProject)
        case workspaceChats(HomeWorkspace)
    }

    /// Where New thread starts: the scope's lead copy.
    public struct Lead: Sendable, Hashable {
        public var environmentId: String
        public var workspaceId: String
        public var projectId: String?
    }

    public var kind: Kind
    /// The scope's unarchived roots, every copy's, a batch thread left to its master.
    public var roots: [HostedItem]
    public var lead: Lead?
    /// The key the live row's order is saved under (`stripScopeKey`): a
    /// linked project's copies share their link id.
    public var key: String

    /// Each host copy's archived roots, for the Recent menu's foot; none for loose chats.
    public var archived: [HomeSections.ArchivedThreads] {
        guard case .project(let project) = kind else { return [] }
        return project.members.filter { $0.group.archivedCount > 0 }.map {
            HomeSections.ArchivedThreads(environmentId: $0.environmentId, projectId: $0.group.id, count: $0.group.archivedCount)
        }
    }

    /// What the shell's bar says: the project's name, or the workspace's for its loose chats.
    public var name: String {
        switch kind {
        case .project(let project): project.project.name
        case .workspaceChats(let workspace): workspace.name
        }
    }
}

/// One chip of the strip.
public struct StripChip: Sendable, Hashable, Identifiable {
    public var environmentId: String
    public var meta: SessionMeta
    /// The thread on screen is this chip's thread or one of its subagents.
    public var selected: Bool
    public var unseen: Bool
    /// On the live row (else the shelf).
    public var live: Bool
    /// The thread on screen from outside the scope: the live row's last
    /// chip, never saved into the order.
    public var outside: Bool
    /// A draft's first send whose meta has not landed (`DraftSending`): no
    /// tap, no menu, until the thread's own chip takes its place.
    public var sending = false

    public var id: String { "\(environmentId):\(meta.id)" }
}

/// What a chip's one glyph slot holds: the type glyph at rest, the status
/// mark while the thread has a state worth a mark (`marksAtRest`: working,
/// waiting, failed, paused, queued, watching, stopped, plan ready), as a
/// browser tab's favicon turns into a spinner. A shelf chip never marks.
public enum StripGlyph: Sendable, Hashable {
    case type(ThreadType)
    case status(CardState)
}

/// How a chip draws (ThreadHeaderStrip.tsx `StripChip`), pure.
public struct StripChipLook: Sendable, Hashable {
    public var glyph: StripGlyph
    /// The title in medium and primary: unread on the live row, never the
    /// selected chip (the fill already says it is on screen) nor the shelf.
    public var medium: Bool
    /// The muted "Master" after the title, on the live row.
    public var master: Bool
    /// The title always reserves its medium width, so a chip never widens
    /// when it turns unread or read.
    public var reservesMediumWidth: Bool { true }
}

extension StripChip {
    /// The row state the mark draws (`rowState`).
    public var state: CardState { CardState.row(meta) }

    public func look(onShelf: Bool) -> StripChipLook {
        let state = state
        return StripChipLook(
            glyph: !onShelf && state.marksAtRest ? .status(state) : .type(meta.threadType ?? .chat),
            medium: !onShelf && !selected && unseen,
            master: !onShelf && meta.isMaster == true
        )
    }
}

/// The strip as drawn: the live row in its stable order with the outside
/// chip last, then the shelf, freshest first.
public struct StripModel: Sendable, Hashable {
    public var live: [StripChip]
    public var shelf: [StripChip]

    public var selected: StripChip? { (live + shelf).first(where: \.selected) }
    /// What the order may keep: the live row less the outside chip.
    public var saveIds: [String] { live.filter { !$0.outside }.map(\.id) }

    /// New Thread leads the row, in words, when no chip is live: the row's
    /// scroll is left out so nothing pushes it off the leading edge.
    public var leadsWithNewThread: Bool { live.isEmpty }

    /// Compact width, where the shelf is the Recent menu: the thread on
    /// screen keeps a chip even when it is settled, at the live row's end
    /// like an outside chip and never saved; the menu lists the rest.
    public var compact: StripModel {
        guard let index = shelf.firstIndex(where: \.selected) else { return self }
        var chip = shelf[index]
        chip.outside = true
        var rest = shelf
        rest.remove(at: index)
        return StripModel(live: live + [chip], shelf: rest)
    }
}

/// The desktop's thread strip rules (lib/threadStripModel.ts,
/// threadHeaderModel.ts, `chipThreadsOf`), pure over the hosts' metas.
public enum ThreadStrip {
    // MARK: The scope

    /// The scope of the thread a route shows (a subagent's root's), or of a
    /// project's shell; nil for any other route, an unknown thread or a chat
    /// outside every workspace.
    public nonisolated static func scope(for route: Route?, hosts: [HomeHostInput]) -> StripScope? {
        if case .project(let key, _, _)? = route { return scope(key: key, hosts: hosts) }
        guard case .thread(let environmentId, let sessionId, _)? = route,
              let host = hosts.first(where: { $0.environmentId == environmentId }),
              let meta = root(of: sessionId, in: host.sessions) else { return nil }
        if let projectId = meta.projectId, let project = host.projects.first(where: { $0.id == projectId }) {
            return scope(project: ProjectPairs.key(environmentId, project), hosts: hosts)
        }
        guard let workspaceId = ThreadGroups.workspaceId(of: meta, projects: host.projects, workspaces: host.workspaces) else { return nil }
        return scope(workspace: environmentId, workspaceId: workspaceId, hosts: hosts)
    }

    /// The scope a shell's key names (`StripScope.key`): a workspace's loose
    /// chats for a `loose:` key, else a project.
    public nonisolated static func scope(key: String, hosts: [HomeHostInput]) -> StripScope? {
        guard key.hasPrefix(looseKeyPrefix) else { return scope(project: key, hosts: hosts) }
        for workspace in HomeSections.workspaces(of: hosts) {
            guard let member = workspace.members.first else { continue }
            if let scope = scope(workspace: member.environmentId, workspaceId: member.workspace.id, hosts: hosts), scope.key == key { return scope }
        }
        return nil
    }

    static let looseKeyPrefix = "loose:"

    /// The scope of a project by its key (`ProjectPairs.key`).
    public nonisolated static func scope(project key: String, hosts: [HomeHostInput]) -> StripScope? {
        guard let screen = HomeSections.project(key, hosts: hosts) else { return nil }
        let project = screen.project
        let lead = StripScope.Lead(environmentId: project.environmentId, workspaceId: project.project.workspaceId, projectId: project.project.id)
        let roots = project.threads.map { HostedItem(environmentId: $0.environmentId, item: $0.item) }
        return StripScope(kind: .project(project), roots: roots, lead: lead, key: key)
    }

    /// The loose chats of a workspace on every linked copy.
    public nonisolated static func scope(workspace environmentId: String, workspaceId: String, hosts: [HomeHostInput]) -> StripScope? {
        guard let workspace = HomeSections.workspaces(of: hosts).first(where: { $0.members.contains { $0.environmentId == environmentId && $0.workspace.id == workspaceId } }) else { return nil }
        let chats = workspace.members.map { member in
            (member.environmentId, hosts.first { $0.environmentId == member.environmentId }.map { chats($0, workspaceId: member.workspace.id) } ?? [])
        }
        let first = workspace.members[0]
        let linkId = workspace.members.lazy.compactMap(\.workspace.linkId).first
        return StripScope(
            kind: .workspaceChats(workspace),
            roots: HomeSections.mixed(chats).map { HostedItem(environmentId: $0.environmentId, item: $0.item) },
            lead: .init(environmentId: first.environmentId, workspaceId: first.workspace.id, projectId: nil),
            key: looseKeyPrefix + "\(linkId ?? "\(first.environmentId):\(first.workspace.id)")"
        )
    }

    // MARK: The live rule

    /// `isLiveThread`: anything not settled and seen. Working, paused,
    /// recoverable or live work in its tree, unread, or a plan ready to
    /// build. Pinned alone is not live.
    public nonisolated static func isLive(_ item: ThreadItem) -> Bool {
        let meta = item.meta
        return (meta.status != .idle && meta.status != .done)
            || meta.treeHasLiveWork == true
            || meta.treeHasPaused == true
            || meta.treeCanContinue == true
            || item.unseen
            || planReady(meta)
    }

    /// A planning thread that settled with its plan complete (`planCompletedAt`).
    public nonisolated static func planReady(_ meta: SessionMeta) -> Bool {
        meta.threadType == .planning && meta.planCompletedAt != nil && (meta.status == .idle || meta.status == .done)
    }

    // MARK: The model

    /// The strip for `scope` with `shown` on screen: the live roots in the
    /// saved `order` (new ones joining at the end, oldest first), then the
    /// thread on screen as an outside chip when the scope does not hold it,
    /// and the settled roots on the shelf, freshest first. The thread on
    /// screen (a subagent selects its root) is selected on whichever row
    /// it sits. A selected chip already on the live row keeps its place
    /// there until another is selected, though opening it marked it seen
    /// or it settled meanwhile: the touch stand-in for the desktop's hover
    /// hold, so a tapped chip never jumps away as its thread opens.
    ///
    /// `sending` is the scope's draft send in flight: a chip at the live
    /// row's end, its glyph the working mark, never saved, selected once
    /// the new thread is on screen, gone the moment its meta lands.
    public nonisolated static func model(scope: StripScope, shown: (environmentId: String, sessionId: String)?, order: [String], hosts: [HomeHostInput], sending: DraftSending? = nil) -> StripModel {
        var shownRoot: (environmentId: String, meta: SessionMeta, unseen: Bool)?
        if let shown, let host = hosts.first(where: { $0.environmentId == shown.environmentId }), let meta = root(of: shown.sessionId, in: host.sessions) {
            shownRoot = (shown.environmentId, meta, ThreadGroups.isUnseen(meta, seen: host.seen, floor: host.floor))
        }
        func isShown(_ environmentId: String, _ id: String) -> Bool {
            shownRoot.map { $0.environmentId == environmentId && $0.meta.id == id } ?? false
        }
        let roots = scope.roots.filter { !$0.item.meta.archived && $0.item.meta.parentId == nil }.sorted(by: freshestFirst)
        var live: [StripChip] = []
        var shelf: [StripChip] = []
        let held = Set(order)
        for root in roots {
            let selected = isShown(root.environmentId, root.item.meta.id)
            let isLive = isLive(root.item) || (selected && held.contains(root.id))
            let chip = StripChip(environmentId: root.environmentId, meta: root.item.meta, selected: selected, unseen: root.item.unseen, live: isLive, outside: false)
            if isLive { live.append(chip) } else { shelf.append(chip) }
        }
        let ordered = orderChips(order, live.map { ($0.id, $0.meta.updatedAt) })
        let byId = Dictionary(uniqueKeysWithValues: live.map { ($0.id, $0) })
        var row = ordered.compactMap { byId[$0] }
        if let shownRoot, !shownRoot.meta.archived, !roots.contains(where: { $0.environmentId == shownRoot.environmentId && $0.item.meta.id == shownRoot.meta.id }) {
            let item = ThreadItem(meta: shownRoot.meta, unseen: shownRoot.unseen)
            row.append(StripChip(environmentId: shownRoot.environmentId, meta: shownRoot.meta, selected: true, unseen: shownRoot.unseen, live: isLive(item), outside: true))
        }
        if let sending, !landed(sending, hosts: hosts) {
            let selected = sending.sessionId.map { id in shown.map { $0.environmentId == sending.environmentId && $0.sessionId == id } ?? false } ?? false
            row.append(StripChip(environmentId: sending.environmentId, meta: sending.standIn, selected: selected, unseen: false, live: true, outside: true, sending: true))
        }
        return StripModel(live: row, shelf: shelf)
    }

    /// The sent draft's thread is in its host's list: its own chip takes over.
    public nonisolated static func landed(_ sending: DraftSending, hosts: [HomeHostInput]) -> Bool {
        guard let id = sending.sessionId else { return false }
        return hosts.first { $0.environmentId == sending.environmentId }?.sessions.contains { $0.id == id } ?? false
    }

    /// `orderChips`: the ids already in `order` keep their places, the ones
    /// gone drop out, new ones join at the end oldest first. A state change
    /// never moves a chip.
    public nonisolated static func orderChips(_ order: [String], _ chips: [(id: String, updatedAt: Int)]) -> [String] {
        let present = Set(chips.map(\.id))
        let kept = order.filter(present.contains)
        let known = Set(kept)
        let added = chips.filter { !known.contains($0.id) }.sorted { ($0.updatedAt, $0.id) < ($1.updatedAt, $1.id) }.map(\.id)
        return kept + added
    }

    /// The root of `id` by the parentId chain over `sessions`; nil when `id` is unknown.
    public nonisolated static func root(of id: String, in sessions: [SessionMeta]) -> SessionMeta? {
        let byId = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var at = byId[id]
        var hops = 0
        while let parent = at?.parentId, let next = byId[parent], hops < 64 {
            at = next
            hops += 1
        }
        return at
    }

    private nonisolated static func freshestFirst(_ a: HostedItem, _ b: HostedItem) -> Bool {
        (a.item.meta.updatedAt, a.item.meta.id, a.environmentId) > (b.item.meta.updatedAt, b.item.meta.id, b.environmentId)
    }

    private nonisolated static func chats(_ host: HomeHostInput, workspaceId: String?) -> [ThreadItem] {
        ThreadGroups.group(host.sessions, projects: host.projects, workspaces: host.workspaces, workspaceId: workspaceId, seen: host.seen, floor: host.floor).chats
    }
}

/// The live row's order per scope key, the desktop's saved strip order: the
/// first 64 chip ids of each scope, and a scope not drawn for 30 days
/// forgotten. Persisted in UserDefaults by `ThreadStripStore`.
public struct StripOrders: Codable, Sendable, Hashable {
    public struct Entry: Codable, Sendable, Hashable {
        public var ids: [String]
        /// When the scope was last drawn, ms.
        public var seenAt: Int
    }

    public static let maxIds = 64
    public static let maxAgeMs = 30 * 24 * 3_600 * 1_000

    public var entries: [String: Entry] = [:]

    public init() {}

    public func order(_ key: String) -> [String] { entries[key]?.ids ?? [] }

    /// The order drawn for `key` at `now`; true when anything changed. Old scopes leave.
    @discardableResult
    public mutating func save(_ key: String, ids: [String], now: Int) -> Bool {
        let entry = Entry(ids: Array(ids.prefix(Self.maxIds)), seenAt: now)
        let before = entries
        entries[key] = entry
        entries = entries.filter { now - $0.value.seenAt <= Self.maxAgeMs }
        return entries != before
    }
}

/// `StripOrders` in UserDefaults under one key.
@MainActor
public final class ThreadStripStore {
    public static let defaultsKey = "strip.order.v1"
    public static let shared = ThreadStripStore()
    private let defaults: UserDefaults
    public private(set) var orders: StripOrders

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        orders = defaults.data(forKey: Self.defaultsKey).flatMap { try? JSONDecoder().decode(StripOrders.self, from: $0) } ?? StripOrders()
    }

    public func order(_ key: String) -> [String] { orders.order(key) }

    /// Saves what the strip drew for `key`; writes only on a change.
    public func save(_ key: String, model: StripModel, now: Int = Int(Date().timeIntervalSince1970 * 1_000)) {
        let ids = model.saveIds
        if orders.order(key) == ids, let seen = orders.entries[key]?.seenAt, now - seen < 24 * 3_600 * 1_000 { return }
        guard orders.save(key, ids: ids, now: now), let data = try? JSONEncoder().encode(orders) else { return }
        defaults.set(data, forKey: Self.defaultsKey)
    }
}

/// The desktop's `activeLanding` (lib/projectLanding.ts): the thread a
/// scope comes back to over its remembered one, the most recent active root
/// of the scope on any linked copy (working, waiting, paused, queued or
/// watching) by its last event, else when it went busy, else when it was
/// made. A batch thread stands in for its master, whose board is where the
/// person watches it; a subagent never counts. Nil when nothing is active,
/// or when the thread on screen is already in the scope: a thread turning
/// active never takes the person's place.
public enum ProjectLanding {
    public struct Landing: Sendable, Hashable {
        public var environmentId: String
        public var meta: SessionMeta
    }

    public nonisolated static func active(scope: StripScope, hosts: [HomeHostInput], shown: (environmentId: String, sessionId: String)? = nil) -> Landing? {
        let inScope = Set(scope.roots.map(\.id))
        if let shown, let host = hosts.first(where: { $0.environmentId == shown.environmentId }),
           let root = ThreadStrip.root(of: shown.sessionId, in: host.sessions), inScope.contains("\(shown.environmentId):\(root.id)") {
            return nil
        }
        var best: Landing?
        var bestAt = Int.min
        for root in scope.roots {
            let candidates = [root.item] + root.item.children.filter { $0.meta.masterId == root.item.meta.id }
            for item in candidates where !item.meta.archived && isActive(item.meta) {
                // A batch thread lands on its master.
                let lands = item.meta.masterId == root.item.meta.id ? root.item.meta : item.meta
                let at = item.meta.lastEventAt ?? item.meta.busySince ?? item.meta.createdAt
                if at > bestAt {
                    best = Landing(environmentId: root.environmentId, meta: lands)
                    bestAt = at
                }
            }
        }
        return best
    }

    /// `rowState` is working, waiting, paused, queued or watching.
    public nonisolated static func isActive(_ meta: SessionMeta) -> Bool {
        if meta.status == .paused || meta.treeHasPaused == true { return true }
        if meta.status == .waiting, meta.treeCanContinue != true { return true }
        if meta.treeHasLiveWork != true, meta.status == .error || meta.treeCanContinue == true { return false }
        if ThreadStrip.planReady(meta) { return false }
        let settled = meta.status == .idle || meta.status == .done
        if settled, !(meta.background?.agents ?? []).isEmpty { return true }
        if settled, meta.treeHasLiveWork == true { return true }
        switch meta.status {
        case .running, .starting, .waiting, .paused, .queued, .watching: return true
        default: return false
        }
    }
}
