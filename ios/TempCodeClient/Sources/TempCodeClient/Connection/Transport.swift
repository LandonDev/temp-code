import Foundation
import TempCodeContract

public enum TransportError: Error, Hashable, Sendable {
    /// `request` before the hello, or after the close.
    case notConnected
    /// The socket closed while the request was waiting.
    case closed(CloseReason)
    /// The server answered `ok: false`.
    case server(method: String, message: String)
    /// The result did not decode as the method's output.
    case decoding(method: String, detail: String)
    /// The calling task was cancelled while the request waited.
    case cancelled

    /// `forbidden: <method> needs <capability>`: the key's capabilities say no.
    public var isForbidden: Bool {
        if case .server(_, let message) = self { return message.hasPrefix("forbidden") }
        return false
    }

    public var message: String {
        switch self {
        case .notConnected: "not connected"
        case .cancelled: "cancelled"
        case .closed(let reason): reason.message
        case .server(_, let message): message
        case .decoding(let method, let detail): "\(method): \(detail)"
        }
    }
}

/// Close codes the server uses when a credential stops being good: the
/// listener's 4401/4403 on refusal and 4001 on revocation.
let unauthorizedCloseCodes: Set<Int> = [4401, 4403, 4001]
public let helloTimeoutMs: Double = 10_000

