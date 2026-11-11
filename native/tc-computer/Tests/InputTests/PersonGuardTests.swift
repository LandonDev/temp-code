import ComputerProtocol
import Foundation
import Testing
#if canImport(InputPure)
@testable import InputPure
#else
@testable import Input
#endif

// The person guard's pure rules (docs/computer-protocol.md §14.9). Foundation only: the box
// runs this file from scripts/computer-text-test.sh, the Mac in InputTests. No test makes a tap.

private func key(_ code: UInt16, down: Bool = true, flags: UInt64 = 0, repeats: Bool = false, at: UInt64 = 0, mark: Int64 = 0) -> GuardedEvent {
    GuardedEvent(type: down ? .keyDown : .keyUp, mark: mark, keyCode: code, flags: flags, autorepeat: repeats, timestamp: at)
}

private func flags(_ code: UInt16, _ flags: UInt64, at: UInt64 = 0) -> GuardedEvent {
    GuardedEvent(type: .flagsChanged, keyCode: code, flags: flags, timestamp: at)
}

/// A letter typed: down then up, timestamps from `at`.
private func typed(_ code: UInt16, at: UInt64) -> [GuardedEvent] {
    [key(code, at: at), key(code, down: false, at: at + 1)]
}

private let a: UInt16 = 0, b: UInt16 = 11, c: UInt16 = 8, d: UInt16 = 2
private let shiftL: UInt16 = 56, optionL: UInt16 = 58, capsLock: UInt16 = 57, commandL: UInt16 = 55
private let ok = ReplayContext(tripped: true, personIdleMs: 1_000, frontmost: .restored, sameElement: true)

