import SwiftUI
import TempCodeClient

/// Three tabs: Home, Inbox, Search. Settings is a button in the Home bar.
/// Home and Search are each one `ShellSplit` on its own `ShellNavigator`
/// (the Inbox is `InboxScreen`, its own split over one typed path): the stacks of
/// the phone in compact width, a sidebar beside (or over) the detail in
/// regular width, the same values under both. The pose (`ShellPose`) is
/// decided here from the window's size classes and the root's own bounds
/// and published as `\.shellPose`. The tab, the navigators and the Inbox's path come
/// back from `NavigationMemory` before the first frame, so a cold launch
/// opens on the screen the app was killed on.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(NavigationRouter.self) private var router
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @AppStorage("appearance") private var appearance = Appearance.system
    @State private var tab: AppTab
    @State private var home: ShellNavigator
    /// The Inbox's typed path: InboxScreen reads its first element as the split's selection.
    @State private var inboxPath: [InboxRoute]
    @State private var search: ShellNavigator
    @State private var size = CGSize.zero
    @State private var routed = false
    @State private var restoredSheet: SheetMemory?

    init() {
        let memory = NavigationMemory.restore()
        let snapshot = memory?.snapshot ?? NavigationSnapshot()
        _tab = State(initialValue: snapshot.tab)
        _home = State(initialValue: ShellNavigator(tab: .home, memory: snapshot[.home], sidebarShown: snapshot.sidebarShown))
        _inboxPath = State(initialValue: memory?.inbox ?? [])
        _search = State(initialValue: ShellNavigator(tab: .search, memory: snapshot[.search], sidebarShown: snapshot.sidebarShown))
        _restoredSheet = State(initialValue: memory?.sheet)
    }
    /// Project settings present from the root: a sheet on a menu item never shows.
    @State private var projectSettings = ProjectSettingsPresenter()
    /// The new-thread sheet, opened from any screen of the Home stack.
    @State private var newThread = NewThreadPresenter()

    private var pose: ShellPose {
        ShellPose.of(horizontal: SizeClass(horizontalSizeClass), vertical: SizeClass(verticalSizeClass), size: size)
    }

    /// Home and Search ride the shell split; the Inbox keeps its own (InboxScreen).
    private var navigators: [ShellNavigator] { [home, search] }

    var body: some View {
        TabView(selection: $tab) {
            Tab("Home", systemImage: "house", value: AppTab.home) {
                ShellSplit(navigator: home) {
                    HomeView(slots: shellSlots)
                        .fleetToastInset()
                } detailTop: { route in
                    if pose.isSplit {
                        ThreadStripView(route: route)
                    }
                } placeholder: {
                    DetailPlaceholder(title: "No Thread Selected", symbol: "bubble.left.and.bubble.right")
                } destination: { destination($0) }
                .environment(home)
            }
            Tab("Inbox", systemImage: "tray", value: AppTab.inbox) {
                // The Inbox keeps its own split over one typed path (InboxScreen, plan 3).
                InboxScreen(path: $inboxPath)
            }
            Tab(value: AppTab.search, role: .search) {
                ShellSplit(navigator: search) {
                    SearchView(initialQuery: model.launchSearch)
                        .fleetToastInset()
                } detailTop: { _ in
                } placeholder: {
                    DetailPlaceholder(title: "No Result Selected", symbol: "magnifyingglass")
                } destination: { destination($0) }
                .environment(search)
            }
        }
        .environment(\.shellPose, pose)
        // The root's own bounds, never the orientation: with the size classes, the one layout input.
        .onGeometryChange(for: CGSize.self) { $0.size } action: { size = $0 }
        .onChange(of: pose, initial: true) { for navigator in navigators { navigator.pose = pose } }
        .onChange(of: size.width, initial: true) { for navigator in navigators { navigator.windowWidth = size.width } }
        .preferredColorScheme(appearance.scheme)
        .modifier(layoutProbe) // DEBUG: the layout report the Duo proof reads (LayoutProbe.swift)
        // The fleet switches' confirm sheet, shared by every menu; the outcome line sits on each tab (thread iOS 20).
        .fleetSwitchHost()
        .onChange(of: model.registry.ordered.map { $0.bootResume }) { BootResumeNotes.shared.observe(model.registry.ordered) }
        .environment(projectSettings)
        .modifier(NewThreadSheetHost(presenter: newThread) { created in
            tab = .home
            home.open(created)
        })
        .sheet(item: $projectSettings.target) { target in
            if let client = model.registry.client(target.home.environmentId) {
                ProjectSettingsSheet(client: client, target: target)
            } else {
                Color.clear.onAppear { projectSettings.target = nil }
            }
        }
        .task(id: model.ready) {
            // The restored stacks are built by now; anything pushed from here keeps the row it names.
            LaunchRestore.end()
            #if DEBUG
            LayoutProbe.route(tab: tab.rawValue, depth: focusedPath.count)
            #endif
            await followLaunchRoute()
        }
        .task { await MasterReleaseWatcher.shared.run() } // master's release for the drift marks (Shell/Hosts, iOS 21)
        // The sheet the last run had up, handed to the view that owns it once
        // the restored stacks are on screen.
        .task {
            guard let sheet = restoredSheet else { return }
            restoredSheet = nil
            router.restoredSheet = sheet
        }
        .onChange(of: tab) { remember() }
        .onChange(of: memoryKey) { remember() }
        .onChange(of: router.visible) { reportVisibility() }
        .onChange(of: router.lists) { reportVisibility() }
        .onChange(of: scenePhase) { reportVisibility() }
        // A notification or Live Activity tap: Home's sidebar at its root, the thread in the detail, on its card.
        .onChange(of: router.pending) { _, route in
            guard let route else { return }
            // A tap names its card: it lands there even this early in a cold launch.
            LaunchRestore.end()
            tab = .home
            home.sidebarPath = []
            home.open(route)
            router.pending = nil
        }
        .onOpenURL(perform: open)
        // Outermost, so the sheets the root presents (new thread, project settings, the fleet confirm) read
        // the window's size classes too (Design/SheetShape.swift); a sheet never reads its own.
        .publishesWindowClasses()
    }

    /// A notification's or Live Activity's link: the thread it names, or Home for a group activity's card.
    private func open(_ url: URL) {
        if let target = PushTarget(url: url) {
            router.open(target)
        } else if url.host == "home" {
            tab = .home
            home.popToRoot()
        }
    }

    /// Every field of every navigator the memory keeps, as one value to watch.
    private var memoryKey: NavigationSnapshot { snapshot }

    private var snapshot: NavigationSnapshot {
        var snapshot = NavigationSnapshot(tab: tab, sidebarShown: home.sidebarShown)
        for navigator in navigators { snapshot[navigator.tab] = navigator.memory }
        return snapshot
    }

    /// Every change of where the person is, written at once: the write is one
    /// small defaults key, and the background has no reliable last moment.
    private func remember() {
        NavigationMemory.save(snapshot, inbox: InboxRoute.remembered(inboxPath))
        reportVisibility()
        #if DEBUG
        LayoutProbe.route(tab: tab.rawValue, depth: focusedPath.count)
        #endif
    }

    /// The stack under the selected tab.
    private var focusedPath: NavigationPath {
        switch tab {
        case .home: homePath
        case .inbox: inboxPath
        case .search: searchPath
        }
    }

    #if DEBUG
    private var layoutProbe: some ViewModifier { LayoutProbeModifier() }
    #else
    private var layoutProbe: some ViewModifier { EmptyModifier() }
    #endif

    /// What is on screen, for the clients: Home's lists when the Home tab shows
    /// its root; the thread the thread screen reported. Off screen, nothing.
    private func reportVisibility() {
        let active = scenePhase == .active
        model.setVisible(thread: active ? router.visible : nil, listVisible: active && tab == .home && !router.lists.isEmpty)
    }

    /// Home's slots with the fleet switches: what every screen of the Home stack reads.
    private var shellSlots: HomeSlots { FleetSwitches.homeSlots(homeSlots) }

    /// What sibling features plug into Home; every slot optional.
    private var homeSlots: HomeSlots {
        var slots = HomeSlots(
            projectSettings: { client, project in AnyView(ProjectSettingsMenuItem(client: client, project: project)) },
            projectTrailing: { AnyView(ProjectPlanChip(client: $0, project: $1)) }
        )
        let registry = model.registry
        slots.hostTrailing = { AnyView(DriftMark(client: $0)) } // iOS 21: the deploy drift mark (Shell/Hosts)
        // Thread 29: a relayed host's "through <carrier>, <presence>" line under its header's name.
        slots.hostSubline = { client in
            AnyView(HostSubline(client: client, carrierName: registry.carrier(of: client.environment.id)?.environment.name))
        }
        return slots
    }

    /// Every route's screen, in whichever column `ShellPaths.column(of:)` placed it.
    @ViewBuilder
    private func destination(_ route: Route) -> some View {
        switch route {
        case .thread(let environmentId, let sessionId, let seq):
            if let client = model.registry.client(environmentId) {
                ThreadScreen(client: client, sessionId: sessionId, targetSeq: seq)
            }
        case .workspace(let key):
            WorkspaceScreen(key: key, slots: shellSlots)
        case .project(let key):
            ProjectScreen(key: key, slots: shellSlots)
        case .archivedThreads(let environmentId, let projectId):
            if let client = model.registry.client(environmentId) {
                ArchivedThreadsView(client: client, projectId: projectId)
            }
        case .archivedProjects(let environmentId, let workspaceId):
            if let client = model.registry.client(environmentId) {
                ArchivedProjectsView(client: client, workspaceId: workspaceId)
            }
        case .settings:
            SettingsView()
        case .hosts:
            HostsView()
        }
    }

    /// DEBUG only: the proof script launches with `TC_TEST_ROUTE` and reads
    /// the screen off the simulator, so the app walks there itself once the
    /// first host has listed its threads (or painted them from the cache).
    private func followLaunchRoute() async {
        guard let route = model.launchRoute, !routed, model.ready else { return }
        guard let client = model.registry.ordered.first else { return }
        if route == "home" || route == "hosts-status" { return }
        for _ in 0..<600 {
            if client.hasShell || !client.sessions.isEmpty { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        routed = true
        let environmentId = client.environment.id
        switch route {
        case "inbox":
            tab = .inbox
        case "search":
            tab = .search
        case "settings":
            home.open(.settings)
        case "hosts":
            home.open(.settings)
            home.detailStack.append(Route.hosts)
        case "archived":
            for workspace in client.workspaces {
                let groups = ThreadGroups.group(client.sessions, projects: client.projects, workspaces: client.workspaces, workspaceId: workspace.id)
                if let group = groups.projects.first(where: { $0.archivedCount > 0 }) {
                    home.open(.archivedThreads(environmentId: environmentId, projectId: group.id))
                    return
                }
            }
        case "archived-projects":
            for workspace in client.workspaces {
                let groups = ThreadGroups.group(client.sessions, projects: client.projects, workspaces: client.workspaces, workspaceId: workspace.id)
                if !groups.archived.isEmpty {
                    home.open(.archivedProjects(environmentId: environmentId, workspaceId: workspace.id))
                    return
                }
            }
        case "thread":
            let candidates = client.sessions.filter { $0.parentId == nil }
            let wanted = model.launchThread.map { needle in candidates.filter { $0.title.localizedCaseInsensitiveContains(needle) } } ?? candidates
            if let session = wanted.first ?? candidates.first {
                home.open(.thread(environmentId: environmentId, sessionId: session.id, seq: TestHooks.targetSeq))
                // The sidebar over the detail in the overlay pose, for the shot; `open` just hid it.
                if TestHooks.open == "sidebar" { home.sidebarShown = true }
            }
        case "thread-in-project":
            // The thread in the detail with its project open in the sidebar: the split's selected row.
            let candidates = client.sessions.filter { $0.parentId == nil && $0.projectId != nil }
            let wanted = model.launchThread.map { needle in candidates.filter { $0.title.localizedCaseInsensitiveContains(needle) } } ?? candidates
            guard let session = wanted.first ?? candidates.first,
                  let project = client.projects.first(where: { $0.id == session.projectId }),
                  let workspace = client.workspaces.first(where: { $0.id == project.workspaceId }) else { return }
            home.open(.workspace(key: ProjectPairs.key(environmentId, workspace)))
            home.open(.project(key: ProjectPairs.key(environmentId, project)))
            home.open(.thread(environmentId: environmentId, sessionId: session.id, seq: nil))
        case "workspace":
            // The sidebar at the Workspace level with nothing open: the split's empty detail.
            if let entry = HomeSections.home(hosts: HomeRows.inputs([client])).entries.first {
                home.open(.workspace(key: entry.id))
            }
        case "notification":
            // The proof's tap: a payload shaped like the hub's, through the delegate's one route.
            guard let hook = TestHooks.notification else { return }
            let parts = hook.split(separator: "|", maxSplits: 1).map(String.init)
            let candidates = client.sessions.filter { $0.parentId == nil }
            guard let session = candidates.first(where: { $0.title.localizedCaseInsensitiveContains(parts[0]) }) else { return }
            var tc: [AnyHashable: Any] = ["event": "needs_you", "hostId": "box", "environmentId": environmentId, "threadId": session.id, "ts": 0]
            if parts.count > 1, let seq = Int(parts[1]) { tc["seq"] = seq }
            PushDelegate.route(["aps": ["alert": ["title": session.title]], "tc": tc])
        default:
            break
        }
    }
}

/// The new-thread sheet over every tab, opened from any screen of the Home
/// stack through `NewThreadPresenter`; a created thread opens on Home.
private struct NewThreadSheetHost: ViewModifier {
    @Bindable var presenter: NewThreadPresenter
    let open: (Route) -> Void

    func body(content: Content) -> some View {
        content
            .environment(presenter)
            .sheet(item: $presenter.target) { target in
                NewThreadSheet(client: target.client, workspace: target.workspace, project: target.project) { created in
                    open(Route.thread(environmentId: target.client.environment.id, sessionId: created.id, seq: nil))
                }
            }
            // Return flow (thread 14): the sheet survives a kill; HomeView reopens it.
            .onChange(of: presenter.target?.id) {
                NavigationMemory.rememberSheet(presenter.target.map { .newThread(environmentId: $0.client.environment.id, workspaceId: $0.workspace.id, projectId: $0.project?.id) })
            }
    }
}
