import ComputerCore
import ComputerProtocol
import Foundation
import Testing
@testable import Input

// Input's half of the tier-scheduling amendment (plan §6): the restore after the person's touch,
// the session-only release, the step's span, and the paste's own check of a recent copy.

private let terminal = AppBrief(pid: 1, bundleId: "com.apple.Terminal", name: "Terminal")
private let mail = AppBrief(pid: 9, bundleId: "com.apple.mail", name: "Mail")

/// A session step on TextEdit that moved the pointer to (400, 300) and was stopped by the person's key.
private func interruptedStep(_ rig: Rig) {
    do {
        _ = try rig.step(.session) { ctx in
            rig.host.pointerAt = pt(400, 300)
            rig.watch.trip()
            try rig.core.key(&ctx, parseKeyCombo("a"), repeat: 1)
        }
        Issue.record("the step ran past the person's touch")
    } catch {
        #expect(kind(error) == .interrupted)
    }
}

@Suite struct RestoreAfterInterruptTests {
    @Test func withinTwoSecondsItPutsTheFrontAppAndThePointerBackDespiteTheTrip() throws {
        let rig = Rig()
        interruptedStep(rig)
        // the person's touch is input: the idle time is fresh
        rig.host.idle = 0.1
        rig.clock.advance(1.5)
        let r = try rig.core.restoreSession(afterInterrupt: true)
        // the guard the step armed ends with this restore and answers its report (§14.9.10)
        #expect(r == SessionRestore(frontmost: .restored, pointer: .restored, held: terminal, personGuard: .init(mode: .active, dropped: 0, replayed: 0, rearmed: 0)))
        #expect(rig.host.front == terminal)
        #expect(rig.host.pointerAt == pt(100, 100))
    }

    @Test func pastTwoSecondsTheTripStillWins() throws {
        let rig = Rig()
        interruptedStep(rig)
        rig.clock.advance(2.5)
        let r = try rig.core.restoreSession(afterInterrupt: true)
        #expect(r.frontmost == .personMoved && r.pointer == .personMoved)
        #expect(rig.host.front?.pid == 7)
        #expect(rig.host.pointerAt == pt(400, 300))
    }

    @Test func withoutTheFlagTheTripWinsAtOnce() throws {
        let rig = Rig()
        interruptedStep(rig)
        rig.clock.advance(0.2)
        let r = try rig.core.restoreSession(afterInterrupt: false)
        #expect(r.frontmost == .personMoved && r.pointer == .personMoved)
    }

    @Test func aPointerThePersonMovedStaysWhereTheyPutIt() throws {
        let rig = Rig()
        interruptedStep(rig)
        rig.host.pointerAt = pt(640, 480)
        rig.clock.advance(0.3)
        let r = try rig.core.restoreSession(afterInterrupt: true)
        #expect(r.frontmost == .restored)
        #expect(r.pointer == .personMoved)
        #expect(rig.host.pointerAt == pt(640, 480))
        #expect(!rig.host.log.contains { $0.hasPrefix("warp") })
    }

    @Test func aFrontAppThePersonSwitchedToStays() throws {
        let rig = Rig()
        interruptedStep(rig)
        rig.host.front = mail
        rig.clock.advance(0.3)
        let r = try rig.core.restoreSession(afterInterrupt: true)
        #expect(r.frontmost == .personMoved)
        #expect(r.pointer == .restored)
        #expect(rig.host.front == mail)
        #expect(!rig.host.log.contains("activate 1"))
    }

    @Test func withNoInterruptionOnRecordItIsThePlainRestore() throws {
        let rig = Rig()
        _ = try rig.step(.session) { _ in rig.host.pointerAt = pt(400, 300) }
        // the person used the Mac since the step, with no trip: the flag changes nothing
        rig.clock.advance(5)
        rig.host.idle = 1
        let r = try rig.core.restoreSession(afterInterrupt: true)
        #expect(r.frontmost == .personMoved && r.pointer == .personMoved)
    }

