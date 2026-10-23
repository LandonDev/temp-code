import SwiftUI
import TempCodeClient

/// Three tabs: Home, Inbox, Search. Settings is a button in the Home bar.
/// The tab and the three stacks come back from `NavigationMemory` before the
/// first frame, so a cold launch opens on the screen the app was killed on.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(NavigationRouter.self) private var router
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("appearance") private var appearance = Appearance.system
    @State private var tab: AppTab
    @State private var homePath: NavigationPath
    @State private var inboxPath: NavigationPath
    @State private var searchPath: NavigationPath
    @State private var routed = false
    @State private var restoredSheet: SheetMemory?

    init() {
        let memory = NavigationMemory.restore()
        _tab = State(initialValue: memory?.tab ?? .home)
        _homePath = State(initialValue: NavigationMemory.path(memory?.home))
        _inboxPath = State(initialValue: NavigationMemory.path(memory?.inbox))
        _searchPath = State(initialValue: NavigationMemory.path(memory?.search))
        _restoredSheet = State(initialValue: memory?.sheet)
    }
    /// Project settings present from the root: a sheet on a menu item never shows.
    @State private var projectSettings = ProjectSettingsPresenter()
    /// The new-thread sheet, opened from any screen of the Home stack.
    @State private var newThread = NewThreadPresenter()

    var body: some View {
        TabView(selection: $tab) {
            Tab("Home", systemImage: "house", value: AppTab.home) {
                NavigationStack(path: $homePath) {
                    HomeView(path: $homePath, slots: shellSlots)
                        .fleetToastInset()
                        .navigationDestination(for: Route.self) { destination($0, path: $homePath) }
                        // At the stack's root, not on Hosts: a push made while Hosts itself was still
                        // arriving (the proof's hook) found no destination and drew the warning glyph.
                        .navigationDestination(for: HostDetailRoute.self) { HostDetailView(environmentId: $0.environmentId) }
                }
            }
            Tab("Inbox", systemImage: "tray", value: AppTab.inbox) {
                NavigationStack(path: $inboxPath) {
                    InboxView(path: $inboxPath)
                        .fleetToastInset()
                        .navigationDestination(for: Route.self) { destination($0, path: $inboxPath) }
                }
            }
            Tab(value: AppTab.search, role: .search) {
                NavigationStack(path: $searchPath) {
                    SearchView(path: $searchPath, initialQuery: model.launchSearch)
                        .fleetToastInset()
                        .navigationDestination(for: Route.self) { destination($0, path: $searchPath) }
                }
            }
        }
        .preferredColorScheme(appearance.scheme)
        // The fleet switches' confirm sheet, shared by every menu; the outcome line sits on each tab (thread iOS 20).
        .fleetSwitchHost()
        .onChange(of: model.registry.ordered.map { $0.bootResume }) { BootResumeNotes.shared.observe(model.registry.ordered) }
        .environment(projectSettings)
        .modifier(NewThreadSheetHost(presenter: newThread) { created in
            tab = .home
            homePath.append(created)
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
        .onChange(of: homePath) { remember() }
        .onChange(of: inboxPath) { remember() }
        .onChange(of: searchPath) { remember() }
        .onChange(of: router.visible) { reportVisibility() }
        .onChange(of: router.lists) { reportVisibility() }
        .onChange(of: scenePhase) { reportVisibility() }
        // A notification or Live Activity tap: the Home stack becomes the thread, on its card.
        .onChange(of: router.pending) { _, route in
            guard let route else { return }
            // A tap names its card: it lands there even this early in a cold launch.
            LaunchRestore.end()
            tab = .home
            homePath = NavigationPath()
            homePath.append(route)
            router.pending = nil
        }
        .onOpenURL { url in
            if let target = PushTarget(url: url) {
                router.open(target)
            } else if url.host == "home" {
                // A group Live Activity's card: Home, where every thread it lists is.
                tab = .home
                homePath = NavigationPath()
            }
        }
    }

    /// Every change of where the person is, written at once: the write is one
    /// small defaults key, and the background has no reliable last moment.
    private func remember() {
        NavigationMemory.save(.init(tab: tab, home: homePath.codable, inbox: inboxPath.codable, search: searchPath.codable))
        reportVisibility()
    }

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

    @ViewBuilder
    private func destination(_ route: Route, path: Binding<NavigationPath>) -> some View {
        switch route {
        case .thread(let environmentId, let sessionId, let seq):
            if let client = model.registry.client(environmentId) {
                ThreadScreen(client: client, sessionId: sessionId, targetSeq: seq)
            }
        case .workspace(let key):
            WorkspaceScreen(key: key, path: path, slots: shellSlots)
        case .project(let key):
            ProjectScreen(key: key, path: path, slots: shellSlots)
        case .archivedThreads(let environmentId, let projectId):
            if let client = model.registry.client(environmentId) {
                ArchivedThreadsView(client: client, projectId: projectId, path: path)
            }
        case .archivedProjects(let environmentId, let workspaceId):
            if let client = model.registry.client(environmentId) {
                ArchivedProjectsView(client: client, workspaceId: workspaceId, path: path)
            }
        case .inboxItem(let environmentId, let item):
            if let client = model.registry.client(environmentId) {
                InboxItemView(client: client, item: item)
            }
        case .settings:
            SettingsView()
        case .hosts:
            HostsView(path: path)
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
            homePath.append(Route.settings)
        case "hosts":
            homePath.append(Route.settings)
            homePath.append(Route.hosts)
        case "archived":
            for workspace in client.workspaces {
                let groups = ThreadGroups.group(client.sessions, projects: client.projects, workspaces: client.workspaces, workspaceId: workspace.id)
                if let group = groups.projects.first(where: { $0.archivedCount > 0 }) {
                    homePath.append(Route.archivedThreads(environmentId: environmentId, projectId: group.id))
                    return
                }
            }
        case "archived-projects":
            for workspace in client.workspaces {
                let groups = ThreadGroups.group(client.sessions, projects: client.projects, workspaces: client.workspaces, workspaceId: workspace.id)
                if !groups.archived.isEmpty {
                    homePath.append(Route.archivedProjects(environmentId: environmentId, workspaceId: workspace.id))
                    return
                }
            }
        case "thread":
            let candidates = client.sessions.filter { $0.parentId == nil }
            let wanted = model.launchThread.map { needle in candidates.filter { $0.title.localizedCaseInsensitiveContains(needle) } } ?? candidates
            if let session = wanted.first ?? candidates.first {
                homePath.append(Route.thread(environmentId: environmentId, sessionId: session.id, seq: TestHooks.targetSeq))
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
