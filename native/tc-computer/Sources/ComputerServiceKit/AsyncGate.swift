import Foundation

/// One body at a time, in arrival order, across tasks: the observation of one session × app (a read, its
/// shot, a re-read and its stamp) is one transaction, so `seq` and `base` count only what the host gets.
public final class AsyncGate: @unchecked Sendable {
    private let lock = NSLock()
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    public init() {}

    public func run<T>(_ body: () async throws -> T) async rethrows -> T {
        await enter()
        defer { leave() }
        return try await body()
    }

    private func enter() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let go: Bool = lock.locked {
                if busy {
                    waiters.append(continuation)
                    return false
                }
                busy = true
                return true
            }
            if go { continuation.resume() }
        }
    }

    private func leave() {
        let next: CheckedContinuation<Void, Never>? = lock.locked {
            if waiters.isEmpty {
                busy = false
                return nil
            }
            return waiters.removeFirst()
        }
        next?.resume()
    }
}
