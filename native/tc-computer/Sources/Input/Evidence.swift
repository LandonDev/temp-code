import ComputerProtocol

/// What a destination showed of itself before and after keys or a paste went in: a
/// digest of AXValue, AXSelectedTextRange and AXNumberOfCharacters, whichever it exposes.
public struct Evidence: Equatable, Sendable {
    public var valueHash: Int?
    public var range: TextRange?
    public var count: Int?

    public init(valueHash: Int? = nil, range: TextRange? = nil, count: Int? = nil) {
        self.valueHash = valueHash
        self.range = range
        self.count = count
    }

    /// The evidence of a value: its digest (stable within the process), its selection and its length.
    public init(value: String?, range: TextRange?, count: Int?) {
        self.init(valueHash: value.map { var h = Hasher(); h.combine($0); return h.finalize() }, range: range, count: count)
    }

    /// `changed` when anything readable on both sides moved; `none` only when the value
    /// was readable and stayed, and the range stayed when it was readable; else `unknown`
    /// (an unchanged character count alone proves nothing).
    public static func compare(before: Evidence, after: Evidence) -> StepEffect {
        if let a = before.valueHash, let b = after.valueHash, a != b { return .changed }
        if let a = before.range, let b = after.range, a != b { return .changed }
        if let a = before.count, let b = after.count, a != b { return .changed }
        guard before.valueHash != nil, after.valueHash != nil else { return .unknown }
        if (before.range == nil) != (after.range == nil) { return .unknown }
        return .none
    }
}

/// The `type` ladder's choice between keys and paste, pure.
public enum TypingRoute: Equatable, Sendable {
    case keys
    case paste

    /// Keys for text of at most `keysMaxUnits` UTF-16 units whose every grapheme cluster
    /// fits one Unicode key event; anything else goes straight to paste, no key posted.
    public static func route(_ text: String) -> TypingRoute {
        if text.utf16.count > InputTiming.keysMaxUnits { return .paste }
        return text.contains { $0.utf16.count > InputTiming.typeChunkUnits } ? .paste : .keys
    }

    /// After the keys rung: paste only when nothing changed. After `changed` or `unknown`,
    /// keys may have gone in, and the text is never entered twice.
    public static func pasteAfterKeys(_ effect: StepEffect) -> Bool {
        effect == .none
    }
}
