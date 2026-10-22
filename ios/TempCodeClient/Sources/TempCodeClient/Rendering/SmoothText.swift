import Foundation
import Observation
#if canImport(UIKit)
import UIKit
#endif

// MARK: - The jitter buffer

/// The desktop's smooth streaming reveal (src/renderer/src/surfaces/
/// smoothText.ts), function for function. Text arrives in chunks whose size
/// and spacing depend on the path: a local harness sends a delta every few
/// ms, the tunnel sends a frame every 33–100 ms with jitter and the odd
/// stall. The pacer decouples what ARRIVED from what is SHOWN and works as
/// a jitter buffer: it measures the arrival rate and a high percentile of
/// the gaps between arrivals, reveals at that rate behind a playout lag of
/// about two such gaps (clamped), leans gently toward that lag, eases down
/// as the buffer runs low, and falls back to an exponential catch-up before
/// the rhythm is known and once the stream ends.
///
/// Positions are counts of UTF-8 code units (`text.utf8.count` is O(1) on a
/// native string, and deltas only ever append). The constants keep the
/// desktop's names and values; "chars" in a name reads as units here, the
/// same number for ASCII and within a few percent for prose.
public enum SmoothText {
    public static let tauStreamMs = 320.0
    public static let tauDrainMs = 90.0
    public static let floorCps = 25.0
    public static let maxLag = 900.0
    /// Paint at most this often: markdown re-lays at ~30 fps, not 120.
    public static let paintEveryMs = 33.0
    /// Frame deltas clamp here so a background app does not dump everything at once.
    public static let maxFrameMs = 100.0
    /// The lag held behind the live end is this many high-percentile gaps…
    public static let targetLagGaps = 2.0
    /// …and never less than this (a local stream: deltas every few ms)…
    public static let minLagMs = 120.0
    /// …nor more than this (a choppy link: past it, waiting costs more than a hitch).
    public static let maxLagMs = 500.0
    /// The gap percentile the lag covers: most gaps, not the one-off stall.
    public static let gapPercentile = 0.9
    /// Recent gaps kept for the percentile.
    public static let gapSamples = 32
    /// The rate's moving average forgets with this time constant.
    public static let rateTauMs = 1500.0
    /// How hard the pace leans toward the target lag.
    public static let lagGain = 0.3
    /// The pace never runs faster than this many times the arrival rate.
    public static let maxSurge = 1.5
    /// A gap this long is a pause (the model thinking, a tool running), not
    /// jitter: the next arrival starts a new spurt and the estimates keep
    /// what they knew.
    public static let pauseMs = 1000.0

    /// One frame of the exponential catch-up: where the revealed position
    /// lands after `dt` ms, given the live end and whether the stream is
    /// still open. The pacer's fallback before it knows the stream's rhythm
    /// and its drain once the stream ends.
    public static func advanceReveal(pos: Double, end: Double, dt: Double, live: Bool) -> Double {
        let remaining = end - pos
        if remaining <= 0 { return end }
        let step = max(
            remaining * (1 - exp(-dt / (live ? tauStreamMs : tauDrainMs))),
            dt * floorCps / 1000
        )
        let next = min(end, pos + step)
        return end - next > maxLag ? end - maxLag : next
    }

    /// True when the already-revealed prefix changed under us (a rewrite,
    /// not an append). Compares the first `revealed` UTF-8 units of both.
    public static func isRewrite(prev: String, next: String, revealed: Double) -> Bool {
        let whole = Int(revealed.rounded(.down))
        return !next.utf8.prefix(whole).elementsEqual(prev.utf8.prefix(whole))
    }

    /// The first `units` UTF-8 units of `text`, rounded down to a whole
    /// scalar and then to a whole grapheme, so a 4-byte scalar never shows
    /// half-built and an emoji never shows without its modifier.
    public static func prefix(of text: String, units: Int) -> Substring {
        let utf8 = text.utf8
        guard units < utf8.count else { return text[...] }
        guard units > 0 else { return text[text.startIndex..<text.startIndex] }
        var i = utf8.index(utf8.startIndex, offsetBy: units)
        // Back out of a scalar's continuation bytes (10xxxxxx).
        while i > utf8.startIndex, i < utf8.endIndex, utf8[i] & 0xC0 == 0x80 {
            i = utf8.index(before: i)
        }
        // A scalar-aligned index inside a grapheme rounds down to the
        // Character boundary in a String subscript (Swift 5.7 index rounding).
        return text[..<Self.characterBoundary(text, at: i)]
    }

