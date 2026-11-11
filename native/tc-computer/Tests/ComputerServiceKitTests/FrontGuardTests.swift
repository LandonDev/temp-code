import ComputerProtocol
@testable import ComputerServiceKit
import Testing

/// The person works in their editor (pid 100, window 11); the service opens Steal (pid 200); a third
/// app is pid 300. Times are milliseconds from the call.
private let person: Int32 = 100
private let stealer: Int32 = 200
private let third: Int32 = 300
private let stealPath = "/Applications/Steal.app"
private let steal = WatchedApp(bundleId: "com.example.Steal", path: stealPath, pid: stealer)

private func launch(_ watched: WatchedApp = steal) -> FrontGuard {
    FrontGuard(recorded: FrontRecord(pid: person, window: 11), watched: watched, at: 0)
}

private func activated(_ pid: Int32, at: Double, bundleId: String? = nil, path: String? = nil) -> FrontEvent {
    .activated(pid: pid, bundleId: bundleId, path: path, at: at)
}

/// The watched app takes the front at `at` and the guard puts the person's app back 60 ms later.
private func stealAndRestore(_ g: inout FrontGuard, at: Double) {
    #expect(g.handle(activated(stealer, at: at)) == .restore(person))
    #expect(g.handle(.restoreStarted(at: at + 5)) == .none)
    #expect(g.handle(activated(person, at: at + 60)) == .none)
    #expect(g.handle(.sample(front: person, window: 11, above: false, at: at + 60)) == .none)
}

@Suite struct FrontGuardStealTests {
    @Test func aStealIsUndoneAndReported() {
        var g = launch()
        #expect(g.report == FrontReport(raised: false))
        #expect(g.handle(activated(stealer, at: 1_000)) == .restore(person))
        #expect(g.report.raised)
        #expect(g.handle(.restoreStarted(at: 1_010)) == .none)
        #expect(g.handle(.sample(front: stealer, window: nil, above: false, at: 1_030)) == .none)
        #expect(g.handle(.sample(front: person, window: nil, above: false, at: 1_050)) == .none)
        #expect(g.report == FrontReport(raised: true, restored: .restored, ms: 50))
        #expect(g.outcomes == 1)
        #expect(g.phase == .idle)
        #expect(g.recorded?.pid == person)
    }

    @Test func itsOwnRestoreIsNoSwitchAndNoSteal() {
        var g = launch()
        stealAndRestore(&g, at: 1_000)
        #expect(g.report == FrontReport(raised: true, restored: .restored, ms: 60))
        #expect(g.steals == 1)
        #expect(g.recorded == FrontRecord(pid: person, window: 11), "the restore's own activation leaves the record as it was")
        #expect(g.handle(activated(person, at: 1_200)) == .none)
        #expect(g.outcomes == 1)
    }

    @Test func aRestoreThatDoesNotLandFailsAfterItsBound() {
        var g = launch()
        _ = g.handle(activated(stealer, at: 1_000))
        _ = g.handle(.restoreStarted(at: 1_000))
        #expect(g.handle(.sample(front: stealer, window: nil, above: false, at: 1_380)) == .none)
        #expect(g.report.restored == nil)
        #expect(g.handle(.sample(front: stealer, window: nil, above: false, at: 1_401)) == .none)
        #expect(g.report == FrontReport(raised: true, restored: .failed))
        #expect(g.phase == .idle)
    }

    @Test func theirAppBackIsNotEnoughUntilTheirWindowIsFocused() {
        var g = launch()
        _ = g.handle(activated(stealer, at: 1_000))
        _ = g.handle(.restoreStarted(at: 1_005))
        #expect(g.handle(activated(person, at: 1_040)) == .none)
        #expect(g.report.restored == nil, "the app is back; its window is not seen yet")
        #expect(g.handle(.sample(front: person, window: 11, above: false, at: 1_060)) == .none)
        #expect(g.report == FrontReport(raised: true, restored: .restored, ms: 60))
        #expect(g.phase == .idle)
    }

