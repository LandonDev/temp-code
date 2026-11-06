import Foundation
import Observation

/// The phrase fade (the desktop's lib/streamReveal.ts): each step of a
/// streaming reply (`SmoothTextReveal`'s whole-word steps, about every
/// 100 ms) fades in as one run over `MotionValues.revealFade`, linear.
///
/// A ledger per block, keyed by the block's first `keyChars` characters of
/// plain text without their marks (`key`), holds the text the block has
/// shown and the steps it grew by: each call, the text past what the
/// ledger holds is a new step. A block
/// shorter than the key grows into the longer key. A block whose marks
/// alone changed (a link's text closed into literal brackets, a lone `*`
/// read literally once the block is no longer the last) keeps its ledger:
/// what it showed keeps its place in the new text (`shownEnd`) and only
/// the text past it fades. A block whose text no longer starts with its
/// ledger's otherwise (a paragraph reparsed into a heading) starts a new
/// ledger, so it fades in whole. Text the row held before it was armed is
/// shown, never faded. Offsets are in Characters.
public struct StreamRevealLedger: Sendable {
    public static let keyChars = 32
    /// Young steps drawn as runs of their own; older young steps join the prefix.
    public static let maxYoung = 4
    public static var fade: Double { MotionValues.revealFade }

    struct Step: Sendable, Equatable {
        var from: Int
        var to: Int
        var at: Double
    }

    struct Ledger: Sendable {
        var text = ""
        var steps: [Step] = []
    }

    private var ledgers: [String: Ledger] = [:]
    public private(set) var armed = false
    /// When the newest armed step arrived, seconds; -infinity before one.
    public private(set) var lastStepAt = -Double.infinity

    public init() {}

    /// From now on new text fades.
    public mutating func arm() { armed = true }

    /// Whether a step is still fading at `now`.
    public func fading(at now: Double) -> Bool { now - lastStepAt < Self.fade }

    /// Notes a block's plain text at `now` and answers its runs: the settled
    /// prefix (`bornAt` nil) and each step younger than the fade, at most
    /// `maxYoung`. Under reduced motion the step is noted but the block is
    /// one settled run: the word steps stay, nothing fades.
    public mutating func segments(for text: String, at now: Double, reduced: Bool = false) -> [RevealSegment] {
        let count = text.count
        guard count > 0 else { return [] }
        var ledger = ledgerFor(text)
        let held = ledger.text.count
        if count > held {
            let at = armed ? now : -Double.infinity
            ledger.steps.append(Step(from: held, to: count, at: at))
            if at > lastStepAt { lastStepAt = at }
        }
        ledger.text = text
        ledgers[Self.key(text)] = ledger
        if reduced { return [RevealSegment(from: 0, to: count, bornAt: nil)] }
        // Only steps inside this text: a ledger reached through a shorter text under the same key holds longer steps.
        let young = ledger.steps.filter { now - $0.at < Self.fade && $0.from < count }.suffix(Self.maxYoung)
        guard let first = young.first else { return [RevealSegment(from: 0, to: count, bornAt: nil)] }
        var runs: [RevealSegment] = []
        if first.from > 0 { runs.append(RevealSegment(from: 0, to: first.from, bornAt: nil)) }
        for step in young { runs.append(RevealSegment(from: step.from, to: min(step.to, count), bornAt: step.at)) }
        return runs.filter { $0.to > $0.from }
    }

    /// A block's ledger key: its first `keyChars` characters without their
    /// marks, so a rewrite of the marks keeps the key.
    static func key(_ text: String) -> String {
        String(skeleton(text).prefix(keyChars))
    }

    private mutating func ledgerFor(_ text: String) -> Ledger {
        let key = Self.key(text)
        let skeleton = Self.skeleton(text)
        var ledger = ledgers[key]
        if ledger == nil {
            // A block shorter than the key grows into a longer key.
            if let (shortKey, short) = ledgers.first(where: { $0.key.count < Self.keyChars && skeleton.hasPrefix(Self.skeleton($0.value.text)) }) {
                ledgers[shortKey] = nil
                ledger = short
            }
        }
        guard let ledger else { return Ledger() }
        if text.hasPrefix(ledger.text) { return ledger }
        // The same block with only its marks rewritten: the ledger moves onto the new text.
        let was = Self.skeleton(ledger.text)
        if skeleton.hasPrefix(was) || was.hasPrefix(skeleton) { return Self.moved(ledger, onto: text) }
        return Ledger()
    }

    /// The characters an inline span's opening or closing adds or takes
    /// away (MarkdownClose's marks and a link's parentheses).
    static let marks: Set<Character> = ["*", "_", "~", "`", "[", "]", "(", ")"]

