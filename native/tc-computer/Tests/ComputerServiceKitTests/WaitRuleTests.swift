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
        #expect(out.report == WaitReport(waitedMs: 1_500, settled: false, busy: false, reason: .max))
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
