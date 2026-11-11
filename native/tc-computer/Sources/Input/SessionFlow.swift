import ComputerCore
import ComputerProtocol
import Foundation

/// The person watch: armed with the person guard (§14.9), from a session step's arm until the
/// restore after it (or the guard's linger). Any input event without TC_EVENT_MARK trips it.
public protocol PersonWatching: AnyObject, Sendable {
    /// Arms the watch, clearing an earlier trip; `onTrip` runs once at the person's first event, on any thread.
    func arm(onTrip: @escaping @Sendable () -> Void)
    func disarm()
    var armed: Bool { get }
    var tripped: Bool { get }
    /// what the guard did, as of the last disarm
    var report: GuardReport? { get }
    /// gives back what `plan` picks of the dropped events (§14.9.4), while still armed
    func replay(plan: ([GuardedEvent]) -> [Int], stillThere: () -> Bool)
}

extension PersonWatching {
    public var report: GuardReport? { nil }
    public func replay(plan: ([GuardedEvent]) -> [Int], stillThere: () -> Bool) {}
}

/// What the session tier reads and writes of the Mac; LiveSessionHost does it over AX,
/// NSWorkspace and CGEvent, the tests with a fake, so the order of the steps is tested offline.
// The host's type is captured by the core's @Sendable closures; Swift 6.2 checks that its
// metatype is Sendable (SendableMetatype), which 6.0 (the box's parse check) does not know.
#if compiler(>=6.2)
public protocol SessionHostBase: AnyObject, SendableMetatype {}
#else
public protocol SessionHostBase: AnyObject {}
#endif

public protocol SessionHost: SessionHostBase {
    associatedtype Window
    func screenLocked() -> Bool
    func secureInputOn() -> Bool
    func frontmost() -> AppBrief?
    func pointer() -> ScreenPoint
    /// seconds since the last keyboard or mouse event of the HID system
    func secondsSinceInput() -> Double
    /// seconds since the last input event of the login session (the idle time Electron's
    /// powerMonitor reads), for a step's span
    func sessionIdleSeconds() -> Double
    func isRunning(pid: Int) -> Bool
    func minimized(_ w: Window) -> Bool
    func unminimize(_ w: Window) throws
    /// AXFrontmost on the app element: NSRunningApplication.activate asks for cooperative activation, which macOS refuses a background caller
    func bringForward(pid: Int32) throws
    /// AXRaise and AXMain on the window
    func raise(_ w: Window) throws
    /// the app's AXFocusedWindow is this window
    func isFocusedWindow(_ w: Window, pid: Int32) -> Bool
    /// restore: brings the recorded app back in front
    func activate(_ app: AppBrief) -> Bool
    /// restore: puts the pointer back without an event
    func warpPointer(to p: ScreenPoint)
    /// the app's focused element (AXFocusedUIElement), recorded when the person guard arms
    func focusedElement(pid: Int32) -> Window?
    /// the app's focused element is still `e`: the guard's replay goes only back where the person was typing
    func sameElement(_ e: Window, pid: Int32) -> Bool
}

extension SessionHost {
    public func sessionIdleSeconds() -> Double { secondsSinceInput() }
}

/// What the person guard recorded when it armed: the app in front and its focused element.
private struct ArmedFront<Window> {
    let app: AppBrief
    let element: Window?
}

func sessionUnavailable(_ reason: ErrorReason, _ message: String, session: SessionChange? = nil) -> ComputerFailure {
    ComputerFailure(ComputerError(kind: .sessionUnavailable, message: message, reason: reason, session: session))
}

func interruptedByPerson(session: SessionChange? = nil) -> ComputerFailure {
    ComputerFailure(ComputerError(kind: .interrupted, message: "The person took over the keyboard or mouse; the step stopped.", by: .person, session: session))
}

func cancelledFailure() -> ComputerFailure {
    ComputerFailure(.cancelled, "The call was cancelled.")
}

/// The error with what the session step changed attached (A6).
func withSession(_ error: Error, _ change: SessionChange) -> Error {
    guard let f = error as? ComputerFailure else { return error }
    let e = f.error
    return ComputerFailure(ComputerError(
        kind: e.kind, message: e.message, which: e.which, candidates: e.candidates, element: e.element, reason: e.reason,
        available: e.available, needed: e.needed, coordinate: e.coordinate, space: e.space, by: e.by,
        keyWindow: e.keyWindow, session: change
    ))
}

