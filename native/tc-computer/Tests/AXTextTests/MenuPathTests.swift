@testable import AXText
import ComputerProtocol
import Foundation
import Testing

/// §27.10: a menu-bar item by its path, over TextEdit's menu bar.
@Suite struct MenuPathTests {
    @Test func bothSeparatorsSplitAPath() {
        #expect(MenuPath.parse("File > Save…") == ["File", "Save…"])
        #expect(MenuPath.parse("Edit › Find › Find…") == ["Edit", "Find", "Find…"])
        #expect(MenuPath.parse(" Format > Font › Bold ") == ["Format", "Font", "Bold"])
        #expect(MenuPath.parse("File>Save") == ["File>Save"])
        #expect(MenuPath.parse(" > ") == [])
    }

    @Test func anItemIsFoundWithoutOpeningAnything() throws {
        let bar = textEditMenuBar(Tree())
        guard case .found(let print) = MenuPath.resolve("File > Print…", in: bar) else { Issue.record("Print… found"); return }
        #expect(print.titles == ["File", "Print…"] && print.enabled && !print.submenu)
        #expect(print.id == first(bar) { $0.title == "Print…" }?.id)
    }

    @Test func eachSegmentMatchesAsNamedDoes() {
        let bar = textEditMenuBar(Tree())
        guard case .found(let find) = MenuPath.resolve("edit > find > find...", in: bar) else { Issue.record("Find… found"); return }
        #expect(find.titles == ["Edit", "Find", "Find…"])
    }

    @Test func aDisabledItemIsFoundAndSaysSo() {
        guard case .found(let save) = MenuPath.resolve("File > Save…", in: textEditMenuBar(Tree())) else { Issue.record("Save… found"); return }
        #expect(!save.enabled)
    }

    @Test func aSubmenuItemIsFoundAndSaysItOpensOne() {
        guard case .found(let recent) = MenuPath.resolve("File > Open Recent", in: textEditMenuBar(Tree())) else { Issue.record("found"); return }
        #expect(recent.submenu)
    }

    @Test func aMissSaysWhereAndWhatWasThere() {
        let bar = textEditMenuBar(Tree())
        #expect(MenuPath.resolve("Fiel > Save…", in: bar) == .noMatch(segment: 0, titles: ["Apple", "TextEdit", "File", "Edit", "Format"]))
        guard case .noMatch(let segment, let titles) = MenuPath.resolve("File > Save As…", in: bar) else { Issue.record("no match"); return }
        #expect(segment == 1 && titles.contains("Save…") && titles.contains("Print…"))
        // a path past an item with no submenu matches nothing there
        #expect(MenuPath.resolve("File > New > Window", in: bar) == .noMatch(segment: 2, titles: []))
    }
}
