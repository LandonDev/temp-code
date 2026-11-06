import Observation
import SwiftUI
import TempCodeClient

/// Where one tab is: the sidebar's routes, the route at the detail's root
/// and whatever the detail pushed over it. The same values drive both
/// shapes: collapsed, the detail sits on top of the sidebar's stack;
/// expanded, beside it. Every tap in the shell's lists goes through `open`,
/// which places the route by its column (`ShellPaths.column(of:)`) and a
/// thread in its project's shell (`ShellPaths.place`); a project's tap goes
/// through `openProject`, which lands it (`ShellPaths.land`). Pushes made
/// from inside the detail keep using `NavigationLink(value:)` on the
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
    var pose = ShellPose.stack(short: false) {
        didSet { if pose != oldValue { poseChangedAt = Date() } }
    }
    /// When the pose last changed: a write of the split's visibility inside
    /// `ShellPose.foldSettle` of it is the fold's, not the person's.
    @ObservationIgnored private(set) var poseChangedAt = Date.distantPast
    /// The window's width, for the fold's place (`ShellSplit`).
    var windowWidth: CGFloat = 0
    /// Every host's lists, for placing a thread in its shell; the root sets it.
    @ObservationIgnored var hosts: () -> [HomeHostInput] = { [] }

    init(tab: AppTab, memory: ColumnMemory = ColumnMemory(), sidebarShown: Bool = true) {
        self.tab = tab
        sidebarPath = memory.sidebar
        detailRoot = memory.detailRoot
        detailStack = NavigationMemory.path(memory.detailStack)
        self.sidebarShown = sidebarShown
    }

    /// A sidebar route pushes; a detail route replaces the detail's root and
    /// clears what was pushed over the old one. A thread of a project (or of
    /// a workspace's loose chats) opens in its shell, a subagent pushed over
    /// its root's; a chat outside every workspace opens bare.
    func open(_ route: Route) {
        switch ShellPaths.column(of: route) {
        case .sidebar:
            sidebarPath.append(route)
        case .detail:
            let placed = ShellPaths.place(route, hosts: hosts())
            detailRoot = placed.root
            detailStack = NavigationPath()
            if let push = placed.push { detailStack.append(push) }
            if pose.isOverlay { sidebarShown = false }
        }
    }

    /// Whether a host has listed its threads in this process; the root sets it.
    @ObservationIgnored var listed: (String) -> Bool = { _ in false }
    /// A bare root its host listed and left bare: not looked for again (`ShellPaths.awaitsListing`).
    @ObservationIgnored private var settledBare: Route?

    /// The detail's root is a thread that opened bare before its host listed
    /// it, and with nothing pushed over it the lists now place it in a shell.
    /// Once the host has listed, a root still bare is never checked again.
    var awaitsListing: Bool {
        ShellPaths.awaitsListing(detailRoot, stackEmpty: detailStack.isEmpty, settled: &settledBare, listed: listed, hosts: hosts)
    }

    /// That thread into its shell once the list arrives (`ShellPaths.relisted`);
    /// what the person pushed over it is never taken away.
    func placeListed() {
        guard detailStack.isEmpty, let placed = ShellPaths.relisted(detailRoot, hosts: hosts()) else { return }
        detailRoot = placed.root
        if let push = placed.push { detailStack.append(push) }
    }

    /// A project card's tap: its shell on its landing, or, already there,
    /// the shell as it is with what was pushed over it gone.
    func openProject(_ key: String) {
        open(ShellPaths.land(key: key, current: detailRoot, hosts: hosts(), remembered: ShellLandingStore.shared[key]))
    }

    /// Back to the tab's root with nothing open.
    /// The sidebar's routes, the detail's root and the detail's stack, counted.
    var depth: Int { sidebarPath.count + (detailRoot == nil ? 0 : 1) + detailStack.count }

    func popToRoot() {
        sidebarPath = []
        detailRoot = nil
        detailStack = NavigationPath()
    }

    /// The thread at the detail's root, bare or in its shell, is this one (any row of it).
    func isOpen(environmentId: String, sessionId: String) -> Bool {
        guard let shown = ShellPaths.shown(detailRoot) else { return false }
        return shown.environmentId == environmentId && shown.sessionId == sessionId
    }

    /// What the memory keeps of this tab.
    var memory: ColumnMemory {
        ColumnMemory(sidebar: sidebarPath, detailRoot: detailRoot, detailStack: NavigationMemory.encode(detailStack))
    }
}
