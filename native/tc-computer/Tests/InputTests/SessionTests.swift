import ComputerCore
import ComputerProtocol
import Foundation
import Testing
@testable import Input

private let terminal = AppBrief(pid: 1, bundleId: "com.apple.Terminal", name: "Terminal")
private let textEdit = AppBrief(pid: 7, bundleId: "com.apple.TextEdit", name: "TextEdit")

@Suite struct SessionLedgerTests {
    /// A ledger after one step that brought TextEdit forward and moved the pointer.
    private func afterOneStep(endedAt: Double = 10) -> SessionLedger {
        var l = SessionLedger()
        l.stepBegan(frontmost: terminal, pointer: pt(100, 100), now: 5, secondsSinceInput: 999)
        l.stepEnded(frontmost: textEdit, pointer: pt(400, 300), now: endedAt, interrupted: false)
        return l
    }

    @Test func keepsTheFirstRecordAcrossSteps() {
        var l = afterOneStep()
        l.stepBegan(frontmost: textEdit, pointer: pt(400, 300), now: 11, secondsSinceInput: 999)
        l.stepEnded(frontmost: textEdit, pointer: pt(500, 500), now: 12, interrupted: false)
        #expect(l.record?.firstFrontmost == terminal)
        #expect(l.record?.firstPointer == pt(100, 100))
        #expect(l.record?.lastPointer == pt(500, 500))
    }

    @Test func restoresBothHalvesWhenNothingMoved() {
        let plan = afterOneStep().plan(now: 20, secondsSinceInput: 15, frontmost: textEdit, pointer: pt(400, 300), isRunning: { _ in true })
        #expect(plan == RestorePlan(frontmost: .restored, pointer: .restored, activate: terminal, movePointer: pt(100, 100)))
    }

    @Test func thePersonTypingOrMovingSinceGivesBothHalvesBack() {
        let plan = afterOneStep().plan(now: 20, secondsSinceInput: 3, frontmost: textEdit, pointer: pt(400, 300), isRunning: { _ in true })
        #expect(plan.frontmost == .personMoved)
        #expect(plan.pointer == .personMoved)
        var tripped = afterOneStep()
        tripped.stepBegan(frontmost: textEdit, pointer: pt(400, 300), now: 11, secondsSinceInput: 999)
        tripped.stepEnded(frontmost: textEdit, pointer: pt(400, 300), now: 12, interrupted: true)
        let p2 = tripped.plan(now: 20, secondsSinceInput: 99, frontmost: textEdit, pointer: pt(400, 300), isRunning: { _ in true })
        #expect(p2.frontmost == .personMoved && p2.pointer == .personMoved)
    }

    @Test func eachHalfGivesWayOnItsOwn() {
        // the person brought another app forward
        let a = afterOneStep().plan(now: 20, secondsSinceInput: 15, frontmost: AppBrief(pid: 9, bundleId: nil, name: "Mail"), pointer: pt(400, 300), isRunning: { _ in true })
        #expect(a.frontmost == .personMoved && a.pointer == .restored)
        // a foreign activation came and went: same endpoint, still the person's
        var b = afterOneStep()
        b.activation(pid: 9)
        let pb = b.plan(now: 20, secondsSinceInput: 15, frontmost: textEdit, pointer: pt(400, 300), isRunning: { _ in true })
        #expect(pb.frontmost == .personMoved && pb.pointer == .restored)
        // the pointer moved more than 2 pt
        let c = afterOneStep().plan(now: 20, secondsSinceInput: 15, frontmost: textEdit, pointer: pt(403, 300), isRunning: { _ in true })
        #expect(c.frontmost == .restored && c.pointer == .personMoved)
        let d = afterOneStep().plan(now: 20, secondsSinceInput: 15, frontmost: textEdit, pointer: pt(401, 301), isRunning: { _ in true })
        #expect(d.pointer == .restored)
    }

    @Test func anAppThatQuitIsGoneAndNoRecordIsNothing() {
        let plan = afterOneStep().plan(now: 20, secondsSinceInput: 15, frontmost: textEdit, pointer: pt(400, 300), isRunning: { $0 != 1 })
        #expect(plan.frontmost == .appGone)
        #expect(SessionLedger().plan(now: 1, secondsSinceInput: 1, frontmost: nil, pointer: pt(0, 0), isRunning: { _ in true }) == RestorePlan(frontmost: .nothing, pointer: .nothing))
    }

