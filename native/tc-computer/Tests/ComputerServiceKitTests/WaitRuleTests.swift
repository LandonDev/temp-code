import ComputerProtocol
@testable import ComputerServiceKit
import Testing

/// Runs a rule over a timeline sampled every 25 ms, the signature and busy every 100 ms as the runner does.
private func run(
    _ options: WaitOptions = ComputerDefaults.Wait.action, thin: Bool = false, pixels: Bool = true,
    ax: [Int] = [], signatures: [(Int, UInt64)] = [], busy: [(Int, Bool)] = [], px: [Int] = [], until: Int = 10_000
) -> WaitOutcome {
    var rule = WaitRule(options: options, signature0: 0, thin: thin, pixels: pixels)
    var at = 0
    while at <= until {
        let sample = WaitSample(
            at: at,
            axLastChange: ax.filter { $0 <= at }.max(),
            signature: at % 100 == 0 ? signatures.filter { $0.0 <= at }.max { $0.0 < $1.0 }?.1 ?? 0 : nil,
            busy: at % 100 == 0 ? busy.filter { $0.0 <= at }.max { $0.0 < $1.0 }?.1 ?? false : nil,
            pixelLastChange: px.filter { $0 <= at }.max()
        )
        if case .done(let outcome) = rule.take(sample) { return outcome }
        at += 25
    }
    Issue.record("the wait never ended")
    return WaitRule.skipped()
}

@Suite struct WaitRuleTests {
    @Test func nothingMovesSoItEndsAtMinPlusQuiet() {
        let out = run()
        #expect(out.report == WaitReport(waitedMs: 750, settled: true, busy: false, reason: .quiet))
        #expect(out.effect(thin: false) == .none)
    }

    @Test func oneAXChangeRestartsTheQuietClock() {
        let out = run(ax: [400])
        #expect(out.report.waitedMs == 850)
        #expect(out.report.reason == .quiet)
        #expect(out.effect(thin: false) == .changed)
        #expect(out.counts.ax == 1)
    }

    @Test func aChangeInsideMinStillEndsAtMinPlusQuiet() {
        let out = run(ax: [100])
        #expect(out.report.waitedMs == 750)
        #expect(out.axChanged)
    }

    @Test func changesThatNeverStopEndAtMax() {
        let out = run(ax: Array(stride(from: 50, through: 9_000, by: 200)))
        #expect(out.report.waitedMs == 1_500 && !out.report.settled && out.report.reason == .max)
    }

    @Test func aBusyIndicatorHoldsTheWaitToBusyMax() {
        let out = run(busy: [(0, true)])
        #expect(out.report == WaitReport(waitedMs: 5_000, settled: false, busy: true, reason: .busyMax))
    }

    @Test func busyThatClearsEndsOnceTheWindowIsQuiet() {
        let out = run(busy: [(0, true), (2_000, false)])
        #expect(out.report == WaitReport(waitedMs: 2_450, settled: true, busy: false, reason: .quiet))
    }

    @Test func aSignatureChangeCountsAsAChange() {
        let out = run(signatures: [(500, 7)])
        #expect(out.report.waitedMs == 950)
        #expect(out.counts.sig == 1)
        #expect(out.effect(thin: false) == .changed)
    }

    @Test func pixelsCountOnAThinTree() {
        let out = run(thin: true, ax: [200], px: [600])
        #expect(out.report.waitedMs == 1_050)
        #expect(out.pixelChanged)
    }

    @Test func pixelsCountWhileNoAXChangeHasBeenSeen() {
        let out = run(px: [500])
        #expect(out.report.waitedMs == 950)
        #expect(out.pixelChanged)
        #expect(out.effect(thin: false) == .changed)
    }

    @Test func pixelsAfterAnAXChangeOnAFullTreeAreIgnored() {
        let out = run(ax: [350], px: [700])
        #expect(out.report.waitedMs == 800)
        #expect(!out.pixelChanged)
        #expect(out.counts.px == 0)
    }

    @Test func pixelsNeverPassTheCap() {
        let out = run(px: Array(stride(from: 100, through: 9_000, by: 100)))
        #expect(out.report.waitedMs == 1_500)
        #expect(out.report.reason == .max)
    }

    @Test func aWatchThatIsNotLiveAddsNothing() {
        let out = run(pixels: false, px: [500])
        #expect(out.report.waitedMs == 750)
        #expect(!out.pixelChanged)
        #expect(out.effect(thin: false) == .none)
        #expect(out.effect(thin: true) == .unknown)
    }

