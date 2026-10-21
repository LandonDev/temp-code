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

    init() {
        let memory = NavigationMemory.restore()
        _tab = State(initialValue: memory?.tab ?? .home)
        _homePath = State(initialValue: NavigationMemory.path(memory?.home))
        _inboxPath = State(initialValue: NavigationMemory.path(memory?.inbox))
        _searchPath = State(initialValue: NavigationMemory.path(memory?.search))
    }

    var body: some View {
        TabView(selection: $tab) {
            Tab("Home", systemImage: "house", value: AppTab.home) {
                NavigationStack(path: $homePath) {
                    HomeView(path: $homePath)
                        .navigationDestination(for: Route.self) { destination($0, path: $homePath) }
                }
            }
            Tab("Inbox", systemImage: "tray", value: AppTab.inbox) {
                NavigationStack(path: $inboxPath) {
                    InboxView(path: $inboxPath)
                        .navigationDestination(for: Route.self) { destination($0, path: $inboxPath) }
                }
            }
            Tab(value: AppTab.search, role: .search) {
                NavigationStack(path: $searchPath) {
                    SearchView(path: $searchPath, initialQuery: model.launchSearch)
                        .navigationDestination(for: Route.self) { destination($0, path: $searchPath) }
                }
            }
        }
        .preferredColorScheme(appearance.scheme)
        .task(id: model.ready) { await followLaunchRoute() }
        .onChange(of: tab) { remember() }
        .onChange(of: homePath) { remember() }
        .onChange(of: inboxPath) { remember() }
        .onChange(of: searchPath) { remember() }
        .onChange(of: router.visible) { reportVisibility() }
        .onChange(of: scenePhase) { reportVisibility() }
        // A notification or Live Activity tap: the Home stack becomes the thread, on its card.
        .onChange(of: router.pending) { _, route in
            guard let route else { return }
            tab = .home
            homePath = NavigationPath()
            homePath.append(route)
            router.pending = nil
        }
        .onOpenURL { url in
            if let target = PushTarget(url: url) { router.open(target) }
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
        model.setVisible(thread: active ? router.visible : nil, listVisible: active && tab == .home && homePath.isEmpty)
    }

    @ViewBuilder
    private func destination(_ route: Route, path: Binding<NavigationPath>) -> some View {
        switch route {
        case .thread(let environmentId, let sessionId, let seq):
            if let client = model.registry.client(environmentId) {
                ThreadScreen(client: client, sessionId: sessionId, targetSeq: seq)
            }
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