    @Test func aTripBetweenCallsCountsFromTheTrip() throws {
        let rig = Rig()
        _ = try rig.step(.session) { ctx in
            try rig.core.mouseDown(&ctx, at: pt(400, 300))
            rig.host.pointerAt = pt(400, 300)
        }
        rig.watch.trip()
        let deadline = Date().addingTimeInterval(2)
        while rig.personInput.isEmpty, Date() < deadline { Thread.sleep(forTimeInterval: 0.005) }
        #expect(rig.core.driver.record?.personTookOver == true)
        rig.clock.advance(1)
        let r = try rig.core.restoreSession(afterInterrupt: true)
        #expect(r.frontmost == .restored && r.pointer == .restored)
    }

    @Test func theLedgerReadsTheWindowFromTheTripNotTheStepsEnd() {
        var l = SessionLedger()
        l.stepBegan(frontmost: terminal, pointer: pt(0, 0), now: 10, secondsSinceInput: 99)
        l.stepEnded(frontmost: AppBrief(pid: 7, bundleId: nil, name: "TextEdit"), pointer: pt(0, 0), now: 11, interrupted: true, trippedAt: 10.5)
        #expect(l.record?.personTookOverAt == 10.5)
        #expect(l.justInterrupted(now: 12.5))
        #expect(!l.justInterrupted(now: 12.6))
    }
}

@Suite struct RestoreReleasesSessionHoldsOnlyTests {
    @Test func aProcessTierButtonOfAnotherPidStaysDownThroughARestore() throws {
        let rig = Rig()
        rig.host.apps[9] = mail
        _ = try rig.core.step(tier: .process, pid: 9, windowID: 90, window: 90, keys: false, cancelled: { false }) { ctx in
            try rig.core.mouseDown(&ctx, at: pt(20, 20))
        }
        _ = try rig.step(.session) { ctx in
            try rig.core.mouseDown(&ctx, at: pt(400, 300))
            rig.host.pointerAt = pt(400, 300)
        }
        rig.sink.clear()
        _ = try rig.core.restoreSession(afterInterrupt: false)
        #expect(rig.core.held.hold(pid: 9)?.tier == .process)
        #expect(rig.core.held.hold(pid: 7) == nil)
        // the one up posted is the session hold's, at the HID tap
        #expect(rig.sink.posted.count == 1)
        #expect(rig.sink.posted.first?.0 == .up(.left, pt(400, 300), clickState: 1, flags: []))
        #expect(rig.sink.posted.first?.1 == .hid)
        #expect(!rig.lock.isTaken)
    }
}

@Suite struct SessionSpanTests {
    @Test func anOkSessionStepCarriesItsSpan() throws {
        let rig = Rig()
        rig.host.idle = 4.25
        let armedAfter = rig.clock.epochSeconds() * 1000
        let (_, change, last) = try rig.step(.session, keys: true) { ctx in
            try rig.core.key(&ctx, parseKeyCombo("a"), repeat: 1)
        }
        let c = try #require(change)
        let armedAt = try #require(c.armedAt)
        let lastInputAt = try #require(c.lastInputAt)
        #expect(armedAt >= armedAfter)
        #expect(armedAt <= lastInputAt)
        #expect(c.idleAtArmMs == 4250)
        #expect(last != nil)
    }

    @Test func aFailedSessionStepCarriesItsSpanToo() throws {
        let rig = Rig()
        rig.host.idle = 30
        do {
            _ = try rig.step(.session, keys: true) { ctx in
                try rig.core.key(&ctx, parseKeyCombo("a"), repeat: 1)
                rig.watch.trip()
                try rig.core.key(&ctx, parseKeyCombo("b"), repeat: 1)
            }
            Issue.record("ran past the trip")
        } catch {
            let c = try #require((error as? ComputerFailure)?.error.session)
            let armedAt = try #require(c.armedAt)
            let lastInputAt = try #require(c.lastInputAt)
            #expect(armedAt <= lastInputAt)
            #expect(c.idleAtArmMs == 30_000)
        }
    }