    @Test func theirAppBackOnAnotherWindowRaisesTheirsOnce() {
        var g = launch()
        _ = g.handle(activated(stealer, at: 1_000))
        _ = g.handle(.restoreStarted(at: 1_005))
        _ = g.handle(activated(person, at: 1_040))
        #expect(g.handle(.sample(front: person, window: 12, above: false, at: 1_060)) == .raiseWindow(pid: person, window: 11))
        #expect(g.handle(.sample(front: person, window: 12, above: false, at: 1_080)) == .none, "raised once")
        #expect(g.handle(.sample(front: person, window: 11, above: false, at: 1_100)) == .none)
        #expect(g.report == FrontReport(raised: true, restored: .restored, ms: 100))
    }

    @Test func aSampleAloneFindsTheirAppOnAnotherWindow() {
        var g = launch()
        _ = g.handle(activated(stealer, at: 1_000))
        _ = g.handle(.restoreStarted(at: 1_005))
        #expect(g.handle(.sample(front: person, window: 12, above: false, at: 1_025)) == .raiseWindow(pid: person, window: 11))
        #expect(g.handle(.sample(front: person, window: 11, above: false, at: 1_045)) == .none)
        #expect(g.report == FrontReport(raised: true, restored: .restored, ms: 45))
    }

    @Test func theirWindowNeverComingBackFailsAfterTheBound() {
        var g = launch()
        _ = g.handle(activated(stealer, at: 1_000))
        _ = g.handle(.restoreStarted(at: 1_000))
        _ = g.handle(activated(person, at: 1_030))
        #expect(g.handle(.sample(front: person, window: 12, above: false, at: 1_050)) == .raiseWindow(pid: person, window: 11))
        #expect(g.handle(.sample(front: person, window: 12, above: false, at: 1_401)) == .none)
        #expect(g.report == FrontReport(raised: true, restored: .failed))
    }

    @Test func anUnreadableFocusOrNoRecordedWindowIsTheAppAlone() {
        var g = launch()
        _ = g.handle(activated(stealer, at: 1_000))
        _ = g.handle(.restoreStarted(at: 1_005))
        #expect(g.handle(.sample(front: person, window: nil, above: false, at: 1_050)) == .none)
        #expect(g.report == FrontReport(raised: true, restored: .restored, ms: 50))
        var bare = FrontGuard(recorded: FrontRecord(pid: person), watched: steal, at: 0)
        _ = bare.handle(activated(stealer, at: 1_000))
        _ = bare.handle(.restoreStarted(at: 1_005))
        _ = bare.handle(activated(person, at: 1_060))
        #expect(bare.report == FrontReport(raised: true, restored: .restored, ms: 60))
    }

    @Test func theThirdStealHidesTheApp() {
        var g = launch()
        stealAndRestore(&g, at: 1_000)
        stealAndRestore(&g, at: 3_000)
        #expect(g.handle(activated(stealer, at: 5_000)) == .hide(stealer))
        #expect(g.report == FrontReport(raised: true, restored: .hidApp))
        #expect(g.isOver)
        #expect(g.handle(activated(stealer, at: 6_000)) == .none, "the watch is over")
    }

    @Test func anAppThatFightsTheRestoreCountsEachTime() {
        var g = launch()
        _ = g.handle(activated(stealer, at: 1_000))
        _ = g.handle(.restoreStarted(at: 1_005))
        #expect(g.handle(activated(stealer, at: 1_050)) == .restore(person))
        #expect(g.steals == 2)
        _ = g.handle(.restoreStarted(at: 1_055))
        #expect(g.handle(activated(stealer, at: 1_100)) == .hide(stealer))
    }

