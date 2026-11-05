import Foundation
import Observation

/// The desktop's streaming reveal (surfaces/smoothText.ts), in UTF-16 units.
/// Text arrives in chunks whose size and spacing depend on the path: every
/// host is another machine to the phone, so frames land every 33–250 ms
/// with jitter, the odd stall, and now and then a whole reply inside a few
/// ms. The reveal decouples what ARRIVED from what is SHOWN and works as an
/// adaptive jitter buffer, as a media player plays packets that arrive
/// unevenly:
///
/// - It measures the stream: the arrival rate over the last `rateWindowMs`
///   (a gap counted `pauseMs` at most, a burst counted at `baseMaxCps` over
///   a step at most) is the base pace, clamped to `floorCps`–`baseMaxCps`,
///   `defaultCps` before the first gap; a high percentile of the gaps sets
///   the lead's floor.
/// - It holds a lead behind the live end, seeded `leadRemoteMs` (the phone's
///   every host is remote), never under twice the gaps' 90th percentile
///   (within `leadMinMs`–`leadMaxMs`). An underrun grows it `leadGrowth`
///   times or by the wait, whichever is more; with no underrun its excess
///   decays toward the floor on `leadDecayMs`.
/// - Each spurt (the first chunk, the chunk that ends an underrun) holds
///   until a lead and a step of text are in hand, or as long has passed.
/// - Then it reveals at the base pace, never slower while text is in hand,
///   leaning faster (at most `maxSurge` times) while more than the lead is
///   buffered, and every character shows within `catchUpMs` of arriving
///   (arrivals inside one step sharing a due time).
/// - The stream's end drains at the same pace with no hold; only a rewrite
///   of the shown prefix and a hidden row snap.
/// - Steps come every `MotionValues.revealStep` (100 ms) and show whole
///   words (`revealCut`); between steps the clock waits on a timer and asks
///   for no display frames.
public enum SmoothText {
    public static let floorCps = 25.0
    /// A step's dt never counts past this, so a stalled clock does not dump everything.
    public static let maxFrameMs = 250.0
    /// The seed lead on the host's own machine; the phone never has one.
    public static let leadLocalMs = 100.0
    /// The seed lead for a thread on another host: every thread, on the phone.
    public static let leadRemoteMs = 250.0
    public static let leadMinMs = 100.0
    public static let leadMaxMs = 800.0
    public static let leadGrowth = 1.5
    public static let leadDecayMs = 6_000.0
    public static let catchUpMs = 1_500.0
    public static let defaultCps = 400.0
    public static let baseMaxCps = 1_500.0
    public static let targetLagGaps = 2.0
    public static let gapPercentile = 0.9
    public static let gapSamples = 32
    public static let rateWindowMs = 1_500.0
    public static let leadGain = 0.3
    public static let maxSurge = 1.5
    public static let pauseMs = 1_000.0
    /// A step of whole words this often (ms).
    public static let stepMs = MotionValues.revealStep * 1_000

    /// True when the shown prefix changed under the reveal (a rewrite, not an append).
    public static func isRewrite(prev: String, next: String, revealed: Double) -> Bool {
        let whole = Int(revealed.rounded(.down))
        return !next.utf16.prefix(whole).elementsEqual(prev.utf16.prefix(whole))
    }

    /// The first `units` UTF-16 units of `text`, never splitting a surrogate pair.
    public static func prefix(of text: String, units: Int) -> String {
        let utf16 = text.utf16
        guard units < utf16.count else { return text }
        var cut = max(0, units)
        if cut > 0, UTF16.isLeadSurrogate(utf16[utf16.index(utf16.startIndex, offsetBy: cut - 1)]) { cut -= 1 }
        return String(decoding: utf16.prefix(cut), as: UTF16.self)
    }

    // MARK: Where a step ends

