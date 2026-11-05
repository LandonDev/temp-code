import Foundation
import Testing
@testable import TempCodeClient

/// A clock the test moves by hand: `schedule` holds one wake, `advance`
/// runs it when its time comes. It asks for no frames, as the real one.
@MainActor
final class ManualRevealClock: RevealClock {
    var now: Double = 1_000
    private var wake: (at: Double, fire: @MainActor (Double) -> Void)?
    private(set) var schedules = 0

    var pending: Bool { wake != nil }

    func schedule(afterMs ms: Double, _ fire: @escaping @MainActor (Double) -> Void) {
        schedules += 1
        wake = (now + ms, fire)
    }

    func cancel() { wake = nil }

    /// Moves time on by `ms`, running every wake that falls due.
    func advance(_ ms: Double) {
        let until = now + ms
        while let next = wake, next.at <= until {
            wake = nil
            now = max(now, next.at)
            next.fire(now)
        }
        now = until
    }
}

@MainActor
private struct Rig {
    let clock = ManualRevealClock()
    let reveal: SmoothTextReveal

    init(text: String, streaming: Bool, fromStart: Bool = false) {
        reveal = SmoothTextReveal(text: text, streaming: streaming, fromStart: fromStart, clock: clock)
    }

    /// Runs the clock in 10 ms slices until it rests or `limitMs` passed;
    /// the (time, revealedUnits) of every published change.
    @discardableResult
    func run(limitMs: Double = 10_000) -> [(t: Double, units: Int)] {
        var changes: [(t: Double, units: Int)] = []
        var last = reveal.revealedUnits
        // Record an already-due wake at its own time, before sampling in
        // 10 ms slices; otherwise a 100 ms gap reads as 90 ms.
        clock.advance(0)
        if reveal.revealedUnits != last {
            last = reveal.revealedUnits
            changes.append((clock.now, last))
        }
        var spent = 0.0
        while clock.pending, spent < limitMs {
            clock.advance(10)
            spent += 10
            if reveal.revealedUnits != last {
                last = reveal.revealedUnits
                changes.append((clock.now, last))
            }
        }
        return changes
    }
}

private let prose = String(repeating: "the gateway forwards every request ", count: 10)   // 350 units

@MainActor
@Suite struct SmoothTextRevealTests {
    @Test func `a row mounted settled shows its whole text and schedules nothing`() {
        let rig = Rig(text: prose, streaming: true)
        #expect(rig.reveal.revealedUnits == prose.utf16.count)
        #expect(rig.reveal.revealed == prose)
        #expect(rig.clock.schedules == 0)
    }

    @Test func `an append steps whole words at most every 100 ms, reaches the end, then the clock rests`() {
        let rig = Rig(text: "hello", streaming: true)
        rig.reveal.update(text: "hello " + prose, streaming: true)
        #expect(rig.reveal.revealedUnits == 5, "nothing shows until a step")
        rig.reveal.update(text: "hello " + prose, streaming: false)
        let changes = rig.run()
        #expect(changes.count >= 3)
        #expect(changes.map(\.units) == changes.map(\.units).sorted(), "the prefix only grows")
        for (a, b) in zip(changes, changes.dropFirst()) {
            #expect(b.t - a.t >= SmoothText.stepMs - 0.001, "stepped \(b.t - a.t) ms apart")
        }
        for change in changes.dropLast() {
            let shown = SmoothText.prefix(of: "hello " + prose, units: change.units)
            #expect(shown.last?.isWhitespace != false, "a step ends at a word: \(shown.suffix(8))")
        }
        #expect(rig.reveal.revealed == "hello " + prose)
        #expect(!rig.clock.pending)
    }

    @Test func `the stream's end drains at the pace instead of snapping; a rewrite snaps`() {
        let rig = Rig(text: "hello", streaming: true)
        let full = "hello " + prose
        rig.reveal.update(text: full, streaming: true)
        rig.run(limitMs: 400)
        let before = rig.reveal.revealedUnits
        #expect(before < full.utf16.count)
        rig.reveal.update(text: full, streaming: false)
        #expect(rig.reveal.revealedUnits == before, "the end is no snap")
        rig.run()
        #expect(rig.reveal.revealedUnits == full.utf16.count)

        let other = Rig(text: "hello", streaming: true)
        other.reveal.update(text: full, streaming: true)
        other.run(limitMs: 400)
        other.reveal.update(text: "hullo " + prose, streaming: false)
        #expect(other.reveal.revealed == "hullo " + prose)
        #expect(!other.clock.pending)
    }

    @Test func `snap shows everything and stops the clock`() {
        let rig = Rig(text: "hello", streaming: true)
        rig.reveal.update(text: "hello " + prose, streaming: true)
        rig.run(limitMs: 200)
        rig.reveal.snap()
        #expect(rig.reveal.revealedUnits == ("hello " + prose).utf16.count)
        #expect(!rig.clock.pending)
    }

    @Test func `a row born live reveals from its first word even when it mounts settled`() {
        let rig = Rig(text: prose, streaming: false, fromStart: true)
        #expect(rig.reveal.revealedUnits == 0)
        #expect(rig.reveal.revealing)
        let changes = rig.run()
        #expect(changes.count >= 3)
        #expect(rig.reveal.revealed == prose)
    }

    @Test func `a settled row whose text changes with nothing in hand shows it at once`() {
        let rig = Rig(text: "done", streaming: false)
        rig.reveal.update(text: "done, and more", streaming: false)
        #expect(rig.reveal.revealed == "done, and more")
        #expect(!rig.clock.pending)
    }

    @Test func `a whole reply in one push plays out over at least ten steps within the catch-up`() {
        let rig = Rig(text: "", streaming: true)
        let reply = String(repeating: "word ", count: 326)   // 1,630 units at once
        rig.reveal.update(text: reply, streaming: true)
        rig.clock.advance(30)
        rig.reveal.update(text: reply, streaming: false)
        let changes = rig.run()
        #expect(changes.count >= 10)
        #expect((changes.last?.t ?? 0) - 1_000 <= SmoothText.catchUpMs + 2 * SmoothText.stepMs)
        #expect(rig.reveal.revealed == reply)
    }

    @Test func `revealedUnits counts UTF-16 and never cuts a joined emoji`() {
        let text = String(repeating: "x", count: MotionValues.longToken + 2) + "👍🏽👍🏽👍🏽 go"
        let rig = Rig(text: "", streaming: true)
        rig.reveal.update(text: text, streaming: true)
        var seen: [Int] = []
        while rig.clock.pending, seen.count < 200 {
            rig.clock.advance(10)
            seen.append(rig.reveal.revealedUnits)
            let shown = rig.reveal.revealed
            #expect(text.hasPrefix(shown), "a whole grapheme prefix")
            #expect(!shown.unicodeScalars.contains("\u{FFFD}"))
        }
        #expect(seen == seen.sorted(), "never decreasing")
    }
}
