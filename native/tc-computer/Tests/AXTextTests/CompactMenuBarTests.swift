@testable import AXText
import ComputerProtocol
import Foundation
import Testing

/// §27.13: `menus: true` lists each top-level menu on one line, every item with its number.
@Suite struct CompactMenuBarTests {
    func read(_ reader: Reader = Reader(), bar: AXNode, t: Tree, budget: Int = 24_000) -> Built {
        reader.read(snapshot([t.window([t.node("AXTextArea", value: .string("Hello"), frame: Rect(x: 0, y: 40, w: 600, h: 400), actions: ["AXShowMenu"])])], menuBar: bar), budget: budget)
    }

    @Test func eachMenuIsOneLine() {
        let t = Tree()
        let text = read(bar: textEditMenuBar(t), t: t).text
        let unnumbered = text.replacingOccurrences(of: #"\[\d+\]"#, with: "[]", options: .regularExpression).split(separator: "\n").map(String.init)
        #expect(Array(unnumbered.suffix(6)) == [
            "[] menu bar",
            "  [] menu \"Apple\": About This Mac [], System Settings… []",
            "  [] menu \"TextEdit\": About TextEdit [], Settings… [], Quit TextEdit []",
            "  [] menu \"File\": New [], Open… [], Open Recent ▸ [], Close [], Save… [] disabled, Duplicate [], Rename… [], Move To… [], Export as PDF… [], Print… []",
            "  [] menu \"Edit\": Undo [], Redo [] disabled, Cut [], Copy [], Paste [], Find ▸ []",
            "  [] menu \"Format\": Font ▸ [], Make Plain Text [] disabled"
        ])
    }

    /// Every number on the line reaches its item: the book holds it, so `element` and a subtree read find it.
    @Test func everyItemCarriesItsNumber() throws {
        let t = Tree()
        let bar = textEditMenuBar(t)
        let reader = Reader()
        let text = read(reader, bar: bar, t: t).text
        let save = try #require(first(bar) { $0.title == "Save…" })
        let index = try #require(reader.book.index(of: save.id))
        #expect(text.contains("Save… [\(index)] disabled"))
        let recent = try #require(first(bar) { $0.title == "Open Recent" })
        let sub = reader.read(snapshot([recent]), subtree: reader.book.index(of: recent.id)!).text
        #expect(sub.contains("menu item \"Clear Menu\""))
    }

    /// A closed submenu's items have no frame on the Mac; read on their own they still list.
    @Test func aClosedSubmenuReadOnItsOwnListsItsItems() {
        let t = Tree()
        let zero = Rect(x: 0, y: 0, w: 0, h: 0)
        let find = t.node("AXMenuItem", title: "Find", frame: zero, actions: ["AXPress"], [
            t.node("AXMenu", frame: zero, [t.node("AXMenuItem", title: "Find…", frame: zero, actions: ["AXPress"]), t.node("AXMenuItem", title: "Find Next", frame: zero, actions: ["AXPress"])])
        ])
        let reader = Reader()
        let bar = t.node("AXMenuBar", nil, [t.node("AXMenuBarItem", title: "Edit", actions: ["AXPress"], [t.node("AXMenu", nil, [find])])])
        read(reader, bar: bar, t: t)
        let sub = reader.read(snapshot([find]), subtree: reader.book.index(of: find.id)!).text
        #expect(sub.contains("menu item \"Find…\"") && sub.contains("menu item \"Find Next\""))
    }

    @Test func theSameBarReadsUnchangedAndAChangedOneReadsFull() {
        let t = Tree()
        let bar = textEditMenuBar(t)
        let reader = Reader()
        read(reader, bar: bar, t: t)
        #expect(read(reader, bar: bar, t: t).kind == .unchanged)
        var changed = bar
        changed.children[2].children[0].children[5].flags.enabled = true
        let after = read(reader, bar: changed, t: t)
        #expect(after.kind == .full && after.fullReason == .menuBar)
        #expect(after.text.contains("Save… ["))
        #expect(!after.text.contains("Save… [\(reader.book.index(of: changed.children[2].children[0].children[5].id)!)] disabled"))
    }

    @Test func underATightBudgetWholeMenusLeaveLast() {
        let t = Tree()
        let built = read(bar: textEditMenuBar(t), t: t, budget: 2_000)
        #expect(built.text.utf8.count <= 2_000)
        #expect(built.text.contains("menu \"Apple\":"))
    }
}
