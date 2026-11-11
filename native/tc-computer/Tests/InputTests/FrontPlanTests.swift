import ComputerCore
import ComputerProtocol
import Foundation
import Testing
#if canImport(InputPure)
@testable import InputPure
#else
@testable import Input
#endif

// The `front` hold's state machine (docs/computer-protocol.md §26.2–§26.5). Foundation only: the
// box runs this file from scripts/computer-text-test.sh, the Mac in InputTests.

/// A hold already active at `at`.
private func activeHold(at: Int = 1_000) -> FrontHoldPlan {
    var h = FrontHoldPlan(startedAt: at - 40, person: AppBrief(pid: 7, bundleId: "com.apple.Notes", name: "Notes"))
    #expect(h.activation(now: at, isFront: true) == .activated)
    return h
}

@Suite struct QuietWaitTests {
    @Test func goesOnceTheLastKeyIsOldAndNothingIsHeld() {
        #expect(QuietWait.decide(now: 5_000, startedAt: 5_000, lastKeyDownAt: nil, held: false) == .go)
        #expect(QuietWait.decide(now: 5_000, startedAt: 5_000, lastKeyDownAt: 4_200, held: false) == .go)
        // 300 ms old: wait the 500 ms left of the quiet
        #expect(QuietWait.decide(now: 5_000, startedAt: 5_000, lastKeyDownAt: 4_700, held: false) == .wait(ms: 500))
    }

    @Test func aHeldKeyOrModifierKeepsItWaiting() {
        #expect(QuietWait.decide(now: 5_000, startedAt: 5_000, lastKeyDownAt: 1_000, held: true) == .wait(ms: InputTiming.frontPollMs))
        #expect(QuietWait.decide(now: 5_000, startedAt: 5_000, lastKeyDownAt: nil, held: true) == .wait(ms: InputTiming.frontPollMs))
    }

    @Test func thePersonStillTypingAtTheCapGoesAnyway() {
        let start = 0
        let atCap = InputTiming.frontQuietMaxMs
        #expect(QuietWait.decide(now: atCap, startedAt: start, lastKeyDownAt: atCap - 10, held: false) == .goAnyway)
        #expect(QuietWait.decide(now: atCap, startedAt: start, lastKeyDownAt: nil, held: true) == .goAnyway)
        // never waits past the cap
        #expect(QuietWait.decide(now: atCap - 100, startedAt: start, lastKeyDownAt: atCap - 110, held: false) == .wait(ms: 100))
    }
}

@Suite struct FrontHoldPlanTests {
    @Test func activationPollsThenIsRefusedAtItsCap() {
        var h = FrontHoldPlan(startedAt: 0)
        #expect(h.activation(now: 0, isFront: false) == .poll(afterMs: InputTiming.frontPollMs))
        #expect(h.activation(now: InputTiming.frontActivateMaxMs - 1, isFront: false) == .poll(afterMs: InputTiming.frontPollMs))
        #expect(h.activation(now: InputTiming.frontActivateMaxMs, isFront: false) == .refused)
        // the restore still runs and the report says nothing was held
        #expect(h.phase == .restoring)
        #expect(h.restore(now: InputTiming.frontActivateMaxMs + 30, front: .personApp) == .done(.restored))
        #expect(h.report?.heldMs == 0)
        #expect(h.report?.activateMs == InputTiming.frontActivateMaxMs)
    }

    @Test func theHoldReportsItsSpans() {
        var h = FrontHoldPlan(startedAt: 960, person: AppBrief(pid: 7, bundleId: nil, name: "Notes"))
        h.armedAt = 1_700_000_000_000
        h.idleAtArmMs = 4_000
        #expect(h.activation(now: 1_000, isFront: true) == .activated)
        #expect(h.beforePost(now: 1_010) == .post(axTimeoutMs: min(Int(InputTiming.axTimeoutS * 1000), InputTiming.frontHoldMaxMs - 10)))
        h.acted(now: 1_020)
        #expect(h.settle(now: 1_040, changed: true, busy: false) == .release)
        h.beginRestore(now: 1_040)
        #expect(h.restore(now: 1_050, front: .agentApp) == .poll(afterMs: InputTiming.frontPollMs))
        #expect(h.restore(now: 1_090, front: .personApp) == .done(.restored))
        let r = h.report
        #expect(r == FrontHold(heldMs: 40, activateMs: 40, restoreMs: 50, restored: .restored, person: AppBrief(pid: 7, bundleId: nil, name: "Notes"), armedAt: 1_700_000_000_000, idleAtArmMs: 4_000, lastInputAt: 1_020))
    }

    @Test func axTimeoutsShrinkToTheTimeLeft() {
        var h = activeHold(at: 0)
        #expect(h.beforePost(now: InputTiming.frontHoldMaxMs - 300) == .post(axTimeoutMs: 300))
        #expect(h.timeLeft(now: InputTiming.frontHoldMaxMs - 300) == 300)
    }

