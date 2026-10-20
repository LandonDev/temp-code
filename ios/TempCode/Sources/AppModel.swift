import Foundation
import Network
import os
import Observation
import SwiftUI
import TempCodeClient
import UIKit
import UserNotifications

/// The app's root: the registry of paired hosts, the network monitor, the
/// foreground/background signal every socket follows, and the push glue
/// (the token to the registrar, a tap to the router).
@Observable
final class AppModel: PushHandler {
    let registry: ClientRegistry
    let router = NavigationRouter()
    let activities = ActivityCoordinator()
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
        PushDelegate.handler = self
        registry.setSessionObserver { [weak self] client, metas in
            guard let self else { return }
            activities.apply(client, metas, registry: registry)
        }
        await applyLaunchPairing()
        await registry.sync()
        ready = true
        activities.reconcile(registry)
        await refreshPushPermission()
        if registry.push.enabled, registry.push.permission == .granted { UIApplication.shared.registerForRemoteNotifications() }
        let registry = self.registry
        monitor.pathUpdateHandler = { path in
            let online = path.status == .satisfied
            Task { @MainActor in await registry.setOnline(online) }
        }
        monitor.start(queue: DispatchQueue(label: "dev.landon.tempcode.network"))
    }

    func scenePhaseChanged(_ phase: ScenePhase) async {
        switch phase {
        case .active:
            await registry.setForeground(true)
            await refreshPushPermission()
        case .background: await registry.setForeground(false)
        default: break
        }
    }

    // MARK: - push

    /// The Settings row: on asks the system once, then registers for a token; off unregisters on every host.
    func setPushEnabled(_ on: Bool) async {
        if on {
            let center = UNUserNotificationCenter.current()
            let settings = await center.notificationSettings()
            var granted = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional || settings.authorizationStatus == .ephemeral
            if settings.authorizationStatus == .notDetermined {
                granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            }
            registry.push.setPermission(granted ? .granted : .denied)
            await registry.push.setEnabled(true, clients: registry.ordered)
            if granted { UIApplication.shared.registerForRemoteNotifications() }
        } else {
            await registry.push.setEnabled(false, clients: registry.ordered)
        }
    }

    private func refreshPushPermission() async {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        switch status {
        case .authorized, .provisional, .ephemeral: registry.push.setPermission(.granted)
        case .denied: registry.push.setPermission(.denied)
        default: registry.push.setPermission(.unknown)
        }
    }

    func pushToken(_ hex: String) {
        let device = PushRegistrar.Device(token: hex, bundleId: Bundle.main.bundleIdentifier ?? "dev.landon.tempcode.ios", environment: ProvisioningProfile.apsEnvironment())
        Task { await registry.push.setDevice(device, clients: registry.ordered) }
    }

    func pushTokenFailed(_ message: String) {
        registry.push.setTokenError(message)
    }

    func pushTapped(_ target: PushTarget) {
        router.open(target)
    }

    func pushIsOnScreen(_ target: PushTarget) -> Bool {
        router.isVisible(target)
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