    @Test func aStepThatPostedNothingCarriesNone() throws {
        let rig = Rig()
        let (_, change, _) = try rig.step(.session) { _ in }
        let c = try #require(change)
        #expect(c.armedAt == nil && c.idleAtArmMs == nil && c.lastInputAt == nil)
        // nor a failed one that stopped before its first event
        do {
            _ = try rig.step(.session) { _ in throw ComputerFailure(.outOfBounds, "off the window") }
        } catch {
            let f = try #require((error as? ComputerFailure)?.error.session)
            #expect(f.armedAt == nil && f.idleAtArmMs == nil && f.lastInputAt == nil)
        }
    }

    @Test func machTicksBecomeEpochMillisecondsOverTheTimebase() {
        // 125/3 ns a tick: 24,000,000 ticks are one second
        let pair = TickEpoch(epochMs: 1_000, ticks: 100_000_000, numer: 125, denom: 3)
        #expect(pair.epochMs(of: 100_000_000) == 1_000)
        #expect(pair.epochMs(of: 124_000_000) == 2_000)
        #expect(abs(pair.epochMs(of: 100_002_400) - 1_000.1) < 1e-9)
        #expect(pair.epochMs(of: 88_000_000) == 500)
        // read off a clock with that timebase
        let now = TickEpoch.now(TimebaseClock())
        #expect(now == TickEpoch(epochMs: 1_800_000_000_000, ticks: 9_000_000, numer: 125, denom: 3))
        let span = SessionSpan.of(arm: now, idleSeconds: 2.5, lastTicks: 9_000_000 + 48_000_000)
        #expect(span == SessionSpan(armedAt: 1_800_000_000_000, idleAtArmMs: 2_500, lastInputAt: 1_800_000_002_000))
        #expect(SessionSpan.of(arm: now, idleSeconds: 2.5, lastTicks: nil) == nil)
    }
}

/// A clock frozen at one moment, with Apple silicon's 125/3 timebase.
private struct TimebaseClock: InputClock {
    func ticks() -> UInt64 { 9_000_000 }
    func seconds() -> Double { 50 }
    func epochSeconds() -> Double { 1_800_000_000 }
    func sleep(ms: Int) {}
    func timebase() -> (numer: UInt32, denom: UInt32) { (125, 3) }
}

/// The shell's pasteboard watch as a fake: when someone else last copied, in fake-clock ms.
private final class FakeCopies: @unchecked Sendable {
    private let lock = NSLock()
    private var at: Double?
    let clock: FakeClock
    private(set) var asked: [Int] = []
    init(clock: FakeClock) { self.clock = clock }
    func copied(msAgo: Double = 0) { lock.withLock { at = clock.seconds() * 1000 - msAgo } }
    func recent(_ ms: Int) -> Bool {
        lock.withLock {
            asked.append(ms)
            guard let at else { return false }
            return clock.seconds() * 1000 - at < Double(ms)
        }
    }
}

/// A clipboard lock another service holds while the paste waits; `meanwhile` runs during the wait.
private final class HandedLock: MacLock, @unchecked Sendable {
    let inner: FakeLock
    var meanwhile: (() -> Void)?
    init(clock: FakeClock) { inner = FakeLock(clock: clock) }
    func acquire(within seconds: Double) -> MacLockHold? {
        if let wait = meanwhile {
            meanwhile = nil
            inner.clock.advance(1.2)
            wait()
        }
        return inner.acquire(within: seconds)
    }
}

@Suite struct FallbackSpanTests {
    let keys = SessionChange(frontmost: .init(before: terminal, after: mail), pointer: .init(before: [1, 1], after: [2, 2]), restorable: true, armedAt: 1_000, idleAtArmMs: 130_000, lastInputAt: 1_400)
    let paste = SessionChange(frontmost: .init(before: mail, after: mail), pointer: .init(before: [2, 2], after: [3, 3]), restorable: true, armedAt: 1_500, idleAtArmMs: 100, lastInputAt: 1_900)

