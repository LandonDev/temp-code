import ApplicationServices
import ComputerCore
import ComputerProtocol
import struct ComputerProtocol.WindowRef
import ComputerServiceKit
import Foundation

/// `mach_absolute_time`, the clock the AX reader, Input and Capture stamp their changes with.
enum MachTime {
    private static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()

    static func now() -> UInt64 { mach_absolute_time() }

    /// Milliseconds from `from` to `to`; negative when `to` is earlier.
    static func ms(from: UInt64, to: UInt64) -> Int {
        let delta = to >= from ? Double(to - from) : -Double(from - to)
        return Int((delta * Double(timebase.numer) / Double(timebase.denom) / 1_000_000).rounded(.down))
    }
}

/// What one worker keeps: the AX handles of its session × pid, which never leave its queue.
final class WorkerState: @unchecked Sendable {
    /// resolved windows, by CGWindowID
    var windows: [UInt32: AXUIElement] = [:]
    /// the session × pid's reader
    var reader: (any AppReading)?
    /// the tab a window ref matched (§25.4), by the window's CGWindowID: its element stays here
    var tabs: [UInt32: TabHandle] = [:]
}

/// One serial queue per session × pid: every AX call, element resolve and `perform` runs here, never on
/// the main thread or the cooperative pool. Only `Sendable` values come back to the request task.
final class Worker: @unchecked Sendable {
    let session: String
    let pid: pid_t
    /// one observation of this session × pid at a time (read, shot, re-read, stamp)
    let observing = AsyncGate()
    private let queue: DispatchQueue
    private let state = WorkerState()

    init(session: String, pid: pid_t) {
        self.session = session
        self.pid = pid
        self.queue = DispatchQueue(label: "tc-computer.worker.\(session).\(pid)")
    }

    func run<T: Sendable>(_ body: @escaping @Sendable (WorkerState) throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { [state] in
                do { continuation.resume(returning: try body(state)) } catch { continuation.resume(throwing: error) }
            }
        }
    }
}

/// The workers, one per session × pid.
final class Workers: @unchecked Sendable {
    private struct Key: Hashable { let session: String; let pid: pid_t }
    private let lock = NSLock()
    private var workers: [Key: Worker] = [:]

    func worker(_ session: String, _ pid: pid_t) -> Worker {
        lock.withLock {
            if let worker = workers[Key(session: session, pid: pid)] { return worker }
            let worker = Worker(session: session, pid: pid)
            workers[Key(session: session, pid: pid)] = worker
            return worker
        }
    }

    func drop(session: String) {
        lock.withLock { workers = workers.filter { $0.key.session != session } }
    }

    func drop(pid: pid_t) {
        lock.withLock { workers = workers.filter { $0.key.pid != pid } }
    }
}

/// One app's action slot (docs/computer-protocol.md §1): actions take it exclusively in arrival order,
/// reads take it shared and wait for a running or queued action. A session holding a button down is the
/// slot's sticky owner until the button is let go: its own actions go through, other sessions' wait.
final class AppSlot: @unchecked Sendable {
    enum Mode: Equatable {
        case shared
        case exclusive(session: String)
    }

    private struct Waiter {
        let id: UInt64
        let mode: Mode
        let continuation: CheckedContinuation<Bool, Never>
    }

    private let lock = NSLock()
    private var readers = 0
    private var writer: String?
    private var sticky: String?
    private var queue: [Waiter] = []
    private var nextID: UInt64 = 0

    /// The session holding the slot exclusively now.
    var holder: String? { lock.withLock { writer } }

    /// The session that holds a button on this app.
    var stickyOwner: String? { lock.withLock { sticky } }

    func setSticky(_ session: String?) {
        lock.withLock { sticky = session }
        pump()
    }

    /// Waits for the slot; nil when `timeout` passed first or the task was cancelled.
    func acquire(_ mode: Mode, timeout: Duration?) async -> SlotLease? {
        let id: UInt64 = lock.withLock {
            nextID += 1
            return nextID
        }
        let got = await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                lock.withLock { queue.append(Waiter(id: id, mode: mode, continuation: continuation)) }
                pump()
                // a cancel that landed before the waiter was queued found nothing to remove
                if Task.isCancelled { give_up(id) }
                if let timeout {
                    Task { [weak self] in
                        try? await Task.sleep(for: timeout)
                        self?.give_up(id)
                    }
                }
            }
        } onCancel: {
            give_up(id)
        }
        return got ? SlotLease(slot: self, mode: mode) : nil
    }

    fileprivate func release(_ mode: Mode) {
        lock.withLock {
            switch mode {
            case .shared: readers -= 1
            case .exclusive: writer = nil
            }
        }
        pump()
    }

    private func give_up(_ id: UInt64) {
        let waiter: Waiter? = lock.withLock {
            guard let at = queue.firstIndex(where: { $0.id == id }) else { return nil }
            return queue.remove(at: at)
        }
        waiter?.continuation.resume(returning: false)
        if waiter != nil { pump() }
    }

    /// Grants in arrival order: an exclusive waiter when nothing holds the slot, consecutive shared
    /// waiters while no action does. A waiter blocked by another session's sticky hold is skipped, so
    /// it never blocks the owner or the reads behind it.
    private func pump() {
        var granted: [CheckedContinuation<Bool, Never>] = []
        lock.withLock {
            var at = 0
            while at < queue.count {
                let waiter = queue[at]
                switch waiter.mode {
                case .exclusive(let session):
                    if let sticky, sticky != session {
                        at += 1
                        continue
                    }
                    if writer == nil && readers == 0 {
                        writer = session
                        granted.append(queue.remove(at: at).continuation)
                    }
                    return
                case .shared:
                    guard writer == nil else { return }
                    readers += 1
                    granted.append(queue.remove(at: at).continuation)
                }
            }
        }
        for continuation in granted { continuation.resume(returning: true) }
    }
}

final class SlotLease: @unchecked Sendable {
    private let slot: AppSlot
    private let mode: AppSlot.Mode
    private let lock = NSLock()
    private var held = true

    fileprivate init(slot: AppSlot, mode: AppSlot.Mode) {
        self.slot = slot
        self.mode = mode
    }

    /// Idempotent.
    func release() {
        let was: Bool = lock.withLock {
            defer { held = false }
            return held
        }
        if was { slot.release(mode) }
    }

    deinit { release() }
}

/// The slots, one per pid.
final class AppSlots: @unchecked Sendable {
    private let lock = NSLock()
    private var slots: [pid_t: AppSlot] = [:]

    func slot(_ pid: pid_t) -> AppSlot {
        lock.withLock {
            if let slot = slots[pid] { return slot }
            let slot = AppSlot()
            slots[pid] = slot
            return slot
        }
    }

    func existing(_ pid: pid_t) -> AppSlot? { lock.withLock { slots[pid] } }
}
