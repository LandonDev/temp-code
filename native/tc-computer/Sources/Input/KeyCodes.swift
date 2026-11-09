/// The grammar's key names (InputTables.keyNames' canonical values) as macOS virtual
/// key codes: the `kVK_*` values of Carbon's Events.h, as literals so this file
/// needs no framework. A key fixed by position has a code; a punctuation name
/// stands for the character it types, which the keyboard layout places.
public enum KeyCodes {
    /// The key a modifier's own key-down and key-up use (the left one).
    public static let modifierCodes: [String: UInt16] = ["shift": 56, "ctrl": 59, "alt": 58, "super": 55]

    public static let returnKey: UInt16 = 36
    public static let tab: UInt16 = 48

    private static let fixed: [String: UInt16] = [
        "Return": 36, "Tab": 48, "space": 49, "BackSpace": 51, "Escape": 53, "Delete": 117,
        "Home": 115, "End": 119, "Page_Up": 116, "Page_Down": 121,
        "Left": 123, "Right": 124, "Down": 125, "Up": 126,
        "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100,
        "F9": 101, "F10": 109, "F11": 103, "F12": 111, "F13": 105, "F14": 107, "F15": 113,
        "F16": 106, "F17": 64, "F18": 79, "F19": 80, "F20": 90
    ]

    private static let characters: [String: Character] = [
        "minus": "-", "plus": "+", "equal": "=", "comma": ",", "period": ".", "slash": "/",
        "backslash": "\\", "semicolon": ";", "apostrophe": "'", "grave": "`",
        "bracketleft": "[", "bracketright": "]"
    ]

    /// The virtual key code of a key fixed by position, or of a modifier.
    public static func code(_ canonical: String) -> UInt16? {
        fixed[canonical] ?? modifierCodes[canonical]
    }

    /// The character a punctuation name types; the layout gives its key.
    public static func character(_ canonical: String) -> Character? {
        characters[canonical]
    }
}
