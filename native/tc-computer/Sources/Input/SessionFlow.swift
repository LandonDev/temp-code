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
    /// the session lock a step or a held session input keeps
    private var lockHold: MacLockHold?
    /// a session step is running
    private var running = false
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

    /// Lets the watch and the lock go when no step runs and nothing session-tier is held.
    func settle(holding: Bool) {
        let release: MacLockHold? = state.withLock {
            guard !running, !holding else { return nil }
            defer { lockHold = nil }
            return lockHold
        }
        release?.release()
        if !holding, !state.withLock({ running }) { watch.disarm() }
    }

    /// Takes the session lock in short tries for at most 5 s, stopping for the person or a cancel.
    func takeLock(cancelled: () -> Bool) throws -> MacLockHold {
        let deadline = clock.seconds() + InputTiming.sessionLockWaitS
        while true {
            if watch.tripped { throw interruptedByPerson() }
            if cancelled() { throw cancelledFailure() }
            if let h = sessionLock.acquire(within: InputTiming.sessionLockTryS) { return h }
            if clock.seconds() >= deadline {
                throw sessionUnavailable(.inUse, "Another computer session holds the Mac's keyboard and mouse.")
            }
        }
    }

    /// Runs one session step. `keys`: the step types or presses keys (secure input refuses it).
    /// `holds`: the body left a session-tier button down, so the lock and the watch stay.
    func run<T>(pid: Int32, window: Host.Window, keys: Bool, cancelled: @escaping () -> Bool, body: (_ check: @escaping () throws -> Void) throws -> (T, holds: Bool)) throws -> (T, SessionChange) {
        if host.screenLocked() { throw sessionUnavailable(.locked, "The screen is locked; the session tier can't use the keyboard or mouse.") }
        if keys, host.secureInputOn() {
            throw sessionUnavailable(.secureInput, "Secure input is on (a password field has focus somewhere); keys can't be sent.")
        }
        armWatch()
        state.withLock { running = true }
        var holds = false
        defer {
            state.withLock { running = false }
            settle(holding: holds)
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
            try activate(pid: pid, window: window, check: check)
            let (value, held) = try body(check)
            holds = held
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
            if host.frontmost()?.pid == Int(pid), host.isFocusedWindow(window, pid: pid) { return }
            if clock.seconds() >= deadline {
                throw sessionUnavailable(.activationRefused, "The app did not come forward with its window focused; a sheet or another window may hold focus.")
            }
            try check()
            clock.sleep(ms: InputTiming.activationPollMs)
        }
    }

    /// Hands the step's lock to a session-tier hold that outlives the call; the hold releases it.
    func lockForHold() -> MacLockHold? {
        state.withLock {
            defer { lockHold = nil }
            return lockHold
        }
    }

    /// `input.restoreSession`, after the engine released every held input: takes the lock and
    /// puts back each half the ledger allows, then forgets the record.
    func restore(cancelled: () -> Bool = { false }) throws -> SessionRestore {
        let already = state.withLock { lockHold }
        let hold = try already ?? takeLock(cancelled: cancelled)
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
