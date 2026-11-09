import ComputerProtocol
@testable import ComputerServiceKit
import Testing

@Suite struct EscapeFilterTests {
    let escape = Int64(ComputerDefaults.EscapeWatch.keycode)

    @Test func thePersonsEscapeIsTakenAndItsDownIsTold() {
        #expect(EscapeFilter.decide(keycode: escape, marked: false, down: true) == .take(press: true))
        #expect(EscapeFilter.decide(keycode: escape, marked: false, down: false) == .take(press: false))
        #expect(EscapeFilter.decide(keycode: escape, marked: false, down: true, autorepeat: true) == .take(press: false))
    }

    @Test func ourOwnEscapeAndEveryOtherKeyPass() {
        #expect(EscapeFilter.decide(keycode: escape, marked: true, down: true) == .pass)
        #expect(EscapeFilter.decide(keycode: escape, marked: true, down: false) == .pass)
        for keycode in [0, 36, 48, 51, 52, 54, 122] as [Int64] {
            #expect(EscapeFilter.decide(keycode: keycode, marked: false, down: true) == .pass)
            #expect(EscapeFilter.decide(keycode: keycode, marked: true, down: false) == .pass)
        }
    }
}

@Suite struct EscapeLeaseTests {
    @Test func itEndsWithoutRenewal() {
        var lease = EscapeLease()
        lease.renew(now: 1_000, leaseMs: 5_000)
        #expect(lease.on)
        let r1 = lease.lapsed(now: 5_999)
        #expect(!r1)
        let r2 = lease.lapsed(now: 6_000)
        #expect(r2)
        #expect(!lease.on)
    }

    @Test func aRenewalKeepsIt() {
        var lease = EscapeLease()
        lease.renew(now: 0, leaseMs: nil)
        #expect(lease.until == Double(ComputerDefaults.EscapeWatch.leaseMs))
        lease.renew(now: 20_000, leaseMs: nil)
        let r3 = lease.lapsed(now: 40_000)
        #expect(!r3)
        let r4 = lease.lapsed(now: 50_000)
        #expect(r4)
    }

    @Test func endingItAndTheBounds() {
        var lease = EscapeLease()
        lease.renew(now: 0, leaseMs: 10)
        #expect(lease.until == Double(ComputerDefaults.EscapeWatch.minLeaseMs))
        lease.renew(now: 0, leaseMs: 10_000_000)
        #expect(lease.until == Double(ComputerDefaults.EscapeWatch.maxLeaseMs))
        lease.end()
        #expect(!lease.on)
        let r5 = lease.lapsed(now: 1e12)
        #expect(!r5)
    }
}

@Suite struct ClickCarryTests {
    let click = ClickCarry.Click(at: [640, 480], spaceWidth: 1280, spaceHeight: 960)

    @Test func aStreamStartingWhileTheCallRunsGetsItEvenFiveSecondsIn() {
        var carry = ClickCarry()
        carry.record(click, session: "s1", windowID: 7, call: 1)
        // the call's smart wait runs 5 s
        do { let got = carry.pending(session: "s1", windowID: 7, now: 5_000); #expect(got == click) }
        carry.answered(call: 1, at: 5_000)
        do { let got = carry.pending(session: "s1", windowID: 7, now: 6_999); #expect(got == click) }
    }

    @Test func underTwoSecondsAfterTheAnswerItIsCarriedAndLaterItIsNot() {
        var carry = ClickCarry()
        carry.record(click, session: "s1", windowID: 7, call: 1)
        carry.answered(call: 1, at: 100)
        do { let got = carry.pending(session: "s1", windowID: 7, now: 1_900); #expect(got == click) }
        do { let got = carry.pending(session: "s1", windowID: 7, now: 2_101); #expect(got == nil) }
        #expect(carry.count == 0)
    }

    @Test func anotherWindowOrSessionNeverGetsIt() {
        var carry = ClickCarry()
        carry.record(click, session: "s1", windowID: 7, call: 1)
        do { let got = carry.pending(session: "s1", windowID: 8, now: 0); #expect(got == nil) }
        do { let got = carry.pending(session: "s2", windowID: 7, now: 0); #expect(got == nil) }
    }

    @Test func aBatchsLaterClickReplacesTheWindowsAndOnlyItsCallsAnswerCarriesIt() {
        var carry = ClickCarry()
        let later = ClickCarry.Click(at: [1, 2], spaceWidth: 1280, spaceHeight: 960)
        carry.record(click, session: "s1", windowID: 7, call: 1)
        carry.record(later, session: "s1", windowID: 7, call: 1)
        carry.record(click, session: "s1", windowID: 9, call: 2)
        carry.answered(call: 1, at: 0)
        do { let got = carry.pending(session: "s1", windowID: 7, now: 1_000); #expect(got == later) }
        // call 2 still runs
        do { let got = carry.pending(session: "s1", windowID: 9, now: 60_000); #expect(got == click) }
        carry.forget(session: "s1")
        do { let got = carry.pending(session: "s1", windowID: 9, now: 60_000); #expect(got == nil) }
    }

    @Test func aClickMapsIntoAStreamOfAnotherSize() {
        #expect(ClickMapping.map(click, frameWidth: 960, frameHeight: 720) == [480, 360])
        #expect(ClickMapping.map(ClickCarry.Click(at: [1279, 959], spaceWidth: 1280, spaceHeight: 960), frameWidth: 400, frameHeight: 300) == [399, 299])
        #expect(ClickMapping.map(ClickCarry.Click(at: [101, 33], spaceWidth: 1000, spaceHeight: 500), frameWidth: 640, frameHeight: 320) == [65, 21])
    }
}
