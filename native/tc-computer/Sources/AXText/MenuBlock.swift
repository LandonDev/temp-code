import ComputerProtocol
import Foundation

/// A menu a step of the call opened and that was still open after its wait (§27.4).
public struct StepMenu: Sendable {
    /// the step's number as the result's lines count steps, from 1 (the wire's index + 1)
    public var step: Int
    /// the menu as walked; nil when its items did not answer within the AX timeout
    public var menu: AXNode?
    /// the menu's title when it has none of its own: its opener's (`Plan`, `File`)
    public var title: String?

    public init(step: Int, menu: AXNode?, title: String? = nil) {
        self.step = step
        self.menu = menu
        self.title = title
    }
}

/// The opened-menu block (§27.4, observation.ts `MENU_BLOCK`): it closes the observation whatever the diff or the
/// viewport would cut, `+ menu opened by step <n>: [<i>] menu "<title>"` and each item one level under it as an
/// element line, at most 80, then `… <n> more`; cut last, after every other cut, at 6,000 bytes. A menu whose items
/// did not answer is one line.
public enum MenuBlock {
    public static let prefix = ObservationTables.menuBlockPrefix
    public static let silent = ObservationTables.menuBlockSilent
    public static let maxItems = ObservationTables.menuBlockMaxItems
    public static let maxBytes = ObservationTables.menuBlockMaxBytes
    public static let submenuMark = ObservationTables.submenuMark

    /// One block before its cut: the menu's number and title, and its items' numbers and lines.
    public struct Block: Sendable, Equatable {
        public var step: Int
        /// nil: the silent line
        public var menu: (index: Int, title: String)?
        public var items: [(index: Int, body: String)]

        public static func == (a: Block, b: Block) -> Bool {
            a.step == b.step && a.menu?.index == b.menu?.index && a.menu?.title == b.menu?.title
                && a.items.map(\.index) == b.items.map(\.index) && a.items.map(\.body) == b.items.map(\.body)
        }
    }

    /// The blocks of the opened menus, numbered by `number` (the book's index of a node, interned when new). An item
    /// is a direct element child of the menu that has a name or a value; a separator has neither.
    public static func blocks(_ opened: [StepMenu], snapshot s: AXSnapshot, number: (NodeID) -> Int) -> [Block] {
        opened.map { o in
            guard let root = o.menu else { return Block(step: o.step, menu: nil, items: []) }
            var one = s
            one.roots = [root]
            one.menuBar = nil
            let kept = Keep.tree(one).roots.first
            let title = kept?.facts.rawName ?? o.title ?? ""
            let items = (kept?.children ?? []).compactMap { c -> (index: Int, body: String)? in
                guard c.kind == .element, c.facts.line.name != nil || c.facts.line.value != nil else { return nil }
                return (number(c.id), Facts.body(c.facts.line))
            }
            return Block(step: o.step, menu: (number(root.id), title), items: items)
        }
    }

    /// The blocks' lines within `maxBytes` (the newline before each line counted): items leave from the last block's
    /// end first, each block's `… n more` growing; the heads stay.
    public static func lines(_ blocks: [Block], maxBytes: Int = MenuBlock.maxBytes) -> [String] {
        var shown = blocks.map { min($0.items.count, maxItems) }
        func render() -> [String] {
            var out: [String] = []
            for (b, block) in blocks.enumerated() {
                guard let menu = block.menu else {
                    out.append("\(prefix)\(block.step)\(silent)")
                    continue
                }
                out.append("\(prefix)\(block.step): [\(menu.index)] menu \(Quote.json(menu.title))")
                out += block.items.prefix(shown[b]).map { Layout.indent(1) + "[\($0.index)] \($0.body)" }
                let more = block.items.count - shown[b]
                if more > 0 { out.append(Layout.indent(1) + "… \(more) more") }
            }
            return out
        }
        var out = render()
        while bytes(out) > maxBytes, let b = shown.lastIndex(where: { $0 > 0 }) {
            shown[b] -= 1
            out = render()
        }
        return out
    }

    /// UTF-8 bytes of the lines, each with the newline before it.
    public static func bytes(_ lines: [String]) -> Int { lines.reduce(0) { $0 + 1 + $1.utf8.count } }
}