    @Test func keysThatFellBackToThePasteSpanFromTheKeysArmToThePastesLastEvent() throws {
        let rig = Rig()
        let typed = try rig.core.typeByEvents("hello", keys: { (StepEffect.none, keys, 1) }, paste: { (ClipboardOutcome.restored, paste, 2) })
        guard case .paste(_, let change, _) = typed else { Issue.record("the type did not paste"); return }
        #expect(change?.armedAt == 1_000)
        #expect(change?.idleAtArmMs == 130_000)
        #expect(change?.lastInputAt == 1_900)
        #expect(change?.frontmost.before == terminal)
        #expect(change?.frontmost.after == mail)
        #expect(change?.pointer.before == [1, 1])
        #expect(change?.pointer.after == [3, 3])
    }

    @Test func inputBetweenTheKeysAndThePasteIsThePersonsSoThePasteKeepsItsOwnSpan() throws {
        let rig = Rig()
        // the paste's arm read input 20 ms before it, 80 ms after the keys' last event: the person
        let touched = SessionChange(frontmost: .init(before: mail, after: mail), pointer: .init(before: [2, 2], after: [3, 3]), restorable: true, armedAt: 1_500, idleAtArmMs: 20, lastInputAt: 1_900)
        #expect(rig.core.spanAcrossFallback(keys, touched) == touched)
        // within the slack it is the keys' own event, read a moment apart
        let quiet = SessionChange(frontmost: .init(before: mail, after: mail), pointer: .init(before: [2, 2], after: [3, 3]), restorable: true, armedAt: 1_500, idleAtArmMs: 70, lastInputAt: 1_900)
        #expect(rig.core.spanAcrossFallback(keys, quiet)?.armedAt == 1_000)
    }

    @Test func keysWithNoSpanLeaveThePastesOwnAndAPasteAloneIsItself() throws {
        let rig = Rig()
        let plain = SessionChange(frontmost: .init(), pointer: .init(before: [0, 0], after: [0, 0]), restorable: false)
        #expect(rig.core.spanAcrossFallback(plain, paste) == paste)
        #expect(rig.core.spanAcrossFallback(nil, paste) == paste)
        #expect(rig.core.spanAcrossFallback(keys, nil) == keys)
        let long = String(repeating: "x", count: InputTiming.keysMaxUnits + 1)
        guard case .paste(_, let change, _) = try rig.core.typeByEvents(long, keys: { Issue.record("keys ran"); return (.changed, keys, 1) }, paste: { (.restored, paste, 2) }) else { return }
        #expect(change == paste)
    }
}

@Suite struct PasteQuietTests {
    let original = [PasteboardItemData(types: ["a"], data: ["a": Data([1, 2, 3])])]

    private struct Setup {
        let rig = Rig()
        let store: FakeStore
        let copies: FakeCopies
        let clipboardLock: HandedLock
        let flow: PasteFlow
        init(items: [PasteboardItemData]) {
            store = FakeStore(items: items)
            copies = FakeCopies(clock: rig.clock)
            clipboardLock = HandedLock(clock: rig.clock)
            let copies = self.copies
            flow = PasteFlow(store: store, lock: clipboardLock, clock: rig.clock, recentForeignCopy: { copies.recent($0) })
        }

        func paste(_ text: String = "pasted", quietMs: Int? = 5_000) throws -> (ClipboardOutcome, SessionChange?, UInt64?) {
            let (result, change, last) = try rig.core.paste(PasteContent(plain: text), flow: flow, quietMs: quietMs, tier: .process, pid: 7, windowID: 70, window: 70, cancelled: { false }, checks: {}, recheck: {}, evidence: { nil })
            return (result.clipboard ?? .restored, change, last)
        }

        /// `type` past its AX rungs: keys that post Unicode events and show `effect`, then the paste.
        func type(_ text: String, keysEffect: StepEffect, quietMs: Int? = 5_000) throws -> InputCore<FakeHost>.TypedBy {
            try rig.core.typeByEvents(text, keys: {
                let (_, change, last) = try rig.step(.process, keys: true) { ctx in try rig.core.typeKeys(&ctx, text) }
                return (keysEffect, change, last)
            }, paste: { try paste(text, quietMs: quietMs) })
        }

