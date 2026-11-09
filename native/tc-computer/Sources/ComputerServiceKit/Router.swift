import ComputerProtocol
import Foundation

/// What a handler knows of its request.
public struct RequestContext: Sendable {
    public let id: Int
    public let method: String
    public let cancel: CancelFlag
    let deferred: Deferred

    public init(id: Int, method: String, cancel: CancelFlag) {
        self.id = id
        self.method = method
        self.cancel = cancel
        self.deferred = Deferred()
    }

    /// Runs `work` once the request's answer is queued, so what it sends follows the answer
    /// (`initialize`'s notifications).
    public func afterAnswer(_ work: @escaping @Sendable () -> Void) { deferred.add(work) }
}

/// What a handler asked to run after its answer.
final class Deferred: @unchecked Sendable {
    private let lock = NSLock()
    private var work: [@Sendable () -> Void] = []

    func add(_ next: @escaping @Sendable () -> Void) { lock.locked { work.append(next) } }

    func run() {
        let all = lock.locked {
            defer { work.removeAll() }
            return work
        }
        for next in all { next() }
    }
}

/// A failure the router answers with a standard JSON-RPC code rather than a `ComputerError`.
public struct RPCFailure: Error, Equatable, Sendable {
    public let code: Int
    public let message: String

    public init(code: Int, message: String) {
        self.code = code
        self.message = message
    }

    public static func invalidParams(_ message: String) -> RPCFailure {
        RPCFailure(code: ComputerDefaults.RPCErrorCode.invalidParams, message: "Invalid params: \(message)")
    }

    public static func invalidRequest(_ message: String) -> RPCFailure {
        RPCFailure(code: ComputerDefaults.RPCErrorCode.invalidRequest, message: "Invalid Request: \(message)")
    }
}

/// Routes stdin lines to handlers and their answers to the outbox (docs/computer-protocol.md §1).
///
/// - A request holds one of `maxInFlight` slots until its response is written, so a host that stops
///   reading holds at most that many responses in memory; later ones wait in arrival order, and past
///   `maxQueued` waiting a new one answers `overloaded` at once. stdin is always read, so `$/cancel`,
///   pings and `shutdown` never wait behind work. Methods registered with `slot: false` answer from
///   memory and take none.
/// - Responses go out as handlers finish, in any order.
public final class Router: @unchecked Sendable {
    private typealias Runnable = @Sendable (RequestContext) async throws -> Data

    private struct Route {
        let beforeInit: Bool
        let slot: Bool
        /// a cancelled request still answers what its handler returned (`action.*`'s normal result)
        let keepsResult: Bool
        /// decodes the params (throwing `RPCFailure.invalidParams`) and gives the work to run
        let prepare: @Sendable (JSONValue) throws -> Runnable
    }

    private struct Running {
        let flag: CancelFlag
        var task: Task<Void, Never>?
    }

    private struct Waiting {
        let id: Int
        let method: String
        let keepsResult: Bool
        let run: Runnable
    }

    public let maxInFlight: Int
    public let maxQueued: Int
    private let outbox: Outbox
    private let trace: Trace?
    /// what a thrown error means as a `ComputerError` (the shell adds ComputerCore's `ComputerFailure`)
    private let mapError: @Sendable (any Error) -> ComputerError?

    private let lock = NSLock()
    private var routes: [String: Route] = [:]
    private var notifications: [String: @Sendable (JSONValue) -> Void] = [:]
    private var running: [Int: Running] = [:]
    private var waiting: [Waiting] = []
    private var slotsInUse = 0
    private var initialized = false
    private var shutDown = false

    public init(outbox: Outbox, trace: Trace? = nil, maxInFlight: Int = ComputerDefaults.Service.maxInFlight,
                maxQueued: Int = ComputerDefaults.Service.maxQueued,
                mapError: @escaping @Sendable (any Error) -> ComputerError? = { $0 as? ComputerError }) {
        self.outbox = outbox
        self.trace = trace
        self.maxInFlight = maxInFlight
        self.maxQueued = maxQueued
        self.mapError = mapError
    }

    /// A typed handler. Params decode as `P`; a failure answers -32602 naming the field. `beforeInit`
    /// handlers (initialize, shutdown) run before `markInitialized`; `slot: false` handlers take no slot.
    /// A cancelled request answers `cancelled` whatever its handler returned, unless `keepsResult`.
    public func on<P: Decodable & Sendable, R: Encodable & Sendable>(
        _ method: String, beforeInit: Bool = false, slot: Bool = true, keepsResult: Bool = false,
        _ handler: @escaping @Sendable (P, RequestContext) async throws -> R
    ) {
        let prepare: @Sendable (JSONValue) throws -> Runnable = { params in
            let decoded: P
            do {
                decoded = try params.decode(P.self)
            } catch {
                throw RPCFailure.invalidParams(Router.describe(error))
            }
            return { ctx in try Router.encode(try await handler(decoded, ctx)) }
        }
        lock.locked { routes[method] = Route(beforeInit: beforeInit, slot: slot, keepsResult: keepsResult, prepare: prepare) }
    }