    @Test func cancelEndsItWhereItIs() {
        var rule = WaitRule(options: ComputerDefaults.Wait.action, signature0: 0, thin: false, pixels: false)
        _ = rule.take(WaitSample(at: 100))
        let out = rule.cancelled(at: 120)
        #expect(out.report == WaitReport(waitedMs: 120, settled: false, busy: false, reason: .cancelled))
    }

    @Test func anAppThatQuitEndsItQuietAtOnce() {
        let rule = WaitRule(options: ComputerDefaults.Wait.action, signature0: 0, thin: false, pixels: false)
        #expect(rule.appGone(at: 40).report.reason == .quiet)
    }

    /// §22.6: a close the app answered by quitting, or a window that left, changed something
    /// though no notification or pixel came; a quiet step is still none.
    @Test func anAppThatQuitOrAWindowThatClosedIsAChange() {
        let rule = WaitRule(options: ComputerDefaults.Wait.action, signature0: 0, thin: false, pixels: false)
        #expect(rule.appGone(at: 40).effect(thin: false) == .changed)
        #expect(rule.appGone(at: 40).effect(thin: true) == .changed)
        let quiet = run()
        #expect(quiet.effect(thin: false, windowGone: true) == .changed)
        #expect(quiet.effect(thin: true, windowGone: true) == .changed)
        #expect(quiet.effect(thin: false, windowGone: false) == .none)
    }

    @Test func skippedIsZeroAndSettled() {
        #expect(WaitRule.skipped().report == WaitReport(waitedMs: 0, settled: true, busy: false, reason: .skipped))
    }

    @Test func theWaitActionRunsTheRuleWithItsOwnCap() {
        let options = ComputerDefaults.Wait.waitAction(seconds: 2)
        #expect(run(options).report.waitedMs == 450)
        let busy = run(options, busy: [(0, true)])
        #expect(busy.report == WaitReport(waitedMs: 2_000, settled: false, busy: true, reason: .busyMax))
        let moving = run(options, ax: Array(stride(from: 50, through: 9_000, by: 200)))
        #expect(moving.report.waitedMs == 2_000)
    }

    @Test func itAsksForTheNextSampleNoLaterThanTheQuietDeadline() {
        var rule = WaitRule(options: ComputerDefaults.Wait.action, signature0: 0, thin: false, pixels: false)
        #expect(rule.take(WaitSample(at: 0)) == .sampleAgain(atOrBefore: 750))
        #expect(rule.take(WaitSample(at: 400, axLastChange: 400)) == .sampleAgain(atOrBefore: 850))
    }

    @Test func aDoneRuleStaysDone() {
        var rule = WaitRule(options: ComputerDefaults.Wait.step, signature0: 0, thin: false, pixels: false)
        guard case .done(let first) = rule.take(WaitSample(at: 150)) else { Issue.record("ends at quiet"); return }
        #expect(rule.take(WaitSample(at: 400, axLastChange: 300)) == .done(first))
    }
}

/// §27.2: every wait says when the window first changed and how far apart its changes came.
@Suite struct WaitChangeTimesTests {
    @Test func aWaitWithNoChangeHasNoTimes() {
        let out = run()
        #expect(out.report.firstChangeMs == nil)
        #expect(out.report.gapCounts == nil)
        #expect(WaitRule.skipped().report.gapCounts == nil)
    }

    @Test func oneChangeHasItsFirstTimeAndNoGap() {
        let out = run(ax: [400])
        #expect(out.report.firstChangeMs == 400)
        #expect(out.report.gapCounts == [Int](repeating: 0, count: 11))
    }

    @Test func manyChangesTwentyFiveMillisecondsApartAllFallInTheFirstBucket() {
        // seventeen notifications 25 ms apart, each seen by its own 25 ms sample: sixteen gaps
        let out = run(ax: Array(stride(from: 100, through: 500, by: 25)))
        #expect(out.report.firstChangeMs == 100)
        var gaps = [Int](repeating: 0, count: 11)
        gaps[0] = 16
        #expect(out.report.gapCounts == gaps)
    }

    @Test func aGapPastTheLastEdgeCountsInTheBucketAbove() {
        let out = run(WaitOptions(minMs: 0, quietMs: 2_000, maxMs: 5_000, busyMaxMs: 5_000), ax: [100, 1_300])
        #expect(out.report.gapCounts?[10] == 1)
        #expect(out.report.gapCounts?.reduce(0, +) == 1)
    }

    @Test func aSignatureAndAPixelCountAsChangesAndABusyIndicatorDoesNot() {
        #expect(run(busy: [(0, true), (300, false)]).report.firstChangeMs == nil)
        let sig = run(signatures: [(500, 7)])
        #expect(sig.report.firstChangeMs == 500)
        let px = run(px: [200, 260])
        #expect(px.report.firstChangeMs == 200)
        #expect(px.report.gapCounts?[2] == 1)
    }

