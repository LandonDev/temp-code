import ComputerCore
import ComputerProtocol
import ComputerServiceKit
import Foundation

/// A `MacLock` over the shell's `MacLocks` (input A11): Input takes it, the shell traces it.
class FlockMacLock: MacLock, @unchecked Sendable {
    let name: MacLockName
    let locks: MacLocks
    let trace: Trace?

    init(_ name: MacLockName, locks: MacLocks, trace: Trace?) {
        self.name = name
        self.locks = locks
        self.trace = trace
    }

    func acquire(within seconds: Double) -> (any MacLockHold)? {
        let start = ContinuousClock.now
        let lease = locks.acquire(name, timeout: .milliseconds(Int((seconds * 1_000).rounded())))
        trace?.lockTaken(name.rawValue, waitedMs: Int((ContinuousClock.now - start) / .milliseconds(1)), got: lease != nil)
        guard let lease else { return nil }
        held(true)
        return Hold(lease: lease) { [self] heldFor in
            trace?.lockReleased(name.rawValue, heldMs: Int(heldFor / .milliseconds(1)))
            held(false)
            released(after: heldFor)
        }
    }

    /// A hold began (true) or ended (false).
    func held(_ on: Bool) {}

    func released(after: Duration) {}

    final class Hold: MacLockHold, @unchecked Sendable {
        private let lease: MacLockLease
        private let onRelease: @Sendable (Duration) -> Void
        private let lock = NSLock()
        private var released = false

        init(lease: MacLockLease, onRelease: @escaping @Sendable (Duration) -> Void) {
            self.lease = lease
            self.onRelease = onRelease
        }

        func release() {
            let first: Bool = lock.withLock {
                defer { released = true }
                return !released
            }
            guard first else { return }
            let heldFor = ContinuousClock.now - lease.acquiredAt
            lease.release()
            onRelease(heldFor)
        }

        deinit { release() }
    }
}

/// The pasteboard's lock. Its holds tell the pasteboard watch which changes are the service's own, and
/// one held past 2.5 s is logged: nothing force-releases a paste in progress. Each edge of a hold looks
/// at the pasteboard (`look`): as a hold begins, a change since the last look is foreign unless an
/// earlier hold of this service could have made it; as it ends, a change is the paste's own. So a copy
/// made between two pastes, or while a paste waited for the lock, is never taken for the service's.
final class ClipboardMacLock: FlockMacLock, @unchecked Sendable {
    private let state = NSLock()
    private var holding = 0
    private var heldSincePoll = false
    private let warn: @Sendable (String) -> Void
    private let look: @Sendable (_ own: Bool) -> Void

    init(locks: MacLocks, trace: Trace?, warn: @escaping @Sendable (String) -> Void, look: @escaping @Sendable (_ own: Bool) -> Void = { _ in }) {
        self.warn = warn
        self.look = look
        super.init(.clipboard, locks: locks, trace: trace)
    }

    override func held(_ on: Bool) {
        if on {
            look(takeHeldSincePoll())
            state.withLock {
                holding += 1
                heldSincePoll = true
            }
        } else {
            state.withLock { holding -= 1 }
            look(true)
            state.withLock { heldSincePoll = holding > 0 }
        }
    }

    override func released(after heldFor: Duration) {
        if heldFor > .milliseconds(ComputerDefaults.Locks.clipboardHoldMaxMs) {
            warn("the clipboard lock was held for \(Int(heldFor / .milliseconds(1))) ms, past \(ComputerDefaults.Locks.clipboardHoldMaxMs) ms")
        }
    }

    /// Whether this service held the lock at any moment since the last call (the pasteboard poll's question).
    func takeHeldSincePoll() -> Bool {
        state.withLock {
            let was = heldSincePoll || holding > 0
            heldSincePoll = false
            return was
        }
    }
}

/// The real pointer and keyboard's lock: held for a whole `session`-tier step, and while a
/// `session`-tier button or key stays down.
final class SessionMacLock: FlockMacLock, @unchecked Sendable {
    init(locks: MacLocks, trace: Trace?) {
        super.init(.session, locks: locks, trace: trace)
    }
}
