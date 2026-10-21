import Foundation
import TempCodeContract

/// What the owner of one transcript gives the subscription set: where its
/// fold is, and how to take a page. `page.reset` is D2's rule: the gap
/// outgrew the replay budget and the host sent a fresh tail, so the owner
/// throws its fold away before folding the rows.
public struct SubscriptionHandlers: Sendable {
    /// The highest seq folded so far; the resume asks for what follows it.
    public var cursor: @MainActor @Sendable () -> Int
    public var page: @MainActor @Sendable (EventsPage, _ tailFirst: Bool) -> Void
    /// `session.subscribe` was refused: the session is gone from the host.
    public var gone: @MainActor @Sendable (String) -> Void

    public init(cursor: @escaping @MainActor @Sendable () -> Int, page: @escaping @MainActor @Sendable (EventsPage, Bool) -> Void, gone: @escaping @MainActor @Sendable (String) -> Void) {
        self.cursor = cursor
        self.page = page
        self.gone = gone
    }
}

public let resumeConcurrency = 4

/// The durable `session.subscribe` set of one environment, the desktop's
/// `Subscriptions` (src/renderer/src/lib/connection/subscriptions.ts). A
/// subscription belongs to the socket that made it, so on every replacement
/// session the set forgets what was subscribed and `resumeAll()`
/// re-subscribes each member and resumes it from its owner's cursor with
/// `afterSeq`, a few at a time. The owner decides what is in the set: it
/// adds a transcript when it opens one and removes it when it closes one,
/// so a reconnect never replays transcripts nobody is looking at.
@MainActor
public final class Subscriptions {
    private let socket: TempCodeSocket
    private var handlers: [String: SubscriptionHandlers] = [:]
    /// Session ids subscribed on the CURRENT socket.
    private var live: Set<String> = []
    private var held: [String: [EventRow]] = [:]
    private var generation = 0
    private var resumeTokens: [String: UUID] = [:]
    private var inFlight: [String: Task<EventsPage, any Error>] = [:]

    public init(socket: TempCodeSocket) {
        self.socket = socket
    }

    public var ids: [String] { Array(handlers.keys).sorted() }

    public func has(_ sessionId: String) -> Bool { handlers[sessionId] != nil }

    /// True when the current socket carries this session's pushes.
    public func isLive(_ sessionId: String) -> Bool { live.contains(sessionId) }

    /// The socket was replaced or lost: nothing is subscribed any more.
    public func sessionChanged() {
        generation += 1
        live.removeAll()
        for task in inFlight.values { task.cancel() }
        inFlight = [:]
        held = [:]
        resumeTokens = [:]
    }

    public func add(_ sessionId: String, _ handlers: SubscriptionHandlers) {
        self.handlers[sessionId] = handlers
    }

    /// Leaves the set; the socket is told when it is up.
    public func remove(_ sessionId: String) {
        handlers[sessionId] = nil
        held[sessionId] = nil
        resumeTokens[sessionId] = nil
        inFlight[sessionId]?.cancel()
        inFlight[sessionId] = nil
        guard live.remove(sessionId) != nil else { return }
        let socket = self.socket
        Task { _ = try? await socket.request(Methods.SessionUnsubscribe.self, .init(sessionId: sessionId)) }
    }

    /// A resume owns these pushes until its gap page lands. On failure they
    /// are discarded so the next resume still starts before the missing gap.
    public func hold(_ sessionId: String, rows: [EventRow]) -> Bool {
        guard held[sessionId] != nil else { return false }
        if resumeTokens[sessionId] != nil { held[sessionId]?.append(contentsOf: rows) }
        return true
    }

    /// Subscribes on the current socket if not yet, then fetches what follows
    /// the owner's cursor (`tail` rows for a cold open). The page goes to the
    /// owner; a second call while one is in flight joins it.
    @discardableResult
    public func resume(_ sessionId: String, tail: Int? = nil) -> Task<EventsPage, any Error> {
        if let pending = inFlight[sessionId] { return pending }
        let socket = self.socket
        let afterSeq = handlers[sessionId]?.cursor() ?? 0
        let generation = self.generation
        let token = UUID()
        resumeTokens[sessionId] = token
        held[sessionId] = []
        let task = Task<EventsPage, any Error> { [weak self] in
            guard let self, let handlers = self.handlers[sessionId] else { throw TransportError.notConnected }
            var completed = false
            defer {
                if self.resumeTokens[sessionId] == token {
                    // Keep the gate closed after a failed gap fetch. Later
                    // pushes must not move the cursor before the next replay.
                    self.held[sessionId] = completed ? nil : []
                    self.resumeTokens[sessionId] = nil
                }
            }
            if !self.live.contains(sessionId) {
                do {
                    _ = try await socket.request(Methods.SessionSubscribe.self, .init(sessionId: sessionId))
                } catch {
                    if let error = error as? TransportError, case .server(_, let message) = error, self.handlers[sessionId] != nil {
                        handlers.gone(message)
                    }
                    throw error
                }
                try Task.checkCancellation()
                guard self.generation == generation, self.resumeTokens[sessionId] == token else { throw TransportError.notConnected }
                self.live.insert(sessionId)
            }
            let tailFirst = tail != nil && afterSeq == 0
            let page = try await socket.request(Methods.SessionEvents.self, .init(sessionId: sessionId, afterSeq: tailFirst ? nil : afterSeq, beforeSeq: nil, tail: tailFirst ? tail : nil, limit: nil))
            try Task.checkCancellation()
            guard self.generation == generation, self.resumeTokens[sessionId] == token, self.handlers[sessionId] != nil else { throw TransportError.notConnected }
            handlers.page(page, tailFirst)
            let cursor = handlers.cursor()
            var unique: [Int: EventRow] = [:]
            var ephemeral: [EventRow] = []
            for row in self.held.removeValue(forKey: sessionId) ?? [] {
                if row.ephemeral == true { ephemeral.append(row) }
                else if row.seq > cursor { unique[row.seq] = row }
            }
            let persisted = unique.values.sorted { $0.seq < $1.seq }
            let finishedCalls = Set((page.rows + persisted).compactMap { row -> String? in
                switch row.event {
                case .toolCall(let call) where call.partial != true: call.callId
                case .toolResult(let result): result.callId
                default: nil
                }
            })
            let previews = ephemeral.filter { row in
                if case .toolCall(let call) = row.event { return !finishedCalls.contains(call.callId) }
                return true
            }
            let rows = persisted + previews
            if !rows.isEmpty {
                handlers.page(EventsPage(rows: rows, moreBefore: false, moreAfter: false, reset: false), false)
            }
            completed = true
            return page
        }
        inFlight[sessionId] = task
        Task { [weak self] in
            _ = try? await task.value
            if self?.inFlight[sessionId] == task { self?.inFlight[sessionId] = nil }
        }
        return task
    }

    /// After a replacement session: every member subscribes and resumes
    /// again, a few at a time. `first` goes in the first batch, ahead of the
    /// rest: the thread on screen is the one the person is waiting on.
    public func resumeAll(tail: Int, first: String? = nil) async {
        var ids = self.ids
        if let first, let at = ids.firstIndex(of: first) {
            ids.remove(at: at)
            ids.insert(first, at: 0)
        }
        var start = 0
        while start < ids.count {
            let end = min(start + resumeConcurrency, ids.count)
            let tasks = ids[start..<end].compactMap { id in handlers[id] != nil ? resume(id, tail: tail) : nil }
            for task in tasks { _ = try? await task.value }
            start = end
        }
    }
}
