import Foundation
import TempCodeContract

// MARK: - What a notice row is

extension NoticeEvent {
    /// What the row is (the contract's `NoticeKind`, an unknown kind kept as `.unknown`).
    public var noticeKind: NoticeKind { kind }
}

// MARK: - The gate row's words (src/shared/gate.ts, GateCard.tsx)

public enum GateText {
    /// "Typecheck", "Gate", "Release"; an unknown step capitalised as it came.
    public static func label(_ step: GateStep) -> String {
        switch step {
        case .typecheck: "Typecheck"
        case .gate: "Gate"
        case .release: "Release"
        case .unknown(let raw): raw.prefix(1).uppercased() + raw.dropFirst()
        }
    }

    /// "Typecheck failed" / "Gate passed".
    public static func lead(_ gate: GateNotice) -> String {
        "\(label(gate.step)) \(gate.ok ? "passed" : "failed")"
    }

    /// What the log says about the run, drawn after the branch as its own
    /// text: "3 errors", "at vitest", "release-277"; nil when it says
    /// nothing worth a word.
    public static func tail(_ gate: GateNotice) -> String? {
        var tail: String?
        switch gate.step {
        case .typecheck where !gate.ok:
            let errors = typecheckErrorCount(gate.log)
            if errors > 0 { tail = "\(errors) error\(errors == 1 ? "" : "s")" }
        case .gate where !gate.ok:
            tail = failedGateStep(gate.log).map { "at \($0)" }
        case .release where gate.ok:
            tail = releaseTag(gate.log)
        default:
            break
        }
        return tail
    }

    /// tsc's count: its "Found N errors" line, else the `error TS` lines; 0 when neither.
    public static func typecheckErrorCount(_ log: String) -> Int {
        if let found = log.firstMatch(of: /Found (\d+) errors?/), let count = Int(found.1) { return count }
        return log.matches(of: /error TS\d+/).count
    }

    /// The failed gate step named in its own log (`✗ vitest 12s failed`); the last one wins.
    public static func failedGateStep(_ log: String) -> String? {
        for line in log.split(separator: "\n", omittingEmptySubsequences: false).reversed() {
            if let match = line.firstMatch(of: /✗ (\S+)/) { return String(match.1) }
        }
        return nil
    }

    /// The release the train tagged ("tag release-277"), when the log names one.
    public static func releaseTag(_ log: String) -> String? {
        log.firstMatch(of: /tag (release-\d+)/).map { String($0.1) }
    }

    /// Non-blank lines.
    public static func lineCount(_ log: String) -> Int {
        log.split(separator: "\n", omittingEmptySubsequences: false).count { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }

    /// "Last 12 lines" / "Last line".
    public static func foldLabel(lines: Int) -> String {
        lines == 1 ? "Last line" : "Last \(lines) lines"
    }
}

// MARK: - The review row's words (ReviewCard.tsx leadOf/detailOf)

public enum ReviewText {
    /// `label` is the model's display name (the app passes ModelName.short(review.model)).
    public static func lead(_ review: ReviewNotice, label: String) -> String {
        switch review.outcome {
        case .pass, .held: "Reviewed by \(label)"
        case .timeout: "Review by \(label) timed out"
        case .failed: "Review by \(label) did not run"
        case .mergedAnyway: "Merged anyway"
        case .skipped: "Merged"
        case .unknown: "Review"
        }
    }

