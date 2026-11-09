@testable import AXText
import ComputerProtocol
import Testing

let sampleHeader = "app \"TextEdit\" · window \"Untitled\" · 1280×1072 · focused [3]"

/// The sample, with something added to the window; the same ids every call.
func sample(value: String = "Hello from the probe\nSecond line", extra: (Tree) -> [AXNode] = { _ in [] }, roots: (Tree) -> [AXNode] = { _ in [] },
            dropFormatting: Bool = false, frameShift: Double = 0) -> AXSnapshot {
    let t = Tree()
    var (s, _) = textEditSample(t, value: value)
    let more = Tree(start: 10_000)
    s.roots[0].children += extra(more)
    s.roots += roots(more)
    if dropFormatting { s.roots[0].children.remove(at: 1) }
    if frameShift != 0 {
        func shift(_ n: inout AXNode) {
            if let f = n.frame { n.frame = Rect(x: f.x + frameShift, y: f.y, w: f.w, h: f.h) }
            for i in n.children.indices { shift(&n.children[i]) }
        }
        shift(&s.roots[0])
    }
    return s
}

@Suite struct DiffTests {
    @Test func nothingChangedIsTheHeaderAlone() {
        let reader = Reader()
        reader.read(sample())
        let built = reader.read(sample())
        #expect(built.kind == .unchanged)
        #expect(built.text == sampleHeader + " · no changes")
    }

    @Test func oneValueIsOneChangedLineUnderItsNumber() {
        let reader = Reader()
        reader.read(sample())
        let built = reader.read(sample(value: "Hello from the probe\nSecond line!"))
        #expect(built.text == sampleHeader + " · changes since your last read\n~ [3] text area = \"Hello from the probe\\nSecond line!\" focused caret 0 actions: show menu")
    }

    @Test func aSheetOpeningOnTheSameWindowIsAnAddedSubtree() {
        let reader = Reader()
        reader.read(sample())
        let built = reader.read(sample(extra: { t in
            [t.node("AXSheet", title: "Save As", frame: Rect(x: 100, y: 50, w: 400, h: 200), [
                t.node("AXTextField", title: "Save As:", value: .string("Untitled"), frame: Rect(x: 120, y: 60, w: 200, h: 20), settable: ["AXValue"]),
                t.node("AXButton", title: "Cancel", frame: Rect(x: 120, y: 200, w: 60, h: 20), actions: ["AXPress"])
            ])]
        }))
        #expect(built.kind == .diff)
        #expect(built.text == sampleHeader + " · changes since your last read\n+ in [1]:\n  [25] sheet \"Save As\"\n    [26] input \"Save As:\" = \"Untitled\"\n    [27] button \"Cancel\"")
    }

    @Test func aMenuOpeningIsAddedAtTheTop() {
        let reader = Reader()
        reader.read(sample())
        let built = reader.read(sample(roots: { t in [t.node("AXMenu", frame: Rect(x: 700, y: 40, w: 200, h: 100), [t.node("AXMenuItem", title: "Copy", frame: Rect(x: 700, y: 44, w: 200, h: 20), actions: ["AXPress"])])] }))
        #expect(built.text.hasSuffix(" · changes since your last read\n+ at top:\n  [25] menu\n    [26] menu item \"Copy\""))
    }

    @Test func aRemovedSubtreeIsItsRootWithACount() {
        let reader = Reader()
        reader.read(sample())
        let built = reader.read(sample(dropFormatting: true))
        #expect(built.text == sampleHeader + " · changes since your last read\n- [4] group \"Formatting\" (and 16 inside)")
    }

    @Test func aRemovedRunOfRangeMembersIsOneRangeLine() {
        let t = Tree()
        let buttons = (0..<8).map { _ in t.node("AXButton", frame: r(0), actions: ["AXPress"]) }
        let reader = Reader()
        let full = reader.read(snapshot([t.window(id: 900_000, buttons + filler())]))
        #expect(full.text.contains("\n  [2]–[9] 8 × button\n"))
        let built = reader.read(snapshot([t.window(id: 900_000, Array(buttons.prefix(2)) + Array(buttons.suffix(3)) + filler())]))
        #expect(built.text.hasSuffix("\n- [4]–[6] 3 × button"))
    }

    @Test func geometryAloneIsNoChange() {
        let reader = Reader()
        reader.read(sample(), geometry: true)
        #expect(reader.read(sample(frameShift: 30), geometry: true).kind == .unchanged)
    }

    @Test func aDiffPastItsShareOrItsBytesIsAFullRead() {
        let reader = Reader()
        reader.read(sample())
        #expect(reader.read(sample(dropFormatting: true, frameShift: 0), mode: .auto).kind == .diff)
        // most of the window changed: the diff would pass 60% of the full text
        let big = Reader()
        let t = Tree()
        let fields = (0..<10).map { _ in t.id() }
        func form(_ v: String) -> AXSnapshot { snapshot([t.window(id: 900_000, fields.map { t.node("AXTextField", id: $0, title: "F", value: .string(v), frame: r(0), settable: ["AXValue"]) })]) }
        big.read(form("a"))
        #expect(big.read(form("b")).fullReason == .tooLarge)
        // and past 12,000 bytes whatever its share
        let huge = Reader()
        let u = Tree()
        let ids = (0..<400).map { _ in u.id() }
        func many(_ v: String, keep: Int) -> AXSnapshot {
            snapshot([u.window(id: 900_000, ids.enumerated().map { i, id in u.node("AXStaticText", id: id, value: .string(i < keep ? "\(v) row \(i) with some words" : "steady row \(i) with some words"), frame: r(0)) })])
        }
        huge.read(many("old", keep: 300), budget: 96_000)
        #expect(huge.read(many("new", keep: 300), budget: 96_000).fullReason == .tooLarge)
    }