    /// The nearest Character boundary at or before a scalar-aligned index.
    static func characterBoundary(_ text: String, at i: String.Index) -> String.Index {
        guard i > text.startIndex, i < text.endIndex else { return i }
        // `index(after:)` rounds a mid-grapheme index down to its Character
        // before stepping; stepping back then lands on that Character's start.
        let next = text.index(after: i)
        let start = text.index(before: next)
        return start <= i ? start : i
    }
}

/// The jitter buffer's state: what is shown, what arrived, and what the
/// stream's rhythm has been. Plain data, so the clock and the tests share it.
public struct Pacer: Sendable {
    /// Fractional revealed length (UTF-8 units).
    public var pos: Double
    /// Arrived length (the live end).
    public var end: Double
    /// When the last chunk arrived (ms); `.nan` before the first.
    public var lastArrival: Double
    /// Gaps folded into the averages since the pacer started.
    public var samples: Int
    /// Moving averages of units per arrival and ms between arrivals.
    public var avgChars: Double
    public var avgGap: Double
    /// Recent gaps (ms), oldest first.
    public var gaps: [Double]

    public init(length: Double) {
        pos = length
        end = length
        lastArrival = .nan
        samples = 0
        avgChars = 0
        avgGap = 0
        gaps = []
    }

    /// The shown text jumps to `length` (mount, a rewrite, a hidden pane);
    /// the stream's rhythm is kept.
    public mutating func snap(to length: Double) {
        pos = length
        end = length
    }

    /// The text grew to `end` at `now` (ms).
    public mutating func noteArrival(end: Double, now: Double) {
        let chars = end - self.end
        if chars <= 0 {
            self.end = end
            if pos > end { pos = end }
            return
        }
        let gap = now - lastArrival
        self.end = end
        lastArrival = now
        // The first chunk, or the first after a pause: no gap to learn from.
        if !(gap >= 0) || gap > SmoothText.pauseMs { return }
        samples += 1
        // A plain mean while the averages fill, then time-weighted, so a
        // stream of 7 ms deltas and one of 100 ms frames forget at the same pace.
        let a = max(1 / Double(samples), 1 - exp(-gap / SmoothText.rateTauMs))
        avgChars += a * (chars - avgChars)
        avgGap += a * (gap - avgGap)
        gaps.append(gap)
        if gaps.count > SmoothText.gapSamples { gaps.removeFirst() }
    }

    /// Units per ms the stream has been arriving at; 0 before the first gap.
    public var arrivalRate: Double {
        samples > 0 && avgGap > 0 ? avgChars / avgGap : 0
    }

    /// The `gapPercentile` gap of the recent arrivals (ms).
    public var highGap: Double {
        if gaps.isEmpty { return 0 }
        let sorted = gaps.sorted()
        return sorted[min(sorted.count - 1, Int((SmoothText.gapPercentile * Double(sorted.count)).rounded(.down)))]
    }

    /// The lag (ms of text) the pacer holds behind the live end.
    public var targetLagMs: Double {
        min(SmoothText.maxLagMs, max(SmoothText.minLagMs, SmoothText.targetLagGaps * highGap))
    }