    @Test func aRestoreWaitsForTheLockAndIsTriedAgainAtTheNextTick() {
        var g = launch()
        #expect(g.handle(activated(stealer, at: 1_000)) == .restore(person))
        // the live side could not take session.lock: no restoreStarted, the steal waits
        #expect(g.handle(.paused(.lock, at: 1_001)) == .none)
        #expect(g.handle(.tick(at: 1_100)) == .none, "nothing moves while the lock is held")
        #expect(g.handle(.resumed(.lock, front: nil, at: 1_190)) == .none)
        #expect(g.handle(.tick(at: 1_200)) == .restore(person))
        _ = g.handle(.restoreStarted(at: 1_200))
        _ = g.handle(activated(person, at: 1_230))
        _ = g.handle(.sample(front: person, window: 11, above: false, at: 1_230))
        #expect(g.report == FrontReport(raised: true, restored: .restored, ms: 230))
    }

    @Test func aStealWhileTheRecordedAppIsGoneFails() {
        var g = launch()
        #expect(g.handle(.quit(person)) == .none)
        #expect(g.recorded == nil)
        #expect(g.handle(activated(stealer, at: 1_000)) == .none)
        #expect(g.report == FrontReport(raised: true, restored: .failed))
    }

    @Test func theRecordedAppQuittingMidRestoreFails() {
        var g = launch()
        _ = g.handle(activated(stealer, at: 1_000))
        _ = g.handle(.restoreStarted(at: 1_000))
        _ = g.handle(.quit(person))
        #expect(g.report.restored == .failed)
        #expect(g.phase == .idle)
    }

    @Test func aLaunchIsWatchedByBundleBeforeItsPidIsBound() {
        var g = launch(WatchedApp(bundleId: "com.example.Steal", path: stealPath))
        #expect(g.handle(activated(stealer, at: 400, bundleId: "com.example.Steal")) == .restore(person))
        #expect(g.watched.pid == stealer, "the activation bound it")

        var byPath = launch(WatchedApp(bundleId: nil, path: stealPath))
        #expect(byPath.handle(activated(stealer, at: 400, path: stealPath + "/")) == .restore(person))

        var other = launch(WatchedApp(bundleId: "com.example.Steal", path: stealPath))
        #expect(other.handle(activated(third, at: 400, bundleId: "com.example.Other")) == .follow(third))
        #expect(other.handle(.bound(stealer)) == .none)
        #expect(other.handle(activated(stealer, at: 900)) == .restore(third))
    }

    @Test func aWindowOrderedAboveIsAStealToo() {
        var g = launch()
        #expect(g.handle(.orderedAbove(at: 2_000)) == .raiseFocusedWindow(person))
        _ = g.handle(.restoreStarted(at: 2_010))
        #expect(g.handle(.sample(front: person, window: nil, above: true, at: 2_030)) == .none)
        #expect(g.handle(.sample(front: person, window: nil, above: false, at: 2_050)) == .none)
        #expect(g.report == FrontReport(raised: true, restored: .restored, ms: 50))
    }
}

@Suite struct FrontGuardChoiceTests {
    @Test func aClickOnTheWatchedAppsWindowGivesWay() {
        var g = launch()
        _ = g.handle(.personDown(.init(at: 1_000, pid: stealer, window: 41)))
        #expect(g.handle(activated(stealer, at: 1_080)) == .giveWay)
        #expect(g.report == FrontReport(raised: true, restored: .personChose))
        #expect(g.isOver)
    }

    @Test func aClickOnItsOwnDockItemGivesWay() {
        var g = launch()
        _ = g.handle(.personDown(.init(at: 1_000, dockItem: stealPath)))
        #expect(g.handle(activated(stealer, at: 1_300)) == .giveWay)
    }

    @Test func commandTabGivesWay() {
        var g = launch()
        _ = g.handle(.personKey(at: 1_000, command: true, control: false, tab: true))
        #expect(g.handle(activated(stealer, at: 1_200)) == .giveWay)
    }

    @Test func aChoiceOlderThanHalfASecondIsNone() {
        var g = launch()
        _ = g.handle(.personDown(.init(at: 1_000, pid: stealer, window: 41)))
        #expect(g.handle(activated(stealer, at: 1_501)) == .restore(person))
    }

