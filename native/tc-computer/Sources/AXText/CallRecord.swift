/// §27.4: one call's bounded record of the menus that opened (AXMenuOpened) and the windows and sheets created
/// (AXWindowCreated; AXCreated for a sheet), each with the step during which it came. A step records from before its
/// input, since an `ax` route stamps its input only after the AX call returns. The change monitor keeps one per app
/// (`Element` its AXUIElement); the menus it holds are §26's to close.
public struct CallRecord<Element> {
    public enum Kind: Sendable, Equatable { case menu, window, sheet }

    public struct Entry {
        public var kind: Kind
        public var element: Element
        public var step: Int
    }

    public static var max: Int { 32 }

    public private(set) var entries: [Entry] = []
    /// the steps during which something opened, kept when the menu closes again
    public private(set) var openedSteps: Set<Int> = []
    /// the step recording now; nil outside a call
    public private(set) var step: Int?

    public init() {}

    /// A call begins: the last call's record goes.
    public mutating func begin() {
        entries = []
        openedSteps = []
        step = nil
    }

    /// Step `index` is about to send its input.
    public mutating func record(step index: Int) { step = index }

    /// The call ended: nothing more is recorded until the next begins.
    public mutating func end() { step = nil }

    /// A notification while a step records; the same element twice, or past `max` entries, is not kept.
    @discardableResult
    public mutating func note(_ kind: Kind, _ element: Element, same: (Element, Element) -> Bool) -> Bool {
        guard let step else { return false }
        openedSteps.insert(step)
        guard entries.count < Self.max, !entries.contains(where: { same($0.element, element) }) else { return false }
        entries.append(Entry(kind: kind, element: element, step: step))
        return true
    }

    /// AXMenuClosed: the menu is no longer open, though its element still answers (a pop up's menu after its
    /// pick, 2026-11-11), so it leaves the record and no closing read lists it.
    public mutating func closed(_ element: Element, same: (Element, Element) -> Bool) {
        entries.removeAll { $0.kind == .menu && same($0.element, element) }
    }

    /// Whether a menu opened, or a window or sheet was made, during step `index`: the step changed the app, even when
    /// the notification came before its AX call returned and so before its wait's clock (a pop up's AXPress).
    public func opened(during index: Int) -> Bool { openedSteps.contains(index) }
}
