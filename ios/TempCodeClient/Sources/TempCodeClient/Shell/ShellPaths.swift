import Foundation

/// The two columns of a tab's split.
public enum ShellColumn: Sendable, Hashable {
    case sidebar
    case detail
}

/// Which column each route opens in, and where a thread lives. The lists
/// stay in the sidebar; a project's shell, a bare thread, Settings and Hosts
/// take the detail (a 320 pt sidebar is no place for a settings form).
/// Collapsed, both push as one stack.
public enum ShellPaths {
    public static func column(of route: Route) -> ShellColumn {
        switch route {
        case .workspace, .archivedThreads, .archivedProjects:
            return .sidebar
        case .project, .thread, .settings, .hosts:
            return .detail
        }
    }

    /// What a detail root is as a screen: a project's shell is the same
    /// screen whichever of its threads it shows, so a chip's tap swaps the
    /// thread under the strip and keeps the strip; anything else is its route.
    public static func identity(of route: Route?) -> String {
        switch route {
        case .project(let key, _, _)?: return "project:\(key)"
        case let route?: return String(describing: route)
        case nil: return ""
        }
    }

    /// The thread a route shows: a bare thread, or the one a shell holds.
    public static func shown(_ route: Route?) -> (environmentId: String, sessionId: String)? {
        switch route {
        case .thread(let environmentId, let sessionId, _)?: return (environmentId, sessionId)
        case .project(_, let thread?, _)?: return split(thread)
        default: return nil
        }
    }

    /// A chip id (`<environmentId>:<sessionId>`) in its two parts. An
    /// environment id never holds a colon; a session id may.
    public static func split(_ thread: String) -> (environmentId: String, sessionId: String)? {
        guard let colon = thread.firstIndex(of: ":") else { return nil }
        let env = String(thread[..<colon])
        let id = String(thread[thread.index(after: colon)...])
        return env.isEmpty || id.isEmpty ? nil : (env, id)
    }

    /// Where a route opens: the detail's root and what to push over it.
    public struct Placement: Sendable, Hashable {
        public var root: Route
        public var push: Route?
    }

    /// Every root of a project or of a workspace's loose chats opens in its
    /// shell; a subagent opens its root's shell and pushes over it; a chat
    /// outside every workspace, or a thread no host lists, opens bare. Any
    /// other route is itself.
    public nonisolated static func place(_ route: Route, hosts: [HomeHostInput]) -> Placement {
        guard case .thread(let environmentId, let sessionId, let seq) = route,
              let host = hosts.first(where: { $0.environmentId == environmentId }),
              let root = ThreadStrip.root(of: sessionId, in: host.sessions),
              let scope = ThreadStrip.scope(for: route, hosts: hosts) else { return Placement(root: route, push: nil) }
        if root.id == sessionId {
            return Placement(root: .project(key: scope.key, thread: "\(environmentId):\(sessionId)", seq: seq), push: nil)
        }
        return Placement(root: .project(key: scope.key, thread: "\(environmentId):\(root.id)"), push: route)
    }

    /// A project's tap (its card, a search's project row): the shell with
    /// its landing. Already in that shell, nothing moves (a thread turning
    /// active never takes the person's place). Else the landing:
    /// `ProjectLanding`'s active thread, else the remembered one (a project
    /// left on its draft comes back on it), else the draft.
    public nonisolated static func land(key: String, current: Route?, hosts: [HomeHostInput], remembered: ShellLanding?) -> Route {
        if case .project(let open, _, _)? = current, open == key, let current { return current }
        guard let scope = ThreadStrip.scope(key: key, hosts: hosts) else { return .project(key: key) }
        if let active = ProjectLanding.active(scope: scope, hosts: hosts) {
            return .project(key: key, thread: "\(active.environmentId):\(active.meta.id)")
        }
        guard case .thread(let thread)? = remembered,
              scope.roots.contains(where: { $0.id == thread && !$0.item.meta.archived }) else { return .project(key: key) }
        return .project(key: key, thread: thread)
    }
}

/// What a project's shell showed last: one of its threads, or its draft.
public enum ShellLanding: Codable, Sendable, Hashable {
    case thread(String)
    case draft
}