/// One socket to one host, the desktop's `Transport` (src/renderer/src/lib/
/// connection/transport.ts) as an actor. `open()` resolves on the `hello`
/// frame, which the server sends first, so an open transport has an identity
/// before any request goes out. Requests correlate by id, pushes stream to
/// `pushes`, `close()` is final, and every close, ours or the network's,
/// settles `closed()` exactly once with its reason.
public actor Transport {
    public enum State: Sendable { case opening, open, closed }

    public let url: URL
    public private(set) var state: State = .opening
    public private(set) var hello: HelloPush?
    public private(set) var closeReason: CloseReason?
    /// Every push after the hello, in order. Finishes on close.
    public nonisolated let pushes: AsyncStream<ServerPush>

    private let pushSink: AsyncStream<ServerPush>.Continuation
    private let connect: WebSocketFactory
    private let clock: any SocketClock
    private let helloTimeout: Double
    private var socket: (any WebSocketConnection)?
    private var reader: Task<Void, Never>?
    private var helloTimer: Task<Void, Never>?
    private var nextId = 1
    /// The last frame handed to the socket: each send waits for the one
    /// before it, so frames reach the wire in the order their requests were made.
    private var sendTail: Task<Void, Never>?
    private var pending: [String: (method: String, continuation: CheckedContinuation<Response, any Error>)] = [:]
    private var helloWaiters: [CheckedContinuation<HelloPush, any Error>] = []
    private var closeWaiters: [CheckedContinuation<CloseReason, Never>] = []

    public init(url: URL, connect: @escaping WebSocketFactory, clock: any SocketClock = SystemClock(), helloTimeoutMs: Double = TempCodeClient.helloTimeoutMs) {
        self.url = url
        self.connect = connect
        self.clock = clock
        self.helloTimeout = helloTimeoutMs
        (pushes, pushSink) = AsyncStream.makeStream(of: ServerPush.self, bufferingPolicy: .unbounded)
    }

    /// Opens the socket and waits for its hello. Throws the close reason's message.
    public func open() async throws -> HelloPush {
        if let hello { return hello }
        if state == .closed { throw TransportError.closed(closeReason ?? CloseReason(kind: .local, message: "closed")) }
        if socket == nil { start() }
        return try await withCheckedThrowingContinuation { continuation in
            helloWaiters.append(continuation)
        }
    }

    /// Sends one request and reads its answer as the method's output.
    public func request<M: ContractMethod>(_ method: M.Type, _ params: M.Params) async throws -> M.Output {
        guard state == .open, let socket else { throw TransportError.notConnected }
        let id = String(nextId)
        nextId += 1
        let data: Data
        do {
            data = try JSONEncoder().encode(Request<M>(id: id, params: params))
        } catch {
            throw TransportError.decoding(method: M.name, detail: "could not encode the request")
        }
        let response: Response = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                pending[id] = (M.name, continuation)
                let previous = sendTail
                sendTail = Task { [weak self] in
                    await previous?.value
                    do {
                        try await socket.send(String(decoding: data, as: UTF8.self))
                    } catch {
                        await self?.fail(id: id, with: TransportError.notConnected)
                    }
                }
            }
        } onCancel: {
            Task { await self.fail(id: id, with: TransportError.cancelled) }
        }
        switch response {
        case .error(_, let message):
            throw TransportError.server(method: M.name, message: message)
        case .ok(_, let result):
            do {
                return try result.decode(M.Output.self)
            } catch {
                throw TransportError.decoding(method: M.name, detail: String(describing: error))
            }
        }
    }

    /// Methods still waiting on a reply, oldest first.
    public var pendingMethods: [String] {
        pending.keys.sorted { (Int($0) ?? 0) < (Int($1) ?? 0) }.compactMap { pending[$0]?.method }
    }

    /// Resolves when the socket has closed, at once if it already has.
    public func closed() async -> CloseReason {
        if let closeReason { return closeReason }
        return await withCheckedContinuation { continuation in
            closeWaiters.append(continuation)
        }
    }

    /// Closes for our own reasons; the socket's later failure is ignored.
    public func close(_ reason: CloseReason = CloseReason(kind: .local, message: "closed")) {
        guard state != .closed else { return }
        let socket = self.socket
        finish(reason)
        socket?.cancel(code: 1000, reason: reason.kind.rawValue)
    }

    // MARK: - the socket

    private func start() {
        let socket = connect(url)
        self.socket = socket
        helloTimer = Task { [weak self, clock, helloTimeout] in
            try? await clock.sleep(ms: helloTimeout)
            guard !Task.isCancelled else { return }
            await self?.helloTimedOut()
        }
        reader = Task { [weak self] in
            while !Task.isCancelled {
                let text: String
                do {
                    text = try await socket.receive()
                } catch {
                    await self?.socketFailed(error, socket: socket)
                    return
                }
                await self?.handle(text)
            }
        }
    }

    private func helloTimedOut() {
        guard hello == nil, state != .closed else { return }
        close(CloseReason(kind: .protocol, message: "no hello from the server"))
    }

    private func handle(_ text: String) {
        guard state != .closed else { return }
        let frame: ServerFrame
        do {
            frame = try decodeFrame(Data(text.utf8))
        } catch {
            return
        }
        switch frame {
        case .push(.hello(let hello)):
            guard self.hello == nil else { return }
            self.hello = hello
            state = .open
            helloTimer?.cancel()
            helloTimer = nil
            let waiters = helloWaiters
            helloWaiters = []
            for waiter in waiters { waiter.resume(returning: hello) }
        case .push(let push):
            pushSink.yield(push)
        case .response(let response):
            guard let entry = pending.removeValue(forKey: response.id) else { return }
            entry.continuation.resume(returning: response)
        }
    }

    private func fail(id: String, with error: TransportError) {
        guard let entry = pending.removeValue(forKey: id) else { return }
        entry.continuation.resume(throwing: error)
    }

    private func socketFailed(_ error: any Error, socket failed: any WebSocketConnection) {
        guard state != .closed, let socket, socket === failed else { return }
        finish(Transport.reason(error: error, closeCode: socket.serverCloseCode, upgradeStatus: socket.upgradeStatus, hadHello: hello != nil))
    }

    /// The desktop's close mapping, plus the upgrade status a native socket can see.
    static func reason(error: any Error, closeCode: Int?, upgradeStatus: Int?, hadHello: Bool) -> CloseReason {
        if let code = closeCode {
            if unauthorizedCloseCodes.contains(code) {
                return CloseReason(kind: .unauthorized, code: code, message: code == 4001 ? "the key was revoked" : "the server refused this credential")
            }
            if code == 1000 || code == 1001 {
                return CloseReason(kind: .server, code: code, message: "the server closed the socket")
            }
            return CloseReason(kind: .network, code: code, message: hadHello ? "the socket dropped" : "could not connect")
        }
        if let status = upgradeStatus, status != 101 {
            if status == 401 || status == 403 {
                return CloseReason(kind: .unauthorized, code: status, message: "the server refused this credential")
            }
            if status == 429 {
                return CloseReason(kind: .network, code: status, message: "too many attempts; try again later")
            }
            return CloseReason(kind: .network, code: status, message: "the server answered \(status) to the upgrade")
        }
        return CloseReason(kind: .network, message: hadHello ? "the socket dropped" : (RemoteAPI.specificDescription(error) ?? "could not connect"))
    }

    private func finish(_ reason: CloseReason) {
        state = .closed
        closeReason = reason
        socket = nil
        helloTimer?.cancel()
        helloTimer = nil
        reader?.cancel()
        reader = nil
        pushSink.finish()
        let requests = pending
        pending = [:]
        for entry in requests.values { entry.continuation.resume(throwing: TransportError.closed(reason)) }
        let hellos = helloWaiters
        helloWaiters = []
        for waiter in hellos { waiter.resume(throwing: TransportError.closed(reason)) }
        let closes = closeWaiters
        closeWaiters = []
        for waiter in closes { waiter.resume(returning: reason) }
    }
}
