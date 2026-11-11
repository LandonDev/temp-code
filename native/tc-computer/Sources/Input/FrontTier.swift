import AppKit
import ApplicationServices
import ComputerCore
import ComputerProtocol
import CoreGraphics
import Foundation

// The `front` tier, live (docs/computer-protocol.md §25.2–§25.5): one hold brings the agent's app
// forward over AX, runs the step's AX calls or events posted to the app's pid, waits for the app
// to take them, and gives the person their app and key window back. FrontPlan.swift decides every
// move; this reads the Mac and writes it. Nothing here moves the pointer, posts at the HID or
// session tap, or calls NSRunningApplication.activate.

/// What a step running inside a hold checks before each posted event or AX call.
public final class FrontHoldContext: @unchecked Sendable {
    public enum Stop: Equatable, Sendable {
        /// the hold reached `frontHoldMaxMs`
        case cap
        /// the person touched the Mac (Escape always; any key, click or wheel without the guard)
        case person
    }

    private let lock = NSLock()
    private var plan: FrontHoldPlan
    private var stop: Stop?
    private let nowMs: @Sendable () -> Int
    private let callCancelled: @Sendable () -> Bool

    init(plan: FrontHoldPlan, nowMs: @escaping @Sendable () -> Int, cancelled: @escaping @Sendable () -> Bool) {
        self.plan = plan
        self.nowMs = nowMs
        callCancelled = cancelled
    }

    /// The step's cancel flag inside the hold: true at the cap, at the person's touch or when the call
    /// was cancelled. Input checks it before every event and in every pause, as it does a call's cancel.
    public var cancelled: @Sendable () -> Bool {
        { [self] in
            if callCancelled() { return true }
            return lock.withLock {
                if stop != nil { return true }
                if case .cap = plan.beforePost(now: nowMs()) {
                    stop = .cap
                    return true
                }
                return false
            }
        }
    }

    /// The messaging timeout for an AX call now: the lesser of 2 s and the time left, in seconds.
    public var axTimeout: Double {
        lock.withLock {
            if case .post(let ms) = plan.beforePost(now: nowMs()) { return Double(ms) / 1000 }
            return 0.001
        }
    }

    /// Throws the hold's stop, or the call's cancel, before an AX call the step makes itself.
    public func check() throws {
        if cancelled() { throw cancelledFailure() }
    }

    var stopped: Stop? { lock.withLock { stop } }

    func touched(_ t: PersonTouch) {
        lock.withLock {
            if case .stop = plan.touched(t, guarded: false) { stop = .person }
        }
    }

    func with<T>(_ body: (inout FrontHoldPlan) -> T) -> T { lock.withLock { body(&plan) } }
}

/// The person's input during a hold: a listen-only global monitor of key downs, the three button
/// downs and the wheel. The service's own events carry TC_EVENT_MARK and never count; pointer moves
/// are not watched, since nothing in a hold moves the pointer and a moved pointer is the person's to keep.
final class HoldWatch: @unchecked Sendable {
    private nonisolated(unsafe) var monitor: Any?

    func arm(_ onTouch: @escaping @Sendable (PersonTouch) -> Void) {
        _ = onMain { [self] in
            guard monitor == nil else { return }
            let mask: NSEvent.EventTypeMask = [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
            monitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { event in
                let mark = event.cgEvent?.getIntegerValueField(.eventSourceUserData) ?? 0
                guard isPersonEvent(userData: mark, type: UInt32(event.type.rawValue)) else { return }
                switch event.type {
                case .keyDown: onTouch(event.keyCode == 53 ? .escape : .key)
                case .scrollWheel: onTouch(.wheel)
                default: onTouch(.click)
                }
            }
        }
    }

    func disarm() {
        _ = onMain { [self] in
            if let m = monitor { NSEvent.removeMonitor(m) }
            monitor = nil
        }
    }
}

/// What the keyboard-quiet wait reads (§25.5), from the login session's event state: the person's last
/// key down and whether any key or modifier is down. Events Input posts to a pid never enter it (only
/// the session tier's, posted at the HID tap, do, which can only make a hold wait longer).
public protocol KeyboardState: Sendable {
    /// seconds since the last key down
    func secondsSinceKeyDown() -> Double
    /// a key or a modifier is down now
    func anyHeld() -> Bool
}

public struct SessionKeyboardState: KeyboardState {
    public init() {}

    public func secondsSinceKeyDown() -> Double {
        CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
    }

    public func anyHeld() -> Bool {
        let mods: CGEventFlags = [.maskShift, .maskControl, .maskAlternate, .maskCommand, .maskSecondaryFn]
        if !CGEventSource.flagsState(.combinedSessionState).intersection(mods).isEmpty { return true }
        // the modifier keys answer through the flags; caps lock (57) stays down while it is on
        for key in CGKeyCode(0) ..< 128 where key != 57 && CGEventSource.keyState(.combinedSessionState, key: key) { return true }
        return false
    }
}

/// The hold itself.
final class FrontTier: @unchecked Sendable {
    let host: LiveSessionHost
    let sessionLock: MacLock
    let clock: InputClock
    let keyboard: KeyboardState
    let watch = HoldWatch()
    /// one hold at a time in this process, as one session step: the per-app queues never share the front
    private let holds = NSLock()

