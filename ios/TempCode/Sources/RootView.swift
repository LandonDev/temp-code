import SwiftUI
import TempCodeClient

struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var path = NavigationPath()
    @State private var routed = false

    var body: some View {
        NavigationStack(path: $path) {
            EnvironmentsView()
                .navigationDestination(for: String.self) { id in
                    if let client = model.registry.client(id) {
                        EnvironmentView(client: client)
                    }
                }
                .navigationDestination(for: ThreadRoute.self) { route in
                    if let client = model.registry.client(route.environmentId) {
                        ThreadView(client: client, sessionId: route.sessionId)
                    }
                }
        }
        .task(id: model.started) {
            await followLaunchRoute()
        }
    }

    /// DEBUG only: the proof script launches with `TC_TEST_ROUTE` and reads the
    /// screen off the simulator, so the app walks there itself once the first
    /// host has listed its threads.
    private func followLaunchRoute() async {
        guard let route = model.launchRoute, route != "hosts", !routed, model.started else { return }
        for _ in 0..<600 {
            if let client = model.registry.ordered.first, client.hasShell {
                routed = true
                path.append(client.environment.id)
                if route == "thread" {
                    let candidates = client.sessions.filter { $0.parentId == nil }
                    let wanted = model.launchThread.map { needle in candidates.filter { $0.title.localizedCaseInsensitiveContains(needle) } } ?? candidates
                    if let session = wanted.first ?? candidates.first {
                        path.append(ThreadRoute(environmentId: client.environment.id, sessionId: session.id))
                    }
                }
                return
            }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }
}