    /// Where the shown text ends when the pace has reached `pos` (UTF-16):
    /// the last word boundary at or before it (just past a whitespace run),
    /// or `pos` itself in a token longer than `MotionValues.longToken` with
    /// no boundary, moved back to the start of a grapheme (so never inside a
    /// surrogate pair or a joined emoji). While revealing, a trailing line
    /// that is only a block marker (`#`, `-`, `1.`, `- [ ]`, under any `>`)
    /// is held to its line start until it has content, and a trailing table
    /// to its first line until its delimiter row is whole; neither inside an
    /// open code fence. Once nothing is left to reveal the cut is the whole text.
    public static func revealCut(_ text: String, pos: Int, revealing: Bool) -> Int {
        let units = Array(text.utf16)
        guard revealing else { return units.count }
        var cut = max(0, min(pos, units.count))
        if cut == 0 { return 0 }
        var boundary = cut
        while boundary > 0, !isSpace(units[boundary - 1]) { boundary -= 1 }
        if cut - boundary <= MotionValues.longToken {
            cut = boundary
        } else {
            cut = graphemeStart(text, at: cut)
        }
        return holdBlockStart(text, units: units, cut: cut)
    }

    /// JavaScript's `\s` on one UTF-16 unit.
    static func isSpace(_ unit: UInt16) -> Bool {
        switch unit {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
        default: false
        }
    }

    /// `offset` moved back to the start of the grapheme it falls inside.
    static func graphemeStart(_ text: String, at offset: Int) -> Int {
        let utf16 = text.utf16
        guard offset > 0, offset < utf16.count else { return offset }
        let index = utf16.index(utf16.startIndex, offsetBy: offset)
        let start = text.rangeOfComposedCharacterSequence(at: index).lowerBound
        return utf16.distance(from: utf16.startIndex, to: start)
    }

