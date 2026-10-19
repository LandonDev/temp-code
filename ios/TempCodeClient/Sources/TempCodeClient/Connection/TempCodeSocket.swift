import Foundation
import TempCodeContract

public enum ProbeTrigger: String, Sendable {
    case foreground, online, offline, retry
}

/// What the socket's owner hears about the live session: a replacement
/// session opened (re-subscribe and resume), or the session went away.
public enum SessionEvent: Sendable, Hashable {
    case opened(HelloPush)
    case closed(CloseReason)
}

public struct SocketConfiguration: Sendable, Hashable {
    public var backoff: BackoffPolicy = .standard
    /// The cheap read a probe sends over the live session, and how long it may take.
    public var probeTimeoutMs: Double = 5_000
    public var helloTimeoutMs: Double = TempCodeClient.helloTimeoutMs
    /// How long after the app leaves the foreground the socket stays up.
    public var backgroundGraceMs: Double = 10_000
    /// What `hello.contract` must be; the generated package's own version.
    public var expectedContract: Int = contractVersion

    public init() {}
}

/// A ticket for the next socket. Throws `RemoteAPIError.unauthorized` when
/// the key is gone or refused: the socket then stops trying by itself.
public typealias TicketMint = @Sendable () async throws(RemoteAPIError) -> String

