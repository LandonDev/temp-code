import Foundation
import TempCodeContract

/// What the http side of a host answered badly, by what the caller does next.
public enum RemoteAPIError: Error, Hashable, Sendable {
    /// 401: the key or code is not good. Nothing retries this by itself.
    case unauthorized(String)
    /// 403: the key exists but may not do this (an mcp key on /api/ticket).
    case forbidden(String)
    /// 429 with `Retry-After` seconds.
    case rateLimited(retryAfterSeconds: Int?)
    /// Any other 4xx: the request itself was wrong.
    case rejected(status: Int, message: String)
    /// No answer, a 5xx, or a body that is not the JSON we expect.
    case unavailable(String)

    /// The text a status line can show.
    public var message: String {
        switch self {
        case .unauthorized(let m), .forbidden(let m), .unavailable(let m): m
        case .rateLimited(let seconds): seconds.map { "too many attempts, try again in \($0) s" } ?? "too many attempts"
        case .rejected(_, let m): m
        }
    }
}

/// One http exchange, injectable so tests answer canned bodies.
public typealias HTTPExchange = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

/// The three http calls of the remote wire: public hello, the pairing
/// exchange, and the 30 s ticket a key mints before each socket.
public struct RemoteAPI: Sendable {
    private let exchange: HTTPExchange

    public init(exchange: @escaping HTTPExchange) {
        self.exchange = exchange
    }

    /// Over a `URLSession`: no cookies, no cache, short timeouts.
    public init(session: URLSession = RemoteAPI.defaultSession) {
        self.init { request in
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            return (data, http)
        }
    }

    public static let defaultSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 15
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    /// `GET /api/hello`: who the host is, and what the key may do when one is sent.
    public func hello(origin: URL, key: String? = nil) async throws(RemoteAPIError) -> HelloResponse {
        try await send(origin: origin, path: "/api/hello", method: "GET", key: key, body: nil as PairBody?)
    }

    /// `POST /api/pair { code, kind: 'key' }`: the code becomes a key, once.
    public func pair(origin: URL, code: String, name: String? = nil) async throws(RemoteAPIError) -> PairKeyResponse {
        try await send(origin: origin, path: "/api/pair", method: "POST", key: nil, body: PairBody(code: code, kind: .key, name: name, caps: nil))
    }

    /// `POST /api/ticket` with the key: a single-use ticket good for 30 s.
    public func ticket(origin: URL, key: String) async throws(RemoteAPIError) -> TicketResponse {
        try await send(origin: origin, path: "/api/ticket", method: "POST", key: key, body: nil as PairBody?)
    }

    private func send<Body: Encodable & Sendable, Output: Decodable>(origin: URL, path: String, method: String, key: String?, body: Body?) async throws(RemoteAPIError) -> Output {
        var request = URLRequest(url: origin.appending(path: path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let key { request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            do { request.httpBody = try JSONEncoder().encode(body) } catch { throw .unavailable("could not encode the request") }
        }
        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await exchange(request)
        } catch {
            throw .unavailable(RemoteAPI.describe(error))
        }
        return try RemoteAPI.decode(status: response.statusCode, retryAfter: response.value(forHTTPHeaderField: "Retry-After"), data: data)
    }

    /// Status and body to a value or the error the caller acts on.
    static func decode<Output: Decodable>(status: Int, retryAfter: String?, data: Data) throws(RemoteAPIError) -> Output {
        let message = (try? JSONDecoder().decode(HttpError.self, from: data))?.error
        switch status {
        case 200..<300:
            do { return try JSONDecoder().decode(Output.self, from: data) } catch { throw .unavailable("the host answered something this app does not understand") }
        case 401: throw .unauthorized(message ?? "the host refused this credential")
        case 403: throw .forbidden(message ?? "this key may not do that")
        case 429: throw .rateLimited(retryAfterSeconds: retryAfter.flatMap { Int($0.trimmingCharacters(in: .whitespaces)) })
        case 400..<500: throw .rejected(status: status, message: message ?? "the host refused the request (\(status))")
        default: throw .unavailable(message ?? "the host answered \(status)")
        }
    }

    static func describe(_ error: any Error) -> String {
        specificDescription(error) ?? error.localizedDescription
    }

    /// A short reason for the URL errors a user can act on; nil for the rest.
    static func specificDescription(_ error: any Error) -> String? {
        guard let urlError = error as? URLError else { return nil }
        switch urlError.code {
        case .notConnectedToInternet: return "no internet connection"
        case .timedOut: return "the host did not answer in time"
        case .cannotFindHost, .dnsLookupFailed: return "the host could not be found"
        case .cannotConnectToHost: return "the host refused the connection"
        case .secureConnectionFailed, .serverCertificateUntrusted: return "the connection is not secure"
        default: return nil
        }
    }
}
