import Foundation

/// One body at a time, in arrival order, across tasks: the observation of one session × app (a read, its
/// shot, a re-read and its stamp) is one transaction, so `seq` and `base` count only what the host gets.
/// A task cancelled while it waits leaves the line at once and never runs its body.
public final class AsyncGate: @unchecked Sendable {
    private struct Waiter {
        let id: UInt64
        /// true: it holds the gate; false: a cancel took it out of line
        let continuation: CheckedContinuation<Bool, Never>
    }

    private let lock = NSLock()
    private var busy = false
    private var waiters: [Waiter] = []
    private var nextID: UInt64 = 0

    public init() {}

    /// Throws `CancellationError` when the task is cancelled before its body starts.
    public func run<T>(_ body: () async throws -> T) async throws -> T {
        guard await enter() else { throw CancellationError() }
        defer { leave() }
        try Task.checkCancellation()
        return try await body()
    }

    private func enter() async -> Bool {
        let id: UInt64 = lock.locked {
            nextID += 1
            return nextID
        }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                let go: Bool = lock.locked {
                    if busy {
                        waiters.append(Waiter(id: id, continuation: continuation))
                        return false
                    }
                    busy = true
                    return true
                }
                if go {
                    continuation.resume(returning: true)
                } else if Task.isCancelled {
                    // a cancel that landed before the waiter was queued found nothing to take out
                    outOfLine(id)
                }
            }
        } onCancel: {
            outOfLine(id)
        }
    }

    private func outOfLine(_ id: UInt64) {
        let waiter: Waiter? = lock.locked {
            guard let at = waiters.firstIndex(where: { $0.id == id }) else { return nil }
            return waiters.remove(at: at)
        }
        waiter?.continuation.resume(returning: false)
    }

    private func leave() {
        let next: Waiter? = lock.locked {
            if waiters.isEmpty {
                busy = false
                return nil
            }
            return waiters.removeFirst()
        }
        next?.continuation.resume(returning: true)
    }
}
