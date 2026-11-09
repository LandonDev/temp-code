import Foundation

// The frame around every message (docs/computer-protocol.md §1): one
// JSON-RPC 2.0 object per line, UTF-8, `"jsonrpc":"2.0"` on every frame, no
// newline inside one, at most `ComputerDefaults.Service.lineMaxBytes`.

/// One request method of the computer protocol: its wire name, what it
/// takes and what it answers. The generated `Methods` namespace has one type
/// per method.
public protocol ContractMethod {
    associatedtype Params: Codable & Hashable & Sendable
    associatedtype Output: Codable & Hashable & Sendable
    static var name: String { get }
}

public let jsonRPCVersion = "2.0"

/// The host's cancel: `$/cancel { id }` stops request `id` at its next safe point.
public let cancelMethod = "$/cancel"

/// A JSON-RPC error object: the standard codes carry no `data`; `-32000` carries a `ComputerError`.
public struct RPCErrorObject: Codable, Hashable, Sendable {
    public let code: Int
    public let message: String
    public let data: ComputerError?

    public init(code: Int, message: String, data: ComputerError? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }

    /// A failure of the protocol's own, as the `-32000` error a request answers.
    public init(_ error: ComputerError) {
        self.init(code: ComputerDefaults.RPCErrorCode.computer, message: error.message, data: error)
    }
}

public enum FramingError: Error, Hashable, Sendable {
    /// The frame has no `"jsonrpc":"2.0"`.
    case notJSONRPC
    /// The frame is none of request, notification, result or error.
    case unknownShape
    /// A line passed the size limit before its newline.
    case lineTooLong(Int)
}

/// Any frame either side sends, told apart by its keys: a request has a
/// method and an id, a notification a method and no id, a result a `result`,
/// an error an `error`. Params and results stay `JSONValue` until the reader,
/// who knows the method, decodes them.
public enum RPCFrame: Codable, Hashable, Sendable {
    case request(id: Int, method: String, params: JSONValue)
    case notification(method: String, params: JSONValue)
    case result(id: Int, result: JSONValue)
    case error(id: Int?, error: RPCErrorObject)

    private enum Keys: String, CodingKey {
        case jsonrpc, id, method, params, result, error
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        guard (try? c.decode(String.self, forKey: .jsonrpc)) == jsonRPCVersion else { throw FramingError.notJSONRPC }
        if let method = try c.decodeIfPresent(String.self, forKey: .method) {
            let params = try c.decodeIfPresent(JSONValue.self, forKey: .params) ?? .object([:])
            if let id = try c.decodeIfPresent(Int.self, forKey: .id) {
                self = .request(id: id, method: method, params: params)
            } else {
                self = .notification(method: method, params: params)
            }
        } else if c.contains(.error) {
            self = .error(id: try c.decodeIfPresent(Int.self, forKey: .id), error: try c.decode(RPCErrorObject.self, forKey: .error))
        } else if c.contains(.result) {
            self = .result(id: try c.decode(Int.self, forKey: .id), result: try c.decode(JSONValue.self, forKey: .result))
        } else {
            throw FramingError.unknownShape
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(jsonRPCVersion, forKey: .jsonrpc)
        switch self {
        case .request(let id, let method, let params):
            try c.encode(id, forKey: .id)
            try c.encode(method, forKey: .method)
            try c.encode(params, forKey: .params)
        case .notification(let method, let params):
            try c.encode(method, forKey: .method)
            try c.encode(params, forKey: .params)
        case .result(let id, let result):
            try c.encode(id, forKey: .id)
            try c.encode(result, forKey: .result)
        case .error(let id, let error):
            try c.encode(id, forKey: .id)
            try c.encode(error, forKey: .error)
        }
    }

    /// A request for `M`.
    public static func request<M: ContractMethod>(_ method: M.Type, id: Int, params: M.Params) throws -> RPCFrame {
        .request(id: id, method: M.name, params: try JSONValue(params))
    }

    /// The answer to a request for `M`.
    public static func result<M: ContractMethod>(_ method: M.Type, id: Int, output: M.Output) throws -> RPCFrame {
        .result(id: id, result: try JSONValue(output))
    }
}

extension JSONValue {
    /// These params read as `M`'s.
    public func params<M: ContractMethod>(of method: M.Type) throws -> M.Params { try decode(M.Params.self) }

    /// This result read as `M`'s output.
    public func output<M: ContractMethod>(of method: M.Type) throws -> M.Output { try decode(M.Output.self) }
}

/// Splits a byte stream into lines, refusing one past `maxBytes` before its newline.
public struct LineReader: Sendable {
    public let maxBytes: Int
    private var buffer = Data()

    public init(maxBytes: Int = ComputerDefaults.Service.lineMaxBytes) {
        self.maxBytes = maxBytes
    }

    /// The whole lines `data` completes, without their newlines; a partial line waits for the next feed.
    public mutating func feed(_ data: Data) throws -> [Data] {
        buffer.append(data)
        var lines: [Data] = []
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<newline]
            if line.count > maxBytes { throw FramingError.lineTooLong(line.count) }
            if !line.isEmpty { lines.append(Data(line)) }
            buffer = Data(buffer[buffer.index(after: newline)...])
        }
        if buffer.count > maxBytes { throw FramingError.lineTooLong(buffer.count) }
        return lines
    }
}

/// One frame as one line: JSON with no raw newline (JSON never needs one), then `\n`.
public func encodeLine(_ frame: RPCFrame) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    var data = try encoder.encode(frame)
    data.append(0x0A)
    return data
}

/// The frame a line holds.
public func decodeLine(_ line: Data) throws -> RPCFrame {
    try JSONDecoder().decode(RPCFrame.self, from: line)
}
