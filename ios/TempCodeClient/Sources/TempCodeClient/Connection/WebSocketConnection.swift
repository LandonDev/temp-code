import Foundation

/// What the transport needs from a WebSocket: text frames in and out, a
/// cancel, and after a failure the server's close code and the upgrade's
/// http status when there was one. `URLSessionWebSocket` is the real one;
/// the tests hand in a scripted fake.
public protocol WebSocketConnection: AnyObject, Sendable {
    func send(_ text: String) async throws
    /// The next text frame; throws when the socket is gone.
    func receive() async throws -> String
    func cancel(code: Int, reason: String)
    /// The close code the server sent, once it has.
    var serverCloseCode: Int? { get }
    /// The status of the upgrade response when the server refused it.
    var upgradeStatus: Int? { get }
}

public typealias WebSocketFactory = @Sendable (URL) -> any WebSocketConnection

/// One `URLSessionWebSocketTask`. URLSession negotiates `permessage-deflate`
/// and answers the server's pings on its own.
public final class URLSessionWebSocket: WebSocketConnection {
    private let task: URLSessionWebSocketTask

    public init(url: URL, session: URLSession) {
        task = session.webSocketTask(with: url)
        task.maximumMessageSize = 64 * 1024 * 1024
        task.resume()
    }

    public static func factory(session: URLSession = URLSessionWebSocket.defaultSession) -> WebSocketFactory {
        { url in URLSessionWebSocket(url: url, session: session) }
    }

    public static let defaultSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = 30
        return URLSession(configuration: config)
    }()

    public func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    public func receive() async throws -> String {
        switch try await task.receive() {
        case .string(let text): return text
        case .data(let data): return String(decoding: data, as: UTF8.self)
        @unknown default: return ""
        }
    }

    public func cancel(code: Int, reason: String) {
        let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure
        task.cancel(with: closeCode, reason: Data(reason.utf8))
    }

    public var serverCloseCode: Int? {
        task.closeCode == .invalid ? nil : task.closeCode.rawValue
    }

    public var upgradeStatus: Int? {
        (task.response as? HTTPURLResponse)?.statusCode
    }
}
