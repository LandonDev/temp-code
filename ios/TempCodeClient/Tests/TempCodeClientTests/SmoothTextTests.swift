import Foundation
import Testing
@testable import TempCodeClient

/// The desktop's smoothText.test.ts on the Swift port, in UTF-16 units: the
/// pacer's rules, the word cut, and the simulated streams of 2026-11-05
/// (docs/TRANSCRIPT.md "The stream reveals a phrase at a time").

@Suite struct IsRewriteTests {
    @Test func `an append is no rewrite, a change inside the shown prefix is, one past it is not`() {
        #expect(!SmoothText.isRewrite(prev: "hello", next: "hello world", revealed: 5))
        #expect(SmoothText.isRewrite(prev: "hello world", next: "help world", revealed: 5))
        #expect(!SmoothText.isRewrite(prev: "hello world", next: "hello there", revealed: 6.9))
        #expect(SmoothText.isRewrite(prev: "hello world", next: "hello there", revealed: 7))
    }
}

private let cps = 500.0

private func afterStart(_ run: SimRun) -> [SimStep] {
    guard let first = run.steps.firstIndex(where: { $0.chars > 0 }) else { return [] }
    return Array(run.steps[first...])
}

/// No empty step with text in hand once a spurt started (a hold aside), and
/// no step past the faster of the surge on the base pace and the catch-up's
/// pace on the largest backlog of the last catch-up window, plus one long token.
private func keepsTheRules(_ run: SimRun) {
    for s in afterStart(run) where s.inHand > 0 && !s.held { #expect(s.chars > 0, "step at \(s.t)") }
    for s in run.steps {
        let recent = run.steps.filter { $0.t <= s.t && $0.t > s.t - SmoothText.catchUpMs }
        let backlog = recent.map(\.inHand).max() ?? 0
        let bound = max(SmoothText.maxSurge * s.base * s.dt, backlog * s.dt / (SmoothText.catchUpMs - SmoothText.stepMs)) + Double(MotionValues.longToken)
        #expect(s.chars <= bound + 1e-9, "step at \(s.t)")
    }
}

private func speedCov(_ run: SimRun, from: Double, to: Double = .infinity) -> Double {
    cov(run.steps.filter { $0.live && $0.t >= from && $0.t < to && $0.chars > 0 }.map { $0.chars / $0.dt })
}

private func macRemote() -> [Arrival] {
    var r = Prng(3)
    return frames(every: 33, cps: cps, durationMs: 8_000) { _ in 100 * r.next() }
}

private func laggingBox(_ durationMs: Double = 8_000) -> [Arrival] {
    var r = Prng(5)
    return frames(every: 250, cps: cps, durationMs: durationMs) { _ in 60 * r.next() }
}

private func stalledBox(_ durationMs: Double = 8_000) -> [Arrival] {
    laggingBox(durationMs).map { $0.t > 4_000 && $0.t < 5_000 ? Arrival(t: 5_000, chars: $0.chars) : $0 }
}

private let whole = 3_342.0
private func wholeReply() -> [Arrival] {
    (0..<143).map { i in Arrival(t: 1_000 + Double(i) * 20 / 143, chars: i < 142 ? 23 : whole - 23 * 142) }
}

private let burstChars = 1_632.0
private func burstFrame() -> (arrivals: [Arrival], at: Double) {
    var r = Prng(9)
    var arrivals = frames(every: 33, cps: cps, durationMs: 6_000) { _ in 20 * r.next() }
    let k = arrivals.count / 2
    arrivals[k].chars = burstChars
    return (arrivals, arrivals[k].t)
}

@Suite struct JitterBufferSimTests {
    @Test func `the Mac's remote cadence: an even pace at the stream's rate, no underrun`() {
        let run = simulate(macRemote(), leadMs: SmoothText.leadRemoteMs)
        keepsTheRules(run)
        #expect(run.underruns.isEmpty)
        #expect(speedCov(run, from: 1_500) < 0.1)
        let live = run.steps.filter { $0.live && $0.t >= 1_500 }
        let pace = live.reduce(0) { $0 + $1.chars } / (live[live.count - 1].t - live[0].t) * 1_000
        #expect(abs(pace - cps) / cps < 0.1)
        #expect(run.doneAt - run.endAt < 2 * SmoothText.leadRemoteMs + SmoothText.stepMs)
    }

    @Test func `a lagging box at 250 ± 60 ms: an even pace after warm-up, at most one underrun`() {
        let run = simulate(laggingBox(), leadMs: SmoothText.leadRemoteMs)
        keepsTheRules(run)
        #expect(run.underruns.count <= 1)
        #expect(speedCov(run, from: 1_500) < 0.15)
        #expect(run.pacer.currentLead >= 500)
    }

    @Test func `a 1 s stall: exactly one underrun, the lead grown after it, back near its floor ten steady seconds on`() throws {
        let run = simulate(stalledBox(16_000), leadMs: SmoothText.leadRemoteMs)
        keepsTheRules(run)
        #expect(run.underruns.count == 1)
        let underrun = try #require(run.underruns.first)
        #expect(underrun > 4_000 && underrun < 5_000)
        let before = try #require(run.steps.last { $0.t < underrun }).lead
        let after = try #require(run.steps.first { $0.t > 5_000 }).lead
        #expect(after > before)
        #expect(speedCov(run, from: 5_500) < 0.15)
        let later = try #require(run.steps.first { $0.t >= 15_000 })
        #expect(later.lead > later.floor)
        #expect(later.lead <= 1.1 * later.floor)
    }

    @Test func `a whole reply inside 20 ms: over at least ten steps, all of it within the catch-up`() {
        let run = simulate(wholeReply(), leadMs: SmoothText.leadRemoteMs, endAt: 1_050)
        keepsTheRules(run)
        #expect(run.steps.filter { $0.chars > 0 }.count >= 10)
        #expect(run.doneAt - 1_000 <= SmoothText.catchUpMs + 2 * SmoothText.stepMs)
        let drain = run.steps.filter { !$0.live && $0.chars > 0 }
        #expect(drain.count >= 10)
        for s in drain { #expect(s.chars < whole / 5) }
    }

    @Test func `one 1,632-unit frame in a 33 ms stream: played out over steps, no underrun after`() {
        let (arrivals, at) = burstFrame()
        let run = simulate(arrivals, leadMs: SmoothText.leadRemoteMs)
        keepsTheRules(run)
        let during = run.steps.filter { $0.t >= at && $0.t <= at + SmoothText.catchUpMs + 2 * SmoothText.stepMs }
        #expect(during.filter { $0.chars > 0 }.count >= 10)
        let shownBy = during.reduce(0) { $0 + $1.chars }
        let before = run.steps.filter { $0.t < at }.reduce(0) { $0 + $1.chars }
        let arrivedWith = arrivals.filter { $0.t <= at }.reduce(0) { $0 + $1.chars }
        #expect(before + shownBy >= arrivedWith - 1e-6)
        #expect(run.underruns.isEmpty)
    }

    @Test func `local deltas every 7 ms: a lead under 150 ms, the pace within 2 % of the stream`() {
        let local = 300.0
        let run = simulate(localDeltas(cps: local, durationMs: 8_000), leadMs: SmoothText.leadLocalMs)
        keepsTheRules(run)
        #expect(run.underruns.isEmpty)
        let live = run.steps.filter { $0.live && $0.t >= 1_500 }
        let pace = live.reduce(0) { $0 + $1.chars } / (live[live.count - 1].t - live[0].t) * 1_000
        #expect(abs(pace - local) / local < 0.02)
        let lagMs = live.reduce(0) { $0 + ($1.inHand - $1.chars) } / Double(live.count) / local * 1_000
        #expect(lagMs < 150)
        #expect(speedCov(run, from: 1_500) < 0.05)
    }
}

@Suite struct PacerTests {
    /// A pacer that has seen `n` 30-unit chunks every 100 ms (300 units/s).
    private func steady(_ n: Int = 20, leadMs: Double = SmoothText.leadLocalMs) -> Pacer {
        var p = Pacer(length: 0, leadMs: leadMs)
        for i in 0...n { p.noteArrival(end: Double(30 * (i + 1)), now: Double(100 * i)) }
        return p
    }

    @Test func `seeded with the host's lead, starting where it mounts`() {
        let p = Pacer(length: 10)
        #expect(p.pos == 10 && p.end == 10)
        #expect(p.currentLead == SmoothText.leadRemoteMs)
        #expect(Pacer(length: 0, leadMs: SmoothText.leadLocalMs).currentLead == SmoothText.leadLocalMs)
    }

    @Test func `the rate over its window, and a lead floor of twice the high gap within its clamps`() {
        let p = steady()
        #expect(abs(p.arrivalRate * 1_000 - 300) < 1e-6)
        #expect(abs(p.leadFloor - 200) < 1e-6)
        var fast = Pacer(length: 0)
        for i in 0...50 { fast.noteArrival(end: Double(2 * (i + 1)), now: Double(7 * i)) }
        #expect(fast.leadFloor == SmoothText.leadMinMs)
        var slow = Pacer(length: 0)
        for i in 0...10 { slow.noteArrival(end: Double(300 * (i + 1)), now: Double(900 * i)) }
        #expect(slow.leadFloor == SmoothText.leadMaxMs)
    }

    @Test func `frames that land together count whole`() {
        var p = Pacer(length: 0)
        for i in 0...40 { p.noteArrival(end: Double(17 * (i + 1)), now: Double(66 * (i / 2))) }
        #expect(p.arrivalRate * 1_000 > 480)
        #expect(p.arrivalRate * 1_000 < 540)
    }

    @Test func `the base pace: the default before a gap, the rate within its clamps`() {
        var p = Pacer(length: 0)
        p.noteArrival(end: 40, now: 0)
        #expect(p.basePace == SmoothText.defaultCps / 1_000)
        #expect(abs(steady().basePace * 1_000 - 300) < 1e-6)
        var all = Pacer(length: 0)
        for a in wholeReply() { all.noteArrival(end: all.end + a.chars, now: a.t) }
        #expect(all.basePace == SmoothText.baseMaxCps / 1_000)
        var trickle = Pacer(length: 0)
        for i in 0...5 { trickle.noteArrival(end: Double(i + 1), now: Double(900 * i)) }
        #expect(trickle.basePace == SmoothText.floorCps / 1_000)
    }

    @Test func `a burst counts at the base's cap over a step at most`() {
        var p = steady()
        p.noteArrival(end: p.end + burstChars, now: 2_100)
        #expect(p.basePace * 1_000 < 500)
    }

    @Test func `an underrun grows the lead 1.5 times or by the wait, up to its cap, and starts a spurt`() {
        func grow(_ lead: Double, _ stallMs: Double) -> Pacer {
            var p = Pacer(length: 0, leadMs: lead)
            p.noteArrival(end: 10, now: 0)
            p.pos = 10
            p.dryAt = 1_000
            p.noteArrival(end: 20, now: 1_000 + stallMs)
            return p
        }
        #expect(grow(200, 50).lead == 300)
        #expect(grow(200, 400).lead == 600)
        #expect(grow(400, 600).lead == SmoothText.leadMaxMs)
        #expect(grow(100, 600).lead == 700)
        #expect(grow(100, 5 * SmoothText.pauseMs).lead == SmoothText.leadMaxMs)
        let p = grow(200, 50)
        #expect(p.holding)
        #expect(p.dryAt.isNaN)
    }

    @Test func `a pause past pauseMs counts as pauseMs on the rate's clock`() {
        let rates = [SmoothText.pauseMs, 5 * SmoothText.pauseMs].map { pause in
            var p = steady()
            p.noteArrival(end: p.end + 30, now: 2_000 + pause)
            return p.arrivalRate
        }
        #expect(abs(rates[1] - rates[0]) < 1e-9)
    }

    @Test func `a spurt holds until a lead and a step of text are in hand, or as long has passed`() {
        let enough = SmoothText.leadLocalMs + SmoothText.stepMs
        var short = Pacer(length: 0, leadMs: SmoothText.leadLocalMs)
        short.noteArrival(end: 50, now: 0)
        #expect(short.holding)
        #expect(short.step(dt: 100, now: 100, live: true) == 0)
        #expect(short.step(dt: 100, now: enough, live: true) > 0)
        var long = Pacer(length: 0, leadMs: SmoothText.leadLocalMs)
        long.noteArrival(end: 100, now: 0)
        #expect(long.step(dt: 10, now: 10, live: true) > 0)
        var ended = Pacer(length: 0, leadMs: SmoothText.leadLocalMs)
        ended.noteArrival(end: 50, now: 0)
        #expect(ended.step(dt: 10, now: 10, live: false) > 0)
    }

    @Test func `the base pace inside the lead, faster above it, never past the surge`() {
        var p = steady(20, leadMs: 200)
        p.holding = false
        p.due = []
        p.pos = p.end - 0.3 * 300
        let at = p.pos
        p.step(dt: 100, now: 2_010, live: true)
        #expect(abs(p.pos - at - 30) < 1e-6)
        var q = steady(20, leadMs: 200)
        q.holding = false
        q.due = []
        q.pos = q.end - 0.3 * 3_000
        let from = q.pos
        q.step(dt: 100, now: 2_010, live: true)
        #expect(q.pos - from <= SmoothText.maxSurge * 30 + 1e-9)
        #expect(q.pos - from > 30)
    }

    @Test func `the catch-up's pace is the backlog over the time it has left`() {
        var p = Pacer(length: 0)
        p.noteArrival(end: 3_000, now: 0)
        #expect(abs(p.catchUpPace(now: 0) - 3_000 / SmoothText.catchUpMs) < 1e-9)
        p.pos = 1_000
        #expect(abs(p.catchUpPace(now: 500) - 2_000 / (SmoothText.catchUpMs - 500)) < 1e-9)
        #expect(abs(p.catchUpPace(now: SmoothText.catchUpMs + 500) - 2_000 / SmoothText.stepMs) < 1e-9)
    }

    @Test func `the lead's excess decays toward its floor, and not during an underrun`() {
        var p = Pacer(length: 100, leadMs: SmoothText.leadMaxMs)
        p.noteArrival(end: 200, now: 0)
        p.step(dt: SmoothText.leadDecayMs, now: SmoothText.leadDecayMs, live: false)
        #expect(abs(p.lead - (SmoothText.leadMinMs + (SmoothText.leadMaxMs - SmoothText.leadMinMs) * exp(-1))) < 1e-6)
        var dry = Pacer(length: 0, leadMs: SmoothText.leadMaxMs)
        dry.dryAt = 0
        dry.step(dt: 1_000, now: 1_000, live: true)
        #expect(dry.lead == SmoothText.leadMaxMs)
    }

    @Test func `an underrun is marked when the shown text reaches the live end while live`() {
        var p = steady()
        p.holding = false
        p.pos = p.end - 1
        p.step(dt: 100, now: 2_010, live: true)
        #expect(p.pos == p.end)
        #expect(p.dryAt == 2_010)
        var ended = steady()
        ended.holding = false
        ended.pos = ended.end - 1
        ended.step(dt: 100, now: 2_010, live: false)
        #expect(ended.dryAt.isNaN)
    }

    @Test func `never passes the live end`() {
        var p = steady()
        p.holding = false
        p.pos = 629.99
        #expect(p.step(dt: 100, now: 2_100, live: true) == 630)
        #expect(p.step(dt: 16, now: 2_116, live: true) == 630)
    }
}

@Suite struct RevealCutTests {
    private func shown(_ text: String, _ pos: Int, _ revealing: Bool = true) -> String {
        SmoothText.prefix(of: text, units: SmoothText.revealCut(text, pos: pos, revealing: revealing))
    }

    @Test func `ends at a word boundary, never inside a word`() {
        #expect(shown("the transcript reads", 8) == "the ")
        #expect(shown("the transcript reads", 15) == "the transcript ")
        #expect(shown("the transcript reads", 4) == "the ")
        #expect(shown("the transcript reads", 3) == "")
        #expect(shown("one\ntwo three", 6) == "one\n")
        #expect(shown("the transcri", 12) == "the ")
    }

    @Test func `a token past the long-token length is cut where the pace reaches`() {
        let url = "see https://example.com/a/very/long/path/to/a/file.ts"
        let pos = 4 + MotionValues.longToken + 6
        #expect(shown(url, pos) == SmoothText.prefix(of: url, units: pos))
        #expect(shown("see " + String(repeating: "x", count: MotionValues.longToken), 4 + MotionValues.longToken) == "see ")
    }

    @Test func `never splits a surrogate pair or a joined emoji`() {
        let text = String(repeating: "a", count: MotionValues.longToken + 2) + "😀😀"
        let pos = MotionValues.longToken + 3
        #expect(SmoothText.revealCut(text, pos: pos, revealing: true) == pos - 1)
        let family = String(repeating: "b", count: MotionValues.longToken + 2) + "👨‍👩‍👧"
        let inside = MotionValues.longToken + 2 + 4
        #expect(SmoothText.revealCut(family, pos: inside, revealing: true) == MotionValues.longToken + 2)
    }

    @Test(arguments: [
        ("# ", "# Title "), ("### ", "### Title "), ("- ", "- item "), ("* ", "* item "), ("+ ", "+ item "),
        ("1. ", "1. item "), ("2) ", "2) item "), ("- [ ] ", "- [ ] task "), ("- [x] ", "- [x] done "),
        ("> - ", "> - quoted "), ("> ", "> quoted "),
    ])
    func `holds a bare block marker until its line has content`(marker: String, full: String) {
        let before = "Intro line\n"
        #expect(shown(before + full, (before + marker).utf16.count) == before)
        #expect(shown(before + full, (before + full).utf16.count) == before + full)
    }

    @Test func `holds a table's header row until its delimiter row is whole`() {
        let table = "Text\n| a | b |\n|---|---|\n| 1 | 2 |\n"
        let header = "Text\n| a | b |\n"
        #expect(shown(table, header.utf16.count) == "Text\n")
        #expect(shown(table, header.utf16.count + 5) == "Text\n")
        #expect(shown(table, header.utf16.count + "|---|---|\n".utf16.count) == header + "|---|---|\n")
        #expect(shown(table, table.utf16.count) == table)
    }

    @Test func `holds no marker or table inside an open code fence`() {
        let code = "```sh\nls\n| grep x\n- \n"
        #expect(shown(code, code.utf16.count) == code)
    }

    @Test func `an open fence's code line shows once its newline comes, or by words once released`() {
        let code = "```ts\nconst a = 1\nconst b = await load(path)"
        let whole = "```ts\nconst a = 1\n"
        #expect(shown(code, code.utf16.count) == whole)
        #expect(SmoothText.revealCut(code, pos: code.utf16.count, revealing: true, holdOpenLine: false) == "```ts\nconst a = 1\nconst b = await ".utf16.count)
        // The closing fence shows as typed.
        let closing = whole + "```\n"
        #expect(shown(closing, closing.utf16.count) == closing)
    }

    @Test func `holds a table row that is only its pipes until a cell has content`() {
        let table = "| a | b |\n|---|---|\n| 1 | 2 |\n| "
        #expect(shown(table, table.utf16.count) == "| a | b |\n|---|---|\n| 1 | 2 |\n")
        let typed = table + "x | "
        #expect(shown(typed, typed.utf16.count) == typed)
    }

    @Test func `cuts at words while draining, and shows everything once nothing is left`() {
        #expect(shown("the reply has ended", 9, true) == "the ")
        for text in ["the transcri", "Intro\n- ", "| a | b |\n|--", String(repeating: "x", count: 40)] {
            #expect(SmoothText.revealCut(text, pos: 3, revealing: false) == text.utf16.count)
        }
    }
}