    init(host: LiveSessionHost, sessionLock: MacLock, clock: InputClock, keyboard: KeyboardState = SessionKeyboardState()) {
        self.host = host
        self.sessionLock = sessionLock
        self.clock = clock
        self.keyboard = keyboard
    }

    private func nowMs() -> Int { Int((clock.seconds() * 1000).rounded()) }

    /// Runs `body` with the app `pid` in front and `window` its focused window, then gives the person's
    /// app back. `changedSince` says whether the app's AX tree changed since a tick (the settle's signal).
    /// Answers the body's value and `step.front`; a failure carries `front` too once the hold began.
    func hold<T>(
        pid: pid_t, window: AXUIElement, app: String, cancelled: @escaping @Sendable () -> Bool,
        changedSince: (@Sendable (UInt64) -> Bool)?, body: (FrontHoldContext) throws -> T
    ) throws -> (T, FrontHold) {
        if host.screenLocked() { throw sessionUnavailable(.locked, "The screen is locked; \(app) can't come forward.") }
        try quiet(cancelled: cancelled)
        let lease = try takeLock(cancelled: cancelled)
        defer { lease.release() }
        guard holds.try() else { throw sessionUnavailable(.inUse, "Another computer step has an app in front.") }
        defer { holds.unlock() }

        // what to give back: the person's app and its focused window
        let personPid = focusedAppPid()
        let person = personPid.flatMap(appBrief)
        let personWindow = personPid.flatMap { $0 == pid ? nil : AX.element(AX.app($0), "AXFocusedWindow") }
        let arm = TickEpoch.now(clock)
        var plan = FrontHoldPlan(startedAt: nowMs(), person: person)
        plan.armedAt = arm.epochMs
        plan.idleAtArmMs = (host.sessionIdleSeconds() * 1000).rounded()
        let ctx = FrontHoldContext(plan: plan, nowMs: { [clock] in Int((clock.seconds() * 1000).rounded()) }, cancelled: cancelled)
        watch.arm { [weak ctx] t in ctx?.touched(t) }
        defer { watch.disarm() }

        var outcome: Result<T, Error>
        var lastTicks: UInt64?
        do {
            try activate(pid: pid, window: window, ctx: ctx)
            do {
                let value = try body(ctx)
                lastTicks = clock.ticks()
                ctx.with { $0.acted(now: nowMs()) }
                try settle(ctx, since: lastTicks!, changedSince: changedSince)
                outcome = .success(value)
            } catch {
                lastTicks = clock.ticks()
                ctx.with { $0.acted(now: nowMs()) }
                outcome = .failure(Self.stopError(error, ctx: ctx, app: app))
            }
        } catch {
            outcome = .failure(error)
        }
        restore(personPid: personPid, personWindow: personWindow, agentPid: pid, ctx: ctx)
        var report = ctx.with { $0.report } ?? FrontHold(heldMs: 0, activateMs: 0, restoreMs: 0, restored: .failed, person: person)
        report = FrontHold(
            heldMs: report.heldMs, activateMs: report.activateMs, restoreMs: report.restoreMs, restored: report.restored, person: report.person,
            armedAt: report.armedAt, idleAtArmMs: report.idleAtArmMs, lastInputAt: lastTicks.map { max(arm.epochMs(of: $0), arm.epochMs) }
        )
        switch outcome {
        case .success(let value): return (value, report)
        case .failure(let error): throw withFront(error, report)
        }
    }

    /// §25.5: wait until the person's last key down is `frontQuietMs` old and nothing is held, at most
    /// `frontQuietMaxMs`; past that the hold goes anyway.
    func quiet(cancelled: () -> Bool) throws {
        let start = nowMs()
        while true {
            if cancelled() { throw cancelledFailure() }
            let now = nowMs()
            let lastKeyDown = now - Int((keyboard.secondsSinceKeyDown() * 1000).rounded())
            switch QuietWait.decide(now: now, startedAt: start, lastKeyDownAt: lastKeyDown, held: keyboard.anyHeld()) {
            case .go, .goAnyway: return
            case .wait(let ms): clock.sleep(ms: min(ms, InputTiming.watchSliceMs))
            }
        }
    }

    /// The Mac-wide session lock: one app comes forward at a time, never during a session step.
    func takeLock(cancelled: () -> Bool) throws -> MacLockHold {
        let deadline = clock.seconds() + InputTiming.sessionLockWaitS
        while true {
            if cancelled() { throw cancelledFailure() }
            if let h = sessionLock.acquire(within: InputTiming.sessionLockTryS) { return h }
            if clock.seconds() >= deadline {
                throw sessionUnavailable(.inUse, "Another computer session holds the Mac's keyboard and mouse.")
            }
        }
    }

