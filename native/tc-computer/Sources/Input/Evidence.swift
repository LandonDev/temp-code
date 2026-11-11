import ComputerProtocol
import Foundation

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

    /// After an AX write the app accepted: the next rung only when nothing changed. Chromium
    /// accepts AXSelectedText on a contenteditable and drops it (a TempCode composer, measured);
    /// after `changed` or `unknown` the text may be in, and it is never entered twice.
    public static func nextRungAfterAX(_ effect: StepEffect) -> Bool {
        effect == .none
    }
}

/// §25.8's read-back: whether a value read from an element is the value `set_value` asked for.
/// Strings compare trimmed, numbers as numbers, a pop up by its value or its selected item's title.
public enum ReadBack {
    public enum Verdict: Equatable, Sendable {
        /// the element reads what was asked
        case taken
        /// it reads this instead: `value_not_taken`, its `value` this
        case notTaken(String)
        /// nothing readable: today's rule, the write's own answer stands
        case unreadable
    }

    /// One read against the value asked; `read` nil is an element that answers nothing.
    public static func verdict(asked: String, read: String?) -> Verdict {
        guard let read else { return .unreadable }
        return same(asked, read) ? .taken : .notTaken(read)
    }

    /// A pop up's read: its value, else its selected item's title, against the item `pick` pressed.
    public static func popUp(item: String, value: String?, selectedTitle: String?) -> Verdict {
        if let value, same(item, value) { return .taken }
        if let selectedTitle, same(item, selectedTitle) { return .taken }
        guard let shown = value ?? selectedTitle else { return .unreadable }
        return .notTaken(shown)
    }

    /// Trimmed strings equal, or both numbers of the same value (`1,000` and `1000.0`).
    public static func same(_ a: String, _ b: String) -> Bool {
        let x = a.trimmingCharacters(in: .whitespacesAndNewlines), y = b.trimmingCharacters(in: .whitespacesAndNewlines)
        if x == y { return true }
        guard let n = number(x), let m = number(y) else { return false }
        return n == m
    }

    /// A decimal number as written, with or without thousands commas; nil for anything else.
    static func number(_ s: String) -> Double? {
        let digits = s.unicodeScalars.allSatisfy { "0123456789.,+-eE".unicodeScalars.contains($0) }
        guard digits, s.contains(where: \.isNumber) else { return nil }
        if let d = Double(s) { return d }
        // commas only as thousands separators: 1,234 or -12,345.6
        let parts = s.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count <= 2 else { return nil }
        let whole = parts[0].hasPrefix("-") || parts[0].hasPrefix("+") ? parts[0].dropFirst() : parts[0]
        let groups = whole.split(separator: ",", omittingEmptySubsequences: false)
        guard groups.count > 1, (1 ... 3).contains(groups[0].count), groups.dropFirst().allSatisfy({ $0.count == 3 }) else { return nil }
        return Double(s.replacingOccurrences(of: ",", with: ""))
    }

    /// A `set_value`'s own evidence: the element reads the value asked and read otherwise before, so the
    /// write changed it, whatever the wait saw (Finder's inline name sends no notification and its outline's
    /// signature misses the field, macOS 27.2). Nil leaves the effect to the wait.
    public static func written(asked: String, before: String?, after: String?) -> StepEffect? {
        guard let after, same(asked, after) else { return nil }
        if let before, same(asked, before) { return nil }
        return .changed
    }

    /// A checkbox's or radio's evidence (§25.7): its value alone before and after the route. Unchanged is
    /// `none`, so a click that only moved the focus ring never reads `changed`; unreadable is `unknown`.
    public static func toggle(before: String?, after: String?) -> StepEffect {
        guard let before, let after else { return .unknown }
        return before == after ? .none : .changed
    }
}
