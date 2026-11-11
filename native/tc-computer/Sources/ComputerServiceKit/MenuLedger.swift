import ComputerProtocol

// The menus a call opened and their closing (docs/computer-protocol.md §25.11, decision 20). The
// live side records what it saw open and tries each close; this keeps the book and the order.

/// What opened a menu.
public enum MenuOpener: Equatable, Sendable {
    /// a menu bar item left AXSelected
    case menuBar
    /// a pop up button or menu button whose menu shows
    case popUp
    /// a context menu (AXShowMenu, a right click)
    case context
}

/// One menu a call opened, by the element that opened it.
public struct OpenedMenu: Equatable, Sendable {
    /// the live side's key for the opener (its handle in the element book)
    public var id: String
    /// the opener's title (`Action`, `File`); the line names the menu by it
    public var title: String
    public var opener: MenuOpener
    /// its items' titles, read with the menu open, for a later step that names one
    public var items: [String]

    public init(id: String, title: String, opener: MenuOpener, items: [String] = []) {
        self.id = id
        self.title = title
        self.opener = opener
        self.items = items
    }
}

/// One way to close a menu, in the order they are tried.
public enum MenuClose: Equatable, Sendable {
    /// AXCancel on the AXMenu: it closed the menu AXPress opened (E2')
    case cancel
    /// AXPress on the opener again
    case pressOpener
    /// Escape posted to the pid inside a brief `front` hold (only where `front` is allowed)
    case escapeAtFront
}

/// How a later step reaches an item of a menu the call closed.
public enum MenuReach: Equatable, Sendable {
    /// a menu bar item takes AXPress closed (§24.2): press it as it is
    case pressAsIs
    /// open it again through its opener, press the item by title; the step says `via: menu`, `on:`
    case reopen(openerId: String, item: String, on: String)
}

public struct MenuLedger: Equatable, Sendable {
    public private(set) var opened: [OpenedMenu] = []
    /// ids closed and checked gone
    public private(set) var closed: Set<String> = []
    /// ids every close failed on
    public private(set) var failed: Set<String> = []
    private var tried: [String: Int] = [:]

    public init() {}

    /// The first sight of a menu: an AXMenuOpened from the app during a step, a selected menu bar
    /// item, a pop up whose menu shows. A menu seen again is the same menu.
    public mutating func saw(_ m: OpenedMenu) {
        if let i = opened.firstIndex(where: { $0.id == m.id }) {
            if !m.items.isEmpty { opened[i].items = m.items }
            closed.remove(m.id)
            failed.remove(m.id)
            tried[m.id] = nil
            return
        }
        opened.append(m)
    }

    /// The menus still open, in the order they opened; the read before the close keeps their
    /// lines with the closed-menu note under them.
    public var open: [OpenedMenu] { opened.filter { !closed.contains($0.id) && !failed.contains($0.id) } }

    /// The close order (decision 20): AXCancel, the opener pressed again, Escape at `front`.
    public static func closeOrder(frontAllowed: Bool) -> [MenuClose] {
        frontAllowed ? [.cancel, .pressOpener, .escapeAtFront] : [.cancel, .pressOpener]
    }

    /// The next close to try on a menu, nil once every way failed (the menu is then left open).
    public mutating func nextClose(_ id: String, frontAllowed: Bool) -> MenuClose? {
        guard opened.contains(where: { $0.id == id }), !closed.contains(id), !failed.contains(id) else { return nil }
        let order = Self.closeOrder(frontAllowed: frontAllowed)
        let n = tried[id, default: 0]
        guard n < order.count else {
            failed.insert(id)
            return nil
        }
        tried[id] = n + 1
        return order[n]
    }

    /// The check after a close: the AXMenu child is gone.
    public mutating func checked(_ id: String, gone: Bool) {
        if gone { closed.insert(id) }
    }

    /// `menusLeftOpen`: the titles of the menus no close removed, at most 8, each at most 100 units.
    public var leftOpen: [String]? {
        let titles = opened.filter { failed.contains($0.id) }.map { cut($0.title) }
        return titles.isEmpty ? nil : Array(titles.prefix(8))
    }

    /// How a later step reaches an item titled `item`: through the menu the call closed that holds it.
    public func reach(item: String) -> MenuReach? {
        guard let m = opened.last(where: { closed.contains($0.id) && $0.items.contains(item) }) else { return nil }
        if m.opener == .menuBar { return .pressAsIs }
        return .reopen(openerId: m.id, item: item, on: "\(m.title) › \(item)")
    }

    private func cut(_ s: String) -> String {
        guard s.utf16.count > 100 else { return s }
        var out = "", units = 0
        for c in s {
            units += String(c).utf16.count
            if units > 99 { break }
            out.append(c)
        }
        return out + "…"
    }
}
