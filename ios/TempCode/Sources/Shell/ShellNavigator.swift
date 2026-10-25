import Observation
import SwiftUI
import TempCodeClient

/// Where one tab is: the sidebar's routes, the route at the detail's root
/// and whatever the detail pushed over it. The same values drive both
/// shapes: collapsed, the detail sits on top of the sidebar's stack;
/// expanded, beside it. Every tap in the shell's lists goes through `open`,
/// which places the route by its column (`ShellPaths.column(of:)`); pushes
/// made from inside the detail keep using `NavigationLink(value:)` on the
/// detail's own stack.
@MainActor @Observable
final class ShellNavigator {
    let tab: AppTab
    var sidebarPath: [Route]
    var detailRoot: Route?
    var detailStack: NavigationPath
    /// The overlay pose's toggle, remembered across folds and launches.
    var sidebarShown: Bool
    /// The shell's pose, set by the root: a detail opened in the overlay pose
    /// hides the overlay, the way Mail's sidebar closes on a pick.
    var pose = ShellPose.stack(short: false)
    /// The window's width, for the fold's place (`ShellSplit`).
    var windowWidth: CGFloat = 0

    init(tab: AppTab, memory: ColumnMemory = ColumnMemory(), sidebarShown: Bool = true) {
        self.tab = tab
        sidebarPath = memory.sidebar
        detailRoot = memory.detailRoot
        detailStack = NavigationMemory.path(memory.detailStack)
        self.sidebarShown = sidebarShown
    }

    /// A sidebar route pushes; a detail route replaces the detail's root and
    /// clears what was pushed over the old one.
    func open(_ route: Route) {
        switch ShellPaths.column(of: route) {
        case .sidebar:
            sidebarPath.append(route)
        case .detail:
            detailRoot = route
            detailStack = NavigationPath()
            if pose.isOverlay { sidebarShown = false }
        }
    }

    /// Back to the tab's root with nothing open.
    func popToRoot() {
        sidebarPath = []
        detailRoot = nil
        detailStack = NavigationPath()
    }

    /// The thread at the detail's root is this one (any row of it).
    func isOpen(environmentId: String, sessionId: String) -> Bool {
        guard case .thread(let env, let id, _)? = detailRoot else { return false }
        return env == environmentId && id == sessionId
    }

    /// What the memory keeps of this tab.
    var memory: ColumnMemory {
        ColumnMemory(sidebar: sidebarPath, detailRoot: detailRoot, detailStack: NavigationMemory.encode(detailStack))
    }
}
