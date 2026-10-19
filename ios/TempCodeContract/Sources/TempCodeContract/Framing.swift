import Foundation

/// One request method of the contract: its wire name, what it takes and
/// what it answers. The generated `Methods` namespace has one type per method.
public protocol ContractMethod: SendableMetatype {
    associatedtype Params: Codable & Hashable & Sendable
    associatedtype Output: Codable & Hashable & Sendable
    static var name: String { get }
}

/// A method that takes nothing: encodes as `{}`, which the server ignores.
public struct NoParams: Codable, Hashable, Sendable {
    public init() {}
}

/// A method that answers `null`.
public struct NoOutput: Codable, Hashable, Sendable {
    public init() {}

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        guard container.decodeNil() else {
            throw DecodingError.typeMismatch(NoOutput.self, .init(codingPath: decoder.codingPath, debugDescription: "expected null"))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encodeNil()
    }
}

/// A request field the server reads three ways: left out (keep the current
/// value), `null` (clear it), or a value. `nil` of a `Patch<Value>?`
/// property leaves the field out; `.clear` sends `null`.
public enum Patch<Value: Codable & Hashable & Sendable>: Codable, Hashable, Sendable {
    case clear
    case set(Value)

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        self = container.decodeNil() ? .clear : .set(try container.decode(Value.self))
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .clear: try container.encodeNil()
        case .set(let value): try container.encode(value)
        }
    }
}

/// Client → server: `{ id, method, params }`.
public struct Request<M: ContractMethod>: Encodable, Sendable {
    public let id: String
    public let params: M.Params

    public init(id: String, params: M.Params) {
        self.id = id
        self.params = params
    }

    private enum CodingKeys: String, CodingKey {
        case id, method, params
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(M.name, forKey: .method)
        try container.encode(params, forKey: .params)
    }
}

/// Server → client, answering one request: `{ id, ok: true, result }` or
/// `{ id, ok: false, error }`. `result` stays a `JSONValue` until the
/// caller, who knows the method, reads it as `Methods.X.Output`.
public enum Response: Codable, Hashable, Sendable {
    case ok(id: String, result: JSONValue)
    case error(id: String, message: String)

    public var id: String {
        switch self {
        case .ok(let id, _), .error(let id, _): id
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, ok, result, error
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let id = try container.decode(String.self, forKey: .id)
        if try container.decode(Bool.self, forKey: .ok) {
            self = .ok(id: id, result: try container.decodeIfPresent(JSONValue.self, forKey: .result) ?? .null)
        } else {
            self = .error(id: id, message: try container.decode(String.self, forKey: .error))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .ok(let id, let result):
            try container.encode(id, forKey: .id)
            try container.encode(true, forKey: .ok)
            try container.encode(result, forKey: .result)
        case .error(let id, let message):
            try container.encode(id, forKey: .id)
            try container.encode(false, forKey: .ok)
            try container.encode(message, forKey: .error)
        }
    }
}

/// Any frame the socket delivers: a push (`{ push, … }`) or a response.
public enum ServerFrame: Codable, Hashable, Sendable {
    case push(ServerPush)
    case response(Response)

    private enum Probe: String, CodingKey {
        case push
    }

    public init(from decoder: any Decoder) throws {
        if try decoder.container(keyedBy: Probe.self).contains(.push) {
            self = .push(try ServerPush(from: decoder))
        } else {
            self = .response(try Response(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .push(let push): try push.encode(to: encoder)
        case .response(let response): try response.encode(to: encoder)
        }
    }
}

/// The bytes of one text frame, told apart: a push or a response.
public func decodeFrame(_ data: Data) throws -> ServerFrame {
    try JSONDecoder().decode(ServerFrame.self, from: data)
}

extension Response {
    /// The result read as the method's output; throws on an error response.
    public func output<M: ContractMethod>(_ method: M.Type) throws -> M.Output {
        switch self {
        case .ok(_, let result): try result.decode(M.Output.self)
        case .error(_, let message): throw ContractError.server(message)
        }
    }
}

public enum ContractError: Error, Hashable, Sendable {
    /// The server answered `ok: false` with this text.
    case server(String)
}
