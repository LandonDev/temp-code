import Foundation
import TempCodeContract

/// The host's read marks on the phone (CLAUDE.md "Read and unread: the
/// host's mark"; docs/IOS-DESIGN.md "Unread"). A host that keeps them sends
/// `readAt` on every thread's meta, and a thread reads unread while its
/// `updatedAt` is past that mark, on the phone, the Mac and the box alike.
/// This is the pure part `EnvironmentClient` keeps: what the phone has to
/// send, what it sent and has not heard back, and the seen map every rule
/// reads. A host that sends no `readAt` leaves the phone's own marks the answer.
public struct ReadMarks: Sendable, Equatable {
    /// What the phone sent and the host has not echoed yet, by thread.
    public private(set) var pending: [String: Int] = [:]
    /// What waits to be sent, by thread.
    public private(set) var queued: [String: Int] = [:]

    public init() {}

    /// The person saw the thread up to `at` (as it stands when nil). True
    /// when there is something to send: the host keeps marks and its mark,
    /// or what is already on its way, is behind.
    public mutating func read(_ meta: SessionMeta, at: Int? = nil) -> Bool {
        guard let host = meta.readAt else { return false }
        let mark = min(at ?? meta.updatedAt, meta.updatedAt)
        guard mark > max(host, pending[meta.id] ?? -1) else { return false }
        pending[meta.id] = mark
        queued[meta.id] = mark
        return true
    }

    /// A meta from the host: an echo of what was sent clears the cover; a
    /// host that keeps no marks takes nothing.
    public mutating func heard(_ meta: SessionMeta) {
        guard let want = pending[meta.id] else { return }
        guard let host = meta.readAt else {
            pending[meta.id] = nil
            queued[meta.id] = nil
            return
        }
        if host >= min(want, meta.updatedAt) { pending[meta.id] = nil }
    }

    /// Everything queued, as one request's items; the queue empties.
    public mutating func take() -> [Methods.SessionMarkRead.Params.Item] {
        let items = queued.sorted { $0.key < $1.key }.map { Methods.SessionMarkRead.Params.Item(sessionId: $0.key, at: $0.value) }
        queued = [:]
        return items
    }

    /// A request that did not land: its marks wait for the next try, unless a newer one took their place.
    public mutating func requeue(_ items: [Methods.SessionMarkRead.Params.Item]) {
        for item in items {
            guard let at = item.at else { continue }
            if (queued[item.sessionId] ?? -1) < at { queued[item.sessionId] = at }
        }
    }

    public mutating func forget(_ ids: some Sequence<String>) {
        for id in ids {
            pending[id] = nil
            queued[id] = nil
        }
    }

    /// The seen map the rules read (`ThreadGroups.isUnseen`, the batch
    /// switches): a thread whose host keeps marks reads the host's, covered
    /// by what this phone sent; the rest, and the thread on screen, read the
    /// phone's own.
    public func merged(local: [String: SeenMark], sessions: [SessionMeta], visible: String?) -> [String: SeenMark] {
        var out = local
        for meta in sessions {
            guard let host = meta.readAt, meta.id != visible else { continue }
            out[meta.id] = SeenMark(at: max(host, pending[meta.id] ?? 0), seq: local[meta.id]?.seq ?? 0)
        }
        return out
    }
}
