import ComputerCore
import ComputerProtocol
import Foundation
@testable import Input
import Testing

/// A keyboard the test sets: seconds since the last key down and whether anything is held, by the fake clock.
final class FakeKeyboard: KeyboardState, @unchecked Sendable {
    let clock: FakeClock
    private let lock = NSLock()
    private var lastDownAt: Double?
    private var heldUntil: Double = -1

    init(clock: FakeClock) { self.clock = clock }

    func keyDown(holdFor s: Double = 0) {
        let now = clock.seconds()
        lock.withLock {
            lastDownAt = now
            heldUntil = now + s
        }
    }

    func secondsSinceKeyDown() -> Double { lock.withLock { lastDownAt.map { clock.seconds() - $0 } ?? 3_600 } }
    func anyHeld() -> Bool { lock.withLock { clock.seconds() < heldUntil } }
}

/// The live hold's seams that need no app in front (docs/computer-protocol.md §25.2–§25.5).
@Suite struct FrontTierTests {
    private func tier(_ clock: FakeClock, _ keyboard: KeyboardState, lock: MacLock? = nil) -> FrontTier {
        FrontTier(host: LiveSessionHost(), sessionLock: lock ?? FakeLock(clock: clock), clock: clock, keyboard: keyboard)
    }

    @Test func aQuietKeyboardStartsTheHoldAtOnce() throws {
        let clock = FakeClock()
        let t0 = clock.seconds()
        try tier(clock, FakeKeyboard(clock: clock)).quiet(cancelled: { false })
        #expect(clock.seconds() == t0)
    }

    @Test func aKeyJustPressedWaitsUntilItIsQuietMsOld() throws {
        let clock = FakeClock()
        let keyboard = FakeKeyboard(clock: clock)
        keyboard.keyDown()
        clock.advance(0.3)
        let t0 = clock.seconds()
        try tier(clock, keyboard).quiet(cancelled: { false })
        let waited = clock.seconds() - t0
        #expect(waited >= 0.49 && waited <= 0.55, "\(waited)")
    }

    @Test func aKeyHeldDownGoesAnywayAtTheCap() throws {
        let clock = FakeClock()
        let keyboard = FakeKeyboard(clock: clock)
        keyboard.keyDown(holdFor: 60)
        let t0 = clock.seconds()
        try tier(clock, keyboard).quiet(cancelled: { false })
        #expect(abs(clock.seconds() - t0 - Double(InputTiming.frontQuietMaxMs) / 1000) < 0.06)
    }

    @Test func aCancelEndsTheQuietWait() {
        let clock = FakeClock()
        let keyboard = FakeKeyboard(clock: clock)
        keyboard.keyDown(holdFor: 60)
        let t0 = clock.seconds()
        #expect(throws: ComputerFailure.self) { try tier(clock, keyboard).quiet(cancelled: { clock.seconds() - t0 > 1 }) }
    }

    @Test func aLockAnotherHolderKeepsAnswersInUse() {
        let clock = FakeClock()
        let lock = FakeLock(clock: clock)
        lock.heldElsewhere = true
        do {
            _ = try tier(clock, FakeKeyboard(clock: clock), lock: lock).takeLock(cancelled: { false })
            Issue.record("took a held lock")
        } catch {
            #expect((error as? ComputerFailure)?.error.reason == .inUse)
        }
    }

    private func activeContext(_ clock: FakeClock, cancelled: @escaping @Sendable () -> Bool = { false }) -> FrontHoldContext {
        let start = Int((clock.seconds() * 1000).rounded())
        var plan = FrontHoldPlan(startedAt: start)
        _ = plan.activation(now: start + 20, isFront: true)
        clock.advance(0.02)
        return FrontHoldContext(plan: plan, nowMs: { Int((clock.seconds() * 1000).rounded()) }, cancelled: cancelled)
    }

    @Test func theCapCancelsTheStepAndReadsTimeout() {
        let clock = FakeClock()
        let ctx = activeContext(clock)
        #expect(!ctx.cancelled())
        #expect(ctx.axTimeout <= InputTiming.axTimeoutS && ctx.axTimeout > 1.9)
        clock.advance(Double(InputTiming.frontHoldMaxMs) / 1000 - 0.5)
        #expect(abs(ctx.axTimeout - 0.5) < 0.01)
        clock.advance(0.6)
        #expect(ctx.cancelled())
        #expect(ctx.stopped == .cap)
        let error = FrontTier.stopError(cancelledFailure(), ctx: ctx, app: "TC Probe")
        #expect((error as? ComputerFailure)?.error == FrontFailure.timeout(app: "TC Probe"))
    }

    @Test func thePersonsKeyStopsTheHoldAndAMoveDoesNot() {
        let clock = FakeClock()
        let ctx = activeContext(clock)
        ctx.touched(.pointerMove)
        #expect(!ctx.cancelled())
        ctx.touched(.key)
        #expect(ctx.cancelled() && ctx.stopped == .person)
        #expect(kind(FrontTier.stopError(cancelledFailure(), ctx: ctx, app: "TC Probe")) == .interrupted)
    }

    @Test func escapeStopsTheHold() {
        let ctx = activeContext(FakeClock())
        ctx.touched(.escape)
        #expect(ctx.stopped == .person)
    }

    @Test func theCallsOwnCancelStaysACancel() {
        let flag = Box(false)
        let ctx = activeContext(FakeClock(), cancelled: { flag.value })
        flag.value = true
        #expect(ctx.cancelled())
        #expect(ctx.stopped == nil)
        #expect(kind(FrontTier.stopError(cancelledFailure(), ctx: ctx, app: "TC Probe")) == .cancelled)
        // an error that is no cancel is the step's own
        let own = ComputerFailure(.actionUnsupported, "File › Save is disabled.")
        #expect(kind(FrontTier.stopError(own, ctx: ctx, app: "TC Probe")) == .actionUnsupported)
    }

    @Test func aFailureCarriesTheHold() {
        let hold = FrontHold(heldMs: 300, activateMs: 40, restoreMs: 20, restored: .restored)
        let error = withFront(ComputerFailure(FrontFailure.timeout(app: "TC Probe")), hold)
        #expect((error as? ComputerFailure)?.error.front == hold)
        #expect((error as? ComputerFailure)?.error.kind == .timeout)
    }

    @Test func anOutcomeTakesItsHold() {
        let hold = FrontHold(heldMs: 300, activateMs: 40, restoreMs: 20, restored: .personMoved)
        let out = InputOutcome(tier: .front, via: .menu, clipboard: nil, cursor: nil, on: "File › Save").with(front: hold)
        #expect(out.front == hold && out.on == "File › Save")
    }
}
