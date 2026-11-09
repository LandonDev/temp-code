/// The key and modifiers that type one character on a keyboard layout.
public struct KeyStroke: Equatable, Sendable {
    public var code: UInt16
    public var modifiers: Modifiers

    public init(code: UInt16, modifiers: Modifiers = []) {
        self.code = code
        self.modifiers = modifiers
    }
}

/// Where a character sits on the keyboard: the person's layout (CurrentKeyLayout) live, a fixed one in tests.
public protocol KeyLayoutSource: Sendable {
    func stroke(for c: Character) -> KeyStroke?
}

/// The US ANSI layout, fixed: the tests' layout, and the fallback for an input source with no layout data.
public struct USANSILayout: KeyLayoutSource {
    public init() {}

    private static let plain: [Character: UInt16] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
        "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
        "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31,
        "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
        ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50, " ": 49
    ]

    private static let shifted: [Character: Character] = [
        "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
        "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`"
    ]

    public func stroke(for c: Character) -> KeyStroke? {
        if let code = Self.plain[c] { return KeyStroke(code: code) }
        if let base = Self.shifted[c], let code = Self.plain[base] { return KeyStroke(code: code, modifiers: .shift) }
        if c.isUppercase, c.isASCII, let lower = c.lowercased().first, let code = Self.plain[lower] {
            return KeyStroke(code: code, modifiers: .shift)
        }
        return nil
    }
}