    @Test func theBucketsTakeTheirUpperEdge() {
        #expect(WaitGaps.bucket(0) == 0)
        #expect(WaitGaps.bucket(25) == 0)
        #expect(WaitGaps.bucket(26) == 1)
        #expect(WaitGaps.bucket(1_000) == 9)
        #expect(WaitGaps.bucket(1_001) == 10)
    }
}

/// §24.10: a copy or cut reads the pasteboard; nothing else does.
@Suite struct PasteboardWaitTests {
    private func run(pasteboard: Bool, pb: [Int]) -> WaitOutcome {
        var rule = WaitRule(options: ComputerDefaults.Wait.action, signature0: 0, thin: false, pixels: false, pasteboard: pasteboard)
        var at = 0
        while at <= 10_000 {
            let sample = WaitSample(at: at, signature: at % 100 == 0 ? 0 : nil, pasteboardLastChange: pb.filter { $0 <= at }.max())
            if case .done(let outcome) = rule.take(sample) { return outcome }
            at += 25
        }
        Issue.record("the wait never ended")
        return WaitRule.skipped()
    }

    @Test func aForeignChangeOnACopyIsChangedAndRestartsTheQuietClock() {
        let out = run(pasteboard: true, pb: [600])
        #expect(out.pasteboardChanged)
        #expect(out.effect(thin: false) == .changed)
        #expect(out.report.waitedMs == 600 + ComputerDefaults.Wait.action.quietMs)
        #expect(out.counts.pb == 1)
    }

    @Test func noChangeIsNone() {
        // the service's own write never reaches the sample: SmartWait feeds foreign changes only
        #expect(run(pasteboard: true, pb: []).effect(thin: false) == StepEffect.none)
    }

    @Test func anotherStepIgnoresThePasteboard() {
        let out = run(pasteboard: false, pb: [600])
        #expect(!out.pasteboardChanged)
        #expect(out.effect(thin: false) == StepEffect.none)
        #expect(out.report.waitedMs == 750)
    }

    @Test func onlyCopyAndCutReadIt() {
        #expect(WaitRule.readsPasteboard(ComputerAction(action: .key, text: "super+c")))
        #expect(WaitRule.readsPasteboard(ComputerAction(action: .key, text: "cmd+X")))
        #expect(!WaitRule.readsPasteboard(ComputerAction(action: .key, text: "super+a")))
        #expect(!WaitRule.readsPasteboard(ComputerAction(action: .key, text: "super+shift+c")))
        #expect(!WaitRule.readsPasteboard(ComputerAction(action: .key, text: "ctrl+c")))
        #expect(!WaitRule.readsPasteboard(ComputerAction(action: .scroll, scroll_direction: .down)))
    }
}

/// §27.3 and §27.5: the wait after each step by its route, and the window a step opened.
@Suite struct WaitRowsTests {
    let rows = WaitRows(
        stepWait: WaitOptions(minMs: 0, quietMs: 150, maxMs: 1_000, busyMaxMs: 2_000), wait: nil,
        axStepWait: WaitOptions(minMs: 0, quietMs: 80, maxMs: 1_000, busyMaxMs: 2_000), axWait: WaitOptions(minMs: 100, quietMs: 200, maxMs: 1_500, busyMaxMs: 5_000)
    )

    @Test func betweenStepsTheStepsOwnRouteDecides() {
        #expect(rows.between(tier: .ax).quietMs == 80)
        #expect(rows.between(tier: .process).quietMs == 150)
        #expect(rows.between(tier: nil).quietMs == 150)
    }

    @Test func afterTheLastEveryInputStepMustHaveGoneInAtAX() {
        #expect(rows.last(tiers: [.ax, nil, .ax]).quietMs == 200)
        #expect(rows.last(tiers: [.ax, .session]) == ComputerDefaults.Wait.action)
        #expect(rows.last(tiers: [nil]) == ComputerDefaults.Wait.action)
    }

    @Test func theRowsShipEqualToTheOldOnes() {
        let shipped = WaitRows(stepWait: nil, wait: nil, axStepWait: nil, axWait: nil)
        #expect(shipped.axStep == shipped.step && shipped.axAction == shipped.action)
    }

    @Test func aStepOpensTheFocusedWindowOnlyWhenItIsNew() {
        #expect(WindowFollow.opened(before: [301], focusedAfter: 302) == 302)
        #expect(WindowFollow.opened(before: [301, 302], focusedAfter: 302) == nil)
        #expect(WindowFollow.opened(before: [301], focusedAfter: nil) == nil)
    }
}
