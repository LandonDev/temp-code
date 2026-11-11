import ComputerProtocol
import Foundation

/// §27.10: a menu-bar item by its path, `File > Save…` or `Edit › Find › Find…`, found in the menu bar's tree
/// (AXMenuBar → AXMenuBarItem → AXMenu → AXMenuItem, a submenu an AXMenu under its item) without opening any menu;
/// each segment matched as §27.9 matches a name.
public enum MenuPath {
    public static let separators = [" > ", " › "]

    /// The path's titles, trimmed, empty segments dropped.
    public static func parse(_ path: String) -> [String] {
        var parts = [path]
        for sep in separators { parts = parts.flatMap { $0.components(separatedBy: sep) } }
        return parts.map(\.trimmed).filter { !$0.isEmpty }
    }

    public struct Found: Sendable, Equatable {
        public var id: NodeID
        /// the titles as the menus give them
        public var titles: [String]
        public var enabled: Bool
        /// the item opens a submenu: picking it picks nothing
        public var submenu: Bool
    }

    public enum Answer: Sendable, Equatable {
        case found(Found)
        /// segment `segment` (0-based) matched nothing; `titles` are that level's items
        case noMatch(segment: Int, titles: [String])
        case several(segment: Int, ids: [NodeID])
    }

    public static func resolve(_ path: String, in bar: AXNode) -> Answer {
        resolve(parse(path), in: bar)
    }

    public static func resolve(_ segments: [String], in bar: AXNode) -> Answer {
        guard !segments.isEmpty else { return .noMatch(segment: 0, titles: titles(bar.children)) }
        var level = bar.children
        var matched: [String] = []
        var node: AXNode?
        for (k, segment) in segments.enumerated() {
            let items = level.filter { title($0) != nil }
            let candidates = items.map { NamedTarget.Candidate(id: $0.id, name: title($0)!, actionable: $0.flags.enabled != false, madeAppear: false) }
            switch NamedTarget.match(segment, among: candidates) {
            case .none: return .noMatch(segment: k, titles: titles(items))
            case .several(let c): return .several(segment: k, ids: c.map(\.id))
            case .one(let c):
                let hit = items.first { $0.id == c.id }!
                matched.append(c.name)
                node = hit
                level = submenu(hit)?.children ?? []
            }
        }
        let hit = node!
        return .found(Found(id: hit.id, titles: matched, enabled: hit.flags.enabled != false, submenu: submenu(hit).map { !$0.children.isEmpty } ?? false))
    }

    /// A menu item's title: AXTitle, else its description.
    static func title(_ n: AXNode) -> String? {
        for s in [n.title, n.description] { if let t = s?.trimmed, !t.isEmpty { return t } }
        return nil
    }

    static func titles(_ items: [AXNode]) -> [String] { items.compactMap(title) }

    /// The AXMenu under a menu-bar item or a menu item.
    static func submenu(_ n: AXNode) -> AXNode? { n.children.first { $0.role == "AXMenu" } }
}
