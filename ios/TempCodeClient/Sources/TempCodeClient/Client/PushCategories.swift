import Foundation
import TempCodeContract

/// The notification categories the host names in `aps.category`
/// (src/main/server/remote/apnsPayload.ts), as data: the app's PushDelegate
/// builds its `UNNotificationCategory` set from this table, and a test holds
/// it. An approval decides with Approve and Deny; a computer step held for
/// the session tier with Run now and Skip, its words `CardDecision`'s. Both
/// decide under the same two action identifiers.
public struct PushCategory: Sendable, Hashable {
    public enum Option: Sendable, Hashable {
        /// The action asks for the phone's unlock first.
        case authenticationRequired
        /// The action is drawn as the destructive one.
        case destructive
    }

    public struct Action: Sendable, Hashable {
        public let id: String
        public let title: String
        public let option: Option
    }

    public let id: String
    public let actions: [Action]
    /// What the notification says when previews are hidden.
    public let hiddenPreview: String
    /// The choices its decisions are made under: the words of a refusal.
    public let choices: ApprovalRequestEvent.Choices?
}

public enum PushCategories {
    public static let approveAction = "tc.approve"
    public static let denyAction = "tc.deny"

    public static let approval = decides("tc.approval", allow: "Approve", choices: nil, hiddenPreview: "Needs approval")
    public static let runSkip = decides("tc.run-skip", allow: CardDecision.allow(.runSkip).title, choices: .runSkip, hiddenPreview: "Waiting for the Mac")
    public static let thread = PushCategory(id: "tc.thread", actions: [], hiddenPreview: "Thread update", choices: nil)

    public static let all: [PushCategory] = [approval, runSkip, thread]

    /// The category a notification named, by id; nil for one this build never registered.
    public static func named(_ id: String) -> PushCategory? {
        all.first { $0.id == id }
    }

    /// Whether an action identifier decides, and which way.
    public static func allow(action: String) -> Bool? {
        switch action {
        case approveAction: true
        case denyAction: false
        default: nil
        }
    }

    private static func decides(_ id: String, allow: String, choices: ApprovalRequestEvent.Choices?, hiddenPreview: String) -> PushCategory {
        PushCategory(id: id, actions: [
            .init(id: approveAction, title: allow, option: .authenticationRequired),
            .init(id: denyAction, title: CardDecision.deny(choices).title, option: .destructive)
        ], hiddenPreview: hiddenPreview, choices: choices)
    }
}
