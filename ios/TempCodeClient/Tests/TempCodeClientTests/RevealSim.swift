import Foundation
@testable import TempCodeClient

/// The desktop's test/revealSim.ts: drives the pacer the way the reveal
/// does, a step every `stepMs` plus 0–16 ms of timer jitter, each arrival
/// noted when it lands, the clock resting once the shown text reached the
/// live end and starting again (from the arrival) when the next chunk lands.
struct Arrival {
    var t: Double
    var chars: Double
}

struct SimStep {
    var t: Double
    var dt: Double
    var chars: Double
    var inHand: Double
    var base: Double
    var lead: Double
    var floor: Double
    var live: Bool
    var held: Bool
}

struct SimRun {
    var steps: [SimStep]
    var underruns: [Double]
    var doneAt: Double
    var endAt: Double
    var pacer: Pacer
}

/// The same LCG as the desktop's `prng`, so a seed repeats the run.
struct Prng {
    private var s: UInt32
    init(_ seed: UInt32) { s = seed }
    mutating func next() -> Double {
        s = s &* 1_664_525 &+ 1_013_904_223
        return Double(s) / 4_294_967_296
    }
}

func simulate(_ arrivals: [Arrival], leadMs: Double = SmoothText.leadRemoteMs, endAt: Double? = nil, seed: UInt32 = 11) -> SimRun {
    var r = Prng(seed)
    var p = Pacer(length: 0, leadMs: leadMs)
    let streamEnd = endAt ?? arrivals[arrivals.count - 1].t
    var steps: [SimStep] = []
    var underruns: [Double] = []
    var next = 0
    var end = 0.0
    var running = false
    var lastFrame = 0.0
    var lastPaint = -Double.infinity
    var stepAt = Double.infinity
    let total = arrivals.reduce(0) { $0 + $1.chars }
    func land(_ until: Double) {
        while next < arrivals.count, arrivals[next].t <= until {
            let a = arrivals[next]
            next += 1
            end += a.chars
            p.noteArrival(end: end, now: a.t)
            if !running, p.pos < p.end {
                running = true
                lastFrame = a.t
                stepAt = max(a.t, lastPaint + SmoothText.stepMs) + 16 * r.next()
            }
        }
    }
    for _ in 0..<100_000 {
        if !running {
            if next >= arrivals.count { break }
            land(arrivals[next].t)
            continue
        }
        land(stepAt)
        let t = stepAt
        let live = t < streamEnd
        let dryBefore = p.dryAt
        let before = p.pos
        let inHand = p.end - p.pos
        let base = p.basePace
        let lead = p.currentLead
        let floor = p.leadFloor
        let holding = p.holding
        let dt = min(t - lastFrame, SmoothText.maxFrameMs)
        p.step(dt: dt, now: t, live: live)
        lastFrame = t
        lastPaint = t
        if dryBefore.isNaN, !p.dryAt.isNaN { underruns.append(t) }
        steps.append(SimStep(t: t, dt: dt, chars: p.pos - before, inHand: inHand, base: base, lead: lead, floor: floor, live: live, held: holding && p.pos == before))
        if p.pos >= p.end {
            running = false
            if p.end >= total { return SimRun(steps: steps, underruns: underruns, doneAt: t, endAt: streamEnd, pacer: p) }
            continue
        }
        stepAt = t + SmoothText.stepMs + 16 * r.next()
    }
    return SimRun(steps: steps, underruns: underruns, doneAt: .nan, endAt: streamEnd, pacer: p)
}

/// A remote host: a frame every `every` ms carrying `cps` worth of text,
/// each delivered `delay(sent)` ms after it was sent and never before the one ahead of it.
func frames(every: Double, cps: Double, durationMs: Double, delay: (Double) -> Double) -> [Arrival] {
    var out: [Arrival] = []
    var last = 0.0
    var t = 0.0
    while t < durationMs {
        last = max(last, t + delay(t))
        out.append(Arrival(t: last, chars: (cps * every / 1_000).rounded()))
        t += every
    }
    return out
}

/// A local harness: a delta every 7 ms of a varying few chars.
func localDeltas(cps: Double, durationMs: Double) -> [Arrival] {
    var r = Prng(1)
    var out: [Arrival] = []
    var owed = 0.0
    var t = 0.0
    while t < durationMs {
        owed += cps * 7 / 1_000
        let chars = max(1, (owed * (0.5 + r.next())).rounded())
        owed -= chars
        out.append(Arrival(t: t, chars: chars))
        t += 7
    }
    return out
}

/// The coefficient of variation.
func cov(_ vs: [Double]) -> Double {
    let mean = vs.reduce(0, +) / Double(vs.count)
    let variance = vs.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(vs.count)
    return variance.squareRoot() / mean
}