    @Test func theCapStopsPostingAndIsNeverReplayed() {
        var h = activeHold(at: 0)
        #expect(h.beforePost(now: InputTiming.frontHoldMaxMs) == .cap)
        #expect(h.stopped)
        #expect(!h.takesAnotherStep(now: InputTiming.frontHoldMaxMs))
        // the settle releases at once at the cap
        #expect(h.settle(now: InputTiming.frontHoldMaxMs, changed: false, busy: true) == .release)
        let fail = FrontFailure.timeout(app: "TextEdit")
        #expect(fail.kind == .timeout)
        #expect(fail.message == "TextEdit was in front for 2 s and the step may be part done; read the window before acting again.")
    }

    @Test func theSettleWaitsForAChangeOrItsTime() {
        var h = activeHold(at: 0)
        h.acted(now: 100)
        // nothing yet: poll, up to frontSettleMs
        #expect(h.settle(now: 150, changed: false, busy: false) == .hold(afterMs: InputTiming.frontPollMs))
        #expect(h.settle(now: 100 + InputTiming.frontSettleMs, changed: false, busy: false) == .release)
        // a change signal releases at once
        #expect(h.settle(now: 120, changed: true, busy: false) == .release)
        // the app still busy with keys it has not handled: up to frontSettleMaxMs
        #expect(h.settle(now: 100 + InputTiming.frontSettleMs, changed: true, busy: true) == .hold(afterMs: InputTiming.frontPollMs))
        #expect(h.settle(now: 100 + InputTiming.frontSettleMaxMs, changed: false, busy: true) == .release)
    }

    @Test func aBatchsFrontStepsShareAHoldWhileItHasTime() {
        let h = activeHold(at: 0)
        #expect(h.takesAnotherStep(now: 500))
        #expect(h.takesAnotherStep(now: InputTiming.frontHoldMaxMs - InputTiming.frontSettleMs))
        #expect(!h.takesAnotherStep(now: InputTiming.frontHoldMaxMs - InputTiming.frontSettleMs + 1))
        // a run per stretch of front steps; another tier between them ends the run
        #expect(frontRuns([.ax, .front, .front, .process, .front, nil, .front]) == [1 ..< 3, 4 ..< 5, 6 ..< 7])
        #expect(frontRuns([.front, .front]) == [0 ..< 2])
        #expect(frontRuns([.ax, .session]) == [])
    }

    @Test func escapeAlwaysStopsTheHold() {
        var guarded = activeHold()
        #expect(guarded.touched(.escape, guarded: true) == .stop)
        #expect(guarded.stopped)
        var bare = activeHold()
        #expect(bare.touched(.escape, guarded: false) == .stop)
    }

    @Test func withTheGuardThePersonsInputIsDropped() {
        var h = activeHold()
        for t in [PersonTouch.key, .click, .wheel, .pointerMove] {
            #expect(h.touched(t, guarded: true) == .ignore, "\(t)")
        }
        #expect(!h.stopped)
    }

    @Test func withoutTheGuardTheFirstKeyOrClickStopsIt() {
        for t in [PersonTouch.key, .click, .wheel] {
            var h = activeHold()
            #expect(h.touched(t, guarded: false) == .stop, "\(t)")
        }
        var moved = activeHold()
        #expect(moved.touched(.pointerMove, guarded: false) == .ignore)
        // once the restore runs nothing the person does stops anything
        var restoring = activeHold()
        restoring.beginRestore(now: 1_500)
        #expect(restoring.touched(.key, guarded: false) == .ignore)
    }

    @Test func theRestoreKeepsThePersonsChoice() {
        var moved = activeHold()
        moved.beginRestore(now: 1_200)
        #expect(moved.restore(now: 1_210, front: .thirdApp) == .done(.personMoved))
        var gone = activeHold()
        gone.beginRestore(now: 1_200)
        #expect(gone.restore(now: 1_210, front: .personAppGone) == .done(.appGone))
        var stuck = activeHold()
        stuck.beginRestore(now: 1_200)
        #expect(stuck.restore(now: 1_200 + InputTiming.frontRestoreMaxMs - 1, front: .agentApp) == .poll(afterMs: InputTiming.frontPollMs))
        #expect(stuck.restore(now: 1_200 + InputTiming.frontRestoreMaxMs, front: .agentApp) == .done(.failed))
        #expect(stuck.report?.restoreMs == InputTiming.frontRestoreMaxMs)
        // the restore begins once
        stuck.beginRestore(now: 9_000)
        #expect(stuck.phase == .done)
    }

    @Test func activationRefusedIsTheSessionTiersReason() {
        let e = FrontFailure.activationRefused(app: "Finder")
        #expect(e.kind == .sessionUnavailable)
        #expect(e.reason == .activationRefused)
    }
}
