import ComputerCore
import ComputerProtocol
import Foundation
import Testing
@testable import Input

/// An app as the probe sees it: a scroll bar "bar" and a text element "text", moved by the posts it honours.
final class FakeProbe: ProbeAccess {
    typealias Element = String
    let clock: FakeClock
    var pid: Int32 = 7
    var bundleId: String? = "com.apple.TextEdit"
    var key: KeyWindowState = .target
    var honours: Set<ActionClass> = [.scroll, .key, .click, .drag]
    var numbers: [String: Double] = ["bar": 0.2, "textBar": 0.5]
    var ranges: [String: TextRange] = ["text": TextRange(location: 3, length: 0)]
    var barSettable = true
    /// each read costs this long, as a read that waits out its timeout
    var readCost: Double = 0
    var sets: [String] = []
    var posted: [[SyntheticEvent]] = []
    var focusedBack = false
    /// reads of a value just set answer the old one this many times, as a web view's AX does
    var lagReads = 0
    private var stale: [String: TextRange] = [:]
    private var staleReads = 0

    init(clock: FakeClock) { self.clock = clock }

    func keyWindow() -> KeyWindowState { key }
    func scrollCandidate() -> ProbeScroll<String>? {
        ProbeScroll(bar: "bar", value: numbers["bar"]!, point: pt(50, 50), facts: [RestoreFact("scroll bar", readable: true, settable: barSettable)])
    }
    private func text() -> ProbeText<String> {
        ProbeText(element: "text", range: ranges["text"]!, length: 10, bar: "textBar", barValue: numbers["textBar"],
                  clickAt: pt(20, 20), clickExpect: TextRange(location: 6, length: 0), dragTo: pt(40, 20), dragExpect: TextRange(location: 6, length: 2),
                  focused: "other", facts: [RestoreFact("selection", readable: true, settable: true), RestoreFact("focus", readable: true, settable: true)])
    }
    func focusedText() -> ProbeText<String>? { text() }
    func clickCandidate() -> ProbeText<String>? { text() }
    func number(_ e: String) -> Double? { clock.advance(readCost); return numbers[e] }
    func range(_ e: String) -> TextRange? {
        clock.advance(readCost)
        if staleReads > 0, let old = stale[e] { staleReads -= 1; return old }
        return ranges[e]
    }
    func setNumber(_ e: String, _ v: Double) -> Bool { sets.append("number \(e)"); numbers[e] = v; return true }
    func setRange(_ e: String, _ r: TextRange) -> Bool {
        sets.append("range \(e)")
        stale[e] = ranges[e]
        staleReads = lagReads
        ranges[e] = r
        return true
    }
    func setFocused(_ e: String) -> Bool { sets.append("focus \(e)"); focusedBack = true; return true }
    func post(_ plan: [SyntheticEvent]) {
        posted.append(plan)
        let isScroll = plan.contains { if case .scroll = $0 { true } else { false } }
        let isKey = plan.contains { if case .key = $0 { true } else { false } }
        let isDrag = plan.contains { if case .move(_, .left?) = $0 { true } else { false } }
        if isScroll, honours.contains(.scroll) { numbers["bar"]! += 0.1 }
        if isKey, honours.contains(.key) { ranges["text"] = TextRange(location: ranges["text"]!.location + 1, length: 0) }
        if !isScroll, !isKey {
            if isDrag, honours.contains(.drag) { ranges["text"] = TextRange(location: 6, length: 2) }
            else if !isDrag, honours.contains(.click) { ranges["text"] = TextRange(location: 6, length: 0) }
        }
    }
}

private func outcomes(_ r: ProbeReport) -> [String] {
    r.results.map { "\($0.class.rawValue) \($0.outcome.rawValue)\($0.restored ? "" : " unrestored")" }
}

@Suite struct ProbeJudgeTests {
    @Test func honouredIgnoredAndRestoredPerClass() {
        let clock = FakeClock()
        let honest = FakeProbe(clock: clock)
        let r = ProbeRun(access: honest, clock: clock).run(classes: [.scroll, .key, .click, .drag, .type, .hover])
        #expect(outcomes(r) == ["scroll honoured", "key honoured", "click honoured", "drag honoured", "type untested", "hover untested"])
        #expect(honest.numbers["bar"] == 0.2)
        #expect(honest.ranges["text"] == TextRange(location: 3, length: 0))
        #expect(honest.focusedBack)
        #expect(r.keyWindow == .target)
        #expect(r.results.last?.reason == "not probed")

        let deaf = FakeProbe(clock: clock)
        deaf.honours = []
        #expect(outcomes(ProbeRun(access: deaf, clock: clock).run(classes: [.scroll, .key, .click])) == ["scroll ignored", "key ignored", "click ignored"])
    }

