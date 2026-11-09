@testable import AXText
import ComputerProtocol
import Foundation
import Testing

@Suite struct FoldTests {
    let t = Tree()

    func buttons(_ n: Int, name: (Int) -> String? = { _ in nil }, flags: (Int) -> AXFlags = { _ in AXFlags() }) -> [AXNode] {
        (0..<n).map { i in t.node("AXButton", title: name(i), flags: flags(i), frame: r(0), actions: ["AXPress"]) }
    }

    @Test func sixBareSiblingsFoldAndFiveDoNot() {
        #expect(body(snapshot([t.window(buttons(6))])) == ["[1] window \"Untitled\"", "  [2]–[7] 6 × button"])
        #expect(body(snapshot([t.window(buttons(5))])).count == 6)
    }

    @Test func aNameOrAStateBreaksARun() {
        let named = body(snapshot([t.window(buttons(13, name: { $0 == 6 ? "Mid" : nil }))]))
        #expect(named == ["[1] window \"Untitled\"", "  [2]–[7] 6 × button", "  [8] button \"Mid\"", "  [9]–[14] 6 × button"])
        let stated = body(snapshot([t.window(buttons(8, flags: { AXFlags(enabled: $0 != 3) }))]))
        #expect(stated.contains("  [5] button disabled") && stated.contains("  [6]–[9] 4 × button") == false)
    }

    @Test func aNumberOutOfStepSplitsARunAndMembersKeepTheirNumbers() {
        let reader = Reader()
        let old = buttons(6)
        reader.read(snapshot([t.window(id: 900_000, old)]))
        let fresh = Tree(start: 5000).node("AXButton", frame: r(0), actions: ["AXPress"])
        let built = reader.read(snapshot([t.window(id: 900_000, Array(old.prefix(3)) + [fresh] + Array(old.suffix(3)))]), mode: .full)
        #expect(built.text.contains("  [2]\n") == false)
        #expect(body(snapshot([])).isEmpty)
        let lines = built.text.split(separator: "\n").dropFirst().map(String.init)
        #expect(lines == ["[1] window \"Untitled\"", "  [2] button", "  [3] button", "  [4] button", "  [8] button", "  [5] button", "  [6] button", "  [7] button"])
        for (i, node) in old.enumerated() { #expect(reader.book.index(of: node.id) == i + 2) }
    }
}

@Suite struct RenderTests {
    let t = Tree()

    @Test func everyHeaderFormInItsOrder() {
        let layout = Layout(rows: [], app: "Mail", title: "Inbox", others: [], space: CoordinateSpace(width: 800, height: 600, scale: 1), windowFrame: windowFrame, geometry: false)
        #expect(layout.header(HeaderFacts()) == "app \"Mail\" · window \"Inbox\" · 800×600")
        #expect(layout.header(HeaderFacts(focused: 4, loading: true, change: .diff, thin: true))
                == "app \"Mail\" · window \"Inbox\" · 800×600 · focused [4] · still loading · changes since your last read · thin tree, see the screenshot")
        #expect(layout.header(HeaderFacts(change: .unchanged)) == "app \"Mail\" · window \"Inbox\" · 800×600 · no changes")
    }

    @Test func theOtherWindowsLine() {
        let s = snapshot([t.window([])], others: [OtherWindow(title: "A"), OtherWindow(title: "B \"two\"", minimized: true), OtherWindow(title: "C", otherSpace: true)])
        #expect(text(s).split(separator: "\n")[1] == "other windows: \"A\", \"B \\\"two\\\"\" minimized, \"C\" other Space")
    }

    @Test func theIndentStopsAtTenLevels() {
        var node = t.node("AXButton", title: "Deep", frame: r(0), actions: ["AXPress"])
        for i in 0..<12 { node = t.node("AXGroup", title: "G\(i)", frame: r(0), [node]) }
        let lines = body(snapshot([t.window([node])]))
        #expect(lines.last == String(repeating: " ", count: 20) + "[14] button \"Deep\"")
        #expect(lines.allSatisfy { $0.prefix { $0 == " " }.count <= 20 })
    }

    @Test func namesAndValuesCutOnAGraphemeAndCountScalars() {
        let family = "👨‍👩‍👧"  // 5 scalars, one grapheme
        let name = String(repeating: "a", count: 97) + family
        #expect(Cut.name(name) == String(repeating: "a", count: 97) + "…")
        let emoji = String(repeating: "🙂", count: 1_200)
        let prefix = String(repeating: "🙂", count: 1_000)  // the 2,000 UTF-16 units AX gives
        let s = snapshot([t.window([t.node("AXTextArea", value: .string(prefix), valueLength: emoji.utf16.count, frame: r(0), settable: ["AXValue"])])])
        #expect(body(s)[1] == "  [2] text area = \"" + String(repeating: "🙂", count: 160) + "…(+1040 chars)\"")
    }

    @Test func aSubtreeShowsValuesWhole() {
        let long = String(repeating: "word ", count: 100)
        let area = t.node("AXTextArea", value: .string(long), frame: r(0), settable: ["AXValue"])
        let reader = Reader()
        reader.read(snapshot([t.window(id: 900_000, [area])]))
        let n = reader.book.index(of: area.id)!
        let sub = reader.read(snapshot([area]), subtree: n)
        #expect(sub.kind == .subtree)
        #expect(sub.text.hasSuffix("[\(n)] text area = \(Quote.json(long))"))
        #expect(reader.read(snapshot([t.window(id: 900_000, [area])])).kind == .unchanged)
    }

    @Test func geometryIsWindowRelativePixelsOnAnyDisplay() {
        let frame = Rect(x: -1500, y: -300, w: 640, h: 536)
        let s = snapshot([t.window(frame: frame, [t.node("AXButton", title: "Go", frame: Rect(x: -1489.6, y: -290, w: 100, h: 20.4), actions: ["AXPress"])])], frame: frame)
        #expect(Reader().read(s, geometry: true).text.split(separator: "\n").map(String.init)[1...] == ["[1] window \"Untitled\" @0,0 1280×1072", "  [2] button \"Go\" @21,20 200×41"])
    }

    @Test func quotingMatchesJSONStringifyByteForByte() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("QuoteVectors.json")
        let vectors = try JSONDecoder().decode([[String: String]].self, from: Data(contentsOf: url))
        #expect(vectors.count >= 10)
        for v in vectors { #expect(Quote.json(v["input"]!) == v["quoted"]!) }
    }
}
