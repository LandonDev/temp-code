import Foundation
import TempCodeClient
import TempCodeContract
import UIKit
import UserNotifications
import os

/// What the push delegate hands the app: tokens, taps, decisions and the
/// on-screen checks. `AppModel` conforms with what it already holds (the
/// registry, the router, the activities); the decision and the live check
/// are written once here, on those.
@MainActor
protocol PushHandler: AnyObject {
    var registry: ClientRegistry { get }
    var router: NavigationRouter { get }
    var activities: ActivityCoordinator { get }
    func pushToken(_ hex: String)
    func pushTokenFailed(_ message: String)
    func pushTapped(_ target: PushTarget)
    func pushIsOnScreen(_ target: PushTarget) -> Bool
}

extension PushHandler {
    /// The thread's Live Activity is on the lock screen: a foreground notice for it needs no banner.
    func pushHasLiveActivity(_ target: PushTarget) -> Bool {
        activities.isLive(ThreadKey(environmentId: target.environmentId, sessionId: target.sessionId))
    }

    /// Approve or Deny from the notification's actions: the host's `session.approve`,
    /// through the thread's client. The app runs in the background for this, so the
    /// socket is brought up first and given a moment. A refusal (a key that may not
    /// approve, a host out of reach, a prompt already decided) is said back as one
    /// quiet notification on the same thread, and the card in the app says why too.
    func pushDecide(_ decision: PushDecision) async {
        let target = decision.target
        guard let client = registry.client(target.environmentId) else {
            PushDelegate.explain(decision, "This host is no longer paired")
            return
        }
        await registry.setForeground(true)
        let deadline = Date.now.addingTimeInterval(8)
        while client.status.transport != .open, Date.now < deadline {
            try? await Task.sleep(for: .milliseconds(250))
        }
        do {
            try await client.approve(target.sessionId, requestId: decision.requestId, allow: decision.allow)
        } catch {
            PushDelegate.explain(decision, (error as? ActionError)?.message ?? error.localizedDescription)
        }
        if UIApplication.shared.applicationState != .active { await registry.setForeground(false) }
    }
}

/// An Approve or Deny tapped on an approval notice.
struct PushDecision: Sendable, Hashable {
    let target: PushTarget
    let requestId: String
    let allow: Bool
    /// The notice's own words, for the answer when the decision is refused.
    let title: String
    let subtitle: String
}

