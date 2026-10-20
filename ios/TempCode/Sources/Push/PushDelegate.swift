import Foundation
import TempCodeClient
import TempCodeContract
import UIKit
import UserNotifications
import os

/// What the push delegate hands the app: tokens, taps and the on-screen check.
@MainActor
protocol PushHandler: AnyObject {
    func pushToken(_ hex: String)
    func pushTokenFailed(_ message: String)
    func pushTapped(_ target: PushTarget)
    func pushIsOnScreen(_ target: PushTarget) -> Bool
}

/// The UIKit side of push: the device token callbacks and the notification
/// centre's delegate. SwiftUI makes it through `UIApplicationDelegateAdaptor`,
/// so the handler is wired after launch (`PushDelegate.handler`).
final class PushDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor static weak var handler: PushHandler?
    private static let log = Logger(subsystem: "dev.landon.tempcode", category: "push")

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
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

    /// A tap on a notification: the thread and its card, through the router.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        // The payload is read here; only the Sendable target crosses to the main actor.
        guard let target = PushTarget(userInfo: response.notification.request.content.userInfo) else { return }
        await MainActor.run { PushDelegate.route(target) }
    }

    /// Delivery in the foreground: nothing for the thread on screen, the banner otherwise.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let target = PushTarget(userInfo: notification.request.content.userInfo)
        let onScreen = await MainActor.run { target.map { PushDelegate.handler?.pushIsOnScreen($0) ?? false } ?? false }
        return onScreen ? [] : [.banner, .sound, .list]
    }

    /// The one route a tapped payload takes; the DEBUG proof feeds a payload here too.
    @MainActor static func route(_ userInfo: [AnyHashable: Any]) {
        guard let target = PushTarget(userInfo: userInfo) else { return }
        route(target)
    }

    @MainActor static func route(_ target: PushTarget) {
        handler?.pushTapped(target)
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