    /// One frame: advance the shown position by `dt` ms at `now` and return
    /// it. While live and once the rate is known, the pace is the arrival
    /// rate leaned toward the target lag. The lag is the playout delay: how
    /// much text will be left when the next chunk is due, which is the
    /// buffer now plus the time since the last arrival (up to a usual gap)
    /// minus the mean gap. It holds still while the buffer drains between
    /// two chunks, so the pace does not wobble with the chunking; only a
    /// chunk later than usual reads as the buffer running low.
    @discardableResult
    public mutating func step(dt: Double, now: Double, live: Bool) -> Double {
        let rate = arrivalRate
        if !live || rate <= 0 {
            pos = SmoothText.advanceReveal(pos: pos, end: end, dt: dt, live: live)
            return pos
        }
        let remaining = end - pos
        if remaining <= 0 {
            pos = end
            return pos
        }
        let target = targetLagMs
        let bufferMs = remaining / rate
        let since = max(0, now - lastArrival)
        let usual = max(avgGap, highGap)
        let lagMs = bufferMs + min(since, usual) - avgGap
        let error = (lagMs - target) / target
        var gain = min(SmoothText.maxSurge, max(0, 1 + SmoothText.lagGain * error))
        // Running low (a stall): ease down as the buffer empties instead of
        // running into the live end at full pace. A steady stream never gets
        // here: its buffer bottoms out at the target lag.
        let low = target / 3
        if bufferMs < low { gain *= bufferMs / low }
        let step = max(rate * gain * dt, dt * SmoothText.floorCps / 1000)
        let next = min(end, pos + step)
        pos = end - next > SmoothText.maxLag ? end - SmoothText.maxLag : next
        return pos
    }
}

extension Pacer: Equatable {
    /// `lastArrival` is `.nan` before the first chunk; two fresh pacers are equal.
    public static func == (lhs: Pacer, rhs: Pacer) -> Bool {
        lhs.pos == rhs.pos && lhs.end == rhs.end
            && (lhs.lastArrival == rhs.lastArrival || (lhs.lastArrival.isNaN && rhs.lastArrival.isNaN))
            && lhs.samples == rhs.samples && lhs.avgChars == rhs.avgChars && lhs.avgGap == rhs.avgGap && lhs.gaps == rhs.gaps
    }
}

// MARK: - The reveal clock

/// A frame source the reveal clock ticks on: a display link on iOS, a timer
/// elsewhere, a hand-cranked one in tests. `onFrame` gets the frame time in
/// ms on a monotonic clock, never wall time.
@MainActor
public protocol RevealTicker: AnyObject {
    var onFrame: ((Double) -> Void)? { get set }
    func start()
    func stop()
}

/// The desktop's `useSmoothText` for one row: owns a `Pacer`, notes every
/// text change as an arrival, steps on the ticker's frames and publishes
/// the revealed prefix (`revealedUnits`) at most every `paintEveryMs`. A
/// row mounts baselined to its whole text, so history and a cache paint
/// show at once and only text that arrives while the row is on screen is
/// paced. Lives on the main actor: a step is a few floating-point
/// operations, and the published value must land there anyway.
@MainActor @Observable
public final class SmoothTextReveal {
    /// UTF-8 units of the text to show. Published only when it changes, at
    /// most every 33 ms while the pacer moves; equals the whole text's count
    /// whenever nothing streams.
    public private(set) var revealedUnits: Int
    /// Reduced motion: no pacing; every arrival shows whole (per batch).
    public var paced: Bool

    @ObservationIgnored private var pacer: Pacer
    /// Observed: a final text of the same length as the deltas (a rewrite
    /// that keeps `revealedUnits`) still redraws the row.
    private var prev: String
    @ObservationIgnored private var live: Bool
    @ObservationIgnored private var lastFrame = 0.0
    @ObservationIgnored private var lastPaint = 0.0
    @ObservationIgnored private let ticker: any RevealTicker
    @ObservationIgnored private let now: () -> Double

    /// - Parameters:
    ///   - ticker: the frame source; nil picks the platform's (a display link under UIKit, a timer elsewhere).
    ///   - now: ms on a monotonic clock, for tests.
    public init(text: String, streaming: Bool, paced: Bool = true, ticker: (any RevealTicker)? = nil, now: @escaping () -> Double = SmoothTextReveal.monotonicMs) {
        let count = text.utf8.count
        revealedUnits = count
        self.paced = paced
        pacer = Pacer(length: Double(count))
        prev = text
        live = streaming
        self.ticker = ticker ?? Self.platformTicker()
        self.now = now
        self.ticker.onFrame = { [weak self] frameTime in self?.frame(at: frameTime) }
    }

