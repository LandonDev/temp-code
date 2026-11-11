@testable import AXText
import ComputerProtocol
import Testing

@Suite struct WindowMatchTests {
    let frame = Rect(x: 3700, y: -244, w: 640, h: 536)

    func entry(_ id: Int, pid: Int32 = 42, title: String = "Untitled", dx: Double = 0, layer: Int = 0) -> WindowListEntry {
        WindowListEntry(id: id, pid: pid, title: title, bounds: Rect(x: 3700 + dx, y: -244, w: 640, h: 536), onScreen: true, layer: layer)
    }

    @Test func oneWindowOfThatPidTitleAndFrameIsTheMatch() {
        #expect(WindowMatch.pick([entry(7), entry(8, pid: 43), entry(9, title: "Other"), entry(10, dx: 40), entry(11, layer: 25)], pid: 42, title: "Untitled", frame: frame) == 7)
        // within a point; and a title CG hides (no Screen Recording) does not rule a window out
        #expect(WindowMatch.pick([entry(7, title: "", dx: 0.6)], pid: 42, title: "Untitled", frame: frame) == 7)
    }

    @Test func aFloatingWindowIsMatchedAtItsOwnLayer() {
        // TC Probe's windows float above ordinary ones (kCGFloatingWindowLevel, layer 3)
        #expect(WindowMatch.pick([entry(12, layer: 3)], pid: 42, title: "Untitled", frame: frame) == 12)
        // a menu or a status item on a higher layer never is
        #expect(WindowMatch.pick([entry(13, layer: 101)], pid: 42, title: "Untitled", frame: frame) == nil)
        // an ordinary and a floating window with one frame and title: no telling them apart
        #expect(WindowMatch.pick([entry(7), entry(12, layer: 3)], pid: 42, title: "Untitled", frame: frame) == nil)
    }

    @Test func noneOrTwoIsNoMatch() {
        #expect(WindowMatch.pick([entry(8, pid: 43)], pid: 42, title: "Untitled", frame: frame) == nil)
        #expect(WindowMatch.pick([entry(7), entry(8, title: "")], pid: 42, title: "Untitled", frame: frame) == nil)
    }
}

@Suite struct ManualAccessibilityTests {
    final class Clock: @unchecked Sendable {
        var now: Double = 10_000
        var sets: [Int32] = []
    }

    func machine(_ clock: Clock, takes: Bool) -> ManualAccessibility {
        ManualAccessibility(set: { pid in clock.sets.append(pid); return takes }, clock: { clock.now })
    }

    @Test func aSetThatTakesMarksChromiumOnceAndARefusalMarksNative() {
        let c = Clock()
        let m = machine(c, takes: true)
        #expect(m.prepare(7) == .chromium(setAt: 10_000))
        #expect(m.prepare(7) == .chromium(setAt: 10_000))
        #expect(c.sets == [7])
        #expect(machine(Clock(), takes: false).prepare(8) == .native)
    }

    @Test func aThinChromiumReadRetriesOnScheduleInsideFiveSeconds() {
        let c = Clock()
        let m = machine(c, takes: true)
        _ = m.prepare(7)
        c.now += 100
        #expect(m.retries(7, thin: true) == [10_250, 10_500, 11_000, 11_500, 12_500, 13_500])
        c.now += 600
        #expect(m.retries(7, thin: true) == [11_000, 11_500, 12_500, 13_500])
        #expect(m.retries(7, thin: false).isEmpty)
        c.now = 15_001
        #expect(m.retries(7, thin: true).isEmpty)
        let native = machine(Clock(), takes: false)
        _ = native.prepare(9)
        #expect(native.retries(9, thin: true).isEmpty)
        m.forget(7)
        _ = m.prepare(7)
        #expect(c.sets == [7, 7])
    }
}

@Suite struct BusyRuleTests {
    let window = Rect(x: 0, y: 0, w: 800, h: 600)
    let list = Rect(x: 0, y: 100, w: 800, h: 200)

    @Test func aSpinnerShowsInsideItsClipAndNotOnceScrolledOut() {
        #expect(BusyRule.showing(.busy, frame: Rect(x: 10, y: 150, w: 16, h: 16), hasValue: false, busy: nil, loaded: nil, clips: [window, list]))
        #expect(!BusyRule.showing(.busy, frame: Rect(x: 10, y: 350, w: 16, h: 16), hasValue: false, busy: nil, loaded: nil, clips: [window, list]))
        #expect(!BusyRule.showing(.busy, frame: Rect(x: 10, y: 150, w: 0, h: 0), hasValue: false, busy: nil, loaded: nil, clips: [window]))
    }

