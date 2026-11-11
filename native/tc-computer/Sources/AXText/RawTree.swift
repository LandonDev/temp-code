import ComputerProtocol
import Foundation

/// Node ids for recorded trees. A recorded `id` (A3) hashes to the same NodeID
/// in every state of an app; a node without one gets a fresh number, so
/// matching across states then goes through the rebuilt-element rule.
public final class NodeIDSource: @unchecked Sendable {
    private let lock = NSLock()
    private var next: NodeID = 1 << 62

    public init() {}

    public func fresh() -> NodeID {
        lock.lock()
        defer { lock.unlock() }
        next += 1
        return next
    }

    public func recorded(_ id: String) -> NodeID { StableHash.of(id) & ((1 << 62) - 1) }
}

/// A recorded fixture (`apps/<app>/<state>/tree.json`) as the snapshot the
/// walker would have made of that window, with the same viewport cut.
public enum RawTree {
    public static func decode(_ data: Data) throws -> RawAXTree {
        try JSONDecoder().decode(RawAXTree.self, from: data)
    }

    /// The document line's path is `~`-relative under `home` (the fixtures' `/Users/me`) and its
    /// written time is read in `timeZone`, UTC unless asked, so a golden reads the same on every host.
    public static func snapshot(_ tree: RawAXTree, ids: NodeIDSource, windowID: Int = 1, home: String = "/Users/me",
                                timeZone: TimeZone = TimeZone(identifier: "UTC")!) -> AXSnapshot {
        var focused: NodeID?
        var nodes = 0
        let window = node(tree.root, clip: tree.root.frame ?? tree.window.frame, ids: ids, focused: &focused, nodes: &nodes)
        let extra = (tree.attached ?? []).map { node($0, clip: $0.frame, ids: ids, focused: &focused, nodes: &nodes) }
        let info = WindowInfo(id: windowID, title: tree.window.title, frame: tree.window.frame, main: true, focused: true, minimized: tree.root.minimized ?? false, onScreen: true, space: .current)
        return AXSnapshot(
            app: AppFacts(pid: 0, bundleId: tree.app.bundleId, name: tree.app.name),
            window: info,
            roots: [window] + extra,
            focusedID: focused,
            ambientActions: ObservationTables.ambientActions,
            visited: nodes,
            partial: tree.walk.capped,
            walkMs: tree.walk.ms,
            document: tree.document.flatMap {
                DocumentLine.from(url: $0.url, mtime: $0.mtime, edited: $0.edited ?? false, home: home, timeZone: timeZone)
            }
        )
    }

    static func scalar(_ v: RawAXValue?) -> (AXScalar?, Int?) {
        guard let v else { return (nil, nil) }
        switch v.type {
        case .string:
            // the recorder cuts at 2,000 scalars with the grammar's marker
            if let cut = v.text.range(of: #"…\(\+(\d+) chars\)$"#, options: .regularExpression) {
                let prefix = String(v.text[..<cut.lowerBound])
                let n = Int(v.text[cut].dropFirst(3).prefix { $0.isNumber }) ?? 0
                return (.string(prefix), prefix.utf16.count + n)
            }
            return (.string(v.text), nil)
        case .number: return (.number(v.text), nil)
        case .bool: return (.bool(v.text == "true" || v.text == "1"), nil)
        default: return (.other, nil)
        }
    }

    /// What a recorded container's children say of its visible lists: tables and outlines list visible rows
    /// (their other children, columns and a header, are judged by frame), any other its visible children. A child
    /// the recorder marked neither way is judged by frame. The recorder marks the children of any container that
    /// answers AXVisibleChildren, where the walker asks lists alone (`Viewport.listRoles`); inside a web area,
    /// where the read-ahead applies, the page's own flow believes neither, so the two cut web content alike.
    static func lists(_ raw: RawAXNode) -> ViewportCut.Lists<Int>? {
        let shown = raw.children.indices.filter { raw.children[$0].visible == true }
        if raw.role == "AXTable" || raw.role == "AXOutline" {
            return ViewportCut.Lists(visibleRows: shown.filter { raw.children[$0].role == "AXRow" }, rows: raw.children.indices.filter { raw.children[$0].role == "AXRow" })
        }
        return ViewportCut.Lists(visibleChildren: shown)
    }

    static func marks(_ raw: RawAXNode, scope: Viewport.Scope) -> [Bool?] {
        var m = ViewportCut.marks(Array(raw.children.indices), lists: lists(raw), scope: scope)
        for i in m.indices where raw.children[i].visible == nil { m[i] = nil }
        return m
    }

    /// One recorded node and its subtree, cut to the viewport. `clip` nil: no clip. `scope`: where it sits (§25.5).
    static func node(_ raw: RawAXNode, clip: Rect?, scope: Viewport.Scope = .window, ids: NodeIDSource, focused: inout NodeID?, nodes: inout Int) -> AXNode {
        nodes += 1
        let id = raw.id.map(ids.recorded) ?? ids.fresh()
        // the deepest focused element: what AXFocusedUIElement would answer
        if raw.focused == true { focused = id }
        let (value, length) = scalar(raw.value)
        var n = AXNode(
            id: id, role: raw.role, subrole: raw.subrole, title: raw.title, description: raw.description,
            titleElementValue: raw.titleElementValue, placeholder: raw.placeholder, value: value, valueLength: length,
            identifier: raw.identifier, domIdentifier: raw.domIdentifier,
            flags: AXFlags(enabled: raw.enabled, focused: raw.focused, selected: raw.selected, expanded: raw.expanded, required: raw.required,
                           invalid: raw.invalid, modal: raw.modal, minimized: raw.minimized, busy: raw.busy, loaded: raw.loaded),
            frame: raw.frame, actions: raw.actions ?? [],
            // the recorder checks every node and leaves the list out when nothing is settable
            settable: Set(raw.settable ?? []),
            selectedTextRange: raw.selectedTextRange
        )
        let inner = Viewport.childClip(role: raw.role, frame: raw.frame, clip: clip, scope: scope)
        let below = scope.inside(raw.role)
        let sliver = Viewport.clipRoles.contains(raw.role)
        let (kept, hidden) = ViewportCut.children(raw.children, marks: marks(raw, scope: scope)) { _, child -> ViewportCut.Outcome<AXNode> in
            if let side = Viewport.cut(role: child.role, frame: child.frame, clip: inner, sliver: sliver) { return .hidden(side) }
            return .node(node(child, clip: inner, scope: below, ids: ids, focused: &focused, nodes: &nodes))
        }
        n.children = kept
        if !hidden.isEmpty { n.hidden = hidden }
        return n
    }
}