    @Test func inputBetweenTwoStepsIsThePersons() {
        var l = afterOneStep(endedAt: 10)
        l.stepBegan(frontmost: textEdit, pointer: pt(400, 300), now: 20, secondsSinceInput: 2)
        l.stepEnded(frontmost: textEdit, pointer: pt(400, 300), now: 21, interrupted: false)
        #expect(l.record?.personSeen == true)
        #expect(l.plan(now: 30, secondsSinceInput: 99, frontmost: textEdit, pointer: pt(400, 300), isRunning: { _ in true }).frontmost == .personMoved)
    }

    @Test func theLateWordOfInputsOwnActivationIsNotThePersons() {
        // NSWorkspace says TextEdit came forward once the step that brought it has returned
        var l = afterOneStep()
        l.activation(pid: 7)
        #expect(l.record?.foreignActivations == 0)
        let plan = l.plan(now: 20, secondsSinceInput: 15, frontmost: textEdit, pointer: pt(400, 300), isRunning: { _ in true })
        #expect(plan.frontmost == .restored)
        l.activation(pid: nil)
        #expect(l.record?.foreignActivations == 1)
    }

    @Test func activationsDuringAStepAreInputsOwn() {
        var l = SessionLedger()
        l.stepBegan(frontmost: terminal, pointer: pt(0, 0), now: 1, secondsSinceInput: 99)
        l.activation(pid: 9)
        l.stepEnded(frontmost: textEdit, pointer: pt(0, 0), now: 2, interrupted: false)
        #expect(l.record?.foreignActivations == 0)
    }
}

@Suite struct SessionDriverTests {
    @Test func runsTheStepsInOrderAndSaysWhatChanged() throws {
        let rig = Rig()
        let (_, change, _) = try rig.step(.session) { ctx in
            rig.host.log.append("body")
            try rig.core.click(&ctx, .left, count: 1, at: pt(400, 300), modifiers: [], duration: nil)
            rig.host.pointerAt = pt(400, 300)
        }
        #expect(rig.host.log == ["bringForward 7", "raise 70", "body"])
        #expect(change?.frontmost.before == terminal)
        #expect(change?.frontmost.after == textEdit)
        #expect(change?.pointer.before == [100, 100])
        #expect(change?.pointer.after == [400, 300])
        #expect(change?.restorable == true)
        #expect(rig.sink.posted.allSatisfy { $0.1 == .hid })
        #expect(rig.sink.events.first == .move(pt(400, 300), dragging: nil))
        #expect(!rig.lock.isTaken)
        // the person guard outlives the step: it ends with the restore after it (§14.9.2)
        #expect(rig.watch.armed)
    }

    @Test func refusesALockedScreenAndSecureInputBeforeAnythingChanges() {
        let rig = Rig()
        rig.host.locked = true
        #expect(throws: ComputerFailure.self) { try rig.step(.session) { _ in } }
        rig.host.locked = false
        rig.host.secure = true
        do { _ = try rig.step(.session, keys: true) { _ in }; Issue.record("secure input passed") } catch {
            #expect((error as? ComputerFailure)?.error.reason == .secureInput)
        }
        // secure input refuses keys only
        #expect(throws: Never.self) { try rig.step(.session, keys: false) { _ in } }
        #expect(rig.host.log.first == "bringForward 7")
    }

    @Test func aRefusedActivationFailsWithItsChange() {
        let rig = Rig()
        rig.host.refuseActivation = true
        do { _ = try rig.step(.session) { _ in }; Issue.record("activation passed") } catch {
            let e = (error as? ComputerFailure)?.error
            #expect(e?.kind == .sessionUnavailable)
            #expect(e?.reason == .activationRefused)
            #expect(e?.session?.frontmost.before == terminal)
        }
        #expect(!rig.lock.isTaken)
        #expect(rig.core.driver.record?.lastFrontmost == terminal)
    }

    @Test func anotherHolderKeepsTheLockForFiveSeconds() {
        let rig = Rig()
        rig.lock.heldElsewhere = true
        let t0 = rig.clock.seconds()
        do { _ = try rig.step(.session) { _ in }; Issue.record("took a held lock") } catch {
            #expect((error as? ComputerFailure)?.error.reason == .inUse)
        }
        #expect(rig.clock.seconds() - t0 >= InputTiming.sessionLockWaitS)
        #expect(rig.host.log.isEmpty)
    }

    @Test func aThrownStepStillWritesTheLastLeftStateAndCarriesItsChange() {
        let rig = Rig()
        do {
            _ = try rig.step(.session) { _ in
                rig.host.pointerAt = pt(222, 333)
                throw ComputerFailure(.timeout, "slow")
            }
        } catch {
            #expect((error as? ComputerFailure)?.error.session?.pointer.after == [222, 333])
        }
        #expect(rig.core.driver.record?.lastPointer == pt(222, 333))
    }

