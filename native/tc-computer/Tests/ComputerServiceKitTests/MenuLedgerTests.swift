import ComputerProtocol
@testable import ComputerServiceKit
import Testing

// The menus a call opened and their closing (§25.11).

private let action = OpenedMenu(id: "e12", title: "Action", opener: .popUp, items: ["New Folder", "Get Info"])
private let file = OpenedMenu(id: "bar2", title: "File", opener: .menuBar, items: ["Save", "Close"])

@Suite struct MenuLedgerTests {
    @Test func theCloseOrder() {
        #expect(MenuLedger.closeOrder(frontAllowed: true) == [.cancel, .pressOpener, .escapeAtFront])
        #expect(MenuLedger.closeOrder(frontAllowed: false) == [.cancel, .pressOpener])
    }

    @Test func aMenuClosedByItsFirstWay() {
        var l = MenuLedger()
        l.saw(action)
        #expect(l.open == [action])
        #expect(l.nextClose("e12", frontAllowed: true) == .cancel)
        l.checked("e12", gone: true)
        #expect(l.open.isEmpty)
        #expect(l.nextClose("e12", frontAllowed: true) == nil)
        #expect(l.leftOpen == nil)
    }

    @Test func everyWayInTurnThenLeftOpen() {
        var l = MenuLedger()
        l.saw(action)
        l.saw(file)
        for way in [MenuClose.cancel, .pressOpener, .escapeAtFront] {
            #expect(l.nextClose("e12", frontAllowed: true) == way)
            l.checked("e12", gone: false)
        }
        #expect(l.nextClose("e12", frontAllowed: true) == nil)
        // the File menu closes by its second way
        #expect(l.nextClose("bar2", frontAllowed: false) == .cancel)
        l.checked("bar2", gone: false)
        #expect(l.nextClose("bar2", frontAllowed: false) == .pressOpener)
        l.checked("bar2", gone: true)
        #expect(l.leftOpen == ["Action"])
        #expect(l.open.isEmpty)
    }

    @Test func withoutFrontEscapeIsNeverTried() {
        var l = MenuLedger()
        l.saw(action)
        _ = l.nextClose("e12", frontAllowed: false)
        _ = l.nextClose("e12", frontAllowed: false)
        #expect(l.nextClose("e12", frontAllowed: false) == nil)
        #expect(l.leftOpen == ["Action"])
    }

    @Test func aMenuSeenAgainIsOneMenuAndOpenAgain() {
        var l = MenuLedger()
        l.saw(OpenedMenu(id: "e12", title: "Action", opener: .popUp))
        _ = l.nextClose("e12", frontAllowed: true)
        l.checked("e12", gone: true)
        l.saw(action)
        #expect(l.opened.count == 1)
        #expect(l.open == [action])
        // its close order starts over
        #expect(l.nextClose("e12", frontAllowed: true) == .cancel)
        // an unknown id has nothing to close
        #expect(l.nextClose("nope", frontAllowed: true) == nil)
    }

    @Test func leftOpenIsCappedForTheWire() {
        var l = MenuLedger()
        for i in 0 ..< 10 {
            let id = "m\(i)"
            l.saw(OpenedMenu(id: id, title: i == 0 ? String(repeating: "x", count: 150) : "Menu \(i)", opener: .context))
            while l.nextClose(id, frontAllowed: false) != nil { l.checked(id, gone: false) }
        }
        let left = l.leftOpen ?? []
        #expect(left.count == 8)
        #expect(left[0].utf16.count == 100 && left[0].hasSuffix("…"))
    }

    @Test func aClosedMenusItemIsReachedThroughItsOpener() {
        var l = MenuLedger()
        l.saw(action)
        l.saw(file)
        for id in ["e12", "bar2"] {
            _ = l.nextClose(id, frontAllowed: true)
            l.checked(id, gone: true)
        }
        #expect(l.reach(item: "New Folder") == .reopen(openerId: "e12", item: "New Folder", on: "Action › New Folder"))
        // a menu bar item takes AXPress closed
        #expect(l.reach(item: "Save") == .pressAsIs)
        #expect(l.reach(item: "Paste") == nil)
    }
}
