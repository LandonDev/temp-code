/// A menu item's key equivalent as AX reports it (docs/computer-protocol.md §24.2):
/// AXMenuItemCmdChar, AXMenuItemCmdVirtualKey, AXMenuItemCmdGlyph and
/// AXMenuItemCmdModifiers. Pure, so the box tests the match.
public struct MenuItemShortcut: Equatable, Sendable {
    /// AXMenuItemCmdChar: AppKit reports a letter upper-cased whatever its shift
    public var cmdChar: String?
    public var virtualKey: Int?
    /// a kMenu…Glyph code, for keys with no character (Delete, Return, the arrows)
    public var glyph: Int?
    /// the AX mask: 0 is Command alone; bit 0 Shift, bit 1 Option, bit 2 Control, bit 3 no Command
    public var modifiers: Int

    public init(cmdChar: String? = nil, virtualKey: Int? = nil, glyph: Int? = nil, modifiers: Int = 0) {
        self.cmdChar = cmdChar
        self.virtualKey = virtualKey
        self.glyph = glyph
        self.modifiers = modifiers
    }

    public static let shiftBit = 1 << 0
    public static let optionBit = 1 << 1
    public static let controlBit = 1 << 2
    public static let noCommandBit = 1 << 3

    /// The modifiers the mask stands for.
    public var maskModifiers: Modifiers {
        var out: Modifiers = []
        if modifiers & Self.shiftBit != 0 { out.insert(.shift) }
        if modifiers & Self.optionBit != 0 { out.insert(.option) }
        if modifiers & Self.controlBit != 0 { out.insert(.control) }
        if modifiers & Self.noCommandBit == 0 { out.insert(.command) }
        return out
    }

    /// The key and modifiers pressing the item's equivalent takes: a glyph's key, else the
    /// character's key on the layout (so `?` is Shift-slash on US), else the virtual key.
    public func stroke(layout: KeyLayoutSource) -> KeyStroke? {
        var base: KeyStroke?
        if let glyph, glyph != 0, let name = MenuGlyphs.keyName[glyph], let code = KeyCodes.code(name) {
            base = KeyStroke(code: code)
        } else if let c = cmdChar.flatMap({ $0.count == 1 ? $0.first : nil }), c.isPrintable {
            // AppKit upper-cases a letter's equivalent; its shift is in the mask
            base = layout.stroke(for: c.isLetter ? Character(c.lowercased()) : c)
        } else if let virtualKey, virtualKey >= 0, virtualKey <= Int(UInt16.max) {
            base = KeyStroke(code: UInt16(virtualKey))
        }
        guard var stroke = base else { return nil }
        stroke.modifiers.formUnion(maskModifiers)
        return stroke
    }

    /// Whether the combo presses this item: the same key with the same modifiers, the
    /// combo's characters placed on the layout as posted keys would place them.
    public func matches(_ combo: KeyCombo, layout: KeyLayoutSource) -> Bool {
        guard let mine = stroke(layout: layout), let theirs = comboStroke(combo, layout: layout) else { return false }
        return mine == theirs
    }
}

/// The key and modifiers a combo posts, as InputCore's key step resolves them.
public func comboStroke(_ combo: KeyCombo, layout: KeyLayoutSource) -> KeyStroke? {
    var base: KeyStroke?
    switch combo.key {
    case .character(let c):
        base = layout.stroke(for: c)
    case .named(let name):
        if let code = KeyCodes.code(name) { base = KeyStroke(code: code) }
        else if let c = KeyCodes.character(name) { base = layout.stroke(for: c) }
    }
    guard var stroke = base else { return nil }
    stroke.modifiers.formUnion(combo.modifiers)
    return stroke
}

/// A combo the menu route looks up: it holds Command or Control (§24.2); `alt+e` types a character.
public func hasMenuModifier(_ combo: KeyCombo) -> Bool {
    combo.modifiers.contains(.command) || combo.modifiers.contains(.control)
}

/// The kMenu…Glyph codes of Carbon's Menus.h for keys with no character, as grammar key names.
public enum MenuGlyphs {
    public static let keyName: [Int: String] = [
        0x02: "Tab", 0x09: "space", 0x0A: "Delete", 0x0B: "Return", 0x17: "BackSpace", 0x1B: "Escape",
        0x62: "Page_Up", 0x64: "Left", 0x65: "Right", 0x66: "Home", 0x68: "Up", 0x69: "End",
        0x6A: "Down", 0x6B: "Page_Down",
        0x6F: "F1", 0x70: "F2", 0x71: "F3", 0x72: "F4", 0x73: "F5", 0x74: "F6", 0x75: "F7", 0x76: "F8",
        0x77: "F9", 0x78: "F10", 0x79: "F11", 0x7A: "F12", 0x87: "F13", 0x88: "F14", 0x89: "F15",
        0xA0: "F16", 0xA1: "F17", 0xA2: "F18", 0xA3: "F19", 0xA4: "F20"
    ]
}

private extension Character {
    /// a character a key types: not a control character, not the private-use function keys AppKit reports
    var isPrintable: Bool {
        guard let s = unicodeScalars.first else { return false }
        if s.value < 0x20 || s.value == 0x7F { return false }
        if (0xF700 ... 0xF8FF).contains(s.value) { return false }
        return true
    }
}