func isInterrupted(_ error: Error) -> Bool {
    (error as? ComputerFailure)?.error.kind == .interrupted
}

/// The session tier's order of steps, generic over the host so the tests run it on a fake:
/// refuse a locked screen or secure input, arm the watch, take the session lock, record
/// what is in front, activate and confirm, run the body at the HID tap, and on every exit
/// write the ledger and say what changed. The watch arms the person guard (§14.9), which
/// outlives the step: it ends with the restore after it, or by `GuardLife`'s rules.
final class SessionDriver<Host: SessionHost>: @unchecked Sendable {
    let host: Host
    let watch: PersonWatching
    let sessionLock: MacLock
    let clock: InputClock
    private let state = NSLock()
    private var ledger = SessionLedger()
    /// the session lock a step keeps, and keeps past it while session-tier input stays held
    private var lockHold: MacLockHold?
    /// a session step is running
    private var running = false
    /// one session step at a time in this process: the per-app queues never share the Mac
    private let steps = NSLock()
    /// the pid whose held session input keeps `lockHold` between calls
    private var holdOwner: Int32?
    /// what the engine does when the person trips the watch with no step running, or once the step
    /// that was running ended: the tokens of the calls the trip is for, and the pid of that step
    /// when it stopped for the person (its own catch lets go of what the pid held)
    var onTripBetweenCalls: (@Sendable (_ tokens: [Int], _ stoppedPid: Int32?) -> Void)?
    /// the person's trips so far: a step that waited compares it, since re-arming clears `watch.tripped`
    private var trips = 0
    /// monotonic seconds of the latest trip
    private var lastTripAt: Double?
    /// the person guard's life, and the calls in flight with their marks
    private var life = GuardLife()
    /// the escape tap's cut, cleared when a guard arms
    let cut: GuardCut
    /// each call in flight: its start, its pid
    private var calls: [Int: (startedAt: Double, pid: Int32)] = [:]
    /// what the guard recorded at arm, for the replay
    private var armedFront: ArmedFront<Host.Window>?
    private var armedIdleMs: Int?
    /// the pid of the last session step, and the call whose session step last armed the guard
    private var lastStepPid: Int32?
    private var guardToken: Int?
    /// a trip while a step ran, handed on once the step is over
    private var tripWhileRunning: [Int]?
    /// the report of a guard that ended before a restore asked for it
    private var endedReport: GuardReport?
    /// one line for the service's log (the secure-input note at arm)
    var trace: (@Sendable (String) -> Void)?

    init(host: Host, watch: PersonWatching, sessionLock: MacLock, clock: InputClock, cut: GuardCut = .shared) {
        self.host = host
        self.watch = watch
        self.sessionLock = sessionLock
        self.clock = clock
        self.cut = cut
    }

    /// A call that may use the session tier began; its token marks it until it ends.
    func callBegan(pid: Int32) -> Int {
        let now = clock.seconds()
        return state.withLock {
            let token = life.callBegan()
            calls[token] = (now, pid)
            return token
        }
    }

    func callEnded(_ token: Int) {
        let now = clock.seconds()
        state.withLock {
            calls[token] = nil
            life.callEnded(token, now: now)
        }
    }

    /// The person guard is on.
    var guardOn: Bool { state.withLock { life.on } }

    /// The pids the guard is for: every call in flight's, then the last session step's.
    var guardOwners: [Int32] {
        state.withLock {
            var out = calls.keys.sorted().compactMap { calls[$0]?.pid }
            if let p = lastStepPid { out.append(p) }
            var seen = Set<Int32>()
            return out.filter { seen.insert($0).inserted }
        }
    }

    var record: SessionRecord? { state.withLock { ledger.record } }

    /// An app came forward (NSWorkspace's activation notification).
    func noteActivation(pid: Int?) {
        state.withLock { ledger.activation(pid: pid) }
    }

    /// The watch tripped while no step ran: the engine has released the held input.
    func notePersonBetweenCalls() {
        let now = clock.seconds()
        state.withLock { ledger.personTripped(at: lastTripAt ?? now) }
    }

