import ComputerCore
import ComputerProtocol

/// The four modifiers, as the Mac names them: `super` is Command and `alt` is Option.
public struct Modifiers: OptionSet, Sendable, Hashable {
    public let rawValue: UInt8
    public init(rawValue: UInt8) { self.rawValue = rawValue }

    public static let shift = Modifiers(rawValue: 1 << 0)
    public static let control = Modifiers(rawValue: 1 << 1)
    public static let option = Modifiers(rawValue: 1 << 2)
    public static let command = Modifiers(rawValue: 1 << 3)

    /// Each modifier with its canonical grammar name, in the order a combo prints them (InputTables.modifiers).
    public static let canonical: [(Modifiers, String)] = [(.shift, "shift"), (.control, "ctrl"), (.option, "alt"), (.command, "super")]

    /// The modifier a canonical name stands for.
    public init?(canonical name: String) {
        guard let entry = Modifiers.canonical.first(where: { $0.1 == name }) else { return nil }
        self = entry.0
    }

    /// The canonical names, in print order.
    public var names: [String] { Modifiers.canonical.filter { contains($0.0) }.map(\.1) }

    /// One modifier at a time, in print order.
    public var each: [Modifiers] { Modifiers.canonical.map(\.0).filter { contains($0) } }
}

/// The key of a combo: a canonical name from the grammar (`Return`, `F5`, `shift`), or one character as written.
public enum KeyName: Equatable, Sendable {
    case named(String)
    case character(Character)

    /// The text a combo prints for it.
    public var text: String {
        switch self {
        case .named(let n): n
        case .character(let c): String(c)
        }
    }
}

public struct KeyCombo: Equatable, Sendable {
    public var modifiers: Modifiers
    public var key: KeyName

    public init(modifiers: Modifiers, key: KeyName) {
        self.modifiers = modifiers
        self.key = key
    }
}

private func invalidKey(_ message: String) -> ComputerFailure {
    ComputerFailure(.invalidKey, message)
}

/// `ctrl+s`, `super+shift+t`, `alt+Tab`, `Return`, `super++`: names case-insensitive, `+`-joined.
/// The same parse as src/shared/computer/observation.ts `parseKeyCombo`; fixtures/keys/combos.json holds both to it.
public func parseKeyCombo(_ text: String) throws -> KeyCombo {
    if text.isEmpty { throw invalidKey("a key is needed") }
    if text == "+" { return KeyCombo(modifiers: [], key: .character("+")) }
    var rest = Substring(text)
    var key: KeyName?
    if text.hasSuffix("++") {
        key = .character("+")
        rest = rest.dropLast(2)
    }
    var parts = rest.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    if parts.contains(where: \.isEmpty) { throw invalidKey("\"\(text)\" has an empty part") }
    if key == nil { key = try keyName(parts.removeLast()) }
    let modifiers = try modifierParts(parts, text: text)
    if case .named(let name) = key!, let m = Modifiers(canonical: name), modifiers.contains(m) {
        throw invalidKey("\"\(text)\" names \(name) twice")
    }
    return KeyCombo(modifiers: modifiers, key: key!)
}

/// The modifiers a click, drag or scroll holds (its `text`): `shift`, `ctrl+alt`, `cmd`. None when absent.
public func parseModifiers(_ text: String?) throws -> Modifiers {
    guard let text else { return [] }
    let parts = text.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    if parts.contains(where: \.isEmpty) { throw invalidKey("\"\(text)\" has an empty part") }
    return try modifierParts(parts, text: text)
}

private func modifierParts(_ parts: [String], text: String) throws -> Modifiers {
    var out: Modifiers = []
    for part in parts {
        guard let name = InputTables.modifierNames[part.lowercased()], let m = Modifiers(canonical: name) else {
            throw invalidKey("\"\(part)\" in \"\(text)\" is not a modifier")
        }
        if out.contains(m) { throw invalidKey("\"\(text)\" names \(name) twice") }
        out.insert(m)
    }
    return out
}

/// One part as a key: a single code point as written (a space is `space`), else a grammar name.
private func keyName(_ part: String) throws -> KeyName {
    // one Unicode scalar, as the TypeScript parse counts code points
    if part.unicodeScalars.count == 1 { return part == " " ? .named("space") : .character(Character(part)) }
    guard let named = InputTables.keyNames[part.lowercased()] else { throw invalidKey("\"\(part)\" is not a key") }
    return .named(named)
}
