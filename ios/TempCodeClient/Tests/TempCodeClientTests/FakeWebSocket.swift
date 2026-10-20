import Foundation
import Synchronization
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A scripted socket: the test delivers frames, closes with a code, or
/// refuses the upgrade; it reads what the transport sent.
final class FakeWebSocket: WebSocketConnection {
    private enum Inbound {
        case text(String)
        case failure(any Error)
    }

    private struct State {
        var queue: [Inbound] = []
        var waiter: CheckedContinuation<String, any Error>?
        var sent: [String] = []
        var closeCode: Int?
        var status: Int?
        var cancelled: (code: Int, reason: String)?
    }

    private let state = Mutex(State())

    init() {}

    // MARK: WebSocketConnection

    func send(_ text: String) async throws {
        state.withLock { $0.sent.append(text) }
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let ready = state.withLock { state -> Inbound? in
                if state.queue.isEmpty {
                    state.waiter = continuation
                    return nil
                }
                return state.queue.removeFirst()
            }
            switch ready {
            case .text(let text)?: continuation.resume(returning: text)
            case .failure(let error)?: continuation.resume(throwing: error)
            case nil: break
            }
        }
    }

    func cancel(code: Int, reason: String) {
        state.withLock { $0.cancelled = (code, reason) }
        push(.failure(CancellationError()))
    }

    var serverCloseCode: Int? { state.withLock { $0.closeCode } }
    var upgradeStatus: Int? { state.withLock { $0.status } }

    // MARK: scripting

    /// What the transport sent, as parsed requests.
    var sentRequests: [(id: String, method: String, params: JSONValue)] {
        state.withLock { $0.sent }.compactMap { text in
            guard let object = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)),
                  case .object(let fields) = object,
                  case .string(let id)? = fields["id"],
                  case .string(let method)? = fields["method"] else { return nil }
            return (id, method, fields["params"] ?? .null)
        }
    }

    var cancelledWith: (code: Int, reason: String)? { state.withLock { $0.cancelled } }

    func deliver(_ text: String) {
        push(.text(text))
    }

    func hello(environmentId: String = "env_test", contract: Int = contractVersion, caps: [String] = ["read"]) {
        let capsText = caps.map { "\"\($0)\"" }.joined(separator: ",")
        deliver(#"{"push":"hello","environmentId":"\#(environmentId)","contract":\#(contract),"caps":[\#(capsText)],"key":{"id":"K1","name":"iphone"}}"#)
    }

    func answer(id: String, result: String) {
        deliver(#"{"id":"\#(id)","ok":true,"result":\#(result)}"#)
    }

    func refuse(id: String, error: String) {
        deliver(#"{"id":"\#(id)","ok":false,"error":"\#(error)"}"#)
    }

    /// The server closed with a code (the receive then fails).
    func serverClose(code: Int) {
        state.withLock { $0.closeCode = code }
        push(.failure(URLError(.networkConnectionLost)))
    }

    /// The upgrade was refused with an http status.
    func refuseUpgrade(status: Int) {
        state.withLock { $0.status = status }
        push(.failure(URLError(.badServerResponse)))
    }

    /// The connection dropped with no close frame.
    func drop() {
        push(.failure(URLError(.networkConnectionLost)))
    }

    /// Waits until the transport has sent `count` requests.
    func waitForSent(_ count: Int) async {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if state.withLock({ $0.sent.count }) >= count { return }
            try? await Task.sleep(for: .milliseconds(1))
        }
        Issue.record("the transport never sent \(count) requests")
    }

    private func push(_ inbound: Inbound) {
        let waiter = state.withLock { state -> CheckedContinuation<String, any Error>? in
            if let waiter = state.waiter {
                state.waiter = nil
                return waiter
            }
            state.queue.append(inbound)
            return nil
        }
        guard let waiter else { return }
        switch inbound {
        case .text(let text): waiter.resume(returning: text)
        case .failure(let error): waiter.resume(throwing: error)
        }
    }
}

/// Hands out fake sockets in order and remembers them, so a test can script
/// the second attempt differently from the first.
final class FakeSocketFactory: Sendable {
    private let state = Mutex<(made: [FakeWebSocket], urls: [URL])>(([], []))

    init() {}

    var factory: WebSocketFactory {
        { [self] url in
            let socket = FakeWebSocket()
            state.withLock {
                $0.made.append(socket)
                $0.urls.append(url)
            }
            return socket
        }
    }

    var sockets: [FakeWebSocket] { state.withLock { $0.made } }
    var urls: [URL] { state.withLock { $0.urls } }

    /// The n-th socket, waiting for it to be made.
    func socket(_ index: Int) async -> FakeWebSocket {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if let socket = state.withLock({ $0.made.count > index ? $0.made[index] : nil }) { return socket }
            try? await Task.sleep(for: .milliseconds(1))
        }
        Issue.record("socket \(index) was never opened")
        return FakeWebSocket()
    }
}
