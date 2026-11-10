/// What the menu walk reads of one item (docs/computer-protocol.md §24.2).
public struct MenuItemFacts: Equatable, Sendable {
    public var title: String
    public var enabled: Bool
    public var shortcut: MenuItemShortcut?
    public var isSeparator: Bool
    public var hasSubmenu: Bool

    public init(title: String, enabled: Bool = true, shortcut: MenuItemShortcut? = nil, isSeparator: Bool = false, hasSubmenu: Bool = false) {
        self.title = title
        self.enabled = enabled
        self.shortcut = shortcut
        self.isSeparator = isSeparator
        self.hasSubmenu = hasSubmenu
    }
}

/// An app's menu bar as the walk sees it; LiveMenuSource is AX, the tests a tree in memory.
public protocol MenuSource {
    associatedtype Node
    /// the bar's items, in order (the Apple menu first)
    func barItems() -> [Node]
    /// the items of a bar item's menu, or of an item's submenu
    func items(_ node: Node) -> [Node]
    func facts(_ node: Node) -> MenuItemFacts
}

/// A key equivalent found in the bar: its title path and the index path that finds it again.
public struct MenuMatch: Equatable, Sendable {
    /// `["File", "Close"]`
    public var path: [String]
    /// the bar item's index, then each item's within its menu
    public var indexPath: [Int]
    public var enabled: Bool

    public init(path: [String], indexPath: [Int], enabled: Bool) {
        self.path = path
        self.indexPath = indexPath
        self.enabled = enabled
    }

    /// `File › Close`, as a step's `input.on` and the words name it
    public var line: String { path.joined(separator: " › ") }
}

/// Every key equivalent of one app's bar, read once and kept per pid for `menuIndexMaxAgeS`.
public struct MenuIndex: Sendable {
    public struct Entry: Equatable, Sendable {
        public var path: [String]
        public var indexPath: [Int]
        public var shortcut: MenuItemShortcut
        public var enabled: Bool
    }

    public var entries: [Entry]
    /// monotonic seconds when it was read
    public var builtAt: Double
    /// the walk stopped at its item or time cap: an item past it is simply not found
    public var truncated: Bool

    public init(entries: [Entry], builtAt: Double, truncated: Bool = false) {
        self.entries = entries
        self.builtAt = builtAt
        self.truncated = truncated
    }

    public func fresh(at now: Double) -> Bool {
        now - builtAt < InputTiming.menuIndexMaxAgeS
    }

    /// The combo's item: the first enabled match, else the first disabled one.
    public func find(_ combo: KeyCombo, layout: KeyLayoutSource) -> MenuMatch? {
        let matches = entries.filter { $0.shortcut.matches(combo, layout: layout) }
        guard let pick = matches.first(where: \.enabled) ?? matches.first else { return nil }
        return MenuMatch(path: pick.path, indexPath: pick.indexPath, enabled: pick.enabled)
    }
}

/// The walk: the bar depth first, never the Apple menu (the bar's first item) nor a submenu of
/// the app menu (Services, the only one AppKit puts there, in whatever language), at most
/// `menuMaxItems` items in `menuMaxMs`.
public func buildMenuIndex<S: MenuSource>(_ source: S, now: () -> Double) -> MenuIndex {
    let start = now()
    let deadline = start + Double(InputTiming.menuMaxMs) / 1000
    var entries: [MenuIndex.Entry] = []
    var read = 0
    var truncated = false

    func walk(_ node: S.Node, path: [String], indexPath: [Int], inAppMenu: Bool) {
        for (i, item) in source.items(node).enumerated() {
            if truncated { return }
            if read >= InputTiming.menuMaxItems || now() >= deadline {
                truncated = true
                return
            }
            read += 1
            let f = source.facts(item)
            if f.isSeparator { continue }
            let p = path + [f.title]
            let ip = indexPath + [i]
            if f.hasSubmenu {
                if !inAppMenu { walk(item, path: p, indexPath: ip, inAppMenu: false) }
                continue
            }
            if let s = f.shortcut { entries.append(.init(path: p, indexPath: ip, shortcut: s, enabled: f.enabled)) }
        }
    }

    for (i, bar) in source.barItems().enumerated() where i > 0 {
        if truncated { break }
        walk(bar, path: [source.facts(bar).title], indexPath: [i], inAppMenu: i == 1)
    }
    return MenuIndex(entries: entries, builtAt: start, truncated: truncated)
}

/// The item at an index path now, read again: what the press acts on.
public func menuItem<S: MenuSource>(_ source: S, at indexPath: [Int]) -> S.Node? {
    guard let first = indexPath.first else { return nil }
    let bar = source.barItems()
    guard bar.indices.contains(first) else { return nil }
    var node = bar[first]
    for i in indexPath.dropFirst() {
        let items = source.items(node)
        guard items.indices.contains(i) else { return nil }
        node = items[i]
    }
    return node
}

/// The combo's item, through the pid's index while it is fresh. The item is read again where
/// the index found it; when it is gone or no longer carries the combo, the bar is read again
/// and searched once more. Returns the item to press with its match.
public func lookUpMenu<S: MenuSource>(_ combo: KeyCombo, source: S, layout: KeyLayoutSource, cache: inout MenuIndex?, now: () -> Double) -> (S.Node, MenuMatch)? {
    func confirm(_ index: MenuIndex) -> (S.Node, MenuMatch)? {
        guard let m = index.find(combo, layout: layout), let node = menuItem(source, at: m.indexPath) else { return nil }
        let f = source.facts(node)
        guard f.title == m.path.last, f.shortcut?.matches(combo, layout: layout) == true else { return nil }
        return (node, MenuMatch(path: m.path, indexPath: m.indexPath, enabled: f.enabled))
    }
    if let index = cache, index.fresh(at: now()) {
        // not in the bar as it was read: no walk again for each key the app has no item for
        guard index.find(combo, layout: layout) != nil else { return nil }
        if let hit = confirm(index) { return hit }
    }
    let rebuilt = buildMenuIndex(source, now: now)
    cache = rebuilt
    return confirm(rebuilt)
}
