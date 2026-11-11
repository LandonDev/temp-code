import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func gate(_ step: GateStep, branch: String = "feature", ok: Bool, log: String = "") -> GateNotice {
    GateNotice(step: step, branch: branch, ok: ok, log: log, at: 1)
}

private func finding(_ file: String, line: Int? = nil, verdict: ReviewFinding.Verdict? = nil) -> ReviewFinding {
    ReviewFinding(file: file, line: line, summary: "claim", failure_scenario: "scenario", verdict: verdict)
}

private func review(_ outcome: ReviewOutcome, blocking: Int = 0, minor: Int = 0, reason: String? = nil, minutes: Double? = nil) -> ReviewNotice {
    ReviewNotice(runId: "r1", reviewerId: nil, provider: "codex", model: "gpt-6.1-sol", outcome: outcome, branch: "feature", target: "master", blocking: (0..<blocking).map { finding("a.ts", line: $0) }, minor: (0..<minor).map { _ in finding("b.ts") }, merged: false, pushed: false, reason: reason, minutes: minutes)
}

@Suite struct GateTextTests {
    @Test(arguments: [
        ("Found 3 errors in 1 file.", 3),
        ("Found 1 error", 1),
        ("src/a.ts(1,1): error TS2322: x\nsrc/a.ts(2,1): error TS2554: y\nsrc/b.ts(3,1): error TS2339: z\n", 3),
        ("", 0)
    ])
    func `tsc's error count comes from its Found line, else the error TS lines`(log: String, count: Int) {
        #expect(GateText.typecheckErrorCount(log) == count)
    }

    @Test func `the failed gate step is the last one marked with a cross`() {
        #expect(GateText.failedGateStep("✓ typecheck 12s\n✗ vitest 40s failed") == "vitest")
        #expect(GateText.failedGateStep("✓ typecheck 12s\n✓ vitest 40s") == nil)
        #expect(GateText.failedGateStep("✗ typecheck 2s\n✗ build 9s failed\n") == "build")
    }

    @Test func `lead and detail per step and outcome`() {
        let failedTypecheck = gate(.typecheck, branch: "ios/import", ok: false, log: "x\nFound 3 errors in 1 file.")
        #expect(GateText.lead(failedTypecheck) == "Typecheck failed")
        #expect(GateText.tail(failedTypecheck) == "3 errors")
        let failedGate = gate(.gate, branch: "master", ok: false, log: "✓ typecheck 12s\n✗ vitest 40s failed")
        #expect(GateText.lead(failedGate) == "Gate failed")
        #expect(GateText.tail(failedGate) == "at vitest")
        let release = gate(.release, branch: "master", ok: true, log: "bumped release.json\ntag release-277")
        #expect(GateText.lead(release) == "Release passed")
        #expect(GateText.tail(release) == "release-277")
        let passed = gate(.typecheck, branch: "ios/export", ok: true)
        #expect(GateText.lead(passed) == "Typecheck passed")
        #expect(GateText.tail(passed) == nil)
        #expect(GateText.tail(gate(.typecheck, branch: "x", ok: false, log: "nothing")) == nil, "no count means the branch alone")
        #expect(GateText.label(.unknown("deploy")) == "Deploy")
    }

    @Test func `the line count skips blank lines and the fold label reads singular at one`() {
        #expect(GateText.lineCount("a\n\n  \nb\nc\n") == 3)
        #expect(GateText.lineCount("") == 0)
        #expect(GateText.foldLabel(lines: 1) == "Last line")
        #expect(GateText.foldLabel(lines: 12) == "Last 12 lines")
    }
}