    /// The revealed prefix of the text, cut on a grapheme.
    public var revealed: Substring {
        SmoothText.prefix(of: prev, units: revealedUnits)
    }

    /// The row's text changed (an append, the final rewrite) or its streaming
    /// flag moved. The desktop hook's layout effect: a rewrite or an unpaced
    /// row snaps to the whole text; an append is an arrival the pacer learns
    /// from, and the clock runs until the shown position reaches the end.
    public func update(text: String, streaming: Bool) {
        let count = Double(text.utf8.count)
        live = streaming
        if !paced || SmoothText.isRewrite(prev: prev, next: text, revealed: pacer.pos) {
            pacer.snap(to: count)
            publish(Int(count))
        } else {
            pacer.noteArrival(end: count, now: now())
        }
        prev = text
        if pacer.pos >= count {
            ticker.stop()
            return
        }
        lastFrame = now()
        ticker.start()
    }

    /// The pane left the screen (or the app did): show everything, stop the clock.
    public func snap() {
        let count = prev.utf8.count
        pacer.snap(to: Double(count))
        publish(count)
        ticker.stop()
    }

    private func frame(at now: Double) {
        let dt = min(max(0, now - lastFrame), SmoothText.maxFrameMs)
        lastFrame = now
        let end = pacer.end
        if end - pacer.pos <= 0 {
            ticker.stop()
            return
        }
        pacer.step(dt: dt, now: now, live: live)
        if pacer.pos >= end {
            lastPaint = now
            publish(Int(end))
            ticker.stop()
            return
        }
        if now - lastPaint >= SmoothText.paintEveryMs {
            lastPaint = now
            publish(Int(pacer.pos.rounded(.down)))
        }
    }

    /// Written only on a change, so a frame between paints observes nothing.
    private func publish(_ units: Int) {
        if revealedUnits != units { revealedUnits = units }
    }

    /// Milliseconds on the system's monotonic clock (mach_absolute_time on
    /// Darwin, the same clock a display link stamps its frames with).
    nonisolated public static func monotonicMs() -> Double {
        Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
    }

    private static func platformTicker() -> any RevealTicker {
        #if canImport(UIKit)
        DisplayLinkTicker()
        #else
        TimerTicker()
        #endif
    }
}

#if canImport(UIKit)
/// A `CADisplayLink` on the main run loop in the common modes, 80–120 Hz
/// where the display offers it. The link's target is a relay that holds
/// the ticker weakly, so the display link never retains the ticker; a
/// link whose ticker is gone invalidates itself on its next frame.
@MainActor
final class DisplayLinkTicker: RevealTicker {
    var onFrame: ((Double) -> Void)?
    private var link: CADisplayLink?

    /// The display link's target; the link fires on the main run loop, so
    /// the main-actor check on the `@objc` entry holds.
    @MainActor
    private final class Relay: NSObject {
        weak var ticker: DisplayLinkTicker?

        @objc func fire(_ link: CADisplayLink) {
            guard let ticker else {
                link.invalidate()
                return
            }
            ticker.onFrame?(link.timestamp * 1000)
        }
    }

    func start() {
        if link != nil { return }
        let relay = Relay()
        relay.ticker = self
        let link = CADisplayLink(target: relay, selector: #selector(Relay.fire(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    func stop() {
        link?.invalidate()
        link = nil
    }
}
#else
/// A 60 Hz timer on the main run loop, for macOS (the package's tests and
/// a Mac host of the client).
@MainActor
final class TimerTicker: RevealTicker {
    var onFrame: ((Double) -> Void)?
    private var timer: Timer?

    func start() {
        if timer != nil { return }
        let timer = Timer(timeInterval: 1 / 60, repeats: true) { [weak self] timer in
            guard let self else {
                timer.invalidate()
                return
            }
            MainActor.assumeIsolated { self.onFrame?(SmoothTextReveal.monotonicMs()) }
        }
        timer.tolerance = 0.002
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }
}
#endif