    /// Arms the guard and the watch for a session step of `call` on `pid`. The first step of a
    /// guard records the person's app, its focused element and the idle the replay reads.
    private func armWatch(call: SessionCall, pid: Int32) {
        let now = clock.seconds()
        let fresh = state.withLock { () -> Bool in
            let fresh = !life.on
            life.armed(now: now)
            lastStepPid = pid
            if let t = call.token { guardToken = t }
            return fresh
        }
        if fresh {
            cut.clear()
            let front = host.frontmost()
            let element = front.flatMap { host.focusedElement(pid: Int32($0.pid)) }
            state.withLock {
                var aged = call
                aged.startedAt = call.token.flatMap { calls[$0]?.startedAt }
                armedFront = front.map { ArmedFront(app: $0, element: element) }
                armedIdleMs = aged.idle(atArm: now)
            }
            // keys pass the tap and the watch unseen while it is on (§14.9.8)
            if host.secureInputOn() { trace?("[input] the person guard armed with secure input on") }
        }
        guard !watch.armed else { return }
        watch.arm { [weak self] in
            guard let self else { return }
            let at = self.clock.seconds()
            let between: [Int]? = self.state.withLock {
                self.trips += 1
                self.lastTripAt = at
                var tokens = self.life.tripped(at: at)
                if tokens.isEmpty, let t = self.guardToken { tokens = [t] }
                if self.running {
                    self.tripWhileRunning = tokens
                    return nil
                }
                return tokens
            }
            if let between { self.onTripBetweenCalls?(between, nil) }
        }
    }

    /// Lets the lock go when no step runs and nothing session-tier is held; while something is,
    /// it stays (for `owner`) until its release calls this again. The guard and its watch stay
    /// either way: they end with the restore, or by `GuardLife`'s rules (`sweepGuard`).
    func settle(holding: Bool, owner: Int32? = nil) {
        let now = clock.seconds()
        let release: MacLockHold? = state.withLock {
            guard !running else { return nil }
            life.holding(holding, now: now)
            if holding {
                // the step that started the hold owns it; another app's refused step never takes it over
                if holdOwner == nil { holdOwner = owner }
                return nil
            }
            defer {
                lockHold = nil
                holdOwner = nil
            }
            return lockHold
        }
        release?.release()
    }

    /// Ends the guard once its rules say so; the engine's 1 s sweeper calls it.
    func sweepGuard() {
        let now = clock.seconds()
        if state.withLock({ !running && life.expired(now: now) }) { endGuard() }
    }

    /// Ends the guard and disarms the watch, keeping the guard's report for the next restore.
    /// The restore calls it after the replay; so does the exit path (§16.2).
    func endGuard() {
        let wasOn = state.withLock { () -> Bool in
            defer {
                life.ended()
                armedFront = nil
                armedIdleMs = nil
                guardToken = nil
            }
            return life.on
        }
        watch.disarm()
        if wasOn, let report = watch.report { state.withLock { endedReport = report } }
    }

    /// Takes the session lock in short tries for at most 5 s, stopping for a cancel and, for a
    /// step (`watchPerson`), for the person; restore and the stale release do not watch.
    func takeLock(cancelled: () -> Bool, watchPerson: Bool = true) throws -> MacLockHold {
        let deadline = clock.seconds() + InputTiming.sessionLockWaitS
        while true {
            if watchPerson, watch.tripped { throw interruptedByPerson() }
            if cancelled() { throw cancelledFailure() }
            if let h = sessionLock.acquire(within: InputTiming.sessionLockTryS) { return h }
            if clock.seconds() >= deadline {
                throw sessionUnavailable(.inUse, "Another computer session holds the Mac's keyboard and mouse.")
            }
        }
    }

    /// Waits, for at most 5 s from `deadline`'s start, until `free` says yes; the session lock's own wait.
    private func waitFor(_ free: () -> Bool, deadline: Double, cancelled: () -> Bool, watchPerson: Bool) throws {
        while !free() {
            if watchPerson, watch.tripped { throw interruptedByPerson() }
            if cancelled() { throw cancelledFailure() }
            if clock.seconds() >= deadline { throw sessionUnavailable(.inUse, "Another computer session holds the Mac's keyboard and mouse.") }
            clock.sleep(ms: InputTiming.watchSliceMs)
        }
    }

