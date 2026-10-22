import Foundation
import Testing
@testable import TempCodeClient

// The port of src/renderer/src/surfaces/smoothText.test.ts, suite for suite
// and assertion for assertion. The constants keep the desktop's values, so
// the same thresholds hold.

private func close(_ a: Double, _ b: Double, digits: Int) -> Bool {
    abs(a - b) < pow(10, -Double(digits)) / 2
}

@Suite struct AdvanceRevealTests {
    @Test func `reveals remaining × (1 − e^(−dt/τ)) while streaming`() {
        let next = SmoothText.advanceReveal(pos: 0, end: 1000, dt: SmoothText.tauStreamMs, live: true)
        #expect(close(next, 1000 * (1 - exp(-1)), digits: 6))
    }

    @Test func `drains faster once the stream ends`() {
        let live = SmoothText.advanceReveal(pos: 0, end: 1000, dt: 50, live: true)
        let drain = SmoothText.advanceReveal(pos: 0, end: 1000, dt: 50, live: false)
        #expect(drain > live)
        #expect(close(drain, 1000 * (1 - exp(-50 / SmoothText.tauDrainMs)), digits: 6))
    }

    @Test func `never moves slower than the 25 chars/s floor`() {
        // 2 chars left: exponential step would be tiny; the floor wins.
        let next = SmoothText.advanceReveal(pos: 98, end: 100, dt: 16, live: true)
        #expect(close(next - 98, 16 * SmoothText.floorCps / 1000, digits: 9))
    }

    @Test func `never overshoots the live end`() {
        #expect(SmoothText.advanceReveal(pos: 99.9, end: 100, dt: 1000, live: false) == 100)
        #expect(SmoothText.advanceReveal(pos: 100, end: 100, dt: 16, live: true) == 100)
    }

    @Test func `skips ahead when the lag exceeds the cap`() {
        let next = SmoothText.advanceReveal(pos: 0, end: 5000, dt: 16, live: true)
        #expect(5000 - next == SmoothText.maxLag)
    }

    @Test func `converges to the end in a bounded number of frames`() {
        var pos = 0.0
        var frames = 0
        while pos < 400, frames < 1000 {
            pos = SmoothText.advanceReveal(pos: pos, end: 400, dt: 16, live: true)
            frames += 1
        }
        #expect(pos == 400)
        // Exponential toward the tail then the floor: well under a second of frames.
        #expect(frames < 300)
    }
}

@Suite struct IsRewriteTests {
    @Test func `treats an append as no rewrite`() {
        #expect(!SmoothText.isRewrite(prev: "hello", next: "hello world", revealed: 5))
    }

    @Test func `flags a change inside the revealed prefix`() {
        #expect(SmoothText.isRewrite(prev: "hello", next: "jello world", revealed: 5))
    }

    @Test func `ignores changes past the revealed position`() {
        // "hello " is shared; the first differing glyph sits at index 6.
        #expect(!SmoothText.isRewrite(prev: "hello world", next: "hello there", revealed: 6))
        #expect(!SmoothText.isRewrite(prev: "hello world", next: "hello there", revealed: 6.9))
        #expect(SmoothText.isRewrite(prev: "hello world", next: "hello there", revealed: 7))
    }
}

// ── the jitter buffer, simulated ─────────────────────────────────────
//
// A stream at cps chars/s reaches the renderer as one of the patterns
// below; a 60 fps loop notes what arrived by each frame (the store bumps
// once per frame, so that is when the row sees it) and steps the reveal.
// The measure is the reveal speed per frame while the stream is live,
// after a warm-up: its coefficient of variation (sd / mean) is how jerky
// the text reads. `legacy` runs the backlog-proportional catch-up the
// pacer replaced, for comparison.

enum StreamSim {
    static let cps = 300.0
    static let durationMs = 8000.0
    static let warmupMs = 1500.0
    static let frameMs = 1000.0 / 60

    struct Arrival {
        var t: Double
        var chars: Double
    }