    @Test func aPutBackThatShowsLateStillReadsRestored() {
        let clock = FakeClock()
        let p = FakeProbe(clock: clock)
        p.lagReads = 3
        let r = ProbeRun(access: p, clock: clock).run(classes: [.key])
        #expect(r.results.first?.outcome == .honoured)
        #expect(r.results.first?.restored == true)
        // and one that never shows is not
        let q = FakeProbe(clock: clock)
        q.lagReads = 1_000
        #expect(ProbeRun(access: q, clock: clock).run(classes: [.key]).results.first?.restored == false)
    }

    @Test func aWindowThatIsNotKeyLeavesKeyUntested() {
        let clock = FakeClock()
        let p = FakeProbe(clock: clock)
        p.key = .other
        let r = ProbeRun(access: p, clock: clock).run(classes: [.key])
        #expect(r.keyWindow == .other)
        #expect(r.results.first?.outcome == .untested)
        #expect(r.results.first?.reason == "the window is not key")
        #expect(p.posted.isEmpty)
    }

    @Test func canRestoreRefusesEachMissingSettable() {
        #expect(ProbeJudge.canRestore([RestoreFact("scroll bar", readable: true, settable: true)]))
        for f in [RestoreFact("scroll bar", readable: true, settable: false), RestoreFact("selection", readable: false, settable: true), RestoreFact("focus", readable: true, settable: false)] {
            #expect(!ProbeJudge.canRestore([f]))
        }
        let clock = FakeClock()
        let p = FakeProbe(clock: clock)
        p.barSettable = false
        let r = ProbeRun(access: p, clock: clock).run(classes: [.scroll])
        #expect(r.results.first?.outcome == .untested)
        #expect(p.posted.isEmpty)
    }

    @Test func theJudgeReadsNumbersAndRanges() {
        #expect(ProbeJudge.outcome(before: 0.2, after: 0.3) == .honoured)
        #expect(ProbeJudge.outcome(before: 0.2, after: 0.2) == .ignored)
        #expect(ProbeJudge.outcome(before: 0.2, after: nil) == .ignored)
        #expect(ProbeJudge.outcome(before: TextRange(location: 1, length: 0), after: TextRange(location: 2, length: 0)) == .honoured)
        #expect(ProbeJudge.outcome(after: TextRange(location: 5, length: 0), expected: TextRange(location: 6, length: 0)) == .ignored)
    }
}

@Suite struct ProbeDeadlineTests {
    @Test func noClassStartsPastOneAndAHalfSecondsAndRestoringRunsToItsEnd() {
        let clock = FakeClock()
        let p = FakeProbe(clock: clock)
        p.honours = []
        p.readCost = 0.25 // every read waits out its timeout
        let start = clock.seconds()
        let r = ProbeRun(access: p, clock: clock).run(classes: [.scroll, .key, .click, .drag])
        #expect(r.results.contains { $0.reason == "the probe ran out of time" })
        let acted = r.results.filter { $0.reason != "the probe ran out of time" }
        #expect(acted.allSatisfy { $0.restored })
        // each acted class put its values back, past the 2 s deadline if it had to
        #expect(p.sets.filter { $0.hasPrefix("number bar") }.count == 1)
        #expect(clock.seconds() - start < 2 + 0.25 * 3 + 0.5)
    }
}

/// A pasteboard as a plain model: items, a change count, and a person who may copy.
final class FakeStore: PasteboardStore {
    var items: [PasteboardItemData]
    var changeCount = 10
    var calls: [String] = []
    var snapshotFails = false
    var writeFails = false
    init(items: [PasteboardItemData]) { self.items = items }

    func snapshot() throws -> PasteboardSnapshot {
        calls.append("snapshot")
        if snapshotFails { throw clipboardBusy("the clipboard holds data that can't be saved") }
        return PasteboardSnapshot(items: items, changeCount: changeCount)
    }
    func clear() { calls.append("clear"); items = []; changeCount += 1 }
    func write(_ c: PasteContent) throws {
        calls.append("write")
        if writeFails { throw clipboardBusy("refused") }
        items = [PasteboardItemData(types: ["public.utf8-plain-text"], data: ["public.utf8-plain-text": Data(c.plain.utf8)])]
    }
    func restore(_ s: PasteboardSnapshot) { calls.append("restore"); items = s.items; changeCount += 1 }
    func personCopies() { items = [PasteboardItemData(types: ["x"], data: ["x": Data([1])])]; changeCount += 1 }
}

