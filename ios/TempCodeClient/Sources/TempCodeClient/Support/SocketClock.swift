import Foundation
import Synchronization

/// Time and randomness as the connection code sees them, injectable so the
/// tests run the backoff and the probes on a clock they advance by hand.
/// Mirrors the desktop runtime's `Clock` (src/renderer/src/lib/connection/
/// supervisor.ts). `now` is milliseconds; on the system clock it is the
/// wall clock, so `EnvironmentStatus.nextRetryAt` turns into a `Date` directly.
public protocol SocketClock: Sendable {
    /// Milliseconds. The wall clock in production, a counter in tests.
    var now: Double { get }
    /// Suspends for `ms`, throwing `CancellationError` if the task is cancelled.
    func sleep(ms: Double) async throws
    /// Uniform in `0..<1`, for the backoff's jitter.
    func random() -> Double
}

/// The production clock: wall time, `Task.sleep`, `Double.random`.
public struct SystemClock: SocketClock {
    public init() {}

    public var now: Double { Date().timeIntervalSince1970 * 1000 }

    public func sleep(ms: Double) async throws {
        guard ms > 0 else { return }
        try await Task.sleep(for: .milliseconds(ms))
    }

    public func random() -> Double { Double.random(in: 0..<1) }
}

/// A clock the tests drive: `now` moves only through `advance(ms:)`, which
/// resumes every sleeper whose deadline it reaches, earliest first.
public final class ManualClock: SocketClock {
    private struct Sleeper {
        let id: Int
        let deadline: Double
        let continuation: CheckedContinuation<Void, any Error>
    }

    private struct State {
        var now: Double
        var nextId = 0
        var sleepers: [Sleeper] = []
        var randomValues: [Double] = []
    }

    private let state: Mutex<State>

    /// - Parameters:
    ///   - now: the starting time in milliseconds.
    ///   - random: what `random()` answers, in order; the last value repeats.
    public init(now: Double = 0, random: [Double] = [0.5]) {
        state = Mutex(State(now: now, randomValues: random))
    }

    public var now: Double { state.withLock { $0.now } }

    /// Sleepers waiting on a deadline, for tests that assert a timer is armed.
    public var pendingSleeps: Int { state.withLock { $0.sleepers.count } }

    public func random() -> Double {
        state.withLock { state in
            if state.randomValues.count > 1 { return state.randomValues.removeFirst() }
            return state.randomValues.first ?? 0.5
        }
    }

    public func sleep(ms: Double) async throws {
        let deadline = now + max(0, ms)
        if ms <= 0 {
            await Task.yield()
            return
        }
        let id = state.withLock { state in
            state.nextId += 1
            return state.nextId
        }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                let dueNow = state.withLock { state -> Bool in
                    if deadline <= state.now { return true }
                    state.sleepers.append(Sleeper(id: id, deadline: deadline, continuation: continuation))
                    return false
                }
                if dueNow { continuation.resume() }
            }
        } onCancel: {
            let cancelled = state.withLock { state -> Sleeper? in
                guard let index = state.sleepers.firstIndex(where: { $0.id == id }) else { return nil }
                return state.sleepers.remove(at: index)
            }
            cancelled?.continuation.resume(throwing: CancellationError())
        }
    }

    /// Moves time forward and wakes every sleeper due by then, earliest first.
    /// Each wake-up yields so the woken task runs before the next deadline fires.
    public func advance(ms: Double) async {
        // Let tasks that were just started arm their timers before time moves.
        await settle()
        let target = now + ms
        while true {
            let next = state.withLock { state -> Sleeper? in
                let due = state.sleepers.filter { $0.deadline <= target }
                guard let first = due.min(by: { ($0.deadline, $0.id) < ($1.deadline, $1.id) }) else {
                    state.now = target
                    return nil
                }
                state.sleepers.removeAll { $0.id == first.id }
                state.now = max(state.now, first.deadline)
                return first
            }
            guard let next else { return }
            next.continuation.resume()
            // Let the woken task run up to its next suspension point.
            for _ in 0..<8 { await Task.yield() }
        }
    }

    /// Lets every task that is ready run, without moving time.
    public func settle() async {
        for _ in 0..<16 { await Task.yield() }
    }
}
