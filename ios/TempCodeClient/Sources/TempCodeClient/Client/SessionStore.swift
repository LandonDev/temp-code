import Foundation
import Observation
import TempCodeContract

/// One session's meta, observed on its own: a reader of this slot runs
/// again when this session's meta changes, and for no other's. A slot is
/// made at the first read of an id, listed yet or not, so a screen opened
/// before its thread's meta arrives hears the arrival.
@MainActor @Observable
final class SessionSlot {
    var meta: SessionMeta?

    init(_ meta: SessionMeta?) {
        self.meta = meta
    }
}

/// A value worked out from the sessions for one thread's screen (its
/// children, its agents cue, a paused master's batch count), observed on
/// its own and assigned only when it changed: a meta that leaves the answer
/// as it was wakes none of its readers.
@MainActor @Observable
final class SessionProjection<Value: Equatable> {
    private(set) var value: Value
    @ObservationIgnored private let compute: @MainActor ([SessionMeta]) -> Value

    init(_ sessions: [SessionMeta], _ compute: @escaping @MainActor ([SessionMeta]) -> Value) {
        self.compute = compute
        value = compute(sessions)
    }

    func refresh(_ sessions: [SessionMeta]) {
        let next = compute(sessions)
        if next != value { value = next }
    }
}

/// The host's sessions as the client holds them, current the moment a meta
/// lands and outside observation: by id, and newest first (ids breaking
/// ties, the order the cache reads back). Everything in the client that
/// must act on the meta as it is now reads here. What the screens observe
/// hangs off it: a slot per id read, and the projections a thread's screen
/// asks for. The list screens read `EnvironmentClient.listedSessions`,
/// which may trail this by a quarter of a second.
@MainActor
final class SessionStore {
    private(set) var byId: [String: SessionMeta] = [:]
    private(set) var sorted: [SessionMeta] = []
    private var slots: [String: SessionSlot] = [:]
    private var refreshers: [@MainActor ([SessionMeta]) -> Void] = []

    /// The slot for `id`, made at the first ask.
    func slot(_ id: String) -> SessionSlot {
        if let held = slots[id] { return held }
        let made = SessionSlot(byId[id])
        slots[id] = made
        return made
    }

    /// A projection that follows the store from here on.
    func project<Value: Equatable>(_ compute: @escaping @MainActor ([SessionMeta]) -> Value) -> SessionProjection<Value> {
        let projection = SessionProjection(sorted, compute)
        refreshers.append { [weak projection] sessions in projection?.refresh(sessions) }
        return projection
    }

    /// Everything, replaced (the cache's paint, a forgotten host).
    func replace(_ metas: [SessionMeta]) {
        sorted = metas
        byId = Dictionary(metas.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for (id, slot) in slots where slot.meta != byId[id] { slot.meta = byId[id] }
        refresh()
    }

    /// One meta in: it takes its place by the order, and its slot hears it.
    /// Answers the meta it replaced. The caller calls `refresh` once its
    /// batch is in.
    @discardableResult
    func put(_ meta: SessionMeta) -> SessionMeta? {
        let held = byId[meta.id]
        if let held, let at = position(of: held) { sorted.remove(at: at) }
        sorted.insert(meta, at: place(for: meta))
        byId[meta.id] = meta
        slots[meta.id]?.meta = meta
        return held
    }

    func remove(_ ids: Set<String>) {
        sorted.removeAll { ids.contains($0.id) }
        for id in ids {
            byId[id] = nil
            if let slot = slots[id], slot.meta != nil { slot.meta = nil }
        }
        refresh()
    }

    /// The projections catch up with the store.
    func refresh() {
        for refresh in refreshers { refresh(sorted) }
    }

    /// The list's order: newest first, ids breaking ties.
    private static func precedes(_ a: SessionMeta, _ b: SessionMeta) -> Bool {
        (a.updatedAt, a.id) > (b.updatedAt, b.id)
    }

    /// Where `meta` goes in the order.
    private func place(for meta: SessionMeta) -> Int {
        var low = 0
        var high = sorted.count
        while low < high {
            let middle = (low + high) / 2
            if Self.precedes(sorted[middle], meta) { low = middle + 1 } else { high = middle }
        }
        return low
    }

    /// Where the held meta sits: its place by the order, else wherever a walk finds its id.
    private func position(of held: SessionMeta) -> Int? {
        let at = place(for: held)
        if at < sorted.count, sorted[at].id == held.id { return at }
        return sorted.firstIndex { $0.id == held.id }
    }
}
