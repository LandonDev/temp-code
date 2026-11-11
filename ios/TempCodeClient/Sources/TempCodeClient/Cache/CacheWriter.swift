import Foundation

/// The one road to the session cache for everything a client writes. Each
/// write is queued in the order the client applied its change and runs
/// after the one before it, off the main actor: the push loop waits on no
/// disk write, and a page that clears a thread's rows (`reset`) can never
/// land after the newer rows pushed behind it.
final class CacheWriter: Sendable {
    typealias Write = @Sendable (SessionCache) async -> Void

    private let writes: AsyncStream<Write>.Continuation

    init(cache: SessionCache) {
        let (stream, writes) = AsyncStream.makeStream(of: Write.self)
        self.writes = writes
        Task {
            for await write in stream { await write(cache) }
        }
    }

    deinit {
        writes.finish()
    }

    /// Queues a write behind every one queued before it.
    func write(_ body: @escaping Write) {
        writes.yield(body)
    }

    /// Returns once everything queued before this call is written: a read
    /// of the cache that must see those writes waits here first.
    func drained() async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            writes.yield { _ in done.resume() }
        }
    }
}