@Suite struct PasteFlowTests {
    let original = [
        PasteboardItemData(types: ["a", "b", "c"], data: ["a": Data([1]), "b": Data([2, 2]), "c": Data([3, 3, 3])]),
        PasteboardItemData(types: ["d", "e", "f"], data: ["d": Data([4]), "e": Data([5]), "f": Data([6])])
    ]

    private func run(_ store: FakeStore, lock: FakeLock? = nil, clock: FakeClock = FakeClock(), cancelled: Bool = false, checks: () throws -> Void = {}, recheck: () throws -> Void = {}, post: () throws -> Void = {}, evidence: () -> Evidence? = { nil }) throws -> (ClipboardOutcome, StepEffect) {
        try PasteFlow(store: store, lock: lock ?? FakeLock(clock: clock), clock: clock).run(PasteContent(plain: "pasted"), cancelled: { cancelled }, checks: checks, recheck: recheck, post: post, evidence: evidence)
    }

    @Test func restoresTwoItemsOfThreeTypesByteForByte() throws {
        let store = FakeStore(items: original)
        var seenDuringPost: [PasteboardItemData] = []
        let changing = Box(0)
        let (outcome, effect) = try run(store, post: { seenDuringPost = store.items }, evidence: {
            changing.value += 1
            return Evidence(value: changing.value > 1 ? "after" : "before", range: nil, count: nil)
        })
        #expect(seenDuringPost.first?.data["public.utf8-plain-text"] == Data("pasted".utf8))
        #expect(store.items == original)
        #expect(outcome == .restored)
        #expect(effect == .changed)
    }

    @Test func thePersonsCopyMeanwhileStays() throws {
        let store = FakeStore(items: original)
        let (outcome, _) = try run(store, post: { store.personCopies() })
        #expect(outcome == .keptPersonCopy)
        #expect(store.items.first?.types == ["x"])
        #expect(!store.calls.contains("restore"))
    }

    @Test func everyFailureAfterTheWriteRestores() {
        let failures: [(String, (FakeStore) -> (cancelled: Bool, recheck: () throws -> Void, post: () throws -> Void))] = [
            ("cancel", { _ in (true, {}, {}) }),
            ("a throwing post", { _ in (false, {}, { throw ComputerFailure(.timeout, "post") }) }),
            ("a focus change caught by the second check", { _ in (false, { throw ComputerFailure(.keyWindowUnavailable, "moved") }, {}) })
        ]
        for (name, make) in failures {
            let store = FakeStore(items: original)
            let f = make(store)
            #expect(throws: ComputerFailure.self, "\(name)") { try run(store, cancelled: f.cancelled, recheck: f.recheck, post: f.post) }
            #expect(store.items == original, "\(name)")
            #expect(store.calls.last == "restore", "\(name)")
        }
        let store = FakeStore(items: original)
        store.writeFails = true
        #expect(throws: ComputerFailure.self) { try run(store) }
        #expect(store.items == original)
    }

    @Test func anEvidenceTimeoutStillRestores() throws {
        let store = FakeStore(items: original)
        let clock = FakeClock()
        let (outcome, effect) = try run(store, clock: clock, evidence: { Evidence(value: "same", range: nil, count: nil) })
        #expect(outcome == .restored)
        #expect(effect == .none)
        #expect(store.items == original)
    }

    @Test func aFailedCheckBeforeTheSnapshotLeavesTheClipboardAlone() {
        let store = FakeStore(items: original)
        #expect(throws: ComputerFailure.self) { try run(store, checks: { throw ComputerFailure(.keyWindowUnavailable, "not key") }) }
        #expect(store.calls.isEmpty)
    }

    @Test func anUnsavableSnapshotWritesNothing() {
        let store = FakeStore(items: original)
        store.snapshotFails = true
        do { _ = try run(store); Issue.record("pasted") } catch { #expect(kind(error) == .clipboardBusy) }
        #expect(store.calls == ["snapshot"])
    }

    @Test func aLockThatNeverFreesIsClipboardBusy() {
        let clock = FakeClock()
        let lock = FakeLock(clock: clock)
        lock.heldElsewhere = true
        let store = FakeStore(items: original)
        do { _ = try run(store, lock: lock, clock: clock); Issue.record("pasted") } catch { #expect(kind(error) == .clipboardBusy) }
        #expect(store.calls.isEmpty)
    }
}
