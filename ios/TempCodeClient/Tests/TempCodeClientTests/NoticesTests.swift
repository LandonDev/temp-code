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

private func review(_ outcome: ReviewNotice.Outcome, blocking: Int = 0, minor: Int = 0, reason: String? = nil, minutes: Double? = nil) -> ReviewNotice {
    ReviewNotice(runId: "r1", reviewerId: nil, provider: "codex", model: "gpt-6.1-sol", outcome: outcome, branch: "feature", target: "master", blocking: (0..<blocking).map { finding("a.ts", line: $0) }, minor: (0..<minor).map { finding("b.ts") }, merged: false, pushed: false, reason: reason, minutes: minutes)
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
        #expect(GateText.detail(failedTypecheck) == "ios/import · 3 errors")
        let failedGate = gate(.gate, branch: "master", ok: false, log: "✓ typecheck 12s\n✗ vitest 40s failed")
        #expect(GateText.lead(failedGate) == "Gate failed")
        #expect(GateText.detail(failedGate) == "master · at vitest")
        let release = gate(.release, branch: "master", ok: true, log: "bumped release.json\ntag release-277")
        #expect(GateText.lead(release) == "Release passed")
        #expect(GateText.detail(release) == "master · release-277")
        let passed = gate(.typecheck, branch: "ios/export", ok: true)
        #expect(GateText.lead(passed) == "Typecheck passed")
        #expect(GateText.detail(passed) == "ios/export")
        #expect(GateText.detail(gate(.typecheck, branch: "x", ok: false, log: "nothing")) == "x", "no count means the branch alone")
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
        #expect(ReviewText.detail(review(.pass), resolved: false) == "no blocking findings")
        #expect(ReviewText.detail(review(.pass, minor: 2), resolved: false) == "no blocking findings, 2 minor")
        #expect(ReviewText.detail(review(.held, blocking: 2, minor: 1), resolved: false) == "2 blocking findings, 1 minor, merge held")
        #expect(ReviewText.detail(review(.held, blocking: 1), resolved: true) == "1 blocking finding, merged anyway")
        #expect(ReviewText.detail(review(.timeout, minutes: 15), resolved: false) == "after 15 min, merged without it")
        #expect(ReviewText.detail(review(.timeout, minutes: 14.6), resolved: false) == "after 15 min, merged without it")
        #expect(ReviewText.detail(review(.timeout), resolved: false) == "after ? min, merged without it")
        #expect(ReviewText.detail(review(.failed, reason: "the reviewer never reported"), resolved: false) == "the reviewer never reported, merged without it")
        #expect(ReviewText.detail(review(.failed), resolved: false) == "merged without it")
        #expect(ReviewText.detail(review(.failed, reason: ""), resolved: false) == "merged without it", "an empty reason is no reason")
        #expect(ReviewText.detail(review(.mergedAnyway, blocking: 1), resolved: false) == "1 blocking finding overridden")
        #expect(ReviewText.detail(review(.skipped, reason: "review off"), resolved: false) == "review off")
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
        #expect(NoticeKind("review") == .review)
        #expect(NoticeKind("gate") == .gate)
        #expect(NoticeKind("batch") == .batch)
        #expect(NoticeKind("account-gone") == .accountGone)
        #expect(NoticeKind("restart") == .other("restart"))
        #expect(NoticeEvent(kind: "account-gone", message: "gone").noticeKind == .accountGone)
    }
}

@Suite struct FailureActionsTests {
    static let kinds: [FailureKind] = [.oauthExpired, .accountUnknown, .tokenExpired, .rateLimited, .quota, .modelUnavailable, .network, .harnessCrashed, .unknown, .unrecognized("x")]
    static let providers: [ProviderId] = [.claude, .codex, .cursor]

    @Test(arguments: Self.kinds, Self.providers)
    func `never more than three, unique, and Retry closes every set`(kind: FailureKind, provider: ProviderId) {
        let actions = FailureActions.actions(kind: kind, provider: provider)
        #expect(actions.count <= FailureActions.maxActions)
        #expect(!actions.isEmpty)
        #expect(actions.last?.id == .retry)
        #expect(Set(actions.map(\.id)).count == actions.count)
        #expect(actions.last?.label == "Retry")
    }

    @Test func `a routed account failure offers Route automatically and names the desktop's actions`() {
        for provider in [ProviderId.claude, .codex] {
            #expect(FailureActions.actions(kind: .oauthExpired, provider: provider).map(\.label) == ["Route automatically", "Retry"])
            #expect(FailureActions.note(kind: .oauthExpired, provider: provider) == "Sign in on the Mac, or pick another account on the desktop.")
            for kind in [FailureKind.accountUnknown, .tokenExpired, .rateLimited, .quota] {
                #expect(FailureActions.actions(kind: kind, provider: provider).map(\.label) == ["Route automatically", "Retry"])
                #expect(FailureActions.note(kind: kind, provider: provider) == "Pick another account on the desktop.")
            }
        }
    }

    @Test func `the model, the network and the harness get Retry alone`() {
        #expect(FailureActions.actions(kind: .modelUnavailable, provider: .claude).map(\.label) == ["Retry"])
        #expect(FailureActions.note(kind: .modelUnavailable, provider: .claude) == "Pick another model on the desktop.")
        #expect(FailureActions.note(kind: .modelUnavailable, provider: .cursor) == "Pick another model on the desktop.")
        for kind in [FailureKind.network, .harnessCrashed, .unknown, .unrecognized("x")] {
            #expect(FailureActions.actions(kind: kind, provider: .claude).map(\.label) == ["Retry"])
            #expect(FailureActions.note(kind: kind, provider: .claude) == nil)
        }
    }

    @Test func `an unrouted provider gets Retry alone and no account note, whatever the kind`() {
        for kind in Self.kinds {
            #expect(FailureActions.actions(kind: kind, provider: .cursor).map(\.label) == ["Retry"])
            if kind != .modelUnavailable { #expect(FailureActions.note(kind: kind, provider: .cursor) == nil) }
        }
        #expect(!FailureActions.isRouted(.unknown("other")))
        #expect(FailureActions.isRouted(.codex))
    }

    @Test func `the pending labels`() {
        #expect(FailureActions.pendingLabel(.route) == "Routing…")
        #expect(FailureActions.pendingLabel(.retry) == "Retrying…")
    }
}
