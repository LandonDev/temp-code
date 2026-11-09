import ComputerProtocol
import Foundation

/// Names, values and titles as JSON strings, written exactly as JavaScript's
/// `JSON.stringify` writes them (docs/computer-protocol.md §4.1): `\"`, `\\`,
/// `\b \f \n \r \t`, other code points under U+0020 as lower-case `\u00xx`,
/// everything else raw, `/` never escaped. JSONEncoder is never used here: it
/// escapes `/`.
public enum Quote {
    public static func json(_ s: String) -> String {
        var out = "\""
        out.reserveCapacity(s.utf8.count + 2)
        for scalar in s.unicodeScalars {
            switch scalar.value {
            case 0x22: out += "\\\""
            case 0x5C: out += "\\\\"
            case 0x08: out += "\\b"
            case 0x0C: out += "\\f"
            case 0x0A: out += "\\n"
            case 0x0D: out += "\\r"
            case 0x09: out += "\\t"
            case 0..<0x20:
                let hex = String(scalar.value, radix: 16)
                out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }
}

/// The cuts of a printed name or value: lengths count Unicode scalars, as
/// `observation.ts` does, and a cut ends on a grapheme boundary, so no emoji
/// or combined character is split.
public enum Cut {
    /// The longest prefix of `s` that is whole graphemes and at most `max` scalars, and how many scalars it holds.
    public static func prefix(_ s: String, scalars max: Int) -> (text: Substring, scalars: Int) {
        var count = 0
        var end = s.startIndex
        for ch in s {
            let n = ch.unicodeScalars.count
            if count + n > max { break }
            count += n
            end = s.index(after: end)
        }
        return (s[..<end], count)
    }

    /// A name: at most `max` scalars, then `…`.
    public static func name(_ s: String, max: Int = ComputerDefaults.ObservationText.nameMaxChars) -> String {
        if s.unicodeScalars.count <= max { return s }
        return String(prefix(s, scalars: max).text) + "…"
    }

    /// A value: at most `max` scalars, then `…(+<n> chars)`, `n` the scalars left out of `total`.
    public static func value(_ s: String, total: Int? = nil, max: Int = ComputerDefaults.ObservationText.valueMaxChars) -> String {
        let whole = total ?? s.unicodeScalars.count
        if whole <= max, s.unicodeScalars.count <= max { return s }
        let (text, shown) = prefix(s, scalars: max)
        return "\(text)…(+\(whole - shown) chars)"
    }
}

/// FNV-1a, 64-bit: a hash that is the same in every process, for value
/// comparison and for fixture ids.
public struct StableHash: Sendable {
    public private(set) var value: UInt64 = 0xcbf2_9ce4_8422_2325

    public init() {}

    public mutating func add(_ s: String) {
        for b in s.utf8 { add(byte: b) }
        add(byte: 0xFF)
    }

    public mutating func add(_ n: Int) {
        var v = UInt64(bitPattern: Int64(n))
        for _ in 0..<8 {
            add(byte: UInt8(v & 0xFF))
            v >>= 8
        }
    }

    public mutating func add(byte: UInt8) {
        value ^= UInt64(byte)
        value = value &* 0x0000_0100_0000_01B3
    }

    public static func of(_ s: String) -> UInt64 {
        var h = StableHash()
        h.add(s)
        return h.value
    }
}