    @Test func restorePutsBackAndClears() throws {
        let rig = Rig()
        _ = try rig.step(.session) { _ in rig.host.pointerAt = pt(400, 300) }
        rig.clock.advance(5)
        let r = try rig.core.restoreSession()
        #expect(r.frontmost == .restored && r.pointer == .restored && r.held == terminal)
        #expect(rig.host.front == terminal)
        #expect(rig.host.pointerAt == pt(100, 100))
        #expect(rig.core.driver.record == nil)
        #expect(try rig.core.restoreSession() == SessionRestore(frontmost: .nothing, pointer: .nothing, held: nil))
    }

    @Test func aPutBackThatMissesIsTriedOnceMoreAndOnlyThenTold() throws {
        // the person's app ignored the first activation (active 9's put-back left the scratch app in front, 2026-11-11)
        let rig = Rig()
        _ = try rig.step(.session) { _ in rig.host.pointerAt = pt(400, 300) }
        rig.clock.advance(5)
        rig.host.activationMisses = 1
        let r = try rig.core.restoreSession()
        #expect(r.frontmost == .restored && r.held == terminal)
        #expect(rig.host.front == terminal)
        #expect(rig.host.log.filter { $0 == "activate 1" }.count == 2)

        let twice = Rig()
        _ = try twice.step(.session) { _ in twice.host.pointerAt = pt(400, 300) }
        twice.clock.advance(5)
        twice.host.activationMisses = 2
        // two misses: the restore says the app is not back, rather than claiming it
        #expect(try twice.core.restoreSession().frontmost == .appGone)
    }

    @Test func restoreReleasesItsOwnHoldBeforeTakingTheLock() throws {
        let rig = Rig()
        _ = try rig.step(.session) { ctx in try rig.core.mouseDown(&ctx, at: pt(400, 300)) }
        #expect(rig.lock.isTaken)
        rig.clock.advance(1)
        rig.host.pointerAt = pt(400, 300)
        let r = try rig.core.restoreSession()
        #expect(r.frontmost == .restored)
        #expect(rig.sink.events.last == .up(.left, pt(400, 300), clickState: 1, flags: []))
        #expect(!rig.lock.isTaken)
    }

    @Test func restoreGivesUpWhenAnotherHolderKeepsTheLock() throws {
        let rig = Rig()
        _ = try rig.step(.session) { _ in }
        rig.lock.heldElsewhere = true
        #expect(throws: ComputerFailure.self) { try rig.core.restoreSession() }
    }
}

/// §22.5: `perform raise` takes a window out of the Dock first, in the same session step, and brings nothing forward.
@Suite struct RaiseTests {
    @Test func aMinimizedWindowComesOutOfTheDockBeforeItsRaise() throws {
        let rig = Rig()
        rig.host.minimizedWindows = [71]
        let change = try rig.core.raiseWindow(pid: 7, windowID: 70, window: 70, element: 71, cancelled: { false }) { rig.host.log.append("AXRaise 71") }
        #expect(rig.host.log == ["unminimize 71", "AXRaise 71"])
        #expect(rig.host.minimizedWindows.isEmpty)
        #expect(change != nil)
        #expect(!rig.lock.isTaken)
    }

    @Test func aWindowOnScreenIsOnlyRaised() throws {
        let rig = Rig()
        _ = try rig.core.raiseWindow(pid: 7, windowID: 70, window: 70, element: 71, cancelled: { false }) { rig.host.log.append("AXRaise 71") }
        #expect(rig.host.log == ["AXRaise 71"])
    }
}

@Suite struct HeldTests {
    @Test func downThenUp() throws {
        let rig = Rig()
        _ = try rig.step(.process) { ctx in try rig.core.mouseDown(&ctx, at: pt(5, 5)) }
        #expect(rig.core.held.heldTier(pid: 7) == .process)
        _ = try rig.step(.process) { ctx in try rig.core.mouseUp(&ctx, at: nil) }
        #expect(rig.core.held.hold(pid: 7) == nil)
        #expect(rig.sink.events == [.down(.left, pt(5, 5), clickState: 1, flags: []), .up(.left, pt(5, 5), clickState: 1, flags: [])])
        #expect(rig.sink.posted.allSatisfy { $0.1 == .pid(7, windowID: 70) })
        #expect(rig.heldEvents.count == 2)
    }

