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
        // A change nobody is looking at lands with animations off: rows that
        // arrived while the person was elsewhere are simply there on return.
        registry.setQuietly { body in
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) { body() }
        }
        // The clients exist before the first frame: a restored thread route
        // resolves at once and paints its thread from the cache.
        registry.prepare()
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
            refreshBadge()
        }
        await applyLaunchPairing()
        await registry.sync()
        ready = true
        activities.reconcile(registry)
        followHosts()
        await refreshPushPermission()
        if registry.push.enabled, registry.push.permission == .granted { UIApplication.shared.registerForRemoteNotifications() }
        let registry = self.registry
        monitor.pathUpdateHandler = { path in
            let online = path.status == .satisfied
            Task { @MainActor in await registry.setOnline(online) }
        }
        monitor.start(queue: DispatchQueue(label: "dev.landon.tempcode.network"))
    }

    /// The paired hosts' names go to the App Group for the notification service extension, now and after every pairing added or removed.
    private func followHosts() {
        withObservationTracking {
            HostDirectory.publish(registry.store.environments.map { ($0.id, $0.name) })
        } onChange: { [weak self] in
            Task { @MainActor in self?.followHosts() }
        }
    }

    func scenePhaseChanged(_ phase: ScenePhase) async {
        switch phase {
        case .active:
            await registry.setForeground(true)
            settleAfterReturn()
            await refreshPushPermission()
        case .background:
            settling?.cancel()
            await registry.setForeground(false)
        default: break
        }
    }

    /// What is on screen, from the root view: the thread (if any) and whether
    /// Home's lists are. The clients publish everything else quietly.
    func setVisible(thread: ThreadKey?, listVisible: Bool) {
        registry.setVisible(environmentId: thread?.environmentId, sessionId: thread?.sessionId, listVisible: listVisible)
    }

    private var settling: Task<Void, Never>?

    /// Once every host has caught up on its live session (or has none to
    /// catch up on), the lock screen and the badge are brought in line with
    /// what the app now shows: an activity whose thread finished while the
    /// phone was away ends, the badge counts what needs the person.
    private func settleAfterReturn() {
        settling?.cancel()
        settling = Task { [weak self] in
            guard let self else { return }
            for _ in 0..<400 {
                if Task.isCancelled { return }
                if registry.allFresh { break }
                try? await Task.sleep(for: .milliseconds(50))
            }
            guard !Task.isCancelled else { return }
            activities.reconcile(registry)
            refreshBadge()
        }
    }

    /// The badge is Home's Needs you count across every host, never a push's own number.
    func refreshBadge() {
        let count = registry.ordered.reduce(0) { $0 + HomeModel.needsYou($1.sessions).count }
        guard count != badge else { return }
        badge = count
        Task { try? await UNUserNotificationCenter.current().setBadgeCount(count) }
    }
    private var badge = -1

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
    /// `TC_TEST_PAIR_LINK` pairs once at launch, and one in
    /// `TC_TEST_PAIR_LINK_SECOND` pairs a second host after it (the features
    /// set's linked project). Never a file, never a log.
    private func applyLaunchPairing() async {
        #if DEBUG
        let env = ProcessInfo.processInfo.environment
        let log = Logger(subsystem: "dev.landon.tempcode", category: "pairing")
        log.notice("launch: link present \((env["TC_TEST_PAIR_LINK"]?.isEmpty == false) ? "yes" : "no", privacy: .public), stored hosts \(self.registry.store.environments.count, privacy: .public)")
        await pairOnce(env["TC_TEST_PAIR_LINK"], name: env["TC_TEST_PAIR_NAME"], label: "launch pairing", log: log)
        await pairOnce(env["TC_TEST_PAIR_LINK_SECOND"], name: env["TC_TEST_PAIR_NAME_SECOND"], label: "second pairing", log: log)
        #endif
    }

    #if DEBUG
    /// Pairs `link` unless a host at its origin is already paired; logs the outcome under `label`.
    private func pairOnce(_ link: String?, name: String?, label: String, log: Logger) async {
        guard let link, !link.isEmpty, let parsed = PairingLink(link) else { return }
        if registry.store.environments.contains(where: { $0.origin == parsed.origin }) { return }
        let began = Date()
        do {
            _ = try await registry.add(pairingLink: link, name: name)
            log.notice("\(label, privacy: .public) done in \(Int(Date().timeIntervalSince(began) * 1000), privacy: .public) ms")
        } catch {
            // The proof reads this from the simulator log; the message never carries the code or a key.
            log.error("\(label, privacy: .public) failed: \(error.message, privacy: .public)")
        }
    }
    #endif
}