/// The thread last on screen in each shell, keyed by the scope's key (a
/// linked project's copies share their link id), so a card's tap comes back
/// where the person left. Persisted in UserDefaults by `ShellLandingStore`.
public struct ShellLandings: Codable, Sendable, Hashable {
    public static let maxEntries = 256
    public var entries: [String: ShellLanding] = [:]
    /// Most recent last, for the cap.
    public var order: [String] = []

    public init() {}

    public subscript(key: String) -> ShellLanding? { entries[key] }

    /// True when anything changed.
    @discardableResult
    public mutating func remember(_ landing: ShellLanding, for key: String) -> Bool {
        guard entries[key] != landing || order.last != key else { return false }
        entries[key] = landing
        order.removeAll { $0 == key }
        order.append(key)
        while order.count > Self.maxEntries { entries[order.removeFirst()] = nil }
        return true
    }
}

@MainActor
public final class ShellLandingStore {
    public static let defaultsKey = "shell.landing.v1"
    public static let shared = ShellLandingStore()
    private let defaults: UserDefaults
    public private(set) var landings: ShellLandings

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        landings = defaults.data(forKey: Self.defaultsKey).flatMap { try? JSONDecoder().decode(ShellLandings.self, from: $0) } ?? ShellLandings()
    }

    public subscript(key: String) -> ShellLanding? { landings[key] }

    /// The shell at `route` is on screen: remember what it shows.
    public func remember(_ route: Route) {
        guard case .project(let key, let thread, _) = route else { return }
        guard landings.remember(thread.map(ShellLanding.thread) ?? .draft, for: key),
              let data = try? JSONEncoder().encode(landings) else { return }
        defaults.set(data, forKey: Self.defaultsKey)
    }
}

/// One tab's place: the sidebar's routes, the route at the detail's root,
/// and whatever the detail pushed over it (the app's own routes, encoded by
/// the app as a `NavigationPath.CodableRepresentation`, opaque here).
public struct ColumnMemory: Codable, Hashable, Sendable {
    public var sidebar: [Route]
    public var detailRoot: Route?
    public var detailStack: Data?

    public init(sidebar: [Route] = [], detailRoot: Route? = nil, detailStack: Data? = nil) {
        self.sidebar = sidebar
        self.detailRoot = detailRoot
        self.detailStack = detailStack
    }
}

/// Where the person was, shape-independent: the same snapshot opens a
/// thread on top of the Project list folded and in the detail beside it
/// unfolded. The app writes it on every navigator change under
/// `navigation.memory.v3` and restores it before the first frame.
public struct NavigationSnapshot: Codable, Hashable, Sendable {
    public static let key = "navigation.memory.v3"
    /// v2 kept a thread at the detail's root and a project's list in the
    /// sidebar; its routes mean other screens now.
    public static let v2Key = "navigation.memory.v2"

    /// What a launch restores: the v3 snapshot whole, else v2's tab and
    /// toggle with every column at its root (mapping a v2 thread to its
    /// project needs the session cache, which the restore runs before).
    public static func restore(v3: Data?, v2: Data?) -> NavigationSnapshot? {
        if let v3, let snapshot = try? JSONDecoder().decode(NavigationSnapshot.self, from: v3) { return snapshot }
        struct Old: Decodable {
            var tab: AppTab
            var sidebarShown: Bool?
        }
        guard let v2, let old = try? JSONDecoder().decode(Old.self, from: v2) else { return nil }
        return NavigationSnapshot(tab: old.tab, sidebarShown: old.sidebarShown ?? true)
    }

    public var tab: AppTab
    public var columns: [AppTab: ColumnMemory]
    /// The overlay pose's sidebar toggle, remembered.
    public var sidebarShown: Bool

    public init(tab: AppTab = .home, columns: [AppTab: ColumnMemory] = [:], sidebarShown: Bool = true) {
        self.tab = tab
        self.columns = columns
        self.sidebarShown = sidebarShown
    }

    public subscript(tab: AppTab) -> ColumnMemory {
        get { columns[tab] ?? ColumnMemory() }
        set { columns[tab] = newValue }
    }
}