    @Test func autoReleasesAfterThirtySeconds() throws {
        let rig = Rig()
        _ = try rig.step(.process) { ctx in try rig.core.mouseDown(&ctx, at: pt(5, 5)) }
        rig.clock.advance(29)
        #expect(rig.core.held.sweep().isEmpty)
        rig.clock.advance(1)
        #expect(rig.core.held.sweep() == [7])
        #expect(rig.sink.events.last == .up(.left, pt(5, 5), clickState: 1, flags: []))
        #expect(rig.heldEvents.last == .released(pid: 7, kind: .button))
    }

    @Test func releaseAllPostsTheUpAtWhereTheButtonMoved() throws {
        let rig = Rig()
        _ = try rig.step(.process) { ctx in
            try rig.core.mouseDown(&ctx, at: pt(5, 5))
            try rig.core.move(&ctx, to: pt(50, 60))
        }
        #expect(rig.sink.events.last == .move(pt(50, 60), dragging: .left))
        rig.core.releaseHeld(pid: 7)
        #expect(rig.sink.events.last == .up(.left, pt(50, 60), clickState: 1, flags: []))
    }

    @Test func aSecondDownWhileHeldIsRefused() throws {
        let rig = Rig()
        _ = try rig.step(.process) { ctx in try rig.core.mouseDown(&ctx, at: pt(5, 5)) }
        #expect(throws: ComputerFailure.self) { try rig.step(.process) { ctx in try rig.core.mouseDown(&ctx, at: pt(9, 9)) } }
        #expect(rig.sink.events.count == 1)
    }

    @Test func tellsTheLedgerAroundEveryLongDownAndNeverAPlainPair() throws {
        let rig = Rig()
        _ = try rig.step(.process) { ctx in try rig.core.click(&ctx, .left, count: 1, at: pt(1, 1), modifiers: [], duration: nil) }
        _ = try rig.step(.process) { ctx in try rig.core.key(&ctx, parseKeyCombo("ctrl+s"), repeat: 1) }
        #expect(rig.heldEvents.isEmpty)
        _ = try rig.step(.process) { ctx in try rig.core.click(&ctx, .left, count: 1, at: pt(1, 1), modifiers: [], duration: 0.5) }
        _ = try rig.step(.process) { ctx in try rig.core.drag(&ctx, from: pt(1, 1), to: pt(9, 9), modifiers: []) }
        _ = try rig.step(.process) { ctx in try rig.core.holdKey(&ctx, parseKeyCombo("shift"), seconds: 0.2) }
        let kinds = rig.heldEvents.map { e -> String in
            switch e {
            case .pressing(let r): "pressing \(r.kind.rawValue)"
            case .released(_, let k): "released \(k.rawValue)"
            }
        }
        #expect(kinds == ["pressing button", "released button", "pressing button", "released button", "pressing key", "released key"])
        if case .pressing(let r) = rig.heldEvents[4] { #expect(r.keyCodes == [56]) }
    }

    @Test func pressingComesBeforeTheDown() throws {
        let rig = Rig()
        let postedAtPressing = Box(-1)
        let sink = rig.sink
        let core = InputCore(host: rig.host, watch: rig.watch, sessionLock: rig.lock, sink: sink, clock: rig.clock, layout: USANSILayout(), onPersonInput: { _, _ in }, onHeld: { e in
            if case .pressing = e { postedAtPressing.value = sink.posted.count }
        })
        _ = try core.step(tier: .process, pid: 7, windowID: 70, window: 70, keys: false, cancelled: { false }) { ctx in try core.mouseDown(&ctx, at: pt(5, 5)) }
        #expect(postedAtPressing.value == 0)
    }

    @Test func releaseStalePostsAProcessRecordsUpsToItsPid() {
        let rig = Rig()
        rig.core.releaseStale(HeldRecord(writer: 1, pid: 42, tier: .process, kind: .key, keyCodes: [59, 0], since: 0)) { _ in }
        #expect(rig.sink.posted.map(\.1) == [.pid(42, windowID: 0), .pid(42, windowID: 0)])
        #expect(rig.sink.events == [.key(0, down: false, flags: []), .modifier(59, down: false, flags: [])])
    }

    @Test func releaseStaleTakesTheSessionLockForASessionRecord() {
        let rig = Rig()
        rig.core.releaseStale(HeldRecord(writer: 1, pid: 42, tier: .session, kind: .button, point: [10, 20], since: 0)) { _ in }
        #expect(rig.lock.acquisitions == 1)
        #expect(rig.sink.posted.first?.1 == .hid)
        rig.lock.heldElsewhere = true
        var logged: [String] = []
        rig.core.releaseStale(HeldRecord(writer: 1, pid: 42, tier: .session, kind: .button, point: [10, 20], since: 0)) { logged.append($0) }
        #expect(logged.count == 1)
    }

    @Test func lastInputAtIsTheLastPostedEvent() throws {
        let rig = Rig()
        let (_, _, last) = try rig.step(.process) { ctx in try rig.core.key(&ctx, parseKeyCombo("a"), repeat: 1) }
        let after = rig.clock.ticks()
        #expect(last != nil && last! < after)
    }

    @Test func aCancelMidHoldLetsTheKeysGo() throws {
        let rig = Rig()
        let calls = Box(0)
        do {
            _ = try rig.core.step(tier: .process, pid: 7, windowID: 70, window: 70, keys: true, cancelled: { calls.value += 1; return calls.value > 4 }) { ctx in
                try rig.core.holdKey(&ctx, parseKeyCombo("ctrl+a"), seconds: 5)
            }
            Issue.record("the hold was not cancelled")
        } catch {
            #expect(kind(error) == .cancelled)
        }
        #expect(rig.sink.events.suffix(2) == [.key(0, down: false, flags: []), .modifier(59, down: false, flags: [])])
        #expect(rig.heldEvents.last == .released(pid: 7, kind: .key))
    }
}

@Suite struct HeldWatchTests {
    @Test func aSessionDownKeepsTheLockAndTheWatch() throws {
        let rig = Rig()
        _ = try rig.step(.session) { ctx in try rig.core.mouseDown(&ctx, at: pt(400, 300)) }
        #expect(rig.lock.isTaken)
        #expect(rig.watch.armed)
        // the up runs under the same lock: no second acquisition, then both go
        _ = try rig.step(.session) { ctx in try rig.core.mouseUp(&ctx, at: nil) }
        #expect(rig.lock.acquisitions == 1)
        #expect(!rig.lock.isTaken)
        // the lock goes with the button; the guard lingers 10 s past the release
        #expect(rig.watch.armed)
        rig.clock.advance(InputTiming.guardLingerS)
        rig.core.driver.sweepGuard()
        #expect(!rig.watch.armed)
    }