@Suite struct ReviewTextTests {
    @Test func `lead per outcome`() {
        #expect(ReviewText.lead(review(.pass), label: "GPT-6.1 Sol") == "Reviewed by GPT-6.1 Sol")
        #expect(ReviewText.lead(review(.held), label: "GPT-6.1 Sol") == "Reviewed by GPT-6.1 Sol")
        #expect(ReviewText.lead(review(.timeout), label: "Opus 5.5") == "Review by Opus 5.5 timed out")
        #expect(ReviewText.lead(review(.failed), label: "Opus 5.5") == "Review by Opus 5.5 did not run")
        #expect(ReviewText.lead(review(.mergedAnyway), label: "x") == "Merged anyway")
        #expect(ReviewText.lead(review(.skipped), label: "x") == "Merged")
        #expect(ReviewText.lead(review(.unknown("later")), label: "x") == "Review")
    }

    @Test func `detail per outcome, with the minor count and the resolved hold`() {
        #expect(ReviewText.detail(review(.pass), resolved: false) == "No blocking findings")
        #expect(ReviewText.detail(review(.pass, minor: 2), resolved: false) == "No blocking findings, 2 minor")
        #expect(ReviewText.detail(review(.held, blocking: 2, minor: 1), resolved: false) == "2 blocking findings, 1 minor, merge held")
        #expect(ReviewText.detail(review(.held, blocking: 1), resolved: true) == "1 blocking finding, merged anyway")
        #expect(ReviewText.detail(review(.timeout, minutes: 15), resolved: false) == "After 15 min, merged without it")
        #expect(ReviewText.detail(review(.timeout, minutes: 14.6), resolved: false) == "After 15 min, merged without it")
        #expect(ReviewText.detail(review(.timeout), resolved: false) == "After ? min, merged without it")
        #expect(ReviewText.detail(review(.failed, reason: "the reviewer never reported"), resolved: false) == "The reviewer never reported, merged without it")
        #expect(ReviewText.detail(review(.failed), resolved: false) == "Merged without it")
        #expect(ReviewText.detail(review(.failed, reason: ""), resolved: false) == "Merged without it", "an empty reason is no reason")
        #expect(ReviewText.detail(review(.mergedAnyway, blocking: 1), resolved: false) == "1 blocking finding overridden")
        #expect(ReviewText.detail(review(.skipped, reason: "review off"), resolved: false) == "Review off")
        #expect(ReviewText.detail(review(.skipped), resolved: false) == "")
        #expect(ReviewText.detail(review(.unknown("later")), resolved: false) == "")
    }

    @Test func `held only while unresolved; the small lines`() {
        #expect(ReviewText.isHeld(review(.held), resolved: false))
        #expect(!ReviewText.isHeld(review(.held), resolved: true))
        #expect(!ReviewText.isHeld(review(.pass), resolved: false))
        #expect(ReviewText.minorLine(1) == "1 minor finding, not blocking")
        #expect(ReviewText.minorLine(2) == "2 minor findings, not blocking")
        #expect(ReviewText.location(finding("src/a.ts", line: 40)) == "src/a.ts:40")
        #expect(ReviewText.location(finding("src/a.ts")) == "src/a.ts")
        #expect(ReviewText.confirmTitle(review(.held, blocking: 1)) == "Merge past 1 blocking finding?")
        #expect(ReviewText.confirmTitle(review(.held, blocking: 2)) == "Merge past 2 blocking findings?")
    }
}

@Suite struct NoticeKindTests {
    @Test func `the host's kind string names the row`() {
        #expect(NoticeKind(rawValue: "review") == .review)
        #expect(NoticeKind(rawValue: "gate") == .gate)
        #expect(NoticeKind(rawValue: "batch") == .batch)
        #expect(NoticeKind(rawValue: "account-gone") == .accountGone)
        #expect(NoticeKind(rawValue: "plan-build") == .planBuild)
        #expect(NoticeKind(rawValue: "restart") == .unknown("restart"))
        #expect(NoticeEvent(kind: .accountGone, message: "gone").noticeKind == .accountGone)
    }
}