    @Test func whatIsNoChoiceOfTheApp() {
        let notChoices: [FrontEvent] = [
            .personDown(.init(at: 1_000, dockItem: "/Applications/Other.app")),
            .personDown(.init(at: 1_000, dockItem: nil)),
            .personDown(.init(at: 1_000, pid: person, window: 11)),
            .personKey(at: 1_000, command: false, control: false, tab: false),
            .personKey(at: 1_000, command: false, control: false, tab: true),
            .personKey(at: 1_000, command: true, control: false, tab: false),
            .personKey(at: 1_000, command: false, control: true, tab: true)
        ]
        for event in notChoices {
            var g = launch()
            _ = g.handle(event)
            #expect(g.handle(activated(stealer, at: 1_050)) == .restore(person), "\(event)")
        }
    }

    @Test func aChoiceHeardAfterTheActivationStillWinsWhileTheUndoWaits() {
        var g = launch()
        #expect(g.handle(activated(stealer, at: 1_000)) == .restore(person))
        _ = g.handle(.paused(.lock, at: 1_000))
        #expect(g.handle(.personDown(.init(at: 990, pid: stealer, window: 41))) == .giveWay)
        #expect(g.report == FrontReport(raised: true, restored: .personChose))
        #expect(g.steals == 0)
    }

    @Test func thePersonSwitchingBetweenTheirOwnAppsMovesTheRecord() {
        var g = launch()
        #expect(g.handle(activated(third, at: 500)) == .follow(third))
        #expect(g.recorded == FrontRecord(pid: third))
        #expect(g.handle(activated(stealer, at: 1_000)) == .restore(third))
        _ = g.handle(.restoreStarted(at: 1_000))
        _ = g.handle(activated(third, at: 1_040))
        #expect(g.report.restored == .restored)
        #expect(g.handle(activated(person, at: 2_000)) == .follow(person))
        #expect(g.recorded == FrontRecord(pid: person))
    }

    @Test func aThirdAppMidRestoreEndsItAndBecomesTheRecord() {
        var g = launch()
        _ = g.handle(activated(stealer, at: 1_000))
        _ = g.handle(.restoreStarted(at: 1_005))
        #expect(g.handle(activated(third, at: 1_100)) == .follow(third))
        #expect(g.phase == .idle)
        #expect(g.recorded == FrontRecord(pid: third))
        #expect(g.report == FrontReport(raised: true, restored: .restored, ms: 100))
        #expect(g.handle(.sample(front: third, window: nil, above: false, at: 1_120)) == .none, "the poll is over")
    }
}

@Suite struct FrontGuardWindowRuleTests {
    /// An open into the app that is already front: the person's window 11 in pid 200.
    func onTheFrontApp() -> FrontGuard {
        FrontGuard(recorded: FrontRecord(pid: stealer, window: 11), watched: steal, at: 0)
    }

    @Test func itsOwnActivationIsNoSteal() {
        var g = onTheFrontApp()
        #expect(g.sameApp)
        #expect(g.handle(activated(stealer, at: 500)) == .none)
        #expect(g.steals == 0)
    }

    @Test func aNewWindowTakingTheFocusIsPutBack() {
        var g = onTheFrontApp()
        #expect(g.handle(.focusChanged(pid: stealer, window: 12, recordedOpen: true, at: 800)) == .raiseWindow(pid: stealer, window: 11))
        _ = g.handle(.restoreStarted(at: 805))
        #expect(g.handle(.focusChanged(pid: stealer, window: 11, recordedOpen: true, at: 840)) == .none)
        #expect(g.report == FrontReport(raised: true, restored: .restored, ms: 40))
        #expect(g.recorded == FrontRecord(pid: stealer, window: 11))
    }

    @Test func anotherExistingWindowTakingTheFocusIsPutBackToo() {
        var g = onTheFrontApp()
        #expect(g.handle(.focusChanged(pid: stealer, window: 9, recordedOpen: true, at: 800)) == .raiseWindow(pid: stealer, window: 11))
        _ = g.handle(.restoreStarted(at: 800))
        #expect(g.handle(.sample(front: stealer, window: 11, above: false, at: 820)) == .none)
        #expect(g.report.restored == .restored)
    }