    /// The card's second line under the lead, as a sentence: "No blocking
    /// findings, 2 minor", "2 blocking findings, merge held"; "" for none.
    public static func detail(_ review: ReviewNotice, resolved: Bool) -> String {
        let words = detailWords(review, resolved: resolved)
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    private static func detailWords(_ review: ReviewNotice, resolved: Bool) -> String {
        let minor = review.minor.isEmpty ? nil : "\(review.minor.count) minor"
        switch review.outcome {
        case .pass:
            return ["no blocking findings", minor].compactMap { $0 }.joined(separator: ", ")
        case .held:
            return [blockingCount(review), minor, resolved ? "merged anyway" : "merge held"].compactMap { $0 }.joined(separator: ", ")
        case .timeout:
            return "after \(minutes(review.minutes)) min, merged without it"
        case .failed:
            return [review.reason, "merged without it"].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
        case .mergedAnyway:
            return "\(blockingCount(review)) overridden"
        case .skipped:
            return review.reason ?? ""
        case .unknown:
            return ""
        }
    }

    /// "2 minor findings, not blocking" / "1 minor finding, not blocking".
    public static func minorLine(_ count: Int) -> String {
        "\(count) minor finding\(count == 1 ? "" : "s"), not blocking"
    }

    /// "file:line", or the file alone.
    public static func location(_ finding: ReviewFinding) -> String {
        finding.line.map { "\(finding.file):\($0)" } ?? finding.file
    }

    /// True while the held merge still waits: held, not resolved.
    public static func isHeld(_ review: ReviewNotice, resolved: Bool) -> Bool {
        review.outcome == .held && !resolved
    }

    /// The confirm sheet's title: "Merge past 2 blocking findings?".
    public static func confirmTitle(_ review: ReviewNotice) -> String {
        "Merge past \(blockingCount(review))?"
    }

    private static func blockingCount(_ review: ReviewNotice) -> String {
        "\(review.blocking.count) blocking finding\(review.blocking.count == 1 ? "" : "s")"
    }

    private static func minutes(_ value: Double?) -> String {
        guard let value else { return "?" }
        return String(Int(value.rounded()))
    }
}

// MARK: - The failure card's actions (src/renderer/src/lib/failureActions.ts)

/// What the failure card offers on the phone: at most three, Retry last.
public struct FailureAction: Sendable, Hashable, Identifiable {
    public enum ID: String, Sendable, Hashable { case route, pickModel, retry }

    public let id: ID
    public let label: String

    public init(id: ID) {
        self.id = id
        self.label = FailureActions.label(id)
    }
}

/// The desktop's failureActions within the phone's reach: Route
/// automatically, Continue on another model (the composer's model menu,
/// then `session.continue` on the pick) and Retry. The desktop's sign-in,
/// key and account rows have no phone counterpart and leave the set; no line
/// sends the person to the desktop. `routed` is the provider the thread's
/// accounts come from (`RoutedProvider(provider:model:catalog:)`), nil for a
/// thread no account routes. `roomElsewhere` is a cap's verdict
/// (`Failure.roomElsewhere`): false means no other account has room for the
/// model, so Route is left out and another model is the way on.
public enum FailureActions {
    public static let maxActions = 3

    public static func actions(kind: FailureKind, routed: RoutedProvider?, roomElsewhere: Bool? = nil) -> [FailureAction] {
        let ids: [FailureAction.ID] = switch kind {
        case .accountUnknown where routed == .meta, .keyInvalid:
            // A Meta thread with no key, or a refused key: the fix is a key, not a route.
            [.retry]
        case .rateLimited where routed == .meta, .quota where routed == .meta:
            // A Meta key's limit lifts on its own and its quota is billing: the keys, not the model.
            [.route, .retry]
        case .rateLimited, .quota:
            // A cap is per account and model: another account while one has room, else another model.
            routed != nil && roomElsewhere != false ? [.route, .pickModel, .retry] : [.pickModel, .retry]
        case .oauthExpired, .accountUnknown, .tokenExpired:
            routed != nil ? [.route, .retry] : [.retry]
        case .modelUnavailable:
            [.pickModel, .retry]
        case .network, .harnessCrashed, .turnEnded, .unknown, .unrecognized:
            [.retry]
        }
        // Retry closes every set, whatever the kind added before it; the cap leaves room for it.
        var ordered: [FailureAction.ID] = []
        for id in ids where id != .retry && !ordered.contains(id) { ordered.append(id) }
        ordered = Array(ordered.prefix(maxActions - 1))
        ordered.append(.retry)
        return ordered.map { FailureAction(id: $0) }
    }

    public static func label(_ id: FailureAction.ID) -> String {
        switch id {
        case .route: "Route automatically"
        case .pickModel: "Continue on another model"
        case .retry: "Retry"
        }
    }

    /// The button's label while its call is out.
    public static func pendingLabel(_ id: FailureAction.ID) -> String {
        switch id {
        case .route: "Routing…"
        case .pickModel: "Continuing…"
        case .retry: "Retrying…"
        }
    }
}
