import SwiftUI
import TempCodeClient
import TempCodeContract

/// The host detail's Activity slot (docs/IOS-DESIGN.md "Host activity"):
/// Build, then the Mac bridge (a box's, from each paired Mac that serves
/// it), then Devices (one section per Mac this host can show), then Sync. A
/// section whose host has nothing of the kind is absent. Every loop that
/// keeps them fresh runs in `ActivityPollers`, which the detail hangs on its
/// `List` itself: a row's tasks end when it scrolls off, the list's do not.
struct HostActivitySections: View {
    let client: EnvironmentClient
    @Environment(AppModel.self) private var model

    var body: some View {
        HostBuildSection(client: client)
        ForEach(pairedMacs(for: client, in: model.registry), id: \.environment.id) { mac in
            MacBridgeSection(box: client, mac: mac)
        }
        ForEach(client.extras.deviceHosts ?? [], id: \.environmentId) { host in
            MacDevicesSection(client: client, host: host)
        }
        SyncSection(client: client)
    }
}

/// The detail's loops, all in one place: each is a `.task` on a view whose
/// identity never changes while the detail shows, so it ends only when the
/// screen goes (and the devices watch sends its unwatch then). The deploy
/// and sync loops start only for a key that may read them; master's release
/// (run from RootView) is asked again when the app comes forward.
struct ActivityPollers: View {
    let client: EnvironmentClient
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let extras = client.extras
        let isMac = isMacHost(client)
        let macs = pairedMacs(for: client, in: model.registry)
        let deploys = !isMac && HostExtrasAccess.deploy.allowed(client.environment)
        let syncs = HostExtrasAccess.sync.allowed(client.environment)
        Color.clear
            .frame(width: 0, height: 0)
            .task { await extras.run(.deviceHosts) }
            .task(id: deploys) { if deploys { await extras.run(.deploy) } }
            .task(id: syncs) { if syncs { await extras.run(.sync) } }
            .background {
                ForEach(extras.deviceHosts ?? [], id: \.environmentId) { host in
                    Color.clear.task { await extras.run(.devices(host.environmentId)) }
                }
            }
            .background {
                ForEach(macs, id: \.environment.id) { mac in
                    Color.clear.task { await mac.extras.run(.macBridge) }
                }
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                Task { await MasterReleaseWatcher.shared.foreground() }
            }
            .accessibilityHidden(true)
    }
}

/// A host whose hello says it is a Mac (it publishes; it never deploys).
@MainActor
func isMacHost(_ client: EnvironmentClient) -> Bool {
    client.status.lastHello?.build?.platform == "darwin"
}

/// The Macs paired here that may serve `client` through the bridge, by their
/// hello; none for a Mac itself, never `client`.
@MainActor
func pairedMacs(for client: EnvironmentClient, in registry: ClientRegistry) -> [EnvironmentClient] {
    guard !isMacHost(client) else { return [] }
    return registry.ordered.filter { $0.environment.id != client.environment.id && isMacHost($0) }
}