    /// Runs one session step. `keys`: the step types or presses keys (secure input refuses it).
    /// `activate: false` skips bringing the app forward (`perform raise`, whose AX call is all it does).
    /// `holding` says, on every exit, whether session-tier input stays held, so the lock and the watch stay.
    /// `lastInput` is the step's last posted event (ticks), read once the body has returned or thrown:
    /// with the moment the watch armed it is the step's span on its change.
    /// `call`: the call the step is in; a call the person tripped the guard during answers `interrupted` before it arms.
    func run<T>(pid: Int32, window: Host.Window, keys: Bool, activate: Bool = true, call: SessionCall = SessionCall(), cancelled: @escaping () -> Bool, holding: () -> Bool, lastInput: () -> UInt64? = { nil }, body: (_ check: @escaping () throws -> Void) throws -> T) throws -> (T, SessionChange) {
        // the person came back during this call: nothing raises the app again (§14.9.5)
        if let t = call.token, state.withLock({ life.isMarked(t) }) { throw interruptedByPerson() }
        if host.screenLocked() { throw sessionUnavailable(.locked, "The screen is locked; the session tier can't use the keyboard or mouse.") }
        if keys, host.secureInputOn() {
            throw sessionUnavailable(.secureInput, "Secure input is on (a password field has focus somewhere); keys can't be sent.")
        }
        let deadline = clock.seconds() + InputTiming.sessionLockWaitS
        let tripsAtStart = state.withLock { trips }
        let mine = { self.state.withLock { self.lockHold == nil || self.holdOwner == nil || self.holdOwner == pid } }
        // a lock kept for another app's held session input: wait for its release as for another
        // holder's, outside the step mutex and the running state, so the person's trip meanwhile
        // still lets that button go (the watch stays armed while it is held)
        try waitFor(mine, deadline: deadline, cancelled: cancelled, watchPerson: true)
        try waitFor({ steps.try() }, deadline: deadline, cancelled: cancelled, watchPerson: false)
        defer { steps.unlock() }
        guard mine() else { throw sessionUnavailable(.inUse, "Another computer session holds the Mac's keyboard and mouse.") }
        // the span starts here: the system's idle before anything of the step's, then the watch
        let idleAtArm = host.sessionIdleSeconds()
        let arm = TickEpoch.now(clock)
        armWatch(call: call, pid: pid)
        state.withLock { running = true }
        var stoppedByPerson = false
        defer {
            let now = clock.seconds()
            let handOn: [Int]? = state.withLock {
                running = false
                life.stepEnded(now: now)
                defer { tripWhileRunning = nil }
                return tripWhileRunning
            }
            settle(holding: holding(), owner: pid)
            // a trip the step met, thrown or after its last check: told for every call it is for, once
            if let handOn { onTripBetweenCalls?(handOn, stoppedByPerson ? pid : nil) }
        }
        // the person took over since this step began (a trip that let a held button go, and the
        // re-arm cleared it): checked once the watch is armed, so a later trip latches instead
        if state.withLock({ trips }) != tripsAtStart {
            stoppedByPerson = true
            throw interruptedByPerson()
        }
        if state.withLock({ lockHold == nil }) {
            do {
                let h = try takeLock(cancelled: cancelled)
                state.withLock { lockHold = h }
            } catch {
                stoppedByPerson = isInterrupted(error)
                throw error
            }
        }

        let before = (host.frontmost(), host.pointer())
        state.withLock { ledger.stepBegan(frontmost: before.0, pointer: before.1, now: clock.seconds(), secondsSinceInput: host.secondsSinceInput()) }
        let check: () throws -> Void = { [watch] in
            if watch.tripped { throw interruptedByPerson() }
            if cancelled() { throw cancelledFailure() }
        }
        do {
            if activate { try self.activate(pid: pid, window: window, check: check) }
            let value = try body(check)
            let after = (host.frontmost(), host.pointer())
            state.withLock { ledger.stepEnded(frontmost: after.0, pointer: after.1, now: clock.seconds(), interrupted: false) }
            let span = SessionSpan.of(arm: arm, idleSeconds: idleAtArm, lastTicks: lastInput())
            return (value, SessionLedger.change(before: before, after: after, restorable: true, span: span))
        } catch {
            let after = (host.frontmost(), host.pointer())
            let interrupted = isInterrupted(error)
            stoppedByPerson = interrupted
            state.withLock { ledger.stepEnded(frontmost: after.0, pointer: after.1, now: clock.seconds(), interrupted: interrupted, trippedAt: interrupted ? lastTripAt : nil) }
            let span = SessionSpan.of(arm: arm, idleSeconds: idleAtArm, lastTicks: lastInput())
            throw withSession(error, SessionLedger.change(before: before, after: after, restorable: true, span: span))
        }
    }