    @Test func aMovedWindowIsJudgedAsItIsNow() {
        let moved = Rect(x: 2000, y: 500, w: 800, h: 600)
        #expect(BusyRule.showing(.busy, frame: Rect(x: 2010, y: 650, w: 16, h: 16), hasValue: false, busy: nil, loaded: nil, clips: [moved]))
    }

    @Test func onlyAnIndeterminateProgressAndABusyOrUnloadedWebAreaCount() {
        let inside = Rect(x: 10, y: 10, w: 100, h: 8)
        #expect(BusyRule.showing(.progress, frame: inside, hasValue: false, busy: nil, loaded: nil, clips: [window]))
        #expect(!BusyRule.showing(.progress, frame: inside, hasValue: true, busy: nil, loaded: nil, clips: [window]))
        #expect(BusyRule.showing(.webArea, frame: nil, hasValue: false, busy: true, loaded: true, clips: []))
        #expect(BusyRule.showing(.webArea, frame: nil, hasValue: false, busy: false, loaded: false, clips: []))
        #expect(!BusyRule.showing(.webArea, frame: nil, hasValue: false, busy: false, loaded: true, clips: []))
    }
}

@Suite struct SignatureTests {
    func sig(focused: UInt64? = 1, value: String? = "hello", length: Int? = 5, selection: [Int]? = [5, 0], title: String? = "Untitled",
             children: [UInt64] = [1, 2], counts: [Int] = [2, 10]) -> UInt64 {
        Signature(focused: focused, value: value, valueLength: length, selection: selection, title: title, windowChildren: children, counts: counts).hash
    }

    @Test func everyPartMovesTheHash() {
        let base = sig()
        for other in [sig(focused: 2), sig(value: "hellp"), sig(selection: [4, 0]), sig(title: "Edited"), sig(children: [1, 3]), sig(counts: [2, 11])] {
            #expect(other != base)
        }
        #expect(sig() == base)
    }

    @Test func aHugeValueHashesAsItsLengthAndAtMost32ScrollAreasCount() {
        let big = Signature.maxValueUnits + 1
        #expect(sig(value: "a", length: big) == sig(value: "b", length: big))
        #expect(sig(value: "a", length: big) != sig(value: "a", length: big + 1))
        let many = [5] + Array(repeating: 1, count: 32)
        #expect(sig(counts: many + [7]) == sig(counts: many + [8]))
    }
}

@Suite struct BusyScanTests {
    /// A node of a tree the scan reads: role, frame, children by id.
    struct N { var role: String; var frame: Rect?; var children: [Int] }

    let tree: [Int: N] = [
        0: N(role: "AXWebArea", frame: Rect(x: 0, y: 0, w: 800, h: 600), children: [1, 2, 5]),
        1: N(role: "AXGroup", frame: Rect(x: 0, y: 0, w: 800, h: 100), children: [3]),
        3: N(role: "AXProgressIndicator", frame: Rect(x: 10, y: 10, w: 16, h: 16), children: []),
        2: N(role: "AXList", frame: Rect(x: 0, y: 200, w: 800, h: 100), children: [4, 6, 8]),
        // a row the list scrolled away, parked at its bottom edge as a 1-point sliver, a spinner inside
        8: N(role: "AXGroup", frame: Rect(x: 0, y: 299, w: 800, h: 1), children: [9]),
        9: N(role: "AXBusyIndicator", frame: Rect(x: 10, y: 299, w: 16, h: 16), children: []),
        4: N(role: "AXBusyIndicator", frame: Rect(x: 10, y: 210, w: 16, h: 16), children: []),
        6: N(role: "AXBusyIndicator", frame: Rect(x: 10, y: 450, w: 16, h: 16), children: []),
        5: N(role: "AXGroup", frame: Rect(x: 0, y: 900, w: 800, h: 100), children: [7]),
        7: N(role: "AXProgressIndicator", frame: Rect(x: 10, y: 910, w: 16, h: 16), children: [])
    ]

    func read(_ id: Int) -> BusyScan.Read<Int> {
        let n = tree[id]!
        return BusyScan.Read(role: n.role, frame: n.frame, children: n.children)
    }

    @Test func findsTheIndicatorsInsideTheirClipWithTheirContainers() {
        let hits = BusyScan.find(root: 0, clip: Rect(x: 0, y: 0, w: 800, h: 600), read: read)
        #expect(hits.map(\.node) == [3, 4])
        #expect(hits.map(\.kind) == [.progress, .busy])
        #expect(hits[0].containers == [0] && hits[1].containers == [0, 2])
    }

    @Test func stopsAtItsCapOrWhenTold() {
        #expect(BusyScan.find(root: 0, clip: nil, maxNodes: 3, read: read).isEmpty)
        #expect(BusyScan.find(root: 0, clip: nil, stop: { true }, read: read).isEmpty)
    }
}
