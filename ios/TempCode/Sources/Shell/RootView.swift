import SwiftUI
import TempCodeClient

/// Three tabs: Home, Inbox, Search. Settings is a button in the Home bar.
struct RootView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("appearance") private var appearance = Appearance.system
    @State private var tab = AppTab.home
    @State private var homePath = NavigationPath()
    @State private var inboxPath = NavigationPath()
    @State private var searchPath = NavigationPath()
    @State private var routed = false

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
        default:
            break
        }
    }
}
