import ComputerProtocol

/// A run of text in UTF-16 units, as AXSelectedTextRange counts it.
public struct TextRange: Equatable, Sendable {
    public var location: Int
    public var length: Int

    public init(location: Int, length: Int) {
        self.location = location
        self.length = length
    }

    public var end: Int { location + length }
}

/// The first occurrence of `text` in `value` that has `prefix` right before it and
/// `suffix` right after it, in UTF-16 units; nil when there is none. An empty
/// `text` matches the empty run at the first place the prefix and suffix allow.
public func findText(_ text: String, in value: String, prefix: String? = nil, suffix: String? = nil) -> TextRange? {
    let v = Array(value.utf16), t = Array(text.utf16)
    let p = Array((prefix ?? "").utf16), s = Array((suffix ?? "").utf16)
    guard t.count <= v.count else { return nil }
    var i = 0
    while i + t.count <= v.count {
        if v[i ..< i + t.count].elementsEqual(t),
           i >= p.count, v[i - p.count ..< i].elementsEqual(p),
           i + t.count + s.count <= v.count, v[i + t.count ..< i + t.count + s.count].elementsEqual(s) {
            return TextRange(location: i, length: t.count)
        }
        i += 1
    }
    return nil
}

/// The range to set for a match: the match itself to select it, or an empty range at its start or end for the caret.
public func selection(for match: TextRange, place: Placement?) -> TextRange {
    switch place {
    case .before: TextRange(location: match.location, length: 0)
    case .after: TextRange(location: match.end, length: 0)
    default: match
    }
}

/// `select_text`'s `range` `[a, b]` as a run.
public func textRange(_ range: [Int]) -> TextRange? {
    guard range.count == 2, range[0] >= 0, range[1] >= range[0] else { return nil }
    return TextRange(location: range[0], length: range[1] - range[0])
}