    @Test func itNeverHidesThePersonsOwnApp() {
        var g = onTheFrontApp()
        for at in [1_000.0, 2_000, 3_000, 4_000] {
            #expect(g.handle(.focusChanged(pid: stealer, window: 12, recordedOpen: true, at: at)) == .raiseWindow(pid: stealer, window: 11))
            _ = g.handle(.restoreStarted(at: at))
            _ = g.handle(.focusChanged(pid: stealer, window: 11, recordedOpen: true, at: at + 20))
        }
        #expect(!g.isOver)
        #expect(g.steals == 4)
    }

    @Test func thePersonsOwnMoveIsFollowed() {
        let moves: [FrontEvent] = [
            .personDown(.init(at: 700, pid: stealer, window: 12)),
            .personDown(.init(at: 700, menuBar: true)),
            .personKey(at: 700, command: true, control: false, tab: false), // ⌘-N, ⌘-O
            .personKey(at: 700, command: true, control: false, tab: false), // ⌘-`
            .personKey(at: 700, command: false, control: true, tab: false)
        ]
        for move in moves {
            var g = onTheFrontApp()
            _ = g.handle(move)
            #expect(g.handle(.focusChanged(pid: stealer, window: 12, recordedOpen: true, at: 800)) == .none, "\(move)")
            #expect(g.recorded == FrontRecord(pid: stealer, window: 12))
            #expect(g.steals == 0)
        }
    }

    @Test func plainTypingShiftAndAClickElsewhereAreNoMove() {
        let notMoves: [FrontEvent] = [
            .personKey(at: 700, command: false, control: false, tab: false),
            .personDown(.init(at: 700, pid: stealer, window: 11))
        ]
        for event in notMoves {
            var g = onTheFrontApp()
            _ = g.handle(event)
            #expect(g.handle(.focusChanged(pid: stealer, window: 12, recordedOpen: true, at: 800)) == .raiseWindow(pid: stealer, window: 11), "\(event)")
        }
    }

    @Test func aRecordedWindowThatClosedGivesWayToTheNewOne() {
        var g = onTheFrontApp()
        #expect(g.handle(.focusChanged(pid: stealer, window: 12, recordedOpen: false, at: 800)) == .none)
        #expect(g.recorded == FrontRecord(pid: stealer, window: 12))
    }

    @Test func thePersonLeavingTheAppEndsTheWindowRule() {
        var g = onTheFrontApp()
        #expect(g.handle(activated(person, at: 500)) == .follow(person))
        #expect(!g.sameApp)
        #expect(g.handle(.focusChanged(pid: stealer, window: 12, recordedOpen: true, at: 600)) == .none)
        #expect(g.handle(activated(stealer, at: 700)) == .restore(person))
    }
}

@Suite struct FrontGuardPauseAndEndTests {
    @Test func aStealDuringASessionRequestIsUndoneAtTheNextTickWhenNoStepRanAtSession() {
        var g = launch()
        _ = g.handle(.paused(.request, at: 500))
        #expect(g.handle(activated(stealer, at: 1_000)) == .none, "nothing is restored while paused")
        #expect(g.handle(.tick(at: 1_100)) == .none)
        #expect(g.handle(.resumed(.request, front: nil, at: 1_500)) == .none)
        #expect(g.recorded == FrontRecord(pid: person, window: 11), "the record was kept")
        #expect(g.handle(.tick(at: 1_600)) == .restore(person))
        _ = g.handle(.restoreStarted(at: 1_600))
        _ = g.handle(activated(person, at: 1_650))
        _ = g.handle(.sample(front: person, window: 11, above: false, at: 1_650))
        #expect(g.report == FrontReport(raised: true, restored: .restored, ms: 650))
    }