    /// The desktop test's LCG, so every run repeats.
    static func prng(_ seed: UInt32) -> () -> Double {
        var s = seed
        return {
            s = s &* 1664525 &+ 1013904223
            return Double(s) / 4294967296.0
        }
    }

    /// A local harness: a delta every 7 ms of a varying few chars.
    static func localDeltas() -> [Arrival] {
        let r = prng(1)
        var out: [Arrival] = []
        var owed = 0.0
        var t = 0.0
        while t < durationMs {
            owed += cps * 7 / 1000
            let chars = max(1, (owed * (0.5 + r())).rounded())
            owed -= chars
            out.append(Arrival(t: t, chars: chars))
            t += 7
        }
        return out
    }

    /// A remote host: a frame every `every` ms, each sent frame delivered
    /// `delay` ms later and never before the one ahead of it.
    static func frames(every: Double, delay: (Double) -> Double) -> [Arrival] {
        var out: [Arrival] = []
        var last = 0.0
        var t = 0.0
        while t < durationMs {
            last = max(last, t + delay(t))
            out.append(Arrival(t: last, chars: cps * every / 1000))
            t += every
        }
        return out
    }

    static func steady100() -> [Arrival] { frames(every: 100) { _ in 20 } }
    static func jittered100() -> [Arrival] {
        let r = prng(7)
        return frames(every: 100) { _ in 20 + 60 * r() }
    }
    static func jittered33() -> [Arrival] {
        let r = prng(3)
        return frames(every: 33) { _ in 20 + 30 * r() }
    }
    /// The link holds everything for `stallMs` after the frame sent at 4 s:
    /// one gap of 100 + stallMs ms, then the held frames land together.
    static func stalled(_ stallMs: Double) -> [Arrival] {
        frames(every: 100) { t in 20 + (t > 4000 && t < 4000 + stallMs + 100 ? 4000 + stallMs + 100 - t : 0) }
    }

    struct Stats {
        var cov: Double
        var mean: Double
        var min: Double
        var max: Double
    }

    struct Run {
        var cov: Double
        var mean: Double
        var min: Double
        var max: Double
        /// Mean ms of text between shown and arrived.
        var lagMs: Double
        /// Speeds by frame time, for a window of the run.
        var speeds: [(t: Double, v: Double)]
    }

    static func simulate(_ arrivals: [Arrival], legacy: Bool = false) -> Run {
        var pacer = Pacer(length: 0)
        var legacyPos = 0.0
        var end = 0.0
        var next = 0
        var speeds: [(t: Double, v: Double)] = []
        var lag = 0.0
        let live = arrivals[arrivals.count - 1].t
        var t = 0.0
        while t <= live {
            while next < arrivals.count, arrivals[next].t <= t {
                end += arrivals[next].chars
                next += 1
            }
            pacer.noteArrival(end: end, now: t)
            let before = legacy ? legacyPos : pacer.pos
            let after: Double
            if legacy {
                legacyPos = SmoothText.advanceReveal(pos: legacyPos, end: end, dt: frameMs, live: true)
                after = legacyPos
            } else {
                after = pacer.step(dt: frameMs, now: t, live: true)
            }
            if t >= arrivals[0].t + warmupMs {
                speeds.append((t, (after - before) / frameMs * 1000))
                lag += (end - after) / cps * 1000
            }
            t += frameMs
        }
        let s = stats(speeds.map(\.v))
        return Run(cov: s.cov, mean: s.mean, min: s.min, max: s.max, lagMs: lag / Double(speeds.count), speeds: speeds)
    }

    static func stats(_ vs: [Double]) -> Stats {
        let mean = vs.reduce(0, +) / Double(vs.count)
        let sd = (vs.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(vs.count)).squareRoot()
        return Stats(cov: sd / mean, mean: mean, min: vs.min() ?? 0, max: vs.max() ?? 0)
    }
}

@Suite struct JitterBufferSimulationTests {
    typealias Sim = StreamSim
    let cps = StreamSim.cps