    /// AXFrontmost, then AXRaise and AXMain on the window, polled every `frontPollMs` until the app is in
    /// front with the window focused, at most `frontActivateMaxMs`.
    private func activate(pid: pid_t, window: AXUIElement, ctx: FrontHoldContext) throws {
        AX.setTimeout(AX.app(pid), seconds: InputTiming.axTimeoutS)
        AX.setTimeout(window, seconds: InputTiming.axTimeoutS)
        if host.minimized(window) { try host.unminimize(window) }
        var polls = 0
        while true {
            if ctx.stopped != nil { throw interruptedByPerson() }
            let front = focusedAppPid() == pid && host.isFocusedWindow(window, pid: pid)
            switch ctx.with({ $0.activation(now: nowMs(), isFront: front) }) {
            case .activated: return
            case .refused:
                let name = appBrief(pid)?.name ?? "The app"
                throw ComputerFailure(FrontFailure.activationRefused(app: name))
            case .poll(let ms):
                // the writes once, and once more halfway: an app that was busy may miss the first
                if polls == 0 || polls == InputTiming.frontActivateMaxMs / InputTiming.frontPollMs / 2 {
                    try? host.bringForward(pid: pid)
                    try? host.raise(window)
                }
                polls += 1
                clock.sleep(ms: ms)
            }
        }
    }

    /// After the last input: until the app's tree changes (or `frontSettleMs`, at most `frontSettleMaxMs`),
    /// since a key the app has not handled when it loses key status goes nowhere.
    private func settle(_ ctx: FrontHoldContext, since: UInt64, changedSince: (@Sendable (UInt64) -> Bool)?) throws {
        while true {
            if ctx.stopped == .person { throw interruptedByPerson() }
            let changed = changedSince?(since) ?? false
            switch ctx.with({ $0.settle(now: nowMs(), changed: changed, busy: false) }) {
            case .release: return
            case .hold(let ms): clock.sleep(ms: ms)
            }
        }
    }

    /// AXFrontmost on the person's app (it brings back its own last focused window), then AXRaise and
    /// AXMain on their recorded window if focus moved within the app; a third app they chose is kept.
    private func restore(personPid: pid_t?, personWindow: AXUIElement?, agentPid: pid_t, ctx: FrontHoldContext) {
        ctx.with { $0.beginRestore(now: nowMs()) }
        var wrote = false
        while true {
            let front = focusedAppPid()
            let now: FrontNow
            if let personPid {
                if front == personPid { now = .personApp }
                else if !host.isRunning(pid: Int(personPid)) { now = .personAppGone }
                else if front == agentPid || front == nil { now = .agentApp }
                else { now = .thirdApp }
            } else {
                // nothing was in front to give back: done once the agent's app is not
                now = front == agentPid ? .agentApp : .personApp
            }
            if now == .agentApp, let personPid, !wrote {
                try? host.bringForward(pid: personPid)
                wrote = true
            }
            switch ctx.with({ $0.restore(now: nowMs(), front: now) }) {
            case .done(let outcome):
                if outcome == .restored, let personWindow, let personPid, !host.isFocusedWindow(personWindow, pid: personPid) {
                    try? host.raise(personWindow)
                }
                return
            case .poll(let ms):
                clock.sleep(ms: ms)
            }
        }
    }

    /// The app in front, by AX: NSWorkspace's answer goes stale on a thread that does not run main's loop.
    private func focusedAppPid() -> pid_t? {
        guard let app = AX.element(AXUIElementCreateSystemWide(), "AXFocusedApplication") else {
            return NSWorkspace.shared.frontmostApplication?.processIdentifier
        }
        var pid: pid_t = 0
        return AXUIElementGetPid(app, &pid) == .success ? pid : nil
    }

    private func appBrief(_ pid: pid_t) -> AppBrief? {
        guard let app = NSRunningApplication(processIdentifier: pid) else { return nil }
        return AppBrief(pid: Int(pid), bundleId: app.bundleIdentifier, name: app.localizedName ?? "")
    }

    /// A step the hold cut: at the cap `timeout` (never replayed), at the person's touch `interrupted`.
    static func stopError(_ error: Error, ctx: FrontHoldContext, app: String) -> Error {
        guard (error as? ComputerFailure)?.error.kind == .cancelled else { return error }
        switch ctx.stopped {
        case .cap?: return ComputerFailure(FrontFailure.timeout(app: app))
        case .person?: return interruptedByPerson()
        case nil: return error
        }
    }
}

/// The error with the hold's report attached, as a session step's carries its change.
func withFront(_ error: Error, _ hold: FrontHold) -> Error {
    guard let f = error as? ComputerFailure else { return error }
    let e = f.error
    return ComputerFailure(ComputerError(
        kind: e.kind, message: e.message, which: e.which, candidates: e.candidates, element: e.element, reason: e.reason,
        available: e.available, needed: e.needed, coordinate: e.coordinate, space: e.space, by: e.by,
        keyWindow: e.keyWindow, session: e.session, front: hold, menu: e.menu
    ))
}