    @Test func aTripBetweenCallsReleasesTellsOnceAndFailsTheNextCallOnce() throws {
        let rig = Rig()
        _ = try rig.step(.session) { ctx in try rig.core.mouseDown(&ctx, at: pt(400, 300)) }
        rig.core.personBetweenCalls()
        #expect(rig.sink.events.last == .up(.left, pt(400, 300), clickState: 1, flags: []))
        #expect(!rig.lock.isTaken)
        #expect(rig.personInput == [7])
        #expect(rig.core.driver.record?.personTookOver == true)
        #expect(rig.core.takeInterruption(pid: 7))
        #expect(!rig.core.takeInterruption(pid: 7))
    }

    @Test func aTripDuringTheLockWaitStopsBeforeAnyWrite() {
        let rig = Rig()
        rig.lock.heldElsewhere = true
        let tries = Box(0)
        let core = rig.core, watch = rig.watch
        do {
            _ = try core.step(tier: .session, pid: 7, windowID: 70, window: 70, keys: false, cancelled: {
                tries.value += 1
                if tries.value == 3 { watch.trip() }
                return false
            }) { _ in }
            Issue.record("the step ran")
        } catch {
            #expect(kind(error) == .interrupted)
        }
        #expect(rig.host.log.isEmpty)
    }

