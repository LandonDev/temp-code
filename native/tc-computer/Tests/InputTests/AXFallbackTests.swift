#if canImport(AppKit)
import AppKit
import ComputerCore
import ComputerProtocol
import Foundation
import Testing
@testable import Input

// The live fallbacks' seams without a live app (docs/computer-protocol.md §24): the menu item's
// batched read mapped to its facts, the cache per pid, and the line a step's `input.on` prints.

@Suite struct AXMenuTests {
    private func read(_ title: String?, enabled: Bool = true, char: String? = nil, key: Int? = nil, glyph: Int? = nil, mods: Int? = nil, children: Int = 0) -> [Any?] {
        [title, NSNumber(value: enabled), char, key.map(NSNumber.init(value:)), glyph.map(NSNumber.init(value:)), mods.map(NSNumber.init(value:)), Array(repeating: NSObject(), count: children)]
    }

    @Test func anItemWithACharacterCarriesItsShortcut() {
        let f = LiveMenuSource.facts(read("Close", char: "W", mods: 0))
        #expect(f == MenuItemFacts(title: "Close", enabled: true, shortcut: MenuItemShortcut(cmdChar: "W", modifiers: 0)))
        #expect(f.shortcut?.matches(try! parseKeyCombo("super+w"), layout: USANSILayout()) == true)
    }

    @Test func aGlyphItemAndADisabledOne() {
        let trash = LiveMenuSource.facts(read("Move to Trash", enabled: false, char: "\u{8}", glyph: 0x17, mods: 0))
        #expect(!trash.enabled)
        #expect(trash.shortcut?.matches(try! parseKeyCombo("super+BackSpace"), layout: USANSILayout()) == true)
    }

    @Test func separatorsSubmenusAndItemsWithoutAKey() {
        #expect(LiveMenuSource.facts(read("", enabled: false)).isSeparator)
        let export = LiveMenuSource.facts(read("Export", children: 1))
        #expect(export.hasSubmenu && !export.isSeparator && export.shortcut == nil)
        #expect(LiveMenuSource.facts(read("About", char: "")).shortcut == nil)
        // an unreadable title is an untitled item, never a crash
        #expect(LiveMenuSource.facts(read(nil, children: 1)).title == "")
    }

    @Test func theCacheKeepsAnIndexPerPid() {
        let cache = MenuIndexCache()
        #expect(cache.take(7) == nil)
        cache.put(7, MenuIndex(entries: [], builtAt: 3))
        #expect(cache.take(7)?.builtAt == 3)
        #expect(cache.take(8) == nil)
        cache.put(7, nil)
        #expect(cache.take(7) == nil)
    }
}

@Suite struct AXHitTests {
    @Test func theLineIsTheRoleAndTheFirstName() {
        #expect(AXHit.line(role: "button", names: ["Save", "save the file", nil]) == "button \"Save\"")
        #expect(AXHit.line(role: "input", names: [nil, "  ", "Name"]) == "input \"Name\"")
        #expect(AXHit.line(role: "group", names: [nil, nil, nil]) == "group")
    }

    @Test func aNameIsQuotedAndCut() {
        #expect(AXHit.line(role: "link", names: ["Say \"hi\" \\ bye"]) == #"link "Say \"hi\" \\ bye""#)
        let long = String(repeating: "a", count: 200)
        #expect(AXHit.line(role: "text", names: [long]) == "text \"\(String(repeating: "a", count: 80))\"")
    }

    @Test func theTextRolesAreTheCaretRoutesWords() {
        // every AX role the caret takes prints as one of the caret's role words
        for role in AXHit.textRoles {
            #expect(caretRoles.contains(InputTables.roleTags[role] ?? ""), "\(role)")
        }
    }
}
#endif
