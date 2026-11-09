import Foundation

/// Any JSON value, kept as the wire had it. Used where the contract says
/// `unknown` (a tool call's input), for the unknown case of every union,
/// and by the tests to compare round trips.
public enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    // MARK: Reading

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public var doubleValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    /// The number when it is a whole value the wire would write without a fraction.
    public var intValue: Int? {
        guard case .number(let value) = self, value.rounded() == value, abs(value) < 9_007_199_254_740_992 else { return nil }
        return Int(value)
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    public subscript(key: String) -> JSONValue? {
        objectValue?[key]
    }

    public subscript(index: Int) -> JSONValue? {
        guard let array = arrayValue, array.indices.contains(index) else { return nil }
        return array[index]
    }

    // MARK: Converting

    /// The value any `Encodable` produces on the wire.
    public init(_ value: some Encodable) throws {
        self = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }

    /// This value read as a contract type.
    public func decode<T: Decodable>(_ type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(self))
    }

    /// One text for one value: keys sorted, no whitespace, whole numbers
    /// without a fraction. With `dropNulls` (the default) a member whose
    /// value is `null` is left out, because the server writes `null` and
    /// nothing at all for the same absent field and a client reads both
    /// as nil; pass `false` where a `null` carries meaning (a request that
    /// clears a setting).
    public func canonicalJSON(dropNulls: Bool = true) -> String {
        var out = ""
        write(into: &out, dropNulls: dropNulls)
        return out
    }

    private func write(into out: inout String, dropNulls: Bool) {
        switch self {
        case .null:
            out += "null"
        case .bool(let value):
            out += value ? "true" : "false"
        case .number(let value):
            if let whole = intValue { out += String(whole) } else { out += String(value) }
        case .string(let value):
            JSONValue.writeString(value, into: &out)
        case .array(let items):
            out += "["
            for (index, item) in items.enumerated() {
                if index > 0 { out += "," }
                item.write(into: &out, dropNulls: dropNulls)
            }
            out += "]"
        case .object(let members):
            out += "{"
            var first = true
            for key in members.keys.sorted() {
                let value = members[key]!
                if dropNulls, case .null = value { continue }
                if !first { out += "," }
                first = false
                JSONValue.writeString(key, into: &out)
                out += ":"
                value.write(into: &out, dropNulls: dropNulls)
            }
            out += "}"
        }
    }

    private static func writeString(_ value: String, into out: inout String) {
        out += "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case _ where scalar.value < 0x20:
                out += String(format: "\\u%04x", scalar.value)
            default:
                out.unicodeScalars.append(scalar)
            }
        }
        out += "\""
    }
}