    @Test func thePauseRecordsNothing() {
        var g = launch()
        _ = g.handle(.paused(.request, at: 500))
        #expect(g.handle(activated(third, at: 600)) == .none)
        #expect(g.recorded == FrontRecord(pid: person, window: 11))
        _ = g.handle(activated(stealer, at: 700))
        _ = g.handle(activated(third, at: 800))
        _ = g.handle(.resumed(.request, front: nil, at: 900))
        #expect(g.handle(.tick(at: 1_000)) == .none, "the stealer is no longer in front: nothing to undo")
        #expect(g.steals == 0)
    }

    @Test func afterASessionStepTheFrontIsReadAgain() {
        var g = launch()
        _ = g.handle(.paused(.request, at: 500))
        _ = g.handle(activated(stealer, at: 600))
        #expect(g.handle(.resumed(.request, front: FrontRecord(pid: third, window: 5), at: 3_000)) == .none)
        #expect(g.recorded == FrontRecord(pid: third, window: 5))
        #expect(g.handle(.tick(at: 3_100)) == .none, "the step's own front change is no steal")
        #expect(g.handle(activated(stealer, at: 4_000)) == .restore(third))
    }

    @Test func bothPausesMustLift() {
        var g = launch()
        _ = g.handle(.paused(.request, at: 500))
        _ = g.handle(.paused(.lock, at: 510))
        _ = g.handle(activated(stealer, at: 600))
        _ = g.handle(.resumed(.request, front: nil, at: 700))
        #expect(g.isPaused)
        #expect(g.handle(.tick(at: 800)) == .none)
        _ = g.handle(.resumed(.lock, front: nil, at: 900))
        #expect(g.handle(.tick(at: 1_000)) == .restore(person))
    }

    @Test func focusChangesWhilePausedAreNeitherRecordedNorUndone() {
        var g = FrontGuard(recorded: FrontRecord(pid: stealer, window: 11), watched: steal, at: 0)
        _ = g.handle(.paused(.request, at: 100))
        #expect(g.handle(.focusChanged(pid: stealer, window: 12, recordedOpen: true, at: 200)) == .none)
        #expect(g.recorded == FrontRecord(pid: stealer, window: 11))
    }

    @Test func theWatchEndsAtItsTime() {
        var g = launch()
        #expect(g.handle(.tick(at: 29_900)) == .none)
        #expect(g.handle(.tick(at: Double(ComputerDefaults.Service.frontWatchMs))) == .end)
        #expect(g.isOver)
        #expect(g.report == FrontReport(raised: false))
    }

    @Test func anActionsWatchEndsASecondAfterItsClosingWait() {
        var g = launch()
        _ = g.handle(.endBy(2_400))
        #expect(g.handle(.tick(at: 2_300)) == .none)
        #expect(g.handle(.tick(at: 2_400)) == .end)
    }

    @Test func aRestoreInFlightFinishesBeforeTheEnd() {
        var g = launch()
        _ = g.handle(.endBy(1_000))
        _ = g.handle(activated(stealer, at: 950))
        _ = g.handle(.restoreStarted(at: 960))
        #expect(g.handle(.tick(at: 1_000)) == .none)
        _ = g.handle(activated(person, at: 1_010))
        _ = g.handle(.sample(front: person, window: 11, above: false, at: 1_010))
        #expect(g.handle(.tick(at: 1_100)) == .end)
        #expect(g.report.restored == .restored)
    }

    @Test func aStealStillWaitingAtTheEndFails() {
        var g = launch()
        _ = g.handle(.endBy(1_000))
        _ = g.handle(activated(stealer, at: 950))
        _ = g.handle(.paused(.lock, at: 950))
        #expect(g.handle(.tick(at: 1_000)) == .end)
        #expect(g.report == FrontReport(raised: true, restored: .failed))
    }

    @Test func theWatchedAppQuittingEndsIt() {
        var g = launch()
        #expect(g.handle(.quit(stealer)) == .end)
        #expect(g.isOver)
        #expect(g.handle(.tick(at: 100)) == .none)
    }
}

