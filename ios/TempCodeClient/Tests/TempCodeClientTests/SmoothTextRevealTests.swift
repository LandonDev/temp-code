import Foundation
import Testing
@testable import TempCodeClient

/// A hand-cranked frame source: the test decides when a frame happens.
@MainActor
final class ManualTicker: RevealTicker {
    var onFrame: ((Double) -> Void)?
    private(set) var running = false
    private(set) var starts = 0

    func start() {
        running = true
        starts += 1
    }

    func stop() { running = false }

    func tick(at ms: Double) { onFrame?(ms) }
}

/// A clock the test moves by hand, in ms.
@MainActor
final class FakeClock {
    var now: Double

    init(now: Double = 1_000) { self.now = now }
}

@MainActor
private struct Rig {
    let clock = FakeClock()
    let ticker = ManualTicker()
    let reveal: SmoothTextReveal

    init(text: String, streaming: Bool, paced: Bool = true) {
        let clock = self.clock
        reveal = SmoothTextReveal(text: text, streaming: streaming, paced: paced, ticker: ticker, now: { clock.now })
    }

    /// Frames every `every` ms until the ticker stops or `limit` frames ran;
    /// returns the (time, revealedUnits) of every published change.
    @discardableResult
    func run(every: Double = 16, limit: Int = 2_000) -> [(t: Double, units: Int)] {
        var changes: [(t: Double, units: Int)] = []
        var last = reveal.revealedUnits
        var frames = 0
        while ticker.running, frames < limit {
            clock.now += every
            ticker.tick(at: clock.now)
            if reveal.revealedUnits != last {
                last = reveal.revealedUnits
                changes.append((clock.now, last))
            }
            frames += 1
        }
        return changes
    }
}

private let prose = String(repeating: "the gateway forwards every request ", count: 10)   // 350 ASCII units

@MainActor
@Suite struct SmoothTextRevealTests {
    @Test func `mount baselines to the whole text and starts nothing`() {
        let rig = Rig(text: prose, streaming: true)
        #expect(rig.reveal.revealedUnits == prose.utf8.count)
        #expect(rig.reveal.revealed == prose[...])
        #expect(rig.ticker.starts == 0)
        #expect(!rig.ticker.running)
    }

    @Test func `an append paces: the prefix grows at most once per 33 ms and reaches the end, then the clock stops`() {
        let rig = Rig(text: "hello", streaming: true)
        rig.reveal.update(text: "hello " + prose, streaming: true)
        #expect(rig.reveal.revealedUnits == 5, "nothing shows until a frame")
        #expect(rig.ticker.running)
        let changes = rig.run()
        #expect(changes.count > 3)
        #expect(changes.map(\.units) == changes.map(\.units).sorted(), "the prefix only grows")
        // The last change is the end landing, painted at once; every other paint waits 33 ms.
        let paints = changes.dropLast()
        for (a, b) in zip(paints, paints.dropFirst()) {
            #expect(b.t - a.t >= SmoothText.paintEveryMs, "painted \(b.t - a.t) ms apart")
        }
        #expect(rig.reveal.revealedUnits == ("hello " + prose).utf8.count)
        #expect(String(rig.reveal.revealed) == "hello " + prose)
        #expect(!rig.ticker.running)
    }

    @Test func `the final row with the same text drains to the end; a differing final text snaps at once`() {
        let rig = Rig(text: "hello", streaming: true)
        let full = "hello " + prose
        rig.reveal.update(text: full, streaming: true)
        rig.run(limit: 6)
        #expect(rig.reveal.revealedUnits < full.utf8.count)
        rig.reveal.update(text: full, streaming: false)
        #expect(rig.ticker.running)
        let changes = rig.run(limit: 38)   // 38 frames of 16 ms: 608 ms
        #expect(rig.reveal.revealedUnits == full.utf8.count, "drained \(changes)")
        #expect(!rig.ticker.running)

        let other = Rig(text: "hello", streaming: true)
        other.reveal.update(text: full, streaming: true)
        other.run(limit: 6)
        other.reveal.update(text: "hullo " + prose, streaming: false)
        #expect(other.reveal.revealedUnits == full.utf8.count)
        #expect(String(other.reveal.revealed) == "hullo " + prose)
        #expect(!other.ticker.running)
    }

