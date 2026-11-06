import Foundation

/// The runner's reveal, fade and drain checks (A5): each assistant block
/// born during the scenario gets the row's own `SmoothTextReveal` on a hand
/// clock and a `StreamRevealLedger`, sampled at every reveal step; the
/// blocks report to a `RevealDrain` under their turn as a row does.
///
/// - `reveal`: the shown text never shrinks (a rewrite aside), a burst is
///   paced rather than shown whole, and once a block's final text is in,
///   every character shows within the pacer's catch-up after it arrived.
/// - `fade`: read as the row reads it, block by block through the
///   streaming markdown (`MarkdownCache.streamingDocument`, open spans
///   closed): no block has more than `maxYoung` young runs, none under
///   reduced motion, and no run born at a sample covers text the block
///   already showed, so its fade never starts over (an unclosed `**` once
///   showed raw, then the closed span rewrote the paragraph and it faded
///   in again from blank; a link's text closed into literal brackets did
///   the same until the ledger read a rewrite of the marks as one).
/// - `drain`: the turn reports revealing while any of its text is unshown
///   or fading, and stops within the catch-up and the fade after its last
///   text arrived.
@MainActor
final class RevealProbes {
    /// A text growing by more than this at once is a burst the pacer must spread.
    static let burstChars = 200
    /// What "within the catch-up" allows: the pacer's catch-up, two steps and the fade.
    static var deadlineMs: Double { SmoothText.catchUpMs + 2 * SmoothText.stepMs + StreamRevealLedger.fade * 1_000 }

    private final class Clock: RevealClock {
        var now: Double = 0
        private var wake: (at: Double, fire: @MainActor (Double) -> Void)?
        func schedule(afterMs ms: Double, _ fire: @escaping @MainActor (Double) -> Void) { wake = (now + ms, fire) }
        func cancel() { wake = nil }
        func advance(to until: Double) {
            while let next = wake, next.at <= until {
                wake = nil
                now = max(now, next.at)
                next.fire(now)
            }
            now = until
        }
    }

    private struct Probe {
        let clock: Clock
        let reveal: SmoothTextReveal
        var ledger = StreamRevealLedger()
        let turn: Int
        var text: String
        var streaming: Bool
        var arrivedAt: Double
        var shown = 0
        /// Each prose block's plain text last sampled, by its index.
        var plains: [Int: String] = [:]
        /// Each prose block's runs last sampled, by its index.
        var runs: [Int: [RevealSegment]] = [:]
    }

    let reduced: Bool
    let drain = RevealDrain()
    private var probes: [Int: Probe] = [:]
    private var known: Set<Int>
    private(set) var violations: [String] = []
    /// The rows still revealing or fading, by their own key.
    private(set) var revealingRows: Set<Int> = []
    /// When each turn stopped revealing, ms on the scenario's clock.
    private(set) var drainedAt: [Int: Double] = [:]
    private(set) var now: Double = 0
    /// Bumped whenever a row's shown text grew (the row asks for a pin).
    private(set) var revision = 0
    /// The streaming markdown each probe reads through, as a row does.
    private let markdown = MarkdownCache()

    init(history: [ThreadEntry], reduced: Bool) {
        self.reduced = reduced
        known = Set(history.map(\.key))
    }

    /// Moves time to `ms`, sampling every reveal step on the way.
    func advance(to ms: Double, checks: Set<TranscriptScenario.Check>, label: String) {
        while now < ms {
            now = min(ms, now + SmoothText.stepMs)
            for key in probes.keys.sorted() { sample(key, checks: checks, label: label) }
        }
    }

    /// The fold after a push: new blocks get a probe, known ones their new
    /// text. `turns` is each row's turn as the view keys it
    /// (`TranscriptRows.turnKeys`): a block reports under its row's turn.
    func sync(_ entries: [ThreadEntry], turns: [TranscriptRowID: Int], checks: Set<TranscriptScenario.Check>, label: String) {
        for entry in entries {
            switch entry.item {
            case .assistant(let block):
                guard let turn = turns[TranscriptRowID(key: entry.key)] ?? probes[entry.key]?.turn else { continue }
                if var probe = probes[entry.key] {
                    if probe.text != block.text || probe.streaming != block.streaming {
                        if block.text != probe.text { probe.arrivedAt = now }
                        // A rewrite of the shown text may show less; only growth must never shrink.
                        if !block.text.hasPrefix(probe.text) {
                            probe.shown = 0
                            probe.plains = [:]
                            probe.runs = [:]
                        }
                        let grew = block.text.count - probe.text.count
                        probe.text = block.text
                        probe.streaming = block.streaming
                        probes[entry.key] = probe
                        probe.reveal.update(text: block.text, streaming: block.streaming)
                        if checks.contains(.reveal), grew > Self.burstChars, probe.reveal.revealedUnits >= block.text.utf16.count {
                            violations.append("\(label): a burst of \(grew) characters was shown whole")
                        }
                    }
                } else if !known.contains(entry.key) {
                    let clock = Clock()
                    clock.now = now
                    // Born live: the row reveals from its first word.
                    let reveal = SmoothTextReveal(text: block.text, streaming: block.streaming, fromStart: true, clock: clock)
                    var ledger = StreamRevealLedger()
                    ledger.arm()
                    probes[entry.key] = Probe(clock: clock, reveal: reveal, ledger: ledger, turn: turn, text: block.text, streaming: block.streaming, arrivedAt: now)
                    if checks.contains(.reveal), block.text.count > Self.burstChars, reveal.revealedUnits >= block.text.utf16.count {
                        violations.append("\(label): a burst of \(block.text.count) characters was shown whole")
                    }
                }
                sample(entry.key, checks: checks, label: label)
            default: break
            }
        }
    }

