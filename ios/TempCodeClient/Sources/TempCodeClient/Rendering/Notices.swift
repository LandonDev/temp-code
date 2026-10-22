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

    /// The branch, and what the log says about the run: "feature · 3 errors",
    /// "master · at vitest", "master · release-277", else the branch alone.
    public static func detail(_ gate: GateNotice) -> String {
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
        return tail.map { "\(gate.branch) · \($0)" } ?? gate.branch
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

    public static func detail(_ review: ReviewNotice, resolved: Bool) -> String {
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
    public enum ID: String, Sendable, Hashable { case route, retry }

    public let id: ID
    public let label: String

    public init(id: ID) {
        self.id = id
        self.label = FailureActions.label(id)
    }
}

/// The desktop's failureActions with the phone's reach: it can route and
/// retry; signing in, picking an account or a model are desktop work, so
/// the note names them instead.
public enum FailureActions {
    public static let maxActions = 3

    /// Only claude and codex threads route through Aliax accounts.
    public static func isRouted(_ provider: ProviderId) -> Bool {
        switch provider {
        case .claude, .codex: true
        default: false
        }
    }

    public static func actions(kind: FailureKind, provider: ProviderId) -> [FailureAction] {
        let ids: [FailureAction.ID] = switch kind {
        case .oauthExpired, .accountUnknown, .tokenExpired, .rateLimited, .quota:
            isRouted(provider) ? [.route, .retry] : [.retry]
        case .modelUnavailable, .network, .harnessCrashed, .unknown, .unrecognized:
            [.retry]
        }
        // Retry closes every set, whatever the kind added before it; the cap leaves room for it.
        var ordered: [FailureAction.ID] = []
        for id in ids where id != .retry && !ordered.contains(id) { ordered.append(id) }
        ordered = Array(ordered.prefix(maxActions - 1))
        ordered.append(.retry)
        return ordered.map { FailureAction(id: $0) }
    }

    /// The desktop actions the phone lacks, named in one line; nil when none apply.
    public static func note(kind: FailureKind, provider: ProviderId) -> String? {
        switch kind {
        case .oauthExpired:
            isRouted(provider) ? "Sign in on the Mac, or pick another account on the desktop." : nil
        case .accountUnknown, .tokenExpired, .rateLimited, .quota:
            isRouted(provider) ? "Pick another account on the desktop." : nil
        case .modelUnavailable:
            "Pick another model on the desktop."
        case .network, .harnessCrashed, .unknown, .unrecognized:
            nil
        }
    }

    public static func label(_ id: FailureAction.ID) -> String {
        switch id {
        case .route: "Route automatically"
        case .retry: "Retry"
        }
    }

    /// The button's label while its call is out.
    public static func pendingLabel(_ id: FailureAction.ID) -> String {
        switch id {
        case .route: "Routing…"
        case .retry: "Retrying…"
        }
    }
}