/// The UIKit side of push: the device token callbacks, the notification
/// categories and the notification centre's delegate. SwiftUI makes it
/// through `UIApplicationDelegateAdaptor`, so the handler is wired after
/// launch (`PushDelegate.handler`).
final class PushDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor static weak var handler: PushHandler?
    private static let log = Logger(subsystem: "dev.landon.tempcode", category: "push")

    /// The categories the host names in `aps.category` (remote/apnsPayload.ts).
    enum Category {
        static let approval = "tc.approval"
        static let thread = "tc.thread"
    }

    enum Action {
        static let approve = "tc.approve"
        static let deny = "tc.deny"
    }

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(Self.categories())
        return true
    }

    /// Approve asks for the phone's unlock; Deny is the destructive one. Every other thread notice opens the thread on tap.
    nonisolated static func categories() -> Set<UNNotificationCategory> {
        let approve = UNNotificationAction(identifier: Action.approve, title: "Approve", options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: Action.deny, title: "Deny", options: [.destructive])
        let approval = UNNotificationCategory(identifier: Category.approval, actions: [approve, deny], intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: "Needs approval", options: [])
        let thread = UNNotificationCategory(identifier: Category.thread, actions: [], intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: "Thread update", options: [])
        return [approval, thread]
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in PushDelegate.handler?.pushToken(hex) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        let message = error.localizedDescription
        Self.log.error("token registration failed: \(message, privacy: .public)")
        Task { @MainActor in PushDelegate.handler?.pushTokenFailed(message) }
    }

    // The completion-handler forms, finished on the main actor: UIKit updates
    // the scene's snapshot and state restoration inside the completion and
    // asserts the main thread there (the async forms returned on a
    // cooperative thread and aborted the app on the first real tap).

    /// A tap on a notification opens the thread and its card; Approve or Deny decides the prompt without opening anything.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        // The payload is read here; only Sendable values cross to the main actor.
        let content = response.notification.request.content
        let target = PushTarget(userInfo: content.userInfo)
        let decision: PushDecision? = {
            guard let target, response.actionIdentifier == Action.approve || response.actionIdentifier == Action.deny,
                  let tc = content.userInfo["tc"] as? [AnyHashable: Any], let requestId = tc["requestId"] as? String, !requestId.isEmpty else { return nil }
            return PushDecision(target: target, requestId: requestId, allow: response.actionIdentifier == Action.approve, title: content.title, subtitle: content.subtitle)
        }()
        // UIKit's handler is not Sendable in this SDK; it is made to be called once, on the main thread, which is where this lands.
        nonisolated(unsafe) let finish = completionHandler
        Task { @MainActor in
            if let decision {
                await PushDelegate.handler?.pushDecide(decision)
            } else if let target, response.actionIdentifier == UNNotificationDefaultActionIdentifier {
                PushDelegate.route(target)
            }
            finish()
        }
    }

    /// Delivery in the foreground: nothing for the thread on screen; the list only
    /// for a thread whose Live Activity already shows the change, unless it needs
    /// the person; the banner otherwise.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let userInfo = notification.request.content.userInfo
        let target = PushTarget(userInfo: userInfo)
        let event = (userInfo["tc"] as? [AnyHashable: Any])?["event"] as? String
        nonisolated(unsafe) let finish = completionHandler
        Task { @MainActor in
            guard let target, let handler = PushDelegate.handler else {
                finish([.banner, .sound, .list])
                return
            }
            if handler.pushIsOnScreen(target) {
                finish([])
            } else if event != "needs_you", handler.pushHasLiveActivity(target) {
                finish([.list])
            } else {
                finish([.banner, .sound, .list])
            }
        }
    }

    /// The one route a tapped payload takes; the DEBUG proof feeds a payload here too.
    @MainActor static func route(_ userInfo: [AnyHashable: Any]) {
        guard let target = PushTarget(userInfo: userInfo) else { return }
        route(target)
    }

    @MainActor static func route(_ target: PushTarget) {
        handler?.pushTapped(target)
    }

    /// A decision the host refused: one notification on the same thread saying why; a tap opens the card.
    nonisolated static func explain(_ decision: PushDecision, _ reason: String) {
        let content = UNMutableNotificationContent()
        content.title = decision.title
        if !decision.subtitle.isEmpty { content.subtitle = decision.subtitle }
        content.body = "\(decision.allow ? "Not approved" : "Not denied"): \(reason)"
        content.threadIdentifier = decision.target.sessionId
        content.categoryIdentifier = Category.thread
        content.interruptionLevel = .timeSensitive
        content.relevanceScore = 1
        var tc: [String: Any] = ["event": "needs_you", "environmentId": decision.target.environmentId, "threadId": decision.target.sessionId, "ts": Int(Date.now.timeIntervalSince1970 * 1000)]
        if let seq = decision.target.seq { tc["seq"] = seq }
        content.userInfo = ["tc": tc]
        let request = UNNotificationRequest(identifier: "tc.decide.\(decision.requestId)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error { log.error("could not say why the decision failed: \(error.localizedDescription, privacy: .public)") }
        }
        log.notice("decision refused: \(reason, privacy: .public)")
    }
}

/// The APNs gateway this build's token belongs to: what the provisioning
/// profile's `aps-environment` says; a build without one (the simulator) is sandbox.
enum ProvisioningProfile {
    static func apsEnvironment() -> PushRegistrar.Device.Environment {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url) else { return .sandbox }
        guard let text = String(data: data, encoding: .isoLatin1) else { return .sandbox }
        guard let range = text.range(of: "<key>aps-environment</key>") else { return .sandbox }
        let tail = text[range.upperBound...]
        guard let open = tail.range(of: "<string>"), let close = tail.range(of: "</string>", range: open.upperBound..<tail.endIndex) else { return .sandbox }
        return tail[open.upperBound..<close.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines) == "production" ? .production : .sandbox
    }
}

extension PushRegistrar.Device {
    typealias Environment = TempCodeContract.PushEnvironment
}