@Suite struct FailureActionsTests {
    static let kinds: [FailureKind] = [.oauthExpired, .accountUnknown, .tokenExpired, .rateLimited, .quota, .keyInvalid, .modelUnavailable, .network, .harnessCrashed, .turnEnded, .contextThrash, .unknown, .unrecognized("x")]
    static let routes: [RoutedProvider?] = [.claude, .codex, .meta, nil]

    @Test(arguments: Self.kinds, Self.routes)
    func `never more than three, unique, and Retry closes every set`(kind: FailureKind, routed: RoutedProvider?) {
        let actions = FailureActions.actions(kind: kind, routed: routed)
        #expect(actions.count <= FailureActions.maxActions)
        #expect(!actions.isEmpty)
        #expect(actions.last?.id == .retry)
        #expect(Set(actions.map(\.id)).count == actions.count)
        #expect(actions.last?.label == "Retry")
    }

    @Test func `a routed account failure offers Route automatically, and no set sends the person to the desktop`() {
        for routed in [RoutedProvider.claude, .codex] {
            for kind in [FailureKind.oauthExpired, .accountUnknown, .tokenExpired] {
                #expect(FailureActions.actions(kind: kind, routed: routed).map(\.label) == ["Route automatically", "Retry"])
            }
        }
    }

    @Test func `a cap routes while another account has room and offers another model, else another model alone`() {
        for routed in [RoutedProvider.claude, .codex] {
            for kind in [FailureKind.rateLimited, .quota] {
                for room in [true, nil] as [Bool?] {
                    #expect(FailureActions.actions(kind: kind, routed: routed, roomElsewhere: room).map(\.label) == ["Route automatically", "Continue on another model", "Retry"])
                }
                #expect(FailureActions.actions(kind: kind, routed: routed, roomElsewhere: false).map(\.label) == ["Continue on another model", "Retry"])
            }
        }
        // Not routed: another model is the only way on.
        #expect(FailureActions.actions(kind: .rateLimited, routed: nil).map(\.id) == [.pickModel, .retry])
        // A Meta key's cap keeps its keys' set, whatever the room.
        #expect(FailureActions.actions(kind: .quota, routed: .meta, roomElsewhere: false).map(\.label) == ["Route automatically", "Retry"])
    }

    @Test func `a refused key and a Meta thread with no key are Retry alone, never a route`() {
        #expect(FailureActions.actions(kind: .keyInvalid, routed: .meta).map(\.label) == ["Retry"])
        #expect(FailureActions.actions(kind: .accountUnknown, routed: .meta).map(\.label) == ["Retry"])
        // A throttled key still routes to another key.
        #expect(FailureActions.actions(kind: .rateLimited, routed: .meta).map(\.label) == ["Route automatically", "Retry"])
    }

    @Test func `a model the host cannot run offers another; the network and the harness get Retry alone`() {
        for routed in [RoutedProvider.claude, nil] {
            #expect(FailureActions.actions(kind: .modelUnavailable, routed: routed).map(\.label) == ["Continue on another model", "Retry"])
        }
        for kind in [FailureKind.network, .harnessCrashed, .turnEnded, .unknown, .unrecognized("x")] {
            #expect(FailureActions.actions(kind: kind, routed: .claude).map(\.label) == ["Retry"])
        }
    }

    @Test func `a thrashing window offers another model, then Retry`() {
        for routed in [RoutedProvider.claude, .codex, nil] {
            #expect(FailureActions.actions(kind: .contextThrash, routed: routed).map(\.label) == ["Continue on another model", "Retry"])
        }
    }

    @Test func `an unrouted thread never routes`() {
        for kind in Self.kinds {
            #expect(!FailureActions.actions(kind: kind, routed: nil).contains { $0.id == .route })
        }
    }

    @Test func `the pending labels`() {
        #expect(FailureActions.pendingLabel(.route) == "Routing…")
        #expect(FailureActions.pendingLabel(.retry) == "Retrying…")
        #expect(FailureActions.pendingLabel(.pickModel) == "Continuing…")
    }
}