        var postedCommandV: Bool {
            rig.sink.events.contains { if case .key(9, true, _) = $0 { true } else { false } }
        }
    }

    private func expectRecentCopy(_ s: Setup, _ body: () throws -> Void) {
        do {
            try body()
            Issue.record("the paste ran over a recent copy")
        } catch {
            let e = (error as? ComputerFailure)?.error
            #expect(e?.kind == .clipboardBusy)
            #expect(e?.reason == .recentCopy)
        }
        #expect(s.store.calls.isEmpty)
        #expect(s.store.items == original)
        #expect(s.store.changeCount == 10)
        #expect(!s.postedCommandV)
        #expect(!s.clipboardLock.inner.isTaken)
    }

    @Test func aPasteARecentCopyRefusesTouchesNothing() {
        let s = Setup(items: original)
        s.copies.copied(msAgo: 2_000)
        expectRecentCopy(s) { _ = try s.paste() }
        #expect(s.copies.asked == [5_000])
    }

    @Test func aLongTypeGoesStraightToThePasteAndIsRefused() {
        let s = Setup(items: original)
        s.copies.copied(msAgo: 1_000)
        let long = String(repeating: "x", count: InputTiming.keysMaxUnits + 1)
        expectRecentCopy(s) { _ = try s.type(long, keysEffect: .changed) }
        #expect(s.rig.sink.events.isEmpty) // no key was posted on the way
    }

    @Test func aShortTypeWhoseKeysShowedNoEffectIsRefusedAtThePaste() {
        let s = Setup(items: original)
        s.copies.copied(msAgo: 1_000)
        expectRecentCopy(s) { _ = try s.type("hello", keysEffect: StepEffect.none) }
        #expect(!s.rig.sink.events.isEmpty) // the keys went, then the paste stopped
    }

    @Test func aShortTypeWhoseKeysWorkedNeverAsks() throws {
        let s = Setup(items: original)
        s.copies.copied()
        guard case .keys = try s.type("hello", keysEffect: .changed) else { Issue.record("pasted"); return }
        #expect(s.copies.asked.isEmpty)
    }

    @Test func outsideTheQuietTimeEachRoutePastes() throws {
        for route in ["paste", "long type", "keys with no effect"] {
            let s = Setup(items: original)
            s.copies.copied(msAgo: 6_000)
            switch route {
            case "paste":
                let (outcome, _, _) = try s.paste()
                #expect(outcome == .restored)
            case "long type":
                guard case .paste(let outcome, _, _) = try s.type(String(repeating: "y", count: InputTiming.keysMaxUnits + 1), keysEffect: .changed) else { Issue.record("keys"); continue }
                #expect(outcome == .restored)
            default:
                guard case .paste(let outcome, _, _) = try s.type("hi", keysEffect: StepEffect.none) else { Issue.record("keys"); continue }
                #expect(outcome == .restored)
            }
            #expect(s.store.calls == ["snapshot", "clear", "write", "restore"], "\(route)")
            #expect(s.postedCommandV, "\(route)")
            #expect(s.store.items == original, "\(route)")
        }
    }

    @Test func withoutPasteQuietMsNothingIsAsked() throws {
        let s = Setup(items: original)
        s.copies.copied()
        let (outcome, _, _) = try s.paste(quietMs: nil)
        #expect(outcome == .restored)
        #expect(s.copies.asked.isEmpty)
        #expect(s.store.calls.contains("write"))
    }

    @Test func aCopyThatLandsWhileThePasteWaitsForTheLockStillRefusesIt() {
        let s = Setup(items: original)
        // quiet when the paste starts; another holder keeps the lock, and the person copies meanwhile
        #expect(!s.copies.recent(5_000))
        s.clipboardLock.meanwhile = { s.copies.copied() }
        expectRecentCopy(s) { _ = try s.paste() }
    }
}