/// One environment's connection owner: the desktop's `Supervisor` (src/
/// renderer/src/lib/connection/supervisor.ts) as an actor owning one
/// `Transport` at a time. It mints a ticket, opens the socket, checks the
/// hello against the paired identity and contract, retries involuntary
/// losses on a jittered exponential backoff that resets only after the
/// session stays up, probes the live session on foreground / online /
/// explicit retry and reconnects only when the probe fails, closes after a
/// short grace in the background, and never retries a refused credential or
/// a host that changed identity by itself.
public actor TempCodeSocket {
    public let environmentId: String
    public let socketURL: URL
    public private(set) var status: EnvironmentStatus = .idle
    /// Every status change, in order.
    public nonisolated let statuses: AsyncStream<EnvironmentStatus>
    /// Pushes of whichever session is live, across replacements.
    public nonisolated let pushes: AsyncStream<ServerPush>
    /// Session replacements, for the subscription set.
    public nonisolated let sessions: AsyncStream<SessionEvent>

    private let statusSink: AsyncStream<EnvironmentStatus>.Continuation
    private let pushSink: AsyncStream<ServerPush>.Continuation
    private let sessionSink: AsyncStream<SessionEvent>.Continuation
    private let mint: TicketMint
    private let connect: WebSocketFactory
    private let clock: any SocketClock
    private let config: SocketConfiguration

    private var session: Transport?
    private var retryTimer: Task<Void, Never>?
    private var upTimer: Task<Void, Never>?
    private var graceTimer: Task<Void, Never>?
    private var closeWatcher: Task<Void, Never>?
    private var pushRelay: Task<Void, Never>?
    private var attempting: Task<Void, Never>?
    private var probing: Task<Void, Never>?
    private var everOpened = false
    private var stopped = true
    private var online = true
    private var foreground = true
    /// The host answered as someone else, or speaks another contract: wait for an explicit retry.
    private var halted = false
    /// The next `lost` is the background grace closing the socket, not a failure.
    private var suspending = false
    /// Bumps on stop/retry so a walk still in flight drops its result.
    private var generation = 0

    public init(environmentId: String, socketURL: URL, mint: @escaping TicketMint, connect: @escaping WebSocketFactory = URLSessionWebSocket.factory(), clock: any SocketClock = SystemClock(), configuration: SocketConfiguration = SocketConfiguration()) {
        self.environmentId = environmentId
        self.socketURL = socketURL
        self.mint = mint
        self.connect = connect
        self.clock = clock
        self.config = configuration
        (statuses, statusSink) = AsyncStream.makeStream(of: EnvironmentStatus.self, bufferingPolicy: .unbounded)
        (pushes, pushSink) = AsyncStream.makeStream(of: ServerPush.self, bufferingPolicy: .unbounded)
        (sessions, sessionSink) = AsyncStream.makeStream(of: SessionEvent.self, bufferingPolicy: .unbounded)
    }

    /// The paired environment's own socket: `wss://host/ws`, tickets from its key.
    public init(environment: PairedEnvironment, keys: any KeyStore, api: RemoteAPI = RemoteAPI(), connect: @escaping WebSocketFactory = URLSessionWebSocket.factory(), clock: any SocketClock = SystemClock(), configuration: SocketConfiguration = SocketConfiguration()) {
        let origin = environment.origin
        let id = environment.id
        self.init(environmentId: id, socketURL: environment.socketURL, mint: { () throws(RemoteAPIError) -> String in
            guard let key = try? keys.key(for: id) else { throw .unauthorized("no key for this host; pair again") }
            return try await api.ticket(origin: origin, key: key).ticket
        }, connect: connect, clock: clock, configuration: configuration)
    }

    deinit {
        statusSink.finish()
        pushSink.finish()
        sessionSink.finish()
    }

    public var isOpen: Bool { session != nil && status.transport == .open }

    // MARK: - lifecycle

    /// Begin connecting.
    public func start() {
        guard stopped else { return }
        stopped = false
        halted = false
        attempt()
    }

    /// Stop for good (the environment was removed): close the session, retry nothing.
    public func stop() {
        stopped = true
        generation += 1
        clearRetry()
        clearUp()
        clearGrace()
        attempting?.cancel()
        attempting = nil
        probing?.cancel()
        probing = nil
        let live = session
        dropSession()
        set(EnvironmentStatus(transport: .offline, lastHello: status.lastHello))
        if let live {
            Task { await live.close(CloseReason(kind: .local, message: "stopped")) }
            sessionSink.yield(.closed(CloseReason(kind: .local, message: "stopped")))
        }
    }

    /// The user asked: probe an open session, else try now, out of any state.
    public func retry() {
        guard !stopped else { return }
        halted = false
        if status.transport == .unauthorized || status.transport == .offline || status.transport == .suspended {
            status.attempts = 0
            status.halt = nil
        }
        probe(.retry)
    }

    /// The OS said the network came or went.
    public func setOnline(_ online: Bool) {
        self.online = online
        guard !stopped else { return }
        if online {
            probe(.online)
        } else if session != nil {
            probe(.offline)
        } else {
            clearRetry()
            var next = status
            next.transport = .offline
            next.nextRetryAt = nil
            set(next)
        }
    }

    /// The app came forward (probe, or reconnect at once) or went to the
    /// background (close after the grace and wait).
    public func setForeground(_ foreground: Bool) {
        self.foreground = foreground
        guard !stopped else { return }
        if foreground {
            clearGrace()
            if session != nil {
                probe(.foreground)
            } else if status.transport == .suspended || status.transport == .reconnecting || status.transport == .connecting {
                clearRetry()
                attempt()
            }
            return
        }
        clearGrace()
        if session == nil {
            clearRetry()
            attempting?.cancel()
            attempting = nil
            generation += 1
            if status.transport != .unauthorized && !halted {
                var next = status
                next.transport = .suspended
                next.nextRetryAt = nil
                set(next)
            }
            return
        }
        graceTimer = Task { [weak self, clock, grace = config.backgroundGraceMs] in
            try? await clock.sleep(ms: grace)
            guard !Task.isCancelled else { return }
            await self?.suspend()
        }
    }

    /// Checks the live session with one cheap request; only a failed probe
    /// reconnects, and then at once. With no session, a pending retry fires now.
    public func probe(_ trigger: ProbeTrigger) {
        guard !stopped else { return }
        if status.transport == .unauthorized && trigger != .retry { return }
        if halted && trigger != .retry { return }
        if !foreground && trigger != .retry { return }
        if !online && trigger != .online && trigger != .retry {
            if let session { probeSession(session, trigger) }
            return
        }
        if let session {
            probeSession(session, trigger)
            return
        }
        clearRetry()
        attempt()
    }

    /// The stores finished their re-list on the live session (or lost it).
    public func markFresh(_ fresh: Bool) {
        guard status.fresh != fresh else { return }
        var next = status
        next.fresh = fresh
        set(next)
    }

    /// One request over the live session.
    public func request<M: ContractMethod>(_ method: M.Type, _ params: M.Params) async throws -> M.Output {
        guard let session else { throw TransportError.notConnected }
        return try await session.request(method, params)
    }

    // MARK: - attempts

    private func attempt() {
        guard attempting == nil else { return }
        generation += 1
        let generation = self.generation
        attempting = Task { [weak self] in
            await self?.walk(generation)
        }
    }

    private func walk(_ generation: Int) async {
        // Cleared on the actor as the walk's last act, so no call can land
        // between "the walk is over" and "another may start".
        defer { attempting = nil }
        clearRetry()
        var pending = status
        pending.transport = pendingState()
        pending.nextRetryAt = nil
        set(pending)

        let ticket: String
        do {
            ticket = try await mint()
        } catch {
            guard generation == self.generation, !stopped else { return }
            switch error {
            case .unauthorized(let message), .forbidden(let message):
                var next = status
                next.transport = .unauthorized
                next.lastError = message
                next.nextRetryAt = nil
                set(next)
            case .rateLimited(let seconds):
                scheduleRetry(error.message, atLeastMs: Double(seconds ?? 0) * 1000)
            case .rejected(_, let message), .unavailable(let message):
                if !online {
                    var next = status
                    next.transport = .offline
                    next.lastError = message
                    next.nextRetryAt = nil
                    set(next)
                } else {
                    scheduleRetry(message)
                }
            }
            return
        }
        guard generation == self.generation, !stopped else { return }

        var parts = URLComponents(url: socketURL, resolvingAgainstBaseURL: false) ?? URLComponents()
        parts.queryItems = (parts.queryItems ?? []) + [URLQueryItem(name: "ticket", value: ticket)]
        let transport = Transport(url: parts.url ?? socketURL, connect: connect, clock: clock, helloTimeoutMs: config.helloTimeoutMs)
        do {
            let hello = try await transport.open()
            guard generation == self.generation, !stopped else {
                await transport.close(CloseReason(kind: .local, message: "superseded"))
                return
            }
            await adopt(transport, hello: hello)
        } catch {
            guard generation == self.generation, !stopped else { return }
            let reason = await transport.closeReason ?? CloseReason(kind: .network, message: (error as? TransportError)?.message ?? String(describing: error))
            if reason.kind == .unauthorized {
                var next = status
                next.transport = .unauthorized
                next.lastError = reason.message
                next.nextRetryAt = nil
                set(next)
            } else if !online {
                var next = status
                next.transport = .offline
                next.lastError = reason.message
                next.nextRetryAt = nil
                set(next)
            } else {
                scheduleRetry(reason.message)
            }
        }
    }

    /// A hello arrived: make the transport the session, unless the host is
    /// not who we paired with or speaks another contract.
    private func adopt(_ transport: Transport, hello: HelloPush) async {
        if hello.environmentId != environmentId {
            await halt(.identityChanged(expected: environmentId, got: hello.environmentId), transport: transport, hello: hello)
            return
        }
        if hello.contract != config.expectedContract {
            await halt(.contractMismatch(app: config.expectedContract, host: hello.contract), transport: transport, hello: hello)
            return
        }
        let previous = session
        session = transport
        everOpened = true
        clearRetry()
        clearUp()
        closeWatcher?.cancel()
        closeWatcher = Task { [weak self] in
            let reason = await transport.closed()
            await self?.lost(transport, reason)
        }
        pushRelay?.cancel()
        pushRelay = Task { [pushSink] in
            for await push in transport.pushes { pushSink.yield(push) }
        }
        upTimer = Task { [weak self, clock, reset = config.backoff.resetAfterMs] in
            try? await clock.sleep(ms: reset)
            guard !Task.isCancelled else { return }
            await self?.stayedUp(transport)
        }
        var next = status
        next.transport = .open
        next.fresh = false
        next.lastHello = hello
        next.lastError = nil
        next.nextRetryAt = nil
        next.halt = nil
        set(next)
        sessionSink.yield(.opened(hello))
        if let previous { await previous.close(CloseReason(kind: .replaced, message: "a new session answered")) }
        if !foreground { setForeground(false) }
    }

    private func halt(_ reason: HaltReason, transport: Transport, hello: HelloPush) async {
        halted = true
        await transport.close(CloseReason(kind: .protocol, message: reason.message))
        var next = status
        next.transport = .offline
        next.lastError = reason.message
        next.lastHello = hello
        next.nextRetryAt = nil
        next.halt = reason
        set(next)
    }

    private func stayedUp(_ transport: Transport) {
        upTimer = nil
        guard session === transport else { return }
        var next = status
        next.attempts = 0
        set(next)
    }

    /// The session closed under us. Our own closes already moved on.
    private func lost(_ transport: Transport, _ reason: CloseReason) {
        guard session === transport else { return }
        dropSession()
        var next = status
        next.fresh = false
        status = next
        sessionSink.yield(.closed(reason))
        if stopped || reason.kind == .replaced {
            emit()
            return
        }
        if suspending {
            suspending = false
            next.transport = .suspended
            next.lastError = nil
            next.nextRetryAt = nil
            set(next)
            return
        }
        switch reason.kind {
        case .unauthorized:
            next.transport = .unauthorized
            next.lastError = reason.message
            next.nextRetryAt = nil
            set(next)
        case .local:
            // A failed probe closes with `local` and reconnects at once.
            next.transport = pendingState()
            next.lastError = reason.message
            next.nextRetryAt = nil
            set(next)
            attempt()
        default:
            if !online {
                next.transport = .offline
                next.lastError = reason.message
                next.nextRetryAt = nil
                set(next)
            } else {
                scheduleRetry(reason.message)
            }
        }
    }

    private func dropSession() {
        session = nil
        clearUp()
        closeWatcher?.cancel()
        closeWatcher = nil
        pushRelay?.cancel()
        pushRelay = nil
    }

    private func scheduleRetry(_ lastError: String?, atLeastMs floor: Double = 0) {
        let attempts = status.attempts + 1
        let delay = max(floor, config.backoff.delay(attempt: attempts - 1, random: clock.random()))
        clearRetry()
        retryTimer = Task { [weak self, clock] in
            try? await clock.sleep(ms: delay)
            guard !Task.isCancelled else { return }
            await self?.retryFired()
        }
        var next = status
        next.transport = pendingState()
        next.lastError = lastError
        next.attempts = attempts
        next.nextRetryAt = clock.now + delay
        set(next)
    }

    private func retryFired() {
        retryTimer = nil
        guard !stopped, foreground || !everOpened else { return }
        attempt()
    }

    private func pendingState() -> TransportState {
        everOpened ? .reconnecting : .connecting
    }

    // MARK: - probes

    private func probeSession(_ session: Transport, _ trigger: ProbeTrigger) {
        guard probing == nil else { return }
        probing = Task { [weak self, clock, timeout = config.probeTimeoutMs] in
            let ok = await withTaskGroup(of: Bool.self) { group in
                group.addTask { (try? await session.request(Methods.WorkspaceList.self, NoParams())) != nil }
                group.addTask {
                    try? await clock.sleep(ms: timeout)
                    return false
                }
                let first = await group.next() ?? false
                group.cancelAll()
                return first
            }
            await self?.probeFinished(session, ok: ok, trigger: trigger)
        }
    }

    private func probeFinished(_ probed: Transport, ok: Bool, trigger: ProbeTrigger) async {
        probing = nil
        guard session === probed, await probed.state == .open else { return }
        if ok {
            markFresh(true)
            return
        }
        let reason = CloseReason(kind: .local, message: "probe on \(trigger.rawValue) failed")
        await probed.close(reason)
        lost(probed, reason)
    }

    // MARK: - background

    private func suspend() async {
        graceTimer = nil
        guard !foreground, let session, !stopped else { return }
        suspending = true
        let reason = CloseReason(kind: .local, message: "in the background")
        await session.close(reason)
        lost(session, reason)
    }

    // MARK: - status

    private func set(_ status: EnvironmentStatus) {
        self.status = status
        emit()
    }

    private func emit() {
        statusSink.yield(status)
    }

    private func clearRetry() {
        retryTimer?.cancel()
        retryTimer = nil
    }

    private func clearUp() {
        upTimer?.cancel()
        upTimer = nil
    }

    private func clearGrace() {
        graceTimer?.cancel()
        graceTimer = nil
    }
}