    @Test func `local deltas every 7 ms: as smooth as before, keeping up with the stream at the minimum lag`() {
        let now = Sim.simulate(Sim.localDeltas())
        let before = Sim.simulate(Sim.localDeltas(), legacy: true)
        #expect(now.cov < 0.05)
        #expect(now.cov <= before.cov + 0.005)
        #expect(abs(now.mean - cps) / cps < 0.02)
        // at most the minimum lag plus a frame of arrivals; the old catch-up
        // trailed by τ (about 320 ms)
        #expect(now.lagMs < SmoothText.minLagMs + 2 * Sim.frameMs)
        #expect(now.lagMs < before.lagMs)
    }

    @Test func `steady 100 ms frames: an even pace, where the old catch-up surged on every frame`() {
        let now = Sim.simulate(Sim.steady100())
        let before = Sim.simulate(Sim.steady100(), legacy: true)
        #expect(now.cov < 0.05)
        #expect(before.cov > 0.05)
        #expect(abs(now.mean - cps) / cps < 0.02)
        // the playout delay is twice the gap, plus half a gap on average
        #expect(now.lagMs > 200)
        #expect(now.lagMs < 300)
    }

    @Test func `100 ms frames with 0–60 ms of jitter: still an even pace`() {
        let now = Sim.simulate(Sim.jittered100())
        let before = Sim.simulate(Sim.jittered100(), legacy: true)
        #expect(now.cov < 0.05)
        #expect(before.cov > 0.05)
        #expect(now.lagMs < SmoothText.maxLagMs)
    }

    @Test func `33 ms frames with jitter (the remote events window): an even pace at the minimum lag`() {
        let now = Sim.simulate(Sim.jittered33())
        #expect(now.cov < 0.05)
        #expect(now.lagMs < SmoothText.minLagMs + 50)
    }

    @Test func `a 300 ms gap (a frame 200 ms late, the edge of the buffer): an even pace`() {
        let now = Sim.simulate(Sim.stalled(200))
        let before = Sim.simulate(Sim.stalled(200), legacy: true)
        #expect(now.cov < 0.05)
        #expect(before.cov > 0.1)
        #expect(now.min > 0.4 * cps)
        #expect(now.max < 1.05 * cps)
    }

    @Test func `one 300 ms stall (a 400 ms gap): eases down and back without stopping or surging, and is even again within a second`() {
        let now = Sim.simulate(Sim.stalled(300))
        let before = Sim.simulate(Sim.stalled(300), legacy: true)
        // The buffer (twice the 100 ms gap) cannot cover a frame 300 ms late:
        // when the frame is first overdue 200 ms of text is left for 300 ms of
        // wait, so any reveal that does not see the future dips here (its CoV
        // over this run cannot go much under 0.07). It never stops and never
        // surges...
        #expect(now.min > 0.1 * cps)
        #expect(now.max < 1.15 * cps)
        #expect(before.max > 1.5 * cps)
        #expect(now.cov < before.cov)
        // ...and away from it the pace is as even as a steady stream's.
        let calm = { (from: Double, to: Double) in Sim.stats(now.speeds.filter { $0.t >= from && $0.t < to }.map(\.v)) }
        #expect(calm(0, 4000).cov < 0.05)
        #expect(calm(5500, Sim.durationMs).cov < 0.05)
    }
}

@Suite struct PacerTests {
    /// Twenty-one 30-unit chunks 100 ms apart: 300 units/s with 100 ms gaps.
    private func steady() -> Pacer {
        var p = Pacer(length: 0)
        for i in 0...20 { p.noteArrival(end: 30 * Double(i + 1), now: 100 * Double(i)) }
        return p
    }

    @Test func `learns nothing from the first chunk and reveals it with the exponential catch-up`() {
        var p = Pacer(length: 0)
        p.noteArrival(end: 50, now: 0)
        #expect(p.arrivalRate == 0)
        let stepped = p.step(dt: 16, now: 16, live: true)
        #expect(close(stepped, SmoothText.advanceReveal(pos: 0, end: 50, dt: 16, live: true), digits: 9))
    }