    nonisolated(unsafe) private static let bareMarker = try! Regex(#"^(?:[ \t]*>)*[ \t]*(?:#{1,6}|[-*+](?:[ \t]+\[[ xX]?\]?)?|\d{1,9}[.)])?[ \t]*$"#)
    nonisolated(unsafe) private static let tableDelimiter = try! Regex(#"^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$"#)
    nonisolated(unsafe) private static let fence = try! Regex(#"^[ \t]{0,3}(?:```|~~~)"#)
    nonisolated(unsafe) private static let tableLine = try! Regex(#"^[ \t]*\|"#)

    /// The cut pulled back to the start of a trailing bare marker or an unfinished table.
    static func holdBlockStart(_ text: String, units: [UInt16], cut: Int) -> Int {
        let shown = String(decoding: units[0..<cut], as: UTF16.self)
        let lines = shown.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var starts: [Int] = []
        var at = 0
        for line in lines {
            starts.append(at)
            at += line.utf16.count + 1
        }
        // Inside an open fence a `-` or a `|` is code.
        var fenced = false
        for line in lines.dropLast() where line.prefixMatch(of: fence) != nil { fenced.toggle() }
        let lastIndex = lines.count - 1
        let last = lines[lastIndex]
        if fenced || last.prefixMatch(of: fence) != nil { return cut }
        if !last.isEmpty, last.wholeMatch(of: bareMarker) != nil { return starts[lastIndex] }
        // The trailing run of lines that start with `|`; it stands once its
        // second line is a whole delimiter row (a newline after it).
        let end = last.isEmpty ? lastIndex - 1 : lastIndex
        guard end >= 0, lines[end].prefixMatch(of: tableLine) != nil else { return cut }
        var first = end
        while first > 0, lines[first - 1].prefixMatch(of: tableLine) != nil { first -= 1 }
        let delimiterWhole = first + 1 < lastIndex && lines[first + 1].wholeMatch(of: tableDelimiter) != nil
        return delimiterWhole ? cut : starts[first]
    }
}

/// The jitter buffer's state, the desktop's `Pacer`: what is shown, what
/// arrived (UTF-16 units) and the stream's rhythm. Plain data, so the
/// reveal and the tests share it.
public struct Pacer: Sendable, Equatable {
    public struct Mark: Sendable, Equatable {
        public var at: Double
        public var value: Double
    }

    /// Fractional revealed length.
    public var pos: Double
    /// Arrived length: the live end.
    public var end: Double
    /// When the last chunk arrived (ms), NaN before the first.
    public var lastArrival = Double.nan
    /// Gaps learned from since the pacer started.
    public var samples = 0
    /// The rate's window, oldest first: when each arrival landed on the
    /// rate's clock and the chars counted up to it.
    public var window: [Mark] = []
    /// Recent gaps (ms), oldest first.
    public var gaps: [Double] = []
    /// The lead (ms of text at the base pace) held behind the live end.
    public var lead: Double
    /// A spurt waits to start.
    public var holding = false
    /// When the current spurt's first chunk arrived (ms).
    public var spurtAt = Double.nan
    /// When the shown text reached the live end while live (ms), NaN otherwise.
    public var dryAt = Double.nan
    /// The arrivals not yet wholly shown, one per step: where each ended
    /// (`value`) and when it landed (`at`), for the catch-up's due times.
    public var due: [Mark] = []

    public init(length: Double, leadMs: Double = SmoothText.leadRemoteMs) {
        pos = length
        end = length
        lead = leadMs
    }

    public static func == (lhs: Pacer, rhs: Pacer) -> Bool {
        func same(_ a: Double, _ b: Double) -> Bool { a == b || (a.isNaN && b.isNaN) }
        return lhs.pos == rhs.pos && lhs.end == rhs.end && same(lhs.lastArrival, rhs.lastArrival) && lhs.samples == rhs.samples
            && lhs.window == rhs.window && lhs.gaps == rhs.gaps && lhs.lead == rhs.lead && lhs.holding == rhs.holding
            && same(lhs.spurtAt, rhs.spurtAt) && same(lhs.dryAt, rhs.dryAt) && lhs.due == rhs.due
    }

    /// The shown text jumps to `length` (a rewrite, a hidden row); the
    /// stream's rhythm and the lead are kept.
    public mutating func snap(to length: Double) {
        pos = length
        end = length
        holding = false
        dryAt = .nan
        due = []
    }

    /// The text grew to `end` at `now` (ms).
    public mutating func noteArrival(end newEnd: Double, now: Double) {
        let chars = newEnd - end
        if chars <= 0 {
            end = newEnd
            if pos > newEnd { pos = newEnd }
            for i in due.indices { due[i].value = min(due[i].value, newEnd) }
            return
        }
        let first = lastArrival.isNaN
        let gap = now - lastArrival
        end = newEnd
        lastArrival = now
        // Arrivals inside one step share an entry, due with the first of them.
        if let last = due.indices.last, now - due[last].at < SmoothText.stepMs {
            due[last].value = newEnd
        } else {
            due.append(Mark(at: now, value: newEnd))
        }
        if !dryAt.isNaN {
            // This chunk ends an underrun: the lead was too short for this link.
            let lead = currentLead
            self.lead = min(SmoothText.leadMaxMs, max(lead * SmoothText.leadGrowth, lead + min(now - dryAt, SmoothText.pauseMs)))
            dryAt = .nan
            startSpurt(now)
        } else if first {
            startSpurt(now)
        }
        if first {
            window = [Mark(at: 0, value: 0)]
            return
        }
        // A burst counts at baseMaxCps over a step at most: the catch-up plays it out.
        let counted = min(chars, max(gap, SmoothText.stepMs) * SmoothText.baseMaxCps / 1_000)
        let lastMark = window[window.count - 1]
        let at = lastMark.at + min(max(0, gap), SmoothText.pauseMs)
        window.append(Mark(at: at, value: lastMark.value + counted))
        // One arrival at or before the window's start stays as its anchor.
        while window.count > 2, window[1].at <= at - SmoothText.rateWindowMs { window.removeFirst() }
        samples += 1
        // A pause is not jitter: the lead's floor learns from the gaps under it.
        if gap > SmoothText.pauseMs { return }
        gaps.append(gap)
        if gaps.count > SmoothText.gapSamples { gaps.removeFirst() }
    }

    private mutating func startSpurt(_ now: Double) {
        holding = true
        spurtAt = now
    }

    /// Chars per ms the stream has been arriving at; 0 before the first gap.
    public var arrivalRate: Double {
        guard window.count >= 2 else { return 0 }
        let span = window[window.count - 1].at - window[0].at
        return span > 0 ? (window[window.count - 1].value - window[0].value) / span : 0
    }

    /// The base pace (chars per ms): the arrival rate within its clamps,
    /// `defaultCps` before the stream has shown one.
    public var basePace: Double {
        let rate = arrivalRate
        if rate <= 0 { return SmoothText.defaultCps / 1_000 }
        return min(SmoothText.baseMaxCps / 1_000, max(SmoothText.floorCps / 1_000, rate))
    }

    /// The 90th-percentile gap of the recent arrivals (ms).
    public var highGap: Double {
        guard !gaps.isEmpty else { return 0 }
        let sorted = gaps.sorted()
        return sorted[min(sorted.count - 1, Int((SmoothText.gapPercentile * Double(sorted.count)).rounded(.down)))]
    }

    /// The least lead the stream's gaps call for (ms).
    public var leadFloor: Double {
        min(SmoothText.leadMaxMs, max(SmoothText.leadMinMs, SmoothText.targetLagGaps * highGap))
    }

    /// The lead held now (ms): its own, never under the floor.
    public var currentLead: Double { max(leadFloor, lead) }

    /// The pace (chars per ms) that shows every arrival within `catchUpMs` of when it landed.
    public mutating func catchUpPace(now: Double) -> Double {
        while let first = due.first, first.value <= pos { due.removeFirst() }
        var pace = 0.0
        for d in due {
            pace = max(pace, (d.value - pos) / max(SmoothText.stepMs, d.at + SmoothText.catchUpMs - now))
        }
        return pace
    }

    /// One step: the shown position advanced by `dt` ms at `now`. The lead
    /// decays toward its floor; a holding spurt waits until a lead and a
    /// step of text are in hand or as long has passed (live only); then the
    /// pace is the base, leaned faster above the lead, never under the
    /// catch-up's. With nothing in hand while live an underrun begins.
    @discardableResult
    public mutating func step(dt: Double, now: Double, live: Bool) -> Double {
        let floor = leadFloor
        if lead > floor, dryAt.isNaN { lead = floor + (lead - floor) * exp(-dt / SmoothText.leadDecayMs) }
        let inHand = end - pos
        if inHand <= 0 {
            pos = end
            if live, dryAt.isNaN { dryAt = now }
            return pos
        }
        let base = basePace
        let lead = currentLead
        let bufferMs = inHand / base
        if holding {
            // Enough that a lead is left once the first step has shown its share.
            let enough = lead + SmoothText.stepMs
            if live, bufferMs < enough, now - spurtAt < enough { return pos }
            holding = false
        }
        // The lead is what is left once this step has shown its share.
        let gain = min(SmoothText.maxSurge, 1 + SmoothText.leadGain * max(0, bufferMs - dt - lead) / lead)
        let pace = max(base * gain, catchUpPace(now: now))
        pos = min(end, pos + pace * dt)
        if live, pos >= end { dryAt = now }
        return pos
    }
}

/// When the reveal's next step runs: a timer between steps, never a display
/// frame. Tests crank a hand clock.
@MainActor
public protocol RevealClock: AnyObject {
    /// Monotonic ms.
    var now: Double { get }
    /// Runs `fire` with the time once `ms` have passed; a second call
    /// replaces the first.
    func schedule(afterMs ms: Double, _ fire: @escaping @MainActor (Double) -> Void)
    func cancel()
}

/// The desktop's `useSmoothText` for one row: owns a `Pacer`, notes every
/// text change as an arrival, steps every `stepMs` on its clock and
/// publishes the shown prefix (`revealedUnits`, UTF-16, cut at whole words)
/// only when it changes. A row mounts baselined to its whole text (history,
/// a row scrolled back in), unless it was born live (`fromStart`): then it
/// reveals from its first word, whatever its first text carried.
@MainActor @Observable
public final class SmoothTextReveal {
    /// UTF-16 units shown: the whole text whenever nothing is left to reveal.
    public private(set) var revealedUnits: Int
    /// The pacer's shown position before the word cut (a test seam).
    public var pacedUnits: Int { Int(pacer.pos.rounded(.down)) }

    @ObservationIgnored private var pacer: Pacer
    /// Observed: a final text of the same length as the deltas still redraws the row.
    private var prev: String
    @ObservationIgnored private var live: Bool
    @ObservationIgnored private var born: Bool
    @ObservationIgnored private var running = false
    @ObservationIgnored private var lastFrame = 0.0
    @ObservationIgnored private var lastPaint = -Double.infinity
    @ObservationIgnored private let clock: any RevealClock

    /// - Parameters:
    ///   - fromStart: the row was born live: reveal from its first word.
    ///   - leadMs: the seed lead; every host is remote to the phone.
    ///   - clock: nil picks a timer on the main run loop.
    public init(text: String, streaming: Bool, fromStart: Bool = false, leadMs: Double = SmoothText.leadRemoteMs, clock: (any RevealClock)? = nil) {
        let count = fromStart ? 0 : text.utf16.count
        revealedUnits = count
        pacer = Pacer(length: Double(count), leadMs: leadMs)
        prev = fromStart ? "" : text
        live = streaming
        born = fromStart
        self.clock = clock ?? TimerRevealClock()
        if fromStart { update(text: text, streaming: streaming) }
    }

    /// The revealed prefix of the text.
    public var revealed: String { SmoothText.prefix(of: prev, units: revealedUnits) }

    /// Text is still to be shown: the row stays on its streaming render.
    public var revealing: Bool { revealedUnits < prev.utf16.count }

    /// The row's text changed or its streaming flag moved. A settled row
    /// whose text changes with nothing in hand (and not born live) shows it
    /// at once; a stream, or one still draining, paces it; a rewrite of the
    /// shown prefix snaps.
    public func update(text: String, streaming: Bool) {
        let count = Double(text.utf16.count)
        live = streaming
        let pacing = streaming || pacer.pos < pacer.end || born
        born = false
        if !pacing || SmoothText.isRewrite(prev: prev, next: text, revealed: pacer.pos) {
            pacer.snap(to: count)
        } else {
            pacer.noteArrival(end: count, now: clock.now)
        }
        prev = text
        if pacer.pos >= count {
            running = false
            clock.cancel()
            publish(Int(count))
            return
        }
        // A reveal under way keeps its clock: its next step counts the time since the last one.
        if !running { lastFrame = clock.now }
        running = true
        next(clock.now)
    }

    /// The row left the screen (or the app did): show everything, stop the clock.
    public func snap() {
        let count = prev.utf16.count
        pacer.snap(to: Double(count))
        running = false
        clock.cancel()
        publish(count)
    }

    private func next(_ now: Double) {
        clock.schedule(afterMs: max(0, lastPaint + SmoothText.stepMs - now)) { [weak self] at in self?.tick(at) }
    }

    private func tick(_ now: Double) {
        let dt = min(now - lastFrame, SmoothText.maxFrameMs)
        lastFrame = now
        let end = pacer.end
        // Stepped even with nothing in hand, so the pacer marks the underrun.
        pacer.step(dt: dt, now: now, live: live)
        if pacer.pos >= end {
            running = false
            lastPaint = now
            publish(Int(end))
            return
        }
        if now - lastPaint >= SmoothText.stepMs {
            lastPaint = now
            publish(Int(pacer.pos.rounded(.down)))
        }
        next(now)
    }

    /// The word cut of the pacer's position, written only on a change.
    private func publish(_ units: Int) {
        let total = prev.utf16.count
        let shown = SmoothText.revealCut(prev, pos: units, revealing: live || units < total)
        if revealedUnits != shown { revealedUnits = shown }
    }

    /// Milliseconds on the system's monotonic clock.
    nonisolated public static func monotonicMs() -> Double {
        Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
    }
}

/// A one-shot timer on the main run loop: the step's wait, never a frame.
@MainActor
final class TimerRevealClock: RevealClock {
    private var timer: Timer?

    var now: Double { SmoothTextReveal.monotonicMs() }

    func schedule(afterMs ms: Double, _ fire: @escaping @MainActor (Double) -> Void) {
        timer?.invalidate()
        let timer = Timer(timeInterval: ms / 1_000, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.timer = nil
                fire(SmoothTextReveal.monotonicMs())
            }
        }
        timer.tolerance = 0.004
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func cancel() {
        timer?.invalidate()
        timer = nil
    }
}
