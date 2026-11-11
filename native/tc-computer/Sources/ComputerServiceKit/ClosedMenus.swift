import ComputerProtocol
import Foundation

/// The menus a call closed after its closing read, with each item by the index that read gave it
/// (docs/computer-protocol.md §26.11, decision 20). A later step naming one of those indices finds its
/// item gone with the menu; `reach(index:)` says how to get to it again, through `MenuLedger.reach`:
/// a menu-bar item is pressed as it is, a pop-up's, menu button's or context menu's by opening its
/// opener again and pressing the item by title. Each closing read replaces the book, since its indices
/// are the ones the model reads now.
public struct ClosedMenus: Sendable {
    public private(set) var ledger = MenuLedger()
    private var byIndex: [Int: (menu: String, title: String)] = [:]

    public init() {}

    /// A menu the closing read showed, with its items by index.
    public mutating func saw(_ menu: OpenedMenu, itemIndices: [Int: String]) {
        ledger.saw(menu)
        for (index, title) in itemIndices { byIndex[index] = (menu.id, title) }
    }

    public mutating func nextClose(_ id: String, frontAllowed: Bool) -> MenuClose? {
        ledger.nextClose(id, frontAllowed: frontAllowed)
    }

    public mutating func checked(_ id: String, gone: Bool) {
        ledger.checked(id, gone: gone)
    }

    public var leftOpen: [String]? { ledger.leftOpen }

    /// The way to an item a step names by index: nil when the index is no item of a menu this call closed.
    public func reach(index: Int) -> MenuReach? {
        guard let (menu, title) = byIndex[index], ledger.closed.contains(menu) else { return nil }
        return ledger.reach(item: title)
    }
}