    @Test func anotherWindowIsAFullRead() {
        let reader = Reader()
        reader.read(sample())
        var other = sample()
        other.window = WindowInfo(id: 8, title: "Other", frame: windowFrame, main: true, focused: true, minimized: false, onScreen: true, space: .current)
        #expect(reader.read(other).fullReason == .windowChanged)
    }

    @Test func aContainerWhoseSummaryCountsMovedCarriesItsNewSummary() {
        let t = Tree()
        let list = t.id()
        let rows = (0..<6).map { _ in t.id() }
        func read(_ visible: Range<Int>, _ hidden: Hidden) -> AXSnapshot {
            snapshot([t.window(id: 900_000, [t.node("AXList", id: list, title: "Past orders", frame: windowFrame, hidden: hidden,
                                                visible.map { i in t.node("AXStaticText", id: rows[i], value: .string("Order \(i)"), frame: r(0)) })] + filler())])
        }
        let reader = Reader()
        reader.read(read(0..<6, Hidden(above: 0, below: 57)))
        let built = reader.read(read(2..<6, Hidden(above: 2, below: 50)))
        #expect(built.text.hasSuffix("\n- [3] text = \"Order 0\"\n- [4] text = \"Order 1\"\n~ [2] list \"Past orders\"\n  … 50 more below, 2 above"))
    }

    @Test func aBaseFromATruncatedReadNamesOnlyWhatWasShown() {
        let t = Tree()
        let ids = (0..<300).map { _ in t.id() }
        let focus = t.id()
        func doc(_ hiddenValue: String, _ shownValue: String) -> AXSnapshot {
            var kids = ids.enumerated().map { i, id in t.node("AXStaticText", id: id, value: .string(i == 299 ? hiddenValue : "Paragraph \(i) of a long scratch page"), frame: r(0)) }
            kids.insert(t.node("AXTextField", id: focus, title: "Search", value: .string(shownValue), frame: r(0), settable: ["AXValue"], range: [0, 0]), at: 0)
            return snapshot([t.window(id: 900_000, kids)], focused: focus)
        }
        let reader = Reader()
        let full = reader.read(doc("tail", "a"), budget: 4_000)
        #expect(full.stats.omitted > 0 && full.text.contains("(truncated: "))
        #expect(reader.read(doc("tail changed", "a"), budget: 4_000).kind == .unchanged)
        let edit = reader.read(doc("tail changed", "ab"), budget: 4_000)
        #expect(edit.text.hasSuffix("\n~ [2] input \"Search\" = \"ab\" focused caret 0"))
    }

    @Test func unchangedReadsKeepTheFirstFullAsThePictureForTheNextDiff() {
        let reader = Reader()
        reader.read(sample())
        #expect(reader.read(sample()).kind == .unchanged)
        #expect(reader.read(sample()).kind == .unchanged)
        let built = reader.read(sample(value: "edited"))
        #expect(built.text.split(separator: "\n").count == 2)
        #expect(built.text.hasSuffix("\n~ [3] text area = \"edited\" focused caret 0 actions: show menu"))
    }

    @Test func aPrefixReadValueComparesByPrefixLengthAndSelection() {
        let t = Tree()
        let area = t.id()
        let prefix = String(repeating: "a", count: 2_000)
        func doc(length: Int, caret: Int) -> AXSnapshot {
            snapshot([t.window(id: 900_000, [t.node("AXTextArea", id: area, value: .string(prefix), valueLength: length, frame: r(0), settable: ["AXValue"], range: [caret, 0])] + filler())], focused: area)
        }
        let reader = Reader()
        let first = reader.read(doc(length: 50_000, caret: 10))
        #expect(first.text.contains("…(+49840 chars)"))
        #expect(reader.read(doc(length: 50_000, caret: 10)).kind == .unchanged)
        #expect(reader.read(doc(length: 50_001, caret: 10)).kind == .diff)
    }

    @Test func aLineTheBudgetCutDifferentlyIsAChange() {
        let t = Tree()
        let field = t.id()
        let name = "A field with a long name " + String(repeating: "x", count: 80)
        let s = snapshot([t.window(id: 900_000, [t.node("AXTextField", id: field, title: name, value: .string("v"), frame: r(0), settable: ["AXValue"], range: [0, 0])]
            + (0..<200).map { i in Tree(start: 50_000 + NodeID(i)).node("AXStaticText", value: .string("Paragraph \(i) of a long scratch page"), frame: r(0)) })], focused: field)
        let reader = Reader()
        let cut = reader.read(s, budget: 2_000)
        #expect(!cut.text.contains(name))
        let whole = reader.read(s, budget: 96_000)
        #expect(whole.kind != .unchanged)
    }

    @Test func aFooterOrTheLastOtherWindowGoingAwayIsAFullRead() {
        let t = Tree()
        let ids = (0..<200).map { _ in t.id() }
        func doc(_ n: Int) -> AXSnapshot {
            snapshot([t.window(id: 900_000, ids.prefix(n).map { t.node("AXStaticText", id: $0, value: .string("Paragraph \($0) of a long scratch page"), frame: r(0)) })])
        }
        let reader = Reader()
        #expect(reader.read(doc(200), budget: 4_000).text.contains("(truncated: "))
        #expect(reader.read(doc(20), budget: 4_000).fullReason == .unsaid)
        let others = Reader()
        others.read(sample())
        var alone = sample()
        alone.otherWindows = []
        #expect(others.read(alone).fullReason == .unsaid)
    }

    @Test func noBaseIsAFullRead() {
        let reader = Reader()
        reader.read(sample())
        reader.base = nil
        let built = reader.read(sample())
        #expect(built.kind == .full && built.fullReason == .first)
    }
}
