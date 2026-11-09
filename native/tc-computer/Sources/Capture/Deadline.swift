#if canImport(ScreenCaptureKit)

import Foundation
import os

/// Runs `operation` and answers whichever comes first: its result, or `failure` once `deadline`
/// passes. A task group would wait for a capture that ignores cancellation; this does not.
func withDeadline<T: Sendable>(
    _ deadline: Duration,
    failure: any Error,
    _ operation: @escaping @Sendable () async throws -> T
) async throws -> T {
    let answered = OSAllocatedUnfairLock(initialState: false)
    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, any Error>) in
        @Sendable func answer(_ result: Result<T, any Error>) -> Bool {
            let first = answered.withLock { done in
                defer { done = true }
                return !done
            }
            if first { continuation.resume(with: result) }
            return first
        }
        let work = Task {
            do { _ = answer(.success(try await operation())) } catch { _ = answer(.failure(error)) }
        }
        Task {
            try? await Task.sleep(for: deadline)
            if answer(.failure(failure)) { work.cancel() }
        }
    }
}

#endif
