import Foundation

/// The phrase fade's ledger, the desktop's lib/streamReveal.ts for the
/// phone: per streaming block, keyed by its first 32 characters, each pass's
/// new text is a step with its arrival time. The view draws the block as the
/// settled prefix and the steps younger than the fade (at most four, the
/// older merged into the prefix), each young step at its linear opacity. A
/// block whose text no longer starts with its ledger's (a paragraph turning
/// into a table) starts a new ledger, so the reparsed block fades in whole.
/// Text the row held before it armed is shown, not faded. Under reduced
/// motion no segments are built; the word steps stay.
public struct StreamReveal: Sendable {
    public static let keyLength = 32
    public static let maxYoung = 4

    public struct Step: Sendable, Hashable {
        /// UTF-16 offsets into the block's text.
        public var from: Int
        public var to: Int
        /// Seconds; -infinity for text held before arming.
        public var at: Double
    }

    /// One run of the block to draw: its text and its opacity now.
    public struct Segment: Sendable, Hashable {
        public var text: String
        public var opacity: Double
        /// The step's arrival, for a renderer that animates the run itself.
        public var at: Double
    }

    private struct Ledger: Sendable {
        var text: String
        var steps: [Step]
    }

    private var ledgers: [String: Ledger] = [:]
    public private(set) var armed = false
    /// When the newest step arrived, or -infinity.
    public private(set) var lastStepAt = -Double.infinity
    public let fade: Double

    public init(fade: Double = MotionValues.revealFade) {
        self.fade = fade
    }

    /// From now on new text fades.
    public mutating func arm() { armed = true }

    /// A pass over a block's revealed `text` at `now` (seconds): records any
    /// new step and returns the segments to draw. `reduced` builds one plain
    /// segment.
    public mutating func observe(_ text: String, now: Double, reduced: Bool = false) -> [Segment] {
        guard !text.isEmpty else { return [] }
        let key = SmoothText.prefix(of: text, units: Self.keyLength)
        var ledger = ledgers[key]
        if ledger == nil {
            // A block shorter than the key grows into a longer one.
            if let (shortKey, short) = ledgers.first(where: { $0.key.utf16.count < Self.keyLength && text.hasPrefix($0.value.text) }) {
                ledgers[shortKey] = nil
                ledger = short
            }
        }
        if ledger == nil || !text.hasPrefix(ledger!.text) { ledger = Ledger(text: "", steps: []) }
        var current = ledger!
        let length = text.utf16.count
        let held = current.text.utf16.count
        if length > held {
            let at = armed ? now : -Double.infinity
            current.steps.append(Step(from: held, to: length, at: at))
            if at > lastStepAt { lastStepAt = at }
        }
        current.text = text
        ledgers[key] = current
        if reduced { return [Segment(text: text, opacity: 1, at: -.infinity)] }
        return segments(text, steps: current.steps, now: now)
    }

    /// Whether any step is still fading at `now`: the row stays on its
    /// streaming render until this is false and the reveal has drained.
    public func fading(now: Double) -> Bool {
        now - lastStepAt < fade
    }

    private func segments(_ text: String, steps: [Step], now: Double) -> [Segment] {
        let young = steps.filter { now - $0.at < fade }.suffix(Self.maxYoung)
        let units = Array(text.utf16)
        func slice(_ from: Int, _ to: Int) -> String { String(decoding: units[from..<to], as: UTF16.self) }
        let prefixEnd = young.first?.from ?? units.count
        var out: [Segment] = []
        if prefixEnd > 0 { out.append(Segment(text: slice(0, prefixEnd), opacity: 1, at: -.infinity)) }
        for step in young {
            let end = min(step.to, units.count)
            guard step.from < end else { continue }
            out.append(Segment(text: slice(step.from, end), opacity: min(1, max(0, (now - step.at) / fade)), at: step.at))
        }
        return out
    }
}

/// Which turns still have text being revealed, the desktop's revealDrain.ts:
/// a row reports itself from its first step until its reveal has drained
/// (every step shown, the last fade done); the turn's closing line waits
/// until no row of its turn reports.
public struct RevealDrain: Sendable, Hashable {
    private var revealing: [String: Set<String>] = [:]

    public init() {}

    /// Row `row` of turn `turn` reveals (`on`) or has drained.
    public mutating func report(turn: String, row: String, on: Bool) {
        if on {
            revealing[turn, default: []].insert(row)
        } else {
            revealing[turn]?.remove(row)
            if revealing[turn]?.isEmpty == true { revealing[turn] = nil }
        }
    }

    public func isRevealing(_ turn: String) -> Bool { revealing[turn] != nil }
}