    @Test func `unpaced, every update shows the whole text and the clock never starts`() {
        let rig = Rig(text: "hello", streaming: true, paced: false)
        rig.reveal.update(text: "hello " + prose, streaming: true)
        #expect(rig.reveal.revealedUnits == ("hello " + prose).utf8.count)
        #expect(rig.ticker.starts == 0)
        rig.reveal.update(text: "hello " + prose + prose, streaming: false)
        #expect(String(rig.reveal.revealed) == "hello " + prose + prose)
        #expect(rig.ticker.starts == 0)
    }

    @Test func `turning pacing off mid-stream shows everything on the next update`() {
        let rig = Rig(text: "hello", streaming: true)
        rig.reveal.update(text: "hello " + prose, streaming: true)
        rig.run(limit: 3)
        rig.reveal.paced = false
        rig.reveal.update(text: "hello " + prose, streaming: true)
        #expect(rig.reveal.revealedUnits == ("hello " + prose).utf8.count)
        #expect(!rig.ticker.running)
    }

    @Test func `snap shows everything and stops the clock`() {
        let rig = Rig(text: "hello", streaming: true)
        rig.reveal.update(text: "hello " + prose, streaming: true)
        rig.run(limit: 3)
        #expect(rig.ticker.running)
        rig.reveal.snap()
        #expect(rig.reveal.revealedUnits == ("hello " + prose).utf8.count)
        #expect(!rig.ticker.running)
    }

    @Test func `a frame after a long gap advances by at most maxFrameMs of reveal`() {
        let rig = Rig(text: "", streaming: true)
        let torrent = String(repeating: "x", count: 5_000)
        rig.reveal.update(text: torrent, streaming: true)
        rig.clock.now += 40
        rig.ticker.tick(at: rig.clock.now)
        // The lag cap: 5,000 units arrived at once, so the first frame skips to 900 behind the end.
        let afterFirst = rig.reveal.revealedUnits
        #expect(afterFirst == 5_000 - Int(SmoothText.maxLag))
        rig.clock.now += 2_000
        rig.ticker.tick(at: rig.clock.now)
        let step = Double(rig.reveal.revealedUnits - afterFirst)
        let atMost = SmoothText.maxLag * (1 - exp(-SmoothText.maxFrameMs / SmoothText.tauStreamMs))
        #expect(step > 0)
        #expect(step <= atMost + 1)
        #expect(rig.reveal.revealedUnits < 5_000)
    }

    @Test func `arrivals while the clock runs keep it running and the measured rhythm paces the reveal`() {
        let rig = Rig(text: "", streaming: true)
        var text = ""
        var changes: [(t: Double, units: Int)] = []
        var last = 0
        // 30 units every 100 ms for 3 s, 16 ms frames between.
        for i in 0..<30 {
            text += String(repeating: "a", count: 30)
            rig.reveal.update(text: text, streaming: true)
            #expect(rig.ticker.running)
            for _ in 0..<6 {
                rig.clock.now += 100.0 / 6
                rig.ticker.tick(at: rig.clock.now)
                if rig.reveal.revealedUnits != last {
                    last = rig.reveal.revealedUnits
                    changes.append((rig.clock.now, last))
                }
            }
            if i > 0 { #expect(rig.reveal.revealedUnits < text.utf8.count, "held behind the live end") }
        }
        #expect(rig.reveal.revealedUnits > 600, "most of the 900 units shown within the lag")
        rig.reveal.update(text: text, streaming: false)
        rig.run()
        #expect(rig.reveal.revealedUnits == 900)
        #expect(!rig.ticker.running)
        for (a, b) in zip(changes, changes.dropFirst()) {
            #expect(b.t - a.t >= SmoothText.paintEveryMs - 0.001)
        }
    }

    @Test func `the revealed prefix is cut on a grapheme`() {
        let rig = Rig(text: "", streaming: true)
        rig.reveal.update(text: "ok 👍🏽 go", streaming: true)   // the thumb and its tone are units 3...10
        var frames = 0
        while rig.reveal.revealedUnits < 4, frames < 100 {
            rig.clock.now += 16
            rig.ticker.tick(at: rig.clock.now)
            frames += 1
        }
        #expect((4...10).contains(rig.reveal.revealedUnits), "the exponential crawl lands inside the glyph: \(rig.reveal.revealedUnits)")
        #expect(String(rig.reveal.revealed) == "ok ")
        rig.run()
        #expect(String(rig.reveal.revealed) == "ok 👍🏽 go")
    }
}
