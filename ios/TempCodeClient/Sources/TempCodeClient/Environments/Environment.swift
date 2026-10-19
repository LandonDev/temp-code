import Foundation
import TempCodeContract

/// One paired temp-code host. The id is the host's own environment id (from
/// `hello`), kept across restarts and endpoint changes; the key lives in the
/// `KeyStore` under that id and never in this value.
public struct Environment: Sendable, Hashable, Codable, Identifiable {
    public let id: String
    public var name: String
    /// `https://tempcode.landonhale.com`, or `http://127.0.0.1:7677` for a dev instance.
    public var origin: URL
    public var caps: [Capability]
    public var keyId: String
    public var keyName: String
    /// Wall-clock milliseconds of the pairing.
    public var addedAt: Double

    public init(id: String, name: String, origin: URL, caps: [Capability], keyId: String, keyName: String, addedAt: Double) {
        self.id = id
        self.name = name
        self.origin = origin
        self.caps = caps
        self.keyId = keyId
        self.keyName = keyName
        self.addedAt = addedAt
    }

    /// The host as the list shows it: the origin without its scheme.
    public var host: String {
        guard let host = origin.host else { return origin.absoluteString }
        if let port = origin.port { return "\(host):\(port)" }
        return host
    }

    /// `wss://host/ws` (or `ws://` behind a plain-http origin), before the ticket.
    public var socketURL: URL {
        var parts = URLComponents(url: origin, resolvingAgainstBaseURL: false) ?? URLComponents()
        parts.scheme = origin.scheme == "http" ? "ws" : "wss"
        parts.path = "/ws"
        parts.query = nil
        parts.fragment = nil
        return parts.url ?? origin
    }

    public func allows(_ capability: Capability) -> Bool {
        if capability == .read { return true }
        return caps.contains(capability) || caps.contains(.admin)
    }
}

/// `<origin>/pair#<code>`, as the desktop's Remote access pane and
/// `tc-local remote.pairings.create` print it.
public struct PairingLink: Sendable, Hashable {
    public let origin: URL
    /// `XXXXX-XXXXX`.
    public let code: String

    public init(origin: URL, code: String) {
        self.origin = origin
        self.code = code
    }

    /// Reads a pasted link. Tolerates whitespace, a lowercase code and a
    /// missing dash; refuses anything that is not an http(s) origin plus a code.
    public init?(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: trimmed),
              let scheme = parts.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = parts.host, !host.isEmpty,
              let fragment = parts.fragment,
              let code = PairingLink.normalizeCode(fragment)
        else { return nil }
        var originParts = URLComponents()
        originParts.scheme = scheme
        originParts.host = host
        originParts.port = parts.port
        guard let origin = originParts.url else { return nil }
        self.origin = origin
        self.code = code
    }

    /// `ab1cd-ef2gh`, `AB1CDEF2GH` → `AB1CD-EF2GH`; nil for anything else.
    public static func normalizeCode(_ raw: String) -> String? {
        let letters = raw.uppercased().filter { $0 != "-" && !$0.isWhitespace }
        guard letters.count == 10, letters.allSatisfy({ $0.isASCII && ($0.isNumber || $0.isUppercase) }) else { return nil }
        return "\(letters.prefix(5))-\(letters.suffix(5))"
    }
}
