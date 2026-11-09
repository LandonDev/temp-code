@testable import AXText
import ComputerProtocol
import Testing

@Suite struct BudgetTests {
    let t = Tree()

    func rows(_ n: Int, _ prefix: String, size: (Int) -> Int = { _ in 12 }) -> [AXNode] {
        (0..<n).map { i in t.node("AXRow", title: "\(prefix) \(i) " + String(repeating: "x", count: size(i)), frame: r(0), actions: ["AXPress"]) }
    }

    func list(_ name: String, _ rows: [AXNode]) -> AXNode { t.node("AXList", title: name, frame: windowFrame, rows) }

    func fits(_ built: Built, _ budget: Int) {
        #expect(built.text.utf8.count <= budget)
        #expect(built.stats.bytes == built.text.utf8.count)
    }

    @Test func theLargestListFoldsFirstAndTheRestStaysWhole() {
        let small = list("Small", rows(15, "s")), large = list("Large", rows(80, "l"))
        let built = Reader().read(snapshot([t.window([small, large])]), budget: 3_000)
        fits(built, 3_000)
        #expect(built.text.contains("[17] row \"s 14 xxxxxxxxxxxx\""))
        #expect(built.text.contains(" more below"))
        #expect(built.text.hasSuffix("observe with element: 18 to see one part whole)"))
        // the large list keeps its first rows, a fifth of the budget at most
        let kept = built.text.split(separator: "\n").filter { $0.contains("row \"l ") }
        #expect(kept.first?.contains("\"l 0 ") == true && kept.reduce(0) { $0 + $1.utf8.count + 1 } <= 600)
    }

    @Test func listsOfEqualSizeFoldInReadingOrder() {
        // A's numbers start with one digit fewer: a character more in its first eight rows makes the two lists the same size
        let a = list("A", rows(40, "a", size: { $0 < 8 ? 13 : 12 })), b = list("B", rows(40, "b"))
        let built = Reader().read(snapshot([t.window([a, b])]), budget: 2_400)
        fits(built, 2_400)
        let lines = built.text.split(separator: "\n").map(String.init)
        #expect(lines.filter { $0.contains("row \"a ") }.count < 40)
        #expect(lines.filter { $0.contains("row \"b ") }.count == 40)
    }

    @Test func theRunAroundAFocusedRowGrowsAfterThenBeforeAndStopsAtAnOversizedRow() {
        var items = rows(30, "r")
        items[16] = t.node("AXRow", title: "big", frame: r(0), actions: ["AXPress"], (0..<15).map { i in t.node("AXCell", title: "cell \(i) yyyyyyyyyy", frame: r(0)) })
        let focus = items[15].id
        let pad = (0..<40).map { i in t.node("AXStaticText", value: .string("Padding paragraph \(i) of the page"), frame: r(0)) }
        let built = Reader().read(snapshot([t.window([list("Rows", items)] + pad)], focused: focus), budget: 2_000)
        fits(built, 2_000)
        let shown = built.text.split(separator: "\n").compactMap { line -> Int? in
            guard let q = line.range(of: "row \"r ") else { return nil }
            return Int(line[q.upperBound...].prefix { $0.isNumber })
        }
        // the oversized row after the focus stops that side; the run grows before it
        #expect(shown.last == 15 && !built.text.contains("row \"big\""))
        #expect(shown.count > 3 && shown == Array((15 - shown.count + 1)...15))
        #expect(built.text.contains("focused [18]"))
    }

    @Test func elementsLeaveByClassInReverseReadingOrder() {
        let buttons = (0..<30).map { i in t.node("AXButton", title: "Button \(i)", frame: r(0), actions: ["AXPress"]) }
        let texts = (0..<30).map { i in t.node("AXStaticText", value: .string("Paragraph \(i) of the page"), frame: r(0)) }
        let images = (0..<30).map { i in t.node("AXImage", description: "Picture \(i)", frame: r(0)) }
        let built = Reader().read(snapshot([t.window(buttons + texts + images)]), budget: 2_000)
        fits(built, 2_000)
        let lines = built.text.split(separator: "\n").map(String.init)
        #expect(!lines.contains { $0.contains("image") })
        #expect(lines.contains { $0.contains("Button 29") })
        // texts leave from the end
        let kept = lines.compactMap { l in l.range(of: "Paragraph ").map { Int(l[$0.upperBound...].prefix { $0.isNumber })! } }
        #expect(kept == Array(0..<kept.count))
        #expect(built.stats.omitted == 90 - lines.filter { $0.contains("[") && !$0.contains("window") && !$0.hasPrefix("(") }.count)
    }

    @Test func theFocusedPathSurvivesAndShortensOnlyAtTheEnd() {
        var node = t.node("AXTextField", title: "Deep field", value: .string("v"), frame: r(0), settable: ["AXValue"], range: [1, 0])
        let focus = node.id
        let custom = "Name:" + String(repeating: "c", count: 3_000) + "\nTarget:0x0\nSelector:(null)"
        for i in 0..<50 {
            node = t.node("AXGroup", title: "Ancestor \(i) \u{1}\u{2}\"\\" + String(repeating: "\u{3}", count: 40), frame: r(0), actions: i == 0 ? [custom] : [], [node])
        }
        let others = (0..<20).map { OtherWindow(title: "Other window \($0) \u{4}\u{5}") }
        let reader = Reader()
        let s = snapshot([t.window(title: String(repeating: "\u{6}", count: 300), [node])], focused: focus, others: others)
        let built = reader.read(s, budget: 2_000)
        fits(built, 2_000)
        // every string is down to 8 scalars before an ancestor leaves, the focused line's own name too
        #expect(built.text.contains("input \"Deep fie…\" = \"v\" focused caret 1"))
        #expect(built.text.contains("\n  [13] group \"Ancestor…\"\n"))
        #expect(!built.text.contains("other windows") && !built.text.contains("actions:"))
        #expect(built.text.hasSuffix("observe with element: 1 to see one part whole)"))
        // two identical reads stay unchanged after ancestors left the text
        #expect(reader.read(s, budget: 2_000).kind == .unchanged)
    }

    @Test func aGroupLeftEmptyByALaterClassLeavesWithItsLastRow() {
        // named groups (other) hold only buttons (interactive): the groups were skipped while they had rows
        let groups = (0..<60).map { g in t.node("AXGroup", title: "Section \(g)", frame: r(0), (0..<6).map { i in t.node("AXButton", title: "Button \(g).\(i)", frame: r(0), actions: ["AXPress"]) }) }
        let built = Reader().read(snapshot([t.window(groups)]), budget: 2_000)
        fits(built, 2_000)
        let lines = built.text.split(separator: "\n")
        // no group survives without a row under it
        for (i, line) in lines.enumerated() where line.contains("] group \"Section") {
            #expect(i + 1 < lines.count && lines[i + 1].contains("] button"), "\(line)")
        }
    }

    @Test func theTextNeverPassesTheBudgetAndOmittedCountsWhatLeft() {
        for budget in [2_000, 3_500, 8_000] {
            let items = (0..<200).map { i in t.node("AXStaticText", value: .string("Line \(i) \"quoted\" \\ \u{7} tail"), frame: r(0)) }
            let built = Reader().read(snapshot([t.window(items)]), budget: budget)
            fits(built, budget)
            let shown = built.text.split(separator: "\n").filter { $0.contains("] text") }.count
            #expect(built.stats.omitted == 200 - shown)
            #expect(built.text.hasSuffix("(truncated: \(200 - shown) elements left out; observe with element: 1 to see one part whole)"))
        }
    }
}
