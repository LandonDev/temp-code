@testable import AXText
import ComputerProtocol
import Foundation
import Testing

/// §27.4: a menu a step opens closes the call's observation, whatever the diff or the budget cut.
@Suite struct MenuBlockTests {
    static let state = "chrome/menu-open"

    func recorded() throws -> (AXSnapshot, AXNode, CoordinateSpace) {
        let s = try Goldens.snapshot(Self.state, ids: NodeIDSource())
        let menu = try #require(first(s.roots[0]) { $0.role == "AXMenu" && $0.children.contains { ($0.title ?? $0.description) == "Large" } })
        return (s, menu, try Goldens.space(Self.state))
    }

    func blockLines(_ text: String) -> [String] {
        let rows = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard let at = rows.firstIndex(where: { $0.hasPrefix(MenuBlock.prefix) }) else { return [] }
        return Array(rows[at...])
    }

    /// The recorded Size menu: its items one level under the head, under the numbers the body gave them.
    @Test func theRecordedMenuClosesAFullRead() throws {
        let (s, menu, space) = try recorded()
        let built = Reader().read(s, space: space, opened: [OpenedMenu(step: 1, menu: menu, title: "Size")])
        let body = built.text.split(separator: "\n").map(String.init)
        let menuLine = try #require(body.first { $0.hasSuffix("] menu actions: cancel") && body.firstIndex(of: $0)! > 30 })
        let menuIndex = menuLine.drop { $0 == " " }.dropFirst().prefix { $0.isNumber }
        let block = blockLines(built.text)
        #expect(block.first == "+ menu opened by step 1: [\(menuIndex)] menu \"Size\"")
        #expect(block.dropFirst().map { $0.replacingOccurrences(of: #"\[\d+\]"#, with: "[]", options: .regularExpression) } == [
            "  [] menu item \"Small\" actions: cancel, pick",
            "  [] menu item \"Medium\" selected actions: cancel, pick",
            "  [] menu item \"Large\" actions: cancel, pick"
        ])
        for line in block.dropFirst() { #expect(body.contains { $0.hasSuffix(line.drop { $0 == " " }) }, "\(line) repeats the body's line") }
    }

    /// No change in the window: the header alone, then the block.
    @Test func itFollowsAnUnchangedHeaderAndADiff() throws {
        let (s, menu, space) = try recorded()
        let reader = Reader()
        reader.read(s, space: space)
        let again = reader.read(s, space: space, opened: [OpenedMenu(step: 2, menu: menu)])
        #expect(again.kind == .unchanged)
        let rows = again.text.split(separator: "\n").map(String.init)
        #expect(rows[0].hasSuffix(" · no changes"))
        #expect(rows[1].hasPrefix("+ menu opened by step 2: ["))
        #expect(rows.count == 5)
    }

    @Test func aMenuWhoseItemsDidNotAnswerIsOneLine() {
        let t = Tree()
        let built = Reader().read(snapshot([t.window([t.node("AXButton", title: "Go", actions: ["AXPress"])])]), opened: [OpenedMenu(step: 3, menu: nil, title: "File")])
        #expect(blockLines(built.text) == ["+ menu opened by step 3; its items did not answer: pick one with named, or close it with key Escape"])
    }

    @Test func atMostEightyItemsThenHowManyMore() {
        let t = Tree()
        let menu = t.node("AXMenu", nil, (1...95).map { t.node("AXMenuItem", title: "Item \($0)", frame: Rect(x: 0, y: 0, w: 100, h: 20), actions: ["AXPress"]) })
        let block = blockLines(Reader().read(snapshot([t.window([])]), opened: [OpenedMenu(step: 1, menu: menu, title: "Long")]).text)
        #expect(block.count == 1 + 80 + 1)
        #expect(block.last == "  … 15 more")
        #expect(block[1].hasSuffix("] menu item \"Item 1\""))
    }

    @Test func separatorsAreNoItemsAndADisabledItemSaysSo() {
        let t = Tree()
        let menu = t.node("AXMenu", nil, [
            t.node("AXMenuItem", title: "Undo", actions: ["AXPress"]),
            t.node("AXMenuItem", flags: AXFlags(enabled: false)),
            t.node("AXMenuItem", title: "Redo", flags: AXFlags(enabled: false), actions: ["AXPress"])
        ])
        let block = blockLines(Reader().read(snapshot([t.window([])]), opened: [OpenedMenu(step: 1, menu: menu, title: "Edit")]).text)
        #expect(block.dropFirst().map { $0.replacingOccurrences(of: #"\[\d+\]"#, with: "[]", options: .regularExpression) } == ["  [] menu item \"Undo\"", "  [] menu item \"Redo\" disabled"])
    }

    /// The block is cut last, at 6,000 bytes (or half a smaller budget), items leaving from its end.
    @Test func theBlockIsCutLastAndWithinItsBytes() {
        let items = (1...80).map { (index: $0 + 100, body: "menu item " + Quote.json(String(repeating: "x", count: 90) + "\($0)")) }
        let lines = MenuBlock.lines([MenuBlock.Block(step: 1, menu: (index: 100, title: "Big"), items: items)])
        #expect(MenuBlock.bytes(lines) <= MenuBlock.maxBytes)
        #expect(lines.last?.hasPrefix("  … ") == true)
        let t = Tree()
        let menu = t.node("AXMenu", nil, (1...80).map { t.node("AXMenuItem", title: String(repeating: "y", count: 90) + "\($0)", actions: ["AXPress"]) })
        let doc = t.window((1...200).map { t.node("AXButton", title: "Button \($0)", actions: ["AXPress"]) })
        let built = Reader().read(snapshot([doc]), budget: 4_000, opened: [OpenedMenu(step: 1, menu: menu, title: "Big")])
        #expect(built.text.utf8.count <= 4_000)
        #expect(built.stats.omitted > 0)
        #expect(MenuBlock.bytes(blockLines(built.text)) <= 2_000)
        #expect(blockLines(built.text).count > 2)
    }

    @Test func aMenuNoReadListedGetsNumbersTheNextReadKeeps() {
        let t = Tree()
        let menu = t.node("AXMenu", nil, [t.node("AXMenuItem", title: "Team", actions: ["AXPress"])])
        let reader = Reader()
        let block = blockLines(reader.read(snapshot([t.window([])]), opened: [OpenedMenu(step: 1, menu: menu, title: "Plan")]).text)
        let team = Int(block[1].drop { $0 == " " }.dropFirst().prefix { $0.isNumber })!
        #expect(reader.book.index(of: menu.children[0].id) == team)
        #expect(reader.book.intern(menu.children[0].id) == team)
    }
}