    /// `text` without its marks: what a rewrite of the marks leaves alone.
    static func skeleton(_ text: String) -> String {
        String(text.filter { !marks.contains($0) })
    }

    /// Where the first `offset` characters of `old` end in `new`, both read
    /// without their marks: past the last character they share.
    static func shownEnd(_ offset: Int, in old: String, onto new: String) -> Int {
        let kept = old.prefix(offset).filter { !marks.contains($0) }.count
        guard kept > 0 else { return 0 }
        var seen = 0
        for (index, character) in new.enumerated() where !marks.contains(character) {
            seen += 1
            if seen == kept { return index + 1 }
        }
        return new.count
    }

    /// `ledger` read on `text`: what it showed stays shown, its steps where they fell.
    static func moved(_ ledger: Ledger, onto text: String) -> Ledger {
        var moved = Ledger()
        moved.text = String(text.prefix(shownEnd(ledger.text.count, in: ledger.text, onto: text)))
        moved.steps = ledger.steps.map { step in
            Step(from: shownEnd(step.from, in: ledger.text, onto: text), to: shownEnd(step.to, in: ledger.text, onto: text), at: step.at)
        }.filter { $0.to > $0.from }
        return moved
    }
}

/// A run of a block's plain text: `[from, to)` in Characters, and when it
/// arrived (nil: settled, drawn at full opacity).
public struct RevealSegment: Sendable, Equatable {
    public var from: Int
    public var to: Int
    public var bornAt: Double?

    public init(from: Int, to: Int, bornAt: Double?) {
        self.from = from
        self.to = to
        self.bornAt = bornAt
    }

    public var young: Bool { bornAt != nil }

    /// When the youngest of `runs` is drawn whole (its arrival plus the
    /// fade); nil when none fades. A redraw past it changes nothing.
    public static func fadeEnd(_ runs: [RevealSegment]) -> Double? {
        runs.compactMap(\.bornAt).max().map { $0 + StreamRevealLedger.fade }
    }

    /// The redraws a fade needs from `start` to `end` (seconds), `interval`
    /// apart, the last at `end` so the youngest run lands at full opacity;
    /// none once `end` has passed. The timeline stops after the last.
    public static func fadeTicks(from start: Double, until end: Double, every interval: Double) -> [Double] {
        guard end > start, interval > 0 else { return [] }
        var ticks = Array(stride(from: start, to: end, by: interval))
        ticks.append(end)
        return ticks
    }

    /// The opacity a run draws at `now`: linear over the fade.
    public func opacity(at now: Double) -> Double {
        guard let bornAt else { return 1 }
        return min(1, max(0, (now - bornAt) / StreamRevealLedger.fade))
    }

    /// The runs that fall inside `[from, to)`, shifted to start at 0: one
    /// item of a list whose plain text is its items joined by newlines.
    public static func slice(_ runs: [RevealSegment], from: Int, to: Int) -> [RevealSegment] {
        runs.compactMap { run in
            let lo = max(run.from, from), hi = min(run.to, to)
            return hi > lo ? RevealSegment(from: lo - from, to: hi - from, bornAt: run.bornAt) : nil
        }
    }
}

/// Whether a streaming row stays on its streaming render (the view's
/// `StreamingAssistantRow.revealing`): the stream runs, the reveal holds
/// text back, a step is still fading, or the reveal published a step the
/// fade has not drawn yet. Without the last a reply short enough to land
/// whole in its first step ("OK.") swapped to the settled render before its
/// one step was drawn, so it never faded.
public enum StreamRowRule {
    public static func onStreamingRender(streaming: Bool, revealing: Bool, fading: Bool, revealedUnits: Int, drawnUnits: Int) -> Bool {
        streaming || revealing || fading || revealedUnits > drawnUnits
    }
}

/// Which turns still have text being revealed (the desktop's
/// surfaces/revealDrain.ts). A row that reveals streamed text reports
/// itself from its first step until its reveal has drained: every step
/// shown and the last fade done. The turn's closing line asks here and
/// waits, so no closing line is drawn above text still appearing. One per
/// thread; rows report under the key of the turn they belong to.
@MainActor @Observable
public final class RevealDrain {
    private var turns: [Int: Set<Int>] = [:]

    public init() {}

    /// A row (`row`, its key) of turn `turn` (its message's key) is, or is no longer, revealing.
    public func report(turn: Int, row: Int, on: Bool) {
        var rows = turns[turn] ?? []
        guard rows.contains(row) != on else { return }
        if on { rows.insert(row) } else { rows.remove(row) }
        turns[turn] = rows.isEmpty ? nil : rows
    }

    /// Whether any row of the turn is still revealing its text.
    public func revealing(turn: Int) -> Bool { turns[turn] != nil }
}