    /// Brings the app and window forward over AX and waits until both are front and focused.
    func activate(pid: Int32, window: Host.Window, check: () throws -> Void) throws {
        if host.frontmost()?.pid == Int(pid), host.isFocusedWindow(window, pid: pid), !host.minimized(window) { return }
        try check()
        if host.minimized(window) { try host.unminimize(window) }
        try check()
        try host.bringForward(pid: pid)
        try check()
        try host.raise(window)
        let deadline = clock.seconds() + Double(InputTiming.activationMs) / 1000
        while true {
            if host.frontmost()?.pid == Int(pid), host.isFocusedWindow(window, pid: pid) {
                // a trip during the last write stops the step here, before anything is posted
                return try check()
            }
            if clock.seconds() >= deadline {
                throw sessionUnavailable(.activationRefused, "The app did not come forward with its window focused; a sheet or another window may hold focus.")
            }
            try check()
            clock.sleep(ms: InputTiming.activationPollMs)
        }
    }

    /// Whether the driver holds the session lock now (a step runs, or session input stays held).
    var holdsLock: Bool { state.withLock { lockHold != nil } }

    /// `input.restoreSession`, after the engine released the held session input: takes the lock and
    /// puts back each half the ledger allows, then forgets the record. `afterInterrupt`, within
    /// 2 s of the person's trip, skips the person check (SessionLedger.plan). Then the guard gives
    /// back the person's typing (§14.9.4), ends, and its report rides the answer.
    func restore(afterInterrupt: Bool = false, cancelled: () -> Bool = { false }) throws -> SessionRestore {
        state.withLock { life.restoreBegan() }
        var ended = false
        defer { if !ended { state.withLock { life.restoreFailed() } } }
        let deadline = clock.seconds() + InputTiming.sessionLockWaitS
        try waitFor({ steps.try() }, deadline: deadline, cancelled: cancelled, watchPerson: false)
        defer { steps.unlock() }
        // an earlier trip is the ledger's to judge, never a reason to refuse
        let already = state.withLock { lockHold }
        let hold = try already ?? takeLock(cancelled: cancelled, watchPerson: false)
        defer {
            if already == nil { hold.release() }
        }
        var plan = state.withLock {
            ledger.plan(now: clock.seconds(), secondsSinceInput: host.secondsSinceInput(), frontmost: host.frontmost(), pointer: host.pointer(), isRunning: host.isRunning(pid:), afterInterrupt: afterInterrupt)
        }
        var put: AppBrief?
        if let app = plan.activate {
            // `activate` checks the front for `activationMs`; a miss is tried once more, then told, never left silent
            if host.activate(app) || (host.isRunning(pid: app.pid) && host.activate(app)) { put = app } else { plan.frontmost = .appGone }
        }
        if let p = plan.movePointer { host.warpPointer(to: p) }
        state.withLock { ledger.clear() }
        replay(frontmost: plan.frontmost, put: put)
        endGuard()
        ended = true
        let report = state.withLock { () -> GuardReport? in
            defer { endedReport = nil }
            return endedReport
        }
        return SessionRestore(frontmost: plan.frontmost, pointer: plan.pointer, held: put, personGuard: report?.wire)
    }

    /// The person's typing back into the field they were in, when ReplayContext allows it.
    private func replay(frontmost: RestoreOutcome, put: AppBrief?) {
        let (front, idle) = state.withLock { (armedFront, armedIdleMs) }
        guard watch.armed, let front, let element = front.element, let put, put.pid == front.app.pid else { return }
        let pid = Int32(put.pid)
        let same = frontmost == .restored && host.sameElement(element, pid: pid)
        let context = ReplayContext(tripped: watch.tripped, personIdleMs: idle, frontmost: frontmost, sameElement: same)
        guard context.allows else { return }
        watch.replay(
            // read at each plan: an Escape taken during the replay still cuts it
            plan: { ReplayPlan.plan($0, cut: self.cut.value, context: context) },
            stillThere: { self.host.frontmost()?.pid == put.pid && self.host.sameElement(element, pid: pid) }
        )
    }
}
