import Foundation
import Network
import os
import Observation
import SwiftUI
import TempCodeClient

/// The app's root: the registry of paired hosts, the network monitor, and
/// the foreground/background signal every socket follows.
@Observable
final class AppModel {
    let registry: ClientRegistry
    private(set) var started = false
    /// The stored hosts have their clients: the shell can tell "no hosts" from "not loaded yet".
    private(set) var ready = false
    /// The simulator proof asks for a screen at launch: `hosts`, `threads` or `thread`.
    let launchRoute: String?
    /// With `thread`: part of the title of the thread to open; else the newest.
    let launchThread: String?
    /// With `search`: the query to run at launch.
    let launchSearch: String?
    private let monitor = NWPathMonitor()

    init() {
        let store = EnvironmentStore(directory: EnvironmentStore.defaultDirectory(), keys: KeychainKeyStore())
        let cache = (try? SessionCache(path: SessionCache.defaultPath())) ?? (try! SessionCache.inMemory())
        registry = ClientRegistry(store: store, cache: cache)
        #if DEBUG
        launchRoute = ProcessInfo.processInfo.environment["TC_TEST_ROUTE"]
        launchThread = ProcessInfo.processInfo.environment["TC_TEST_THREAD"].flatMap { $0.isEmpty ? nil : $0 }
        launchSearch = ProcessInfo.processInfo.environment["TC_TEST_SEARCH"].flatMap { $0.isEmpty ? nil : $0 }
        #else
        launchRoute = nil
        launchThread = nil
        launchSearch = nil
        #endif
    }

    func start() async {
        guard !started else { return }
        started = true
        await applyLaunchPairing()
        await registry.sync()
        ready = true
        let registry = self.registry
        monitor.pathUpdateHandler = { path in
            let online = path.status == .satisfied
            Task { @MainActor in await registry.setOnline(online) }
        }
        monitor.start(queue: DispatchQueue(label: "dev.landon.tempcode.network"))
    }

    func scenePhaseChanged(_ phase: ScenePhase) async {
        switch phase {
        case .active: await registry.setForeground(true)
        case .background: await registry.setForeground(false)
        default: break
        }
    }

    /// The simulator proof pairs through the process environment: a link in
    /// `TC_TEST_PAIR_LINK` pairs once at launch. Never a file, never a log.
    private func applyLaunchPairing() async {
        #if DEBUG
        let env = ProcessInfo.processInfo.environment
        let log = Logger(subsystem: "dev.landon.tempcode", category: "pairing")
        log.notice("launch: link present \((env["TC_TEST_PAIR_LINK"]?.isEmpty == false) ? "yes" : "no", privacy: .public), stored hosts \(self.registry.store.environments.count, privacy: .public)")
        guard let link = env["TC_TEST_PAIR_LINK"], !link.isEmpty, let parsed = PairingLink(link) else { return }
        if registry.store.environments.contains(where: { $0.origin == parsed.origin }) { return }
        let began = Date()
        do {
            _ = try await registry.add(pairingLink: link, name: env["TC_TEST_PAIR_NAME"])
            log.notice("launch pairing done in \(Int(Date().timeIntervalSince(began) * 1000), privacy: .public) ms")
        } catch {
            // The proof reads this from the simulator log; the message never carries the code or a key.
            log.error("launch pairing failed: \(error.message, privacy: .public)")
        }
        #endif
    }
}