    @Test func aTripMidActivationStopsBeforeTheNextWrite() {
        let rig = Rig()
        rig.host.beforeWrite = { w in if w == "raise" { rig.watch.trip() } }
        do { _ = try rig.step(.session) { _ in }; Issue.record("ran") } catch { #expect(kind(error) == .interrupted) }
        #expect(rig.host.log == ["bringForward 7", "raise 70"] || rig.host.log == ["bringForward 7"])
        #expect(rig.core.driver.record?.personTookOver == true)
    }

    @Test func aStepThatThrowsKeepsTheLockAndTheWatchWhileTheButtonIsHeld() {
        let rig = Rig()
        _ = try? rig.step(.session) { ctx in try rig.core.mouseDown(&ctx, at: pt(400, 300)) }
        #expect(throws: ComputerFailure.self) { try rig.step(.session) { _ in throw ComputerFailure(.outOfBounds, "off the window") } }
        #expect(rig.core.held.hold(pid: 7) != nil)
        #expect(rig.lock.isTaken)
        #expect(rig.watch.armed)
    }

    @Test func thePersonMidStepLetsGoOfAnEarlierHeldButton() throws {
        let rig = Rig()
        _ = try rig.step(.session) { ctx in try rig.core.mouseDown(&ctx, at: pt(400, 300)) }
        do {
            _ = try rig.step(.session) { ctx in
                rig.watch.trip()
                try rig.core.move(&ctx, to: pt(410, 310))
            }
            Issue.record("the move ran")
        } catch { #expect(kind(error) == .interrupted) }
        #expect(rig.core.held.hold(pid: 7) == nil)
        #expect(rig.sink.events.last == .up(.left, pt(400, 300), clickState: 1, flags: []))
        #expect(!rig.lock.isTaken)
    }

    @Test func anotherAppsStepWaitsForAHeldSessionButtonAndNeverPosts() throws {
        let rig = Rig()
        _ = try rig.step(.session) { ctx in try rig.core.mouseDown(&ctx, at: pt(400, 300)) }
        let posted = rig.sink.posted.count
        rig.host.apps[9] = AppBrief(pid: 9, bundleId: "com.google.Chrome", name: "Chrome")
        do {
            _ = try rig.core.step(tier: .session, pid: 9, windowID: 90, window: 90, keys: false, cancelled: { false }) { ctx in
                try rig.core.click(&ctx, .left, count: 1, at: pt(1, 1), modifiers: [], duration: nil)
            }
            Issue.record("the other app's step ran")
        } catch {
            #expect((error as? ComputerFailure)?.error.reason == .inUse)
        }
        #expect(rig.sink.posted.count == posted)
        #expect(rig.lock.isTaken)
        #expect(rig.core.held.hold(pid: 7) != nil)
        // the holder's own up still runs under its lock, and then both go
        _ = try rig.step(.session) { ctx in try rig.core.mouseUp(&ctx, at: nil) }
        #expect(rig.lock.acquisitions == 1)
        #expect(!rig.lock.isTaken)
    }

    @Test func restoreAfterTheWatchTrippedSaysThePersonMoved() throws {
        let rig = Rig()
        do {
            _ = try rig.step(.session) { ctx in
                rig.watch.trip()
                try rig.core.key(&ctx, parseKeyCombo("a"), repeat: 1)
            }
        } catch { #expect(kind(error) == .interrupted) }
        let r = try rig.core.restoreSession()
        #expect(r.frontmost == .personMoved)
        #expect(rig.core.driver.record == nil)
    }
}

@Suite struct HeldReleaseTests {
    @Test func aCancelledUpStillPostsTheUp() throws {
        let rig = Rig()
        _ = try rig.step(.process) { ctx in try rig.core.mouseDown(&ctx, at: pt(5, 5)) }
        #expect(throws: ComputerFailure.self) {
            try rig.core.step(tier: .process, pid: 7, windowID: 70, window: 70, keys: false, cancelled: { true }) { ctx in try rig.core.mouseUp(&ctx, at: nil) }
        }
        #expect(rig.sink.events.last == .up(.left, pt(5, 5), clickState: 1, flags: []))
        #expect(rig.core.held.hold(pid: 7) == nil)
        #expect(rig.heldEvents.last == .released(pid: 7, kind: .button))
    }

    @Test func aHeldRightClickWithModifiersIsRecordedWholeAndReleasedWhole() throws {
        let rig = Rig()
        _ = try rig.step(.process) { ctx in try rig.core.click(&ctx, .right, count: 1, at: pt(3, 4), modifiers: .shift, duration: 0.2) }
        guard case .pressing(let r) = rig.heldEvents.first else { Issue.record("no record"); return }
        #expect(r.button == 1)
        #expect(r.keyCodes == [56])
        rig.sink.clear()
        rig.core.releaseStale(r) { _ in }
        #expect(rig.sink.events == [.up(.right, pt(3, 4), clickState: 1, flags: []), .modifier(56, down: false, flags: [])])
    }

    @Test func thePersonDuringAnotherAppsWaitLetsTheHeldButtonGo() throws {
        let rig = Rig()
        _ = try rig.step(.session) { ctx in try rig.core.mouseDown(&ctx, at: pt(400, 300)) }
        rig.host.apps[9] = AppBrief(pid: 9, bundleId: "com.google.Chrome", name: "Chrome")
        let watch = rig.watch
        let tries = Box(0)
        do {
            _ = try rig.core.step(tier: .session, pid: 9, windowID: 90, window: 90, keys: false, cancelled: {
                tries.value += 1
                if tries.value == 2 { watch.trip() }
                return false
            }) { _ in }
            Issue.record("the other app's step ran")
        } catch {
            #expect(kind(error) == .interrupted)
        }
        // the trip between the owner's calls lets its button go, on another queue
        let deadline = Date().addingTimeInterval(2)
        while rig.personInput.isEmpty, Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
        #expect(rig.core.held.hold(pid: 7) == nil)
        #expect(rig.personInput == [7])
        #expect(rig.core.takeInterruption(pid: 7))
    }

    @Test func aTripWhoseReleaseFinishesBeforeTheWaiterWakesStillStopsTheWaiter() throws {
        let rig = Rig()
        _ = try rig.step(.session) { ctx in try rig.core.mouseDown(&ctx, at: pt(400, 300)) }
        rig.host.apps[9] = AppBrief(pid: 9, bundleId: "com.google.Chrome", name: "Chrome")
        let watch = rig.watch, core = rig.core
        let tries = Box(0)
        let posted = rig.sink.posted.count
        do {
            _ = try core.step(tier: .session, pid: 9, windowID: 90, window: 90, keys: false, cancelled: {
                tries.value += 1
                if tries.value == 2 {
                    watch.trip()
                    // the release lands on its queue before the waiter looks again
                    let until = Date().addingTimeInterval(2)
                    while core.held.hold(pid: 7) != nil, Date() < until { Thread.sleep(forTimeInterval: 0.005) }
                }
                return false
            }) { ctx in
                try core.click(&ctx, .left, count: 1, at: pt(1, 1), modifiers: [], duration: nil)
            }
            Issue.record("the waiting app's step ran after the person took over")
        } catch {
            #expect(kind(error) == .interrupted)
        }
        // only the owner's up was posted; nothing of the waiting app's
        #expect(rig.sink.posted.count == posted + 1)
        #expect(rig.sink.events.last == .up(.left, pt(400, 300), clickState: 1, flags: []))
        #expect(!rig.host.log.contains("bringForward 9"))
    }

    @Test func aTripJustBeforeTheOwnersNextStepArmsStopsThatStep() throws {
        let rig = Rig()
        _ = try rig.step(.session) { ctx in try rig.core.mouseDown(&ctx, at: pt(400, 300)) }
        let watch = rig.watch, core = rig.core
        let posted = rig.sink.posted.count
        // the person moves after the step began and before it arms: their trip lets the button go and disarms the watch
        watch.onArmedRead = {
            watch.trip()
            let until = Date().addingTimeInterval(2)
            while core.held.hold(pid: 7) != nil, Date() < until { Thread.sleep(forTimeInterval: 0.005) }
        }
        do {
            _ = try rig.step(.session) { ctx in try core.move(&ctx, to: pt(410, 310)) }
            Issue.record("the step moved the pointer after the person took over")
        } catch {
            #expect(kind(error) == .interrupted)
        }
        #expect(rig.sink.posted.count == posted + 1)
        #expect(rig.sink.events.last == .up(.left, pt(400, 300), clickState: 1, flags: []))
    }
}


/// The person guard's life in the driver (§14.9): it outlives the step, ends with the restore or
/// its linger, and a trip anywhere reaches the shell once for every call it is for.
@Suite struct PersonGuardDriverTests {
    private func typed(_ code: UInt16) -> [GuardedEvent] {
        [GuardedEvent(type: .keyDown, keyCode: code), GuardedEvent(type: .keyUp, keyCode: code)]
    }

    @Test func restoreReplaysThenDisarmsAndAnswersTheReport() throws {
        let rig = Rig()
        rig.watch.dropped = typed(0) + typed(11)
        let token = rig.core.driver.callBegan(pid: 7)
        _ = try rig.step(.session, call: SessionCall(token: token, personIdleMs: 800)) { _ in }
        rig.core.driver.callEnded(token)
        // the person types in a batch gap: the guard dropped their keys
        rig.watch.trip()
        rig.waitForPersonInput()
        let r = try rig.core.restoreSession(afterInterrupt: true)
        #expect(r.frontmost == .restored)
        #expect(rig.watch.log == ["arm", "replay", "disarm"])
        #expect(rig.watch.replays == [[0, 1, 2, 3]])
        #expect(r.personGuard == SessionRestore.PersonGuard(mode: .active, dropped: 2, replayed: 2, rearmed: 0))
        // the next restore has no guard to report
        #expect(try rig.core.restoreSession().personGuard == nil)
    }

    @Test func nothingReplaysForAPersonComingBackOrAMovedField() throws {
        for (idle, field) in [(9_000, 11), (800, 12)] {
            let rig = Rig()
            rig.watch.dropped = typed(0)
            let token = rig.core.driver.callBegan(pid: 7)
            _ = try rig.step(.session, call: SessionCall(token: token, personIdleMs: idle)) { _ in }
            rig.watch.trip()
            rig.waitForPersonInput()
            rig.host.focusedElements[1] = field
            let r = try rig.core.restoreSession(afterInterrupt: true)
            #expect(rig.watch.replays.isEmpty)
            #expect(r.personGuard?.replayed == 0)
            #expect(r.personGuard?.dropped == 1)
        }
    }

    @Test func theSweepEndsItTenSecondsAfterTheCallNeverDuringIt() throws {
        let rig = Rig()
        let token = rig.core.driver.callBegan(pid: 7)
        _ = try rig.step(.session, call: SessionCall(token: token)) { _ in }
        rig.clock.advance(100)
        rig.core.driver.sweepGuard()
        #expect(rig.watch.armed)
        rig.core.driver.callEnded(token)
        rig.clock.advance(InputTiming.guardLingerS - 0.1)
        rig.core.driver.sweepGuard()
        #expect(rig.watch.armed)
        rig.clock.advance(0.1)
        rig.core.driver.sweepGuard()
        #expect(!rig.watch.armed)
        // the report waits for the restore that comes after
        #expect(try rig.core.restoreSession().personGuard?.mode == .active)
    }

    @Test func aTripAfterAStepWithNothingHeldTellsOnceAndFailsNothing() throws {
        let rig = Rig()
        let token = rig.core.driver.callBegan(pid: 7)
        _ = try rig.step(.session, call: SessionCall(token: token)) { _ in }
        rig.watch.trip()
        rig.waitForPersonInput()
        Thread.sleep(forTimeInterval: 0.05)
        #expect(rig.personInput == [7])
        #expect(rig.personTokens == [[token]])
        #expect(!rig.core.takeInterruption(pid: 7))
        #expect(rig.core.driver.record?.personTookOver == true)
    }

    @Test func aTripAfterTheBodysLastCheckReachesTheShellOnce() throws {
        let rig = Rig()
        let token = rig.core.driver.callBegan(pid: 7)
        // the person's key lands after the step's last check: the step itself answers ok
        _ = try rig.step(.session, call: SessionCall(token: token)) { _ in rig.watch.trip() }
        rig.waitForPersonInput()
        Thread.sleep(forTimeInterval: 0.05)
        #expect(rig.personInput == [7])
        #expect(rig.personTokens == [[token]])
    }

    @Test func aMarkedCallsLaterStepAnswersInterruptedAndTheNextCallRuns() throws {
        let rig = Rig()
        let first = rig.core.driver.callBegan(pid: 7)
        _ = try rig.step(.session, call: SessionCall(token: first)) { _ in }
        rig.watch.trip()
        rig.waitForPersonInput()
        _ = try rig.core.restoreSession(afterInterrupt: true)
        rig.host.log = []
        do {
            _ = try rig.step(.session, call: SessionCall(token: first)) { _ in }
            Issue.record("the marked call raised the app again")
        } catch {
            #expect(kind(error) == .interrupted)
        }
        #expect(rig.host.log.isEmpty)
        rig.core.driver.callEnded(first)
        let next = rig.core.driver.callBegan(pid: 7)
        _ = try rig.step(.session, call: SessionCall(token: next)) { _ in }
        #expect(rig.host.log.first == "bringForward 7")
    }

    @Test func aTripDuringAStepThatStopsForItLeavesItsOwnReleaseToTheStep() throws {
        let rig = Rig()
        let token = rig.core.driver.callBegan(pid: 7)
        do {
            _ = try rig.step(.session, call: SessionCall(token: token)) { ctx in
                try rig.core.mouseDown(&ctx, at: pt(400, 300))
                rig.watch.trip()
                try ctx.poster.pause(InputTiming.watchSliceMs)
            }
            Issue.record("the step ran on")
        } catch { #expect(kind(error) == .interrupted) }
        rig.waitForPersonInput()
        Thread.sleep(forTimeInterval: 0.05)
        // the step's call is told (the shell's book keeps it to once); the pid's next call is not failed
        #expect(rig.personTokens == [[token]])
        #expect(!rig.core.takeInterruption(pid: 7))
        #expect(rig.core.held.hold(pid: 7) == nil)
    }
}