    /// A notification from the host. `$/cancel` is the router's own.
    public func onNotification(_ method: String, _ handler: @escaping @Sendable (JSONValue) -> Void) {
        lock.locked { notifications[method] = handler }
    }

    public func markInitialized() { lock.locked { initialized = true } }

    public var isInitialized: Bool { lock.locked { initialized } }

    /// After this, every new request answers `cancelled`.
    public func markShutDown() { lock.locked { shutDown = true } }

    /// Requests holding a slot or waiting for one.
    public var load: (inFlight: Int, waiting: Int) { lock.locked { (slotsInUse, waiting.count) } }

    /// Whether any request is running (holding a slot or not).
    public var busy: Bool { lock.locked { !running.isEmpty || !waiting.isEmpty } }

    /// One stdin line.
    public func receive(_ line: Data) {
        trace?.frameIn(line)
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: line) else {
            return answer(id: nil, failure: RPCFailure(code: ComputerDefaults.RPCErrorCode.parseError, message: "Parse error"))
        }
        guard case .object(let frame) = value else {
            return answer(id: nil, failure: .invalidRequest("a frame is a JSON object"))
        }
        let rawID = frame["id"]
        guard frame["jsonrpc"] == .string(jsonRPCVersion) else {
            return answer(id: rawID?.intValue, failure: .invalidRequest(#"a frame carries "jsonrpc":"2.0""#))
        }
        guard let methodValue = frame["method"] else {
            // a response from the host: the service never sends a request, so there is nothing to match
            if frame["result"] != nil || frame["error"] != nil { return }
            return answer(id: rawID?.intValue, failure: .invalidRequest("a frame has a method, a result or an error"))
        }
        guard case .string(let method) = methodValue else {
            return answer(id: rawID?.intValue, failure: .invalidRequest("method is a string"))
        }
        let params = frame["params"] ?? .object([:])
        guard let rawID, rawID != .null else { return notification(method, params) }
        guard let id = rawID.intValue, id >= 0 else { return answer(id: nil, failure: .invalidRequest("id is a non-negative integer")) }
        request(id: id, method: method, params: params)
    }

    /// A line past the limit was dropped.
    public func receiveOverlong(_ bytes: Int) {
        answer(id: nil, failure: RPCFailure(code: ComputerDefaults.RPCErrorCode.parseError, message: "Parse error: a line of \(bytes) bytes is over the limit"))
    }

    /// Shutdown and EOF: every running request's flag set and task cancelled, every waiting one answered `cancelled`.
    public func cancelAll() {
        let (flags, dropped): ([Running], [Waiting]) = lock.locked {
            let out = (Array(running.values), waiting)
            waiting.removeAll()
            return out
        }
        for entry in flags {
            entry.flag.set()
            entry.task?.cancel()
        }
        for entry in dropped { answer(id: entry.id, error: Router.cancelledError) }
    }

    // MARK: Requests

    private func request(id: Int, method: String, params: JSONValue) {
        enum Next { case answer(RPCErrorObject), run(Bool, Bool, Runnable), wait }
        let next: Next = lock.locked {
            if shutDown { return .answer(RPCErrorObject(Router.cancelledError)) }
            guard let route = routes[method] else {
                return .answer(RPCErrorObject(code: ComputerDefaults.RPCErrorCode.methodNotFound, message: "Method not found: \(method)"))
            }
            if !initialized && !route.beforeInit {
                return .answer(RPCErrorObject(ComputerError(kind: .notInitialized, message: "The service has not been initialized.")))
            }
            let run: Runnable
            do {
                run = try route.prepare(params)
            } catch let failure as RPCFailure {
                return .answer(RPCErrorObject(code: failure.code, message: failure.message))
            } catch {
                return .answer(RPCErrorObject(code: ComputerDefaults.RPCErrorCode.invalidParams, message: "Invalid params"))
            }
            if !route.slot { return .run(false, route.keepsResult, run) }
            if slotsInUse < maxInFlight {
                slotsInUse += 1
                return .run(true, route.keepsResult, run)
            }
            if waiting.count >= maxQueued {
                return .answer(RPCErrorObject(code: ComputerDefaults.RPCErrorCode.internalError, message: "overloaded: \(maxQueued) requests waiting"))
            }
            waiting.append(Waiting(id: id, method: method, keepsResult: route.keepsResult, run: run))
            return .wait
        }
        switch next {
        case .answer(let error): send(id: id, error: error, onWritten: nil)
        case .run(let slot, let keepsResult, let run): start(id: id, method: method, slot: slot, keepsResult: keepsResult, run: run)
        case .wait: break
        }
    }

    private func start(id: Int, method: String, slot: Bool, keepsResult: Bool, run: @escaping Runnable) {
        let flag = CancelFlag()
        let ctx = RequestContext(id: id, method: method, cancel: flag)
        lock.locked { running[id] = Running(flag: flag, task: nil) }
        let task = Task<Void, Never> { [self] in
            let line: Data
            do {
                let result = try await run(ctx)
                line = flag.isSet && !keepsResult
                    ? errorLine(id: id, error: Router.cancelledError, cancelled: true)
                    : Router.resultLine(id: id, result: result)
            } catch {
                line = errorLine(id: id, error: error, cancelled: flag.isSet || Task<Never, Never>.isCancelled)
            }
            lock.locked { _ = running.removeValue(forKey: id) }
            var onWritten: (@Sendable () -> Void)?
            if slot { onWritten = { [self] in slotFreed() } }
            outbox.respond(line, onWritten: onWritten)
            ctx.deferred.run()
        }
        lock.locked {
            if running[id] != nil { running[id]?.task = task }
        }
    }

    private func slotFreed() {
        let next: Waiting? = lock.locked {
            if waiting.isEmpty {
                slotsInUse -= 1
                return nil
            }
            return waiting.removeFirst()
        }
        if let next { start(id: next.id, method: next.method, slot: true, keepsResult: next.keepsResult, run: next.run) }
    }

    // MARK: Notifications

    private func notification(_ method: String, _ params: JSONValue) {
        if method == cancelMethod {
            if let id = params["id"]?.intValue { cancel(id) }
            return
        }
        let handler = lock.locked { notifications[method] }
        handler?(params)
    }

    /// `$/cancel`: a waiting request leaves the queue answered `cancelled`; a running one has its flag set and its task cancelled.
    private func cancel(_ id: Int) {
        enum Found { case waiting, running(Running), none }
        let found: Found = lock.locked {
            if let at = waiting.firstIndex(where: { $0.id == id }) {
                waiting.remove(at: at)
                return .waiting
            }
            if let entry = running[id] { return .running(entry) }
            return .none
        }
        switch found {
        case .waiting:
            answer(id: id, error: Router.cancelledError)
        case .running(let entry):
            entry.flag.set()
            entry.task?.cancel()
        case .none:
            break
        }
    }

    // MARK: Answers

    public static let cancelledError = ComputerError(kind: .cancelled, message: "The request was cancelled.")

    private func answer(id: Int?, failure: RPCFailure) {
        send(id: id, error: RPCErrorObject(code: failure.code, message: failure.message), onWritten: nil)
    }

    private func answer(id: Int, error: ComputerError) {
        send(id: id, error: RPCErrorObject(error), onWritten: nil)
    }

    private func send(id: Int?, error: RPCErrorObject, onWritten: (@Sendable () -> Void)?) {
        let line = (try? encodeLine(.error(id: id, error: error))) ?? Data()
        outbox.respond(line, onWritten: onWritten)
    }

    private func errorLine(id: Int, error: any Error, cancelled: Bool) -> Data {
        let object: RPCErrorObject
        if let failure = error as? RPCFailure {
            object = RPCErrorObject(code: failure.code, message: failure.message)
        } else if let computer = mapError(error) {
            object = RPCErrorObject(computer)
        } else if cancelled || error is CancellationError {
            object = RPCErrorObject(Router.cancelledError)
        } else {
            let text = String(describing: error)
            outbox.notify(notificationLine(method: "log", params: LogNotification.Params(level: .error, message: "internal error: \(text)")), kind: .log)
            object = RPCErrorObject(code: ComputerDefaults.RPCErrorCode.internalError, message: "Internal error: \(text)")
        }
        return (try? encodeLine(.error(id: id, error: object))) ?? Data()
    }

    static func encode(_ value: some Encodable) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return try encoder.encode(value)
    }

    static func resultLine(id: Int, result: Data) -> Data {
        var line = Data(#"{"jsonrpc":"2.0","id":\#(id),"result":"#.utf8)
        line.append(result)
        line.append(Data("}\n".utf8))
        return line
    }

    /// The field a decode failure names, as `a.b[2].c: why`.
    static func describe(_ error: any Error) -> String {
        func path(_ keys: [any CodingKey]) -> String {
            keys.reduce("") { out, key in
                if let index = key.intValue { return out + "[\(index)]" }
                return out.isEmpty ? key.stringValue : out + "." + key.stringValue
            }
        }
        guard let error = error as? DecodingError else { return String(describing: error) }
        switch error {
        case .keyNotFound(let key, let ctx):
            return "\(path(ctx.codingPath + [key])): missing"
        case .typeMismatch(_, let ctx), .valueNotFound(_, let ctx), .dataCorrupted(let ctx):
            let at = path(ctx.codingPath)
            return (at.isEmpty ? "params" : at) + ": " + ctx.debugDescription
        @unknown default:
            return String(describing: error)
        }
    }
}