    @Test func `measures the arrival rate and holds a lag of twice the high gap, within its clamps`() {
        let p = steady()
        #expect(close(p.arrivalRate * 1000, 300, digits: 6))
        #expect(close(p.targetLagMs, 200, digits: 6))
        var fast = Pacer(length: 0)
        for i in 0...50 { fast.noteArrival(end: 2 * Double(i + 1), now: 7 * Double(i)) }
        #expect(fast.targetLagMs == SmoothText.minLagMs)
        var slow = Pacer(length: 0)
        for i in 0...10 { slow.noteArrival(end: 300 * Double(i + 1), now: 900 * Double(i)) }
        #expect(slow.targetLagMs == SmoothText.maxLagMs)
    }

    @Test func `a pause past pauseMs starts a new spurt without dragging the rate down`() {
        var p = steady()
        let rate = p.arrivalRate
        p.noteArrival(end: 30 * 22, now: 2000 + SmoothText.pauseMs + 1)
        #expect(p.arrivalRate == rate)
    }

    @Test func `drains with the end-of-stream catch-up once the stream ends`() {
        var p = steady()
        p.pos = 400
        let drained = p.step(dt: 16, now: 2016, live: false)
        #expect(close(drained, SmoothText.advanceReveal(pos: 400, end: 630, dt: 16, live: false), digits: 9))
    }

    @Test func `keeps the lag cap: a torrent skips ahead`() {
        var p = steady()
        p.noteArrival(end: 5000, now: 2050)
        let shown = p.step(dt: 16, now: 2066, live: true)
        #expect(p.end - shown == SmoothText.maxLag)
    }

    @Test func `never passes the live end`() {
        var p = steady()
        p.pos = 629.99
        let first = p.step(dt: 100, now: 2100, live: true)
        #expect(first == 630)
        let second = p.step(dt: 16, now: 2116, live: true)
        #expect(second == 630)
    }

    @Test func `two fresh pacers are equal, nan and all`() {
        #expect(Pacer(length: 0) == Pacer(length: 0))
        var moved = Pacer(length: 0)
        moved.noteArrival(end: 1, now: 0)
        #expect(moved != Pacer(length: 0))
    }
}

@Suite struct SmoothTextPrefixTests {
    @Test func `ASCII cuts exactly`() {
        #expect(SmoothText.prefix(of: "hello world", units: 5) == "hello")
        #expect(SmoothText.prefix(of: "hello", units: 0) == "")
        #expect(SmoothText.prefix(of: "hello", units: 5) == "hello")
        #expect(SmoothText.prefix(of: "hello", units: 50) == "hello")
    }

    @Test func `units inside a 4-byte scalar round down to the scalar`() {
        let text = "ab😀cd"   // 😀 is 4 bytes: units 2...5
        #expect(SmoothText.prefix(of: text, units: 2) == "ab")
        #expect(SmoothText.prefix(of: text, units: 3) == "ab")
        #expect(SmoothText.prefix(of: text, units: 5) == "ab")
        #expect(SmoothText.prefix(of: text, units: 6) == "ab😀")
        #expect(SmoothText.prefix(of: text, units: 7) == "ab😀c")
    }

    @Test func `a cut between a thumb and its skin tone shows neither`() {
        let text = "ok 👍🏽 go"   // 👍 (4 bytes) + 🏽 (4 bytes), one grapheme
        #expect(SmoothText.prefix(of: text, units: 3) == "ok ")
        #expect(SmoothText.prefix(of: text, units: 7) == "ok ")
        #expect(SmoothText.prefix(of: text, units: 9) == "ok ")
        #expect(SmoothText.prefix(of: text, units: 11) == "ok 👍🏽")
        #expect(SmoothText.prefix(of: text, units: 12) == "ok 👍🏽 ")
    }
}