    private func sample(_ key: Int, checks: Set<TranscriptScenario.Check>, label: String) {
        guard var probe = probes[key] else { return }
        probe.clock.advance(to: now)
        let units = probe.reveal.revealedUnits
        let total = probe.text.utf16.count
        if checks.contains(.reveal) {
            if units < probe.shown {
                violations.append("\(label) @\(Int(now))ms: the shown text shrank from \(probe.shown) to \(units)")
            }
            // A live block holds its unfinished last word back by design; the deadline is for text that is all in.
            if !probe.streaming, units < total, now - probe.arrivedAt > Self.deadlineMs, !violations.contains(where: { $0.contains("block \(key) still hidden") }) {
                violations.append("\(label) @\(Int(now))ms: block \(key) still hidden (\(units)/\(total) streaming=\(probe.streaming) \(probe.text.prefix(30)))")
            }
        }
        if units != probe.shown { revision += 1 }
        probe.shown = units
        let revealed = probe.reveal.revealed
        let document = revealed.isEmpty ? nil : markdown.streamingDocument(seq: key, text: revealed)
        for (index, block) in (document?.blocks ?? []).enumerated() {
            guard let plain = block.plainProse else { continue }
            let runs = probe.ledger.segments(for: plain, at: now / 1_000, reduced: reduced)
            guard checks.contains(.fade) else { continue }
            let young = runs.filter(\.young).count
            if young > StreamRevealLedger.maxYoung { violations.append("\(label) @\(Int(now))ms: \(young) young runs") }
            if reduced, young > 0 { violations.append("\(label) @\(Int(now))ms: a run fades under reduced motion") }
            // A rewrite of the marks may move what was shown; a run born since the last sample never covers it.
            let before = Set(probe.runs[index]?.compactMap(\.bornAt) ?? [])
            let born = runs.filter { $0.bornAt.map { !before.contains($0) } ?? false }
            defer { probe.runs[index] = runs }
            if let was = probe.plains[index], born.contains(where: { $0.from < StreamRevealLedger.shownEnd(was.count, in: was, onto: plain) }) {
                violations.append("\(label) @\(Int(now))ms: block \(index) of row \(key) was rewritten (\(was.suffix(24).debugDescription) → \(plain.suffix(24).debugDescription)), so its fade started over")
            }
            probe.plains[index] = plain
        }
        let on = probe.streaming || probe.reveal.revealing || probe.ledger.fading(at: now / 1_000)
        if on { revealingRows.insert(key) } else { revealingRows.remove(key) }
        let was = drain.revealing(turn: probe.turn)
        drain.report(turn: probe.turn, row: key, on: on)
        if was, !drain.revealing(turn: probe.turn) { drainedAt[probe.turn] = now }
        if checks.contains(.drain), units < total || probe.ledger.fading(at: now / 1_000), !drain.revealing(turn: probe.turn) {
            violations.append("\(label) @\(Int(now))ms: turn \(probe.turn) reads drained with text still appearing")
        }
        probes[key] = probe
    }

    /// How far `finish` plays: the catch-up and the fade past the last text.
    var finishTarget: Double { max(now, probes.values.map(\.arrivedAt).max() ?? now) + Self.deadlineMs }

    /// After the last push: every turn drained in time.
    func finish(checks: Set<TranscriptScenario.Check>, label: String) {
        advance(to: finishTarget, checks: checks, label: label)
        guard checks.contains(.drain) else { return }
        for turn in Set(probes.values.filter { !$0.streaming }.map(\.turn)) where drain.revealing(turn: turn) {
            violations.append("\(label): turn \(turn) still revealing \(Int(Self.deadlineMs)) ms after its last text")
        }
    }
}
