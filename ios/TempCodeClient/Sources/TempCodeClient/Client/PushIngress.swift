import Foundation
import TempCodeContract

/// Where the pushes that change threads and the session list wait to be
/// applied together. The host sends each row of the thread on screen as
/// its own frame; applied one by one, each was a main-actor turn and a
/// SwiftUI update of its own. Here the first push after a quiet window is
/// applied at once (a lone row waits for nothing) and opens a window of
/// `windowMs`; pushes that arrive inside it are applied together when it
/// closes, in one synchronous block, and a window that closes on waiting
/// pushes opens the next. So a stream costs one write per thread and one
/// update per window, and what the reader sees is at most a window late.
///
/// Order is kept: the block walks the queue as it arrived and merges only
/// neighbours (`merged`). Anything whose order against rows matters and
/// that does not ride the queue empties it first (`flush`): a page, a
/// resume's read of the cursor, a resync, a removal, a move, the workspace
/// and project lists, a new socket. A socket that closed drops it (`drop`):
/// its rows came from the dead socket and must mark no thread live.
@MainActor
final class PushIngress {
    enum Item: Sendable, Equatable {
        case events(sessionId: String, rows: [EventRow])
        case liveEdits([LiveEdit])
        case sessions([SessionMeta])
    }

    /// One display interval: two frames of a 120 Hz phone.
    static let windowMs: Double = 16

    /// Applies a block of merged items; the client's.
    var land: @MainActor ([Item]) -> Void = { _ in }

    private var queue: [Item] = []
    /// When the open window opened, on `now`'s clock.
    private var opened: Double?
    private var closing: Task<Void, Never>?
    private let now: @MainActor () -> Double
    private let sleep: @Sendable (Double) async -> Void

    /// `now` in milliseconds and `sleep` for as many: the wall clock unless a test hands its own.
    init(now: @escaping @MainActor () -> Double = { Date().timeIntervalSinceReferenceDate * 1_000 },
         sleep: @escaping @Sendable (Double) async -> Void = { try? await Task.sleep(for: .milliseconds($0)) }) {
        self.now = now
        self.sleep = sleep
    }

    /// A push arrives.
    func take(_ item: Item) {
        queue.append(item)
        let time = now()
        if let opened, time >= opened, time - opened < Self.windowMs {
            guard closing == nil else { return }
            let wait = Self.windowMs - (time - opened)
            closing = Task { [weak self, sleep] in
                await sleep(wait)
                self?.close()
            }
            return
        }
        opened = time
        deliver()
    }

    /// Everything waiting is applied now: what follows must find it applied.
    func flush() {
        deliver()
    }

    /// Everything waiting is forgotten.
    func drop() {
        queue = []
        closing?.cancel()
        closing = nil
    }

    /// Pushes waiting for their window (a test's seam).
    var waiting: Int { queue.count }

    private func close() {
        closing = nil
        guard !queue.isEmpty else { return }
        opened = now()
        deliver()
    }

    private func deliver() {
        guard !queue.isEmpty else { return }
        let items = Self.merged(queue)
        queue = []
        land(items)
    }

    /// The queue as one block, in its order, neighbours merged: rows for one
    /// thread into one batch, live edits into one list, session pushes into
    /// one (`collapsed`). Rows for a thread on either side of another push
    /// stay two batches: nothing moves past anything.
    static func merged(_ items: [Item]) -> [Item] {
        var out: [Item] = []
        for item in items {
            switch (out.last, item) {
            case (.events(let id, let rows)?, .events(let next, let more)) where id == next:
                out[out.count - 1] = .events(sessionId: id, rows: rows + more)
            case (.liveEdits(let edits)?, .liveEdits(let more)):
                out[out.count - 1] = .liveEdits(edits + more)
            case (.sessions(let metas)?, .sessions(let more)):
                out[out.count - 1] = .sessions(collapsed(metas + more))
            default:
                out.append(item)
            }
        }
        return out
    }

    /// The newest meta per session, except that a meta whose status differs
    /// from the one before it for the same session is kept beside it: a
    /// `running` then `idle` inside one window must both be seen, in order
    /// (the click's clock and the Live Activity act on the first).
    static func collapsed(_ metas: [SessionMeta]) -> [SessionMeta] {
        var out: [SessionMeta] = []
        var last: [String: Int] = [:]
        for meta in metas {
            if let at = last[meta.id], out[at].status == meta.status {
                out[at] = meta
            } else {
                last[meta.id] = out.count
                out.append(meta)
            }
        }
        return out
    }
}

extension ThreadFold {
    /// A window's live edits for this thread in one write: each merged into
    /// the state kept by its path and stamped on its running edit, in order.
    /// True when an item changed.
    @discardableResult
    public mutating func applyLiveEdits(_ edits: [LiveEdit.Edit]) -> Bool {
        var changed = false
        for edit in edits {
            if applyLiveEdit(edit) { changed = true }
        }
        return changed
    }
}
