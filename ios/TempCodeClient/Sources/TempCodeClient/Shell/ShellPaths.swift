import Foundation

/// The two columns of a tab's split.
public enum ShellColumn: Sendable, Hashable {
    case sidebar
    case detail
}

/// Which column each route opens in. The lists stay in the sidebar; a
/// thread, Settings and Hosts take the detail (a 320 pt
/// sidebar is no place for a settings form). Collapsed, both push as one stack.
public enum ShellPaths {
    public static func column(of route: Route) -> ShellColumn {
        switch route {
        case .workspace, .project, .archivedThreads, .archivedProjects:
            return .sidebar
        case .thread, .settings, .hosts:
            return .detail
        }
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
/// `navigation.memory.v2` and restores it before the first frame.
public struct NavigationSnapshot: Codable, Hashable, Sendable {
    public static let key = "navigation.memory.v2"

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