@Suite struct SessionPauseTests {
    let change = SessionChange(frontmost: .init(), pointer: .init(before: [0, 0], after: [0, 0]), restorable: true)

    @Test func noStepAtSessionLiftsAtTheAnswerKeepingTheRecord() {
        var p = SessionPause()
        let r1 = p.begin()
        #expect(r1)
        #expect(p.on)
        let r2 = p.answered(sessionStep: false, at: 100)
        #expect(r2 == .keep)
        #expect(!p.on)
    }

    @Test func aSessionStepHoldsUntilTheRestoreAnswers() {
        var p = SessionPause()
        _ = p.begin()
        let r3 = p.answered(sessionStep: true, at: 100)
        #expect(r3 == nil)
        #expect(p.on)
        let r4 = p.tick(at: 4_000)
        #expect(r4 == nil)
        let r5 = p.restoreAnswered()
        #expect(r5 == .reread)
        #expect(!p.on)
        let r6 = p.restoreAnswered()
        #expect(r6 == nil)
    }

    @Test func orFiveSecondsWhenNoRestoreComes() {
        var p = SessionPause()
        _ = p.begin()
        _ = p.answered(sessionStep: true, at: 100)
        let r7 = p.tick(at: 5_099)
        #expect(r7 == nil)
        let r8 = p.tick(at: 5_100)
        #expect(r8 == .reread)
        #expect(!p.on)
    }

    @Test func overlappingRequestsHoldItUntilTheLast() {
        var p = SessionPause()
        let r9 = p.begin()
        #expect(r9)
        let r10 = p.begin()
        #expect(!r10)
        let r11 = p.answered(sessionStep: true, at: 100)
        #expect(r11 == nil)
        let r12 = p.restoreAnswered()
        #expect(r12 == nil, "the second request is still out")
        let r13 = p.answered(sessionStep: false, at: 200)
        #expect(r13 == .reread, "a step of the first moved the front")
    }

    @Test func whichStepsRanAtSession() {
        let ok = OkStep(index: 0, action: .leftClick, tier: .session, effect: .changed, session: change)
        let plain = OkStep(index: 0, action: .leftClick, tier: .ax, effect: .changed)
        let failedWith = FailedStep(index: 0, action: .leftClick, error: ComputerError(kind: .interrupted, message: "the person", session: change))
        let failedWithout = FailedStep(index: 0, action: .leftClick, error: ComputerError(kind: .timeout, message: "slow"))
        #expect(SessionPause.ranAtSession([.ok(ok)]))
        #expect(SessionPause.ranAtSession([.ok(plain), .failed(failedWith)]), "a failed session step carrying a SessionChange")
        #expect(!SessionPause.ranAtSession([.ok(plain), .failed(failedWithout), .notRun(NotRunStep(index: 2, action: .type))]))
    }
}

@Suite struct FrontGuardTraceTests {
    @Test func aStealAndItsSettleAreTracedAndQuietTicksAreNot() {
        var g = launch()
        let steal = activated(stealer, at: 1_000)
        let decision = g.handle(steal)
        let line = FrontGuard.traceLine(1, steal, decision, g, settled: false)
        #expect(line?.hasPrefix("front 1: activated(pid: 200") == true)
        #expect(line?.contains("→ restore(100)") == true)
        #expect(line?.contains("recorded 100/11") == true)
        #expect(FrontGuard.traceLine(1, .tick(at: 1_100), .none, g, settled: false) == nil)
        #expect(FrontGuard.traceLine(1, .sample(front: stealer, window: nil, above: false, at: 1_120), .none, g, settled: false) == nil)
        _ = g.handle(.restoreStarted(at: 1_010))
        let late = FrontEvent.tick(at: 1_500)
        let outcomes = g.outcomes
        let d = g.handle(late)
        #expect(g.outcomes == outcomes + 1)
        #expect(FrontGuard.traceLine(1, late, d, g, settled: true)?.hasSuffix("settled failed") == true)
    }
}
