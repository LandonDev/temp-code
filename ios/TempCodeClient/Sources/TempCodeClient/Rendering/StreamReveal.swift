import Foundation
import Observation

/// The phrase fade (the desktop's lib/streamReveal.ts): each step of a
/// streaming reply (`SmoothTextReveal`'s whole-word steps, about every
/// 100 ms) fades in as one run over `MotionValues.revealFade`, linear.
///
/// A ledger per block, keyed by the block's first `keyChars` characters of
/// plain text, holds the text the block has shown and the steps it grew by:
/// each call, the text past what the ledger holds is a new step. A block
/// shorter than the key grows into the longer key. A block whose text no
/// longer starts with its ledger's (a paragraph reparsed into a heading)
/// starts a new ledger, so it fades in whole. Text the row held before it
/// was armed is shown, never faded. Offsets are in Characters.
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
        ledgers[String(text.prefix(Self.keyChars))] = ledger
        if reduced { return [RevealSegment(from: 0, to: count, bornAt: nil)] }
        // Only steps inside this text: a ledger reached through a shorter text under the same key holds longer steps.
        let young = ledger.steps.filter { now - $0.at < Self.fade && $0.from < count }.suffix(Self.maxYoung)
        guard let first = young.first else { return [RevealSegment(from: 0, to: count, bornAt: nil)] }
        var runs: [RevealSegment] = []
        if first.from > 0 { runs.append(RevealSegment(from: 0, to: first.from, bornAt: nil)) }
        for step in young { runs.append(RevealSegment(from: step.from, to: min(step.to, count), bornAt: step.at)) }
        return runs.filter { $0.to > $0.from }
    }

    private mutating func ledgerFor(_ text: String) -> Ledger {
        let key = String(text.prefix(Self.keyChars))
        var ledger = ledgers[key]
        if ledger == nil {
            // A block shorter than the key grows into a longer key.
            if let (shortKey, short) = ledgers.first(where: { $0.key.count < Self.keyChars && text.hasPrefix($0.value.text) }) {
                ledgers[shortKey] = nil
                ledger = short
            }
        }
        guard let ledger, text.hasPrefix(ledger.text) else { return Ledger() }
        return ledger
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
