import ComputerCore
import ComputerProtocol
import Foundation

/// The person watch: armed from a session step's start until it ends, and longer while
/// session-tier input stays held. Any input event without TC_EVENT_MARK trips it.
public protocol PersonWatching: AnyObject, Sendable {
    /// Arms the watch, clearing an earlier trip; `onTrip` runs once at the person's first event, on any thread.
    func arm(onTrip: @escaping @Sendable () -> Void)
    func disarm()
    var armed: Bool { get }
    var tripped: Bool { get }
}

/// What the session tier reads and writes of the Mac; LiveSessionHost does it over AX,
/// NSWorkspace and CGEvent, the tests with a fake, so the order of the steps is tested offline.
public protocol SessionHost: AnyObject {
    associatedtype Window
    func screenLocked() -> Bool
    func secureInputOn() -> Bool
    func frontmost() -> AppBrief?
    func pointer() -> ScreenPoint
    /// seconds since the last keyboard or mouse event of the HID system
    func secondsSinceInput() -> Double
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
/// write the ledger and say what changed.
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
    /// what the engine does when the person trips the watch between calls
    var onTripBetweenCalls: (@Sendable () -> Void)?

    init(host: Host, watch: PersonWatching, sessionLock: MacLock, clock: InputClock) {
        self.host = host
        self.watch = watch
        self.sessionLock = sessionLock
        self.clock = clock
    }

    var record: SessionRecord? { state.withLock { ledger.record } }

    /// An app came forward (NSWorkspace's activation notification).
    func noteActivation() {
        state.withLock { ledger.activation() }
    }

    /// The watch tripped while no step ran: the engine has released the held input.
    func notePersonBetweenCalls() {
        state.withLock { ledger.personTripped() }
    }

    private func armWatch() {
        guard !watch.armed else { return }
        watch.arm { [weak self] in
            guard let self else { return }
            let between = self.state.withLock { !self.running }
            if between { self.onTripBetweenCalls?() }
        }
    }

    /// Lets the watch and the lock go when no step runs and nothing session-tier is held;
    /// while something is, both stay (for `owner`) until its release calls this again.
    func settle(holding: Bool, owner: Int32? = nil) {
        let release: MacLockHold? = state.withLock {
            guard !running else { return nil }
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
        if !holding, !state.withLock({ running }) { watch.disarm() }
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
    func run<T>(pid: Int32, window: Host.Window, keys: Bool, activate: Bool = true, cancelled: @escaping () -> Bool, holding: () -> Bool, body: (_ check: @escaping () throws -> Void) throws -> T) throws -> (T, SessionChange) {
        if host.screenLocked() { throw sessionUnavailable(.locked, "The screen is locked; the session tier can't use the keyboard or mouse.") }
        if keys, host.secureInputOn() {
            throw sessionUnavailable(.secureInput, "Secure input is on (a password field has focus somewhere); keys can't be sent.")
        }
        let deadline = clock.seconds() + InputTiming.sessionLockWaitS
        let mine = { self.state.withLock { self.lockHold == nil || self.holdOwner == nil || self.holdOwner == pid } }
        // a lock kept for another app's held session input: wait for its release as for another
        // holder's, outside the step mutex and the running state, so the person's trip meanwhile
        // still lets that button go (the watch stays armed while it is held)
        try waitFor(mine, deadline: deadline, cancelled: cancelled, watchPerson: true)
        try waitFor({ steps.try() }, deadline: deadline, cancelled: cancelled, watchPerson: false)
        defer { steps.unlock() }
        guard mine() else { throw sessionUnavailable(.inUse, "Another computer session holds the Mac's keyboard and mouse.") }
        armWatch()
        state.withLock { running = true }
        defer {
            state.withLock { running = false }
            settle(holding: holding(), owner: pid)
        }
        if state.withLock({ lockHold == nil }) {
            let h = try takeLock(cancelled: cancelled)
            state.withLock { lockHold = h }
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
            return (value, SessionLedger.change(before: before, after: after, restorable: true))
        } catch {
            let after = (host.frontmost(), host.pointer())
            state.withLock { ledger.stepEnded(frontmost: after.0, pointer: after.1, now: clock.seconds(), interrupted: isInterrupted(error)) }
            throw withSession(error, SessionLedger.change(before: before, after: after, restorable: true))
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

    /// `input.restoreSession`, after the engine released every held input: takes the lock and
    /// puts back each half the ledger allows, then forgets the record.
    func restore(cancelled: () -> Bool = { false }) throws -> SessionRestore {
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
            ledger.plan(now: clock.seconds(), secondsSinceInput: host.secondsSinceInput(), frontmost: host.frontmost(), pointer: host.pointer(), isRunning: host.isRunning(pid:))
        }
        var put: AppBrief?
        if let app = plan.activate {
            if host.activate(app) { put = app } else { plan.frontmost = .appGone }
        }
        if let p = plan.movePointer { host.warpPointer(to: p) }
        state.withLock { ledger.clear() }
        return SessionRestore(frontmost: plan.frontmost, pointer: plan.pointer, held: put)
    }
}
