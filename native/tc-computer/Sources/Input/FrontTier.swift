import AppKit
import ApplicationServices
import ComputerCore
import ComputerProtocol
import CoreGraphics
import Foundation

// The `front` tier, live (docs/computer-protocol.md §26.2–§26.5): one hold brings the agent's app
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
    /// the person guard is on for this hold: their keys, clicks and wheel are dropped and stop nothing
    let guarded: Bool
    private let nowMs: @Sendable () -> Int
    private var callCancelled: @Sendable () -> Bool

    init(plan: FrontHoldPlan, nowMs: @escaping @Sendable () -> Int, cancelled: @escaping @Sendable () -> Bool, guarded: Bool = false) {
        self.plan = plan
        self.guarded = guarded
        self.nowMs = nowMs
        callCancelled = cancelled
    }

    /// The step's cancel flag inside the hold: true at the cap, at the person's touch or when the call
    /// was cancelled. Input checks it before every event and in every pause, as it does a call's cancel.
    /// A step that joins an open hold brings its own call's cancel.
    func setCallCancelled(_ c: @escaping @Sendable () -> Bool) { lock.withLock { callCancelled = c } }

    public var cancelled: @Sendable () -> Bool {
        { [self] in
            if lock.withLock({ callCancelled })() { return true }
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
            if case .stop = plan.touched(t, guarded: guarded) { stop = .person }
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

/// What the keyboard-quiet wait reads (§26.5), from the login session's event state: the person's last
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

/// The context the guard's Escape reaches, set once the context exists.
private final class EscapeBox: @unchecked Sendable {
    private let lock = NSLock()
    private weak var _ctx: FrontHoldContext?
    var ctx: FrontHoldContext? {
        get { lock.withLock { _ctx } }
        set { lock.withLock { _ctx = newValue } }
    }
}

/// The hold itself.
final class FrontTier: @unchecked Sendable {
    let host: LiveSessionHost
    let sessionLock: MacLock
    let clock: InputClock
    let keyboard: KeyboardState
    let watch = HoldWatch()
    /// the person guard's tap for a hold (§14.9, §26.5); nil or refused, the watch alone stops on a touch
    let tap: PersonTapping?
    /// one hold step at a time in this process (a cap's close included): the per-app queues never share the front
    private let steps = NSLock()
    /// the hold a batch's `front` step left open for the next one (decision 4); under `steps`
    private var open: OpenHold?
    /// reports of holds closed after the step that last used them returned, by pid, for the shell to take
    private let reportLock = NSLock()
    private var reports: [pid_t: FrontHold] = [:]

    init(host: LiveSessionHost, sessionLock: MacLock, clock: InputClock, keyboard: KeyboardState = SessionKeyboardState(), tap: PersonTapping? = nil) {
        self.host = host
        self.tap = tap
        self.sessionLock = sessionLock
        self.clock = clock
        self.keyboard = keyboard
    }

    private func nowMs() -> Int { Int((clock.seconds() * 1000).rounded()) }

    /// One hold, from its activation to its restore: what giving the Mac back needs, and what its steps did.
    final class OpenHold: @unchecked Sendable {
        let pid: pid_t
        let window: AXUIElement
        let app: String
        let ctx: FrontHoldContext
        let lease: MacLockHold
        let personPid: pid_t?
        let personWindow: AXUIElement?
        let person: AppBrief?
        let arm: TickEpoch
        var changedSince: (@Sendable (UInt64) -> Bool)?
        var lastTicks: UInt64?
        var timer: DispatchWorkItem?

        init(pid: pid_t, window: AXUIElement, app: String, ctx: FrontHoldContext, lease: MacLockHold, personPid: pid_t?, personWindow: AXUIElement?, person: AppBrief?, arm: TickEpoch) {
            self.pid = pid
            self.window = window
            self.app = app
            self.ctx = ctx
            self.lease = lease
            self.personPid = personPid
            self.personWindow = personWindow
            self.person = person
            self.arm = arm
        }
    }

    /// Runs `body` with the app `pid` in front and `window` its focused window, then gives the person's
    /// app back. `changedSince` says whether the app's AX tree changed since a tick (the settle's signal).
    /// With `keepOpen` (another step of the batch follows, decision 4) a step that leaves at least a
    /// settle's time before the cap keeps the hold for the next `front` step on the same window, which joins
    /// it with no new activation; the hold closes when a step does not join, at the cap (a timer), or when
    /// the shell closes it. Answers the body's value and `step.front`, nil while the hold stays open (its
    /// report then goes to `takeReport`); a failure always closes the hold and carries `front`.
    func hold<T>(
        pid: pid_t, window: AXUIElement, app: String, cancelled: @escaping @Sendable () -> Bool,
        changedSince: (@Sendable (UInt64) -> Bool)?, keepOpen: Bool = false, body: (FrontHoldContext) throws -> T
    ) throws -> (T, FrontHold?) {
        if host.screenLocked() { throw sessionUnavailable(.locked, "The screen is locked; \(app) can't come forward.") }
        steps.lock()
        defer { steps.unlock() }
        let h: OpenHold
        if let o = open, joins(o, pid: pid, window: window) {
            o.timer?.cancel()
            open = nil
            o.ctx.setCallCancelled(cancelled)
            h = o
        } else {
            if let o = open {
                open = nil
                keep(closeLocked(o), for: o.pid)
            }
            h = try begin(pid: pid, window: window, app: app, cancelled: cancelled)
        }
        h.changedSince = changedSince

        var outcome: Result<T, Error>
        do {
            let value = try body(h.ctx)
            h.lastTicks = clock.ticks()
            h.ctx.with { $0.acted(now: nowMs()) }
            outcome = .success(value)
        } catch {
            h.lastTicks = clock.ticks()
            h.ctx.with { $0.acted(now: nowMs()) }
            outcome = .failure(Self.stopError(error, ctx: h.ctx, app: app))
        }
        if case .success(let value) = outcome, keepOpen, h.ctx.stopped == nil, h.ctx.with({ $0.takesAnotherStep(now: nowMs()) }) {
            open = h
            armCap(h)
            return (value, nil)
        }
        if case .success = outcome {
            do { try settle(h.ctx, since: h.lastTicks ?? clock.ticks(), changedSince: changedSince) } catch { outcome = .failure(error) }
        }
        let report = closeLocked(h)
        switch outcome {
        case .success(let value): return (value, report)
        case .failure(let error): throw withFront(error, report)
        }
    }

    /// The next step joins an open hold: same app and window, nothing stopped it, a settle's time left,
    /// and the app still the one in front (a person who switched apps took the front back).
    private func joins(_ o: OpenHold, pid: pid_t, window: AXUIElement) -> Bool {
        o.pid == pid && CFEqual(o.window, window) && o.ctx.stopped == nil
            && o.ctx.with({ $0.takesAnotherStep(now: nowMs()) }) && focusedAppPid() == pid
    }

    /// A new hold: the keyboard quiet, the session lock, the person's app and window recorded, the guard
    /// armed, the app brought forward. A refused activation restores and throws with the hold's report.
    private func begin(pid: pid_t, window: AXUIElement, app: String, cancelled: @escaping @Sendable () -> Bool) throws -> OpenHold {
        try quiet(cancelled: cancelled)
        let lease = try takeLock(cancelled: cancelled)
        let personPid = focusedAppPid()
        let person = personPid.flatMap(appBrief)
        let personWindow = personPid.flatMap { $0 == pid ? nil : AX.element(AX.app($0), "AXFocusedWindow") }
        let arm = TickEpoch.now(clock)
        var plan = FrontHoldPlan(startedAt: nowMs(), person: person)
        plan.armedAt = arm.epochMs
        plan.idleAtArmMs = (host.sessionIdleSeconds() * 1000).rounded()
        let ctx: FrontHoldContext
        do {
            ctx = try guardHold(plan: plan, cancelled: cancelled)
        } catch {
            lease.release()
            throw error
        }
        let h = OpenHold(pid: pid, window: window, app: app, ctx: ctx, lease: lease, personPid: personPid, personWindow: personWindow, person: person, arm: arm)
        do {
            try activate(pid: pid, window: window, ctx: ctx)
        } catch {
            throw withFront(error, closeLocked(h))
        }
        return h
    }

    /// The restore, the guard and the lock let go, and the hold's report; under `steps`.
    private func closeLocked(_ h: OpenHold) -> FrontHold {
        h.timer?.cancel()
        restore(personPid: h.personPid, personWindow: h.personWindow, agentPid: h.pid, ctx: h.ctx)
        endGuard(h.ctx)
        h.lease.release()
        let r = h.ctx.with { $0.report } ?? FrontHold(heldMs: 0, activateMs: 0, restoreMs: 0, restored: .failed, person: h.person)
        return FrontHold(
            heldMs: r.heldMs, activateMs: r.activateMs, restoreMs: r.restoreMs, restored: r.restored, person: r.person,
            armedAt: r.armedAt, idleAtArmMs: r.idleAtArmMs, lastInputAt: h.lastTicks.map { max(h.arm.epochMs(of: $0), h.arm.epochMs) }
        )
    }

    /// An open hold closes itself at its cap: the next step past it starts a new hold, and the app never
    /// stays in front longer than `frontHoldMaxMs` while the shell waits between steps.
    private func armCap(_ h: OpenHold) {
        let left = h.ctx.with { $0.timeLeft(now: nowMs()) }
        let item = DispatchWorkItem { [weak self, weak h] in
            guard let self, let h else { return }
            self.close(h)
        }
        h.timer = item
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + .milliseconds(max(0, left)), execute: item)
    }

    /// Closes `h` if it is still the open hold: the settle its last step skipped, then the restore.
    private func close(_ h: OpenHold) {
        steps.lock()
        defer { steps.unlock() }
        guard let o = open, o === h else { return }
        open = nil
        try? settle(h.ctx, since: h.lastTicks ?? clock.ticks(), changedSince: h.changedSince)
        keep(closeLocked(h), for: h.pid)
    }

    /// The shell's close at the end of a call, or before a step that does not run at `front`.
    func closeOpen(pid: pid_t? = nil) {
        let o = steps.withLock { pid == nil || open?.pid == pid ? open : nil }
        if let o { close(o) }
    }

    /// Whether a hold is open now.
    var isOpen: Bool { steps.withLock { open != nil } }

    private func keep(_ report: FrontHold, for pid: pid_t) {
        reportLock.withLock { reports[pid] = report }
    }

    /// The report of a hold of `pid` closed after its last step returned; nil when none waits.
    func takeReport(pid: pid_t) -> FrontHold? {
        reportLock.withLock { reports.removeValue(forKey: pid) }
    }

    /// Decision 6: the person guard for the hold, when its tap can be made: their keys, clicks and wheel
    /// are dropped and stop nothing, Escape stops the step and restores at once. Without it, the watch:
    /// their first key, click or wheel stops it the same way.
    func guardHold(plan: FrontHoldPlan, cancelled: @escaping @Sendable () -> Bool) throws -> FrontHoldContext {
        let now: @Sendable () -> Int = { [clock] in Int((clock.seconds() * 1000).rounded()) }
        let escape = EscapeBox()
        let on = tap?.enableReportingEscape(onTrip: {}, onEscape: { escape.ctx?.touched(.escape) }) ?? false
        let ctx = FrontHoldContext(plan: plan, nowMs: now, cancelled: cancelled, guarded: on)
        escape.ctx = ctx
        if !on { watch.arm { [weak ctx] t in ctx?.touched(t) } }
        return ctx
    }

    func endGuard(_ ctx: FrontHoldContext) {
        if ctx.guarded { _ = tap?.disable() } else { watch.disarm() }
    }

    /// §26.5: wait until the person's last key down is `frontQuietMs` old and nothing is held, at most
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