@Suite struct PersonGuardTests {
    @Test func markedEventsPassWhateverTheirType() {
        var rule = PersonGuardRule()
        for t in GuardedEventType.allCases {
            do { let got = rule.decide(GuardedEvent(type: t, mark: TC_EVENT_MARK, keyCode: 56, flags: GuardFlags.shift)); #expect(got == .pass, "\(t)") }
        }
        #expect(rule.dropped == 0)
    }

    @Test func downsModifierPressesButtonsAndTheWheelDropAndTrip() {
        var rule = PersonGuardRule()
        do { let got = rule.decide(key(a)); #expect(got == .drop(trip: true, keep: true)) }
        do { let got = rule.decide(flags(shiftL, GuardFlags.shift)); #expect(got == .drop(trip: true, keep: true)) }
        for (t, n) in [(GuardedEventType.leftMouseDown, 0), (.rightMouseDown, 1), (.otherMouseDown, 2)] {
            do { let got = rule.decide(GuardedEvent(type: t, button: n)); #expect(got == .drop(trip: true, keep: true)) }
        }
        do { let got = rule.decide(GuardedEvent(type: .scrollWheel)); #expect(got == .drop(trip: true, keep: true)) }
        #expect(rule.dropped == 6)
    }

    @Test func aKeyHeldBeforeTheGuardKeepsItsUp() {
        var rule = PersonGuardRule()
        do { let got = rule.decide(key(a, repeats: true)); #expect(got == .drop(trip: true, keep: false)) }
        do { let got = rule.decide(key(a, down: false)); #expect(got == .pass) }
        #expect(rule.dropped == 0)
    }

    @Test func aDroppedKeysRepeatsAndUpDrop() {
        var rule = PersonGuardRule()
        _ = rule.decide(key(a))
        do { let got = rule.decide(key(a, repeats: true)); #expect(got == .drop(trip: true, keep: true)) }
        do { let got = rule.decide(key(a, down: false)); #expect(got == .drop(trip: false, keep: true)) }
        // the next up of that key is someone else's
        do { let got = rule.decide(key(a, down: false)); #expect(got == .pass) }
    }

    @Test func anUpOrDragPassesWithNoDroppedDownAndDropsAfterOne() {
        var rule = PersonGuardRule()
        do { let got = rule.decide(GuardedEvent(type: .leftMouseUp)); #expect(got == .pass) }
        do { let got = rule.decide(GuardedEvent(type: .leftMouseDragged)); #expect(got == .pass) }
        _ = rule.decide(GuardedEvent(type: .leftMouseDown))
        do { let got = rule.decide(GuardedEvent(type: .leftMouseDragged)); #expect(got == .drop(trip: false, keep: false)) }
        do { let got = rule.decide(GuardedEvent(type: .rightMouseUp, button: 1)); #expect(got == .pass) }
        do { let got = rule.decide(GuardedEvent(type: .leftMouseUp)); #expect(got == .drop(trip: false, keep: false)) }
        do { let got = rule.decide(GuardedEvent(type: .leftMouseUp)); #expect(got == .pass) }
    }

    @Test func aModifierReleaseFollowsItsPress() {
        var rule = PersonGuardRule()
        do { let got = rule.decide(flags(optionL, 0)); #expect(got == .pass) }
        _ = rule.decide(flags(shiftL, GuardFlags.shift))
        do { let got = rule.decide(flags(shiftL, 0)); #expect(got == .drop(trip: false, keep: true)) }
        // Caps Lock toggles: each change is a press, none waits for a release
        do { let got = rule.decide(flags(capsLock, 0)); #expect(got == .drop(trip: true, keep: true)) }
        do { let got = rule.decide(flags(capsLock, GuardFlags.capsLock)); #expect(got == .drop(trip: true, keep: true)) }
    }

    @Test func afterAResetAnOldDownsUpPasses() {
        var rule = PersonGuardRule()
        _ = rule.decide(key(a))
        _ = rule.decide(GuardedEvent(type: .leftMouseDown))
        rule.reset()
        #expect(rule.dropped == 0)
        do { let got = rule.decide(key(a, down: false)); #expect(got == .pass) }
        do { let got = rule.decide(GuardedEvent(type: .leftMouseUp)); #expect(got == .pass) }
    }

    @Test func droppedCountsNoUps() {
        var rule = PersonGuardRule()
        for e in typed(a, at: 0) + typed(b, at: 10) { _ = rule.decide(e) }
        #expect(rule.dropped == 2)
    }
}

@Suite struct ReplayPlanTests {
    @Test func plainTypingReplaysInOrder() {
        // Shift, a letter, Option, Space, Tab, Delete, an arrow (it carries the Fn flag)
        var events: [GuardedEvent] = [flags(shiftL, GuardFlags.shift)]
        events += typed(a, at: 1)
        events += [flags(shiftL, 0), flags(optionL, GuardFlags.option), flags(optionL, 0)]
        for (i, code) in [UInt16(49), 48, 51].enumerated() { events += typed(code, at: UInt64(5 + i * 2)) }
        events += [key(124, flags: GuardFlags.function, at: 11), key(124, down: false, flags: GuardFlags.function, at: 12)]
        #expect(ReplayPlan.plan(events, cut: nil, context: ok) == Array(events.indices))
    }

    @Test func returnEnterEscapeFKeysAndShortcutsEndThePrefix() {
        for stop in [key(36), key(76), key(53), key(122), key(a, flags: GuardFlags.command), key(a, flags: GuardFlags.control),
                     GuardedEvent(type: .leftMouseDown), GuardedEvent(type: .scrollWheel), flags(commandL, GuardFlags.command)] {
            let events = typed(a, at: 0) + [stop] + typed(b, at: 10)
            #expect(ReplayPlan.plan(events, cut: nil, context: ok) == [0, 1], "\(stop)")
        }
    }

    @Test func theCutEndsThePrefixWhateverOrderItWasWrittenIn() {
        // ab, Escape at 15 (the escape tap took it, so it is not in the buffer), cd
        let events = typed(a, at: 10) + typed(b, at: 12) + typed(c, at: 20) + typed(d, at: 22)
        #expect(ReplayPlan.plan(events, cut: 15, context: ok) == [0, 1, 2, 3])
        // the cut stamped before the buffer saw ab: still only what came before it
        #expect(ReplayPlan.plan(Array(events.prefix(4)), cut: 15, context: ok) == [0, 1, 2, 3])
    }

    @Test func upsOfReplayedDownsGoAfterTheCutAndPastTheCap() {
        // a down before the cut, its up after
        let held = [key(a, at: 10), key(b, at: 20), key(a, down: false, at: 21), key(b, down: false, at: 22)]
        #expect(ReplayPlan.plan(held, cut: 15, context: ok) == [0, 2])
        // 64 downs fill the cap (ups of replayed downs are outside it); the 64th's up comes after the 65th down
        var events: [GuardedEvent] = []
        for i in 0..<63 { events += typed(a, at: UInt64(i * 2)) }
        events += [key(b, at: 200), key(c, at: 201), key(c, down: false, at: 202), key(b, down: false, at: 203)]
        let plan = ReplayPlan.plan(events, cut: nil, context: ok)
        #expect(plan == Array(0...126) + [129])
    }

    @Test func nothingReplaysUnlessEveryConditionHolds() {
        let events = typed(a, at: 0)
        var cases: [ReplayContext] = []
        for f in [RestoreOutcome.nothing, .personMoved, .appGone] { cases.append(ReplayContext(tripped: true, personIdleMs: 1_000, frontmost: f, sameElement: true)) }
        cases.append(ReplayContext(tripped: false, personIdleMs: 1_000, frontmost: .restored, sameElement: true))
        cases.append(ReplayContext(tripped: true, personIdleMs: nil, frontmost: .restored, sameElement: true))
        cases.append(ReplayContext(tripped: true, personIdleMs: 5_000, frontmost: .restored, sameElement: true))
        cases.append(ReplayContext(tripped: true, personIdleMs: 1_000, frontmost: .restored, sameElement: false))
        for c in cases { #expect(ReplayPlan.plan(events, cut: nil, context: c).isEmpty) }
        #expect(ReplayPlan.plan(events, cut: nil, context: ok) == [0, 1])
    }

    @Test func theIdleIsAgedToTheArm() {
        // the call's personIdleMs was 1,000, its first session step armed 6 s later
        let aged = SessionCall(token: 1, personIdleMs: 1_000, startedAt: 10).idle(atArm: 16)
        #expect(aged == 7_000)
        #expect(!ReplayContext(tripped: true, personIdleMs: aged, frontmost: .restored, sameElement: true).allows)
        #expect(SessionCall(token: 1, personIdleMs: nil, startedAt: 10).idle(atArm: 11) == nil)
    }

    @Test func twoCutsKeepTheEarlierAndAClearForgetsThem() {
        let cut = GuardCut()
        cut.note(30)
        cut.note(20)
        cut.note(40)
        #expect(cut.value == 20)
        cut.clear()
        #expect(cut.value == nil)
    }
}

@Suite struct GuardLifeTests {
    @Test func onAtArmAndThroughACallHoweverLong() {
        var life = GuardLife()
        let t = life.callBegan()
        life.armed(now: 0)
        life.stepEnded(now: 1)
        #expect(life.on)
        #expect(!life.expired(now: 500))
        life.callEnded(t, now: 500)
        #expect(!life.expired(now: 509.9))
        #expect(life.expired(now: 510))
    }

    @Test func twoOverlappingCallsKeepItUntilBothEnd() {
        var life = GuardLife()
        let one = life.callBegan(), two = life.callBegan()
        life.armed(now: 0)
        life.callEnded(one, now: 1)
        #expect(!life.expired(now: 20))
        life.callEnded(two, now: 20)
        #expect(!life.expired(now: 29.9))
        #expect(life.expired(now: 30))
    }

    @Test func aTripMarksTheCallsInFlightButNotALaterOne() {
        var life = GuardLife()
        let one = life.callBegan(), two = life.callBegan()
        life.armed(now: 0)
        do { let got = life.tripped(at: 1); #expect(got == [one, two]) }
        let three = life.callBegan()
        #expect(life.isMarked(one) && life.isMarked(two))
        #expect(!life.isMarked(three))
        // the marks outlive the guard
        life.ended()
        #expect(life.isMarked(one))
    }

    @Test func heldInputKeepsItCountedFromTheRelease() {
        var life = GuardLife()
        life.armed(now: 0)
        life.holding(true, now: 1)
        #expect(!life.expired(now: 100))
        life.holding(false, now: 100)
        #expect(!life.expired(now: 109.9))
        #expect(life.expired(now: 110))
    }

    @Test func afterATripItEndsAtTwoSecondsUnlessARestoreBegan() {
        var life = GuardLife()
        let t = life.callBegan()
        life.armed(now: 0)
        _ = life.tripped(at: 5)
        #expect(!life.expired(now: 6.9))
        #expect(life.expired(now: 7))
        life.restoreBegan()
        #expect(!life.expired(now: 60))
        life.ended()
        #expect(!life.on)
        _ = t
    }

    @Test func aRestoreThatFailedLetsTheOtherRulesEndIt() {
        var life = GuardLife()
        life.armed(now: 0)
        _ = life.tripped(at: 1)
        life.restoreBegan()
        life.restoreFailed()
        #expect(life.expired(now: 3))
    }

    @Test func tapRearmOnceForATimeoutAlwaysForUserInput() {
        var rearm = TapRearm()
        do { let got = rearm.disabled(.timeout); #expect(got) }
        do { let got = rearm.disabled(.timeout); #expect(!got) }
        do { let got = rearm.disabled(.userInput); #expect(got) }
        do { let got = rearm.disabled(.userInput); #expect(got) }
        #expect(rearm.rearmed == 3)
        rearm.reset()
        do { let got = rearm.disabled(.timeout); #expect(got) }
    }
}
