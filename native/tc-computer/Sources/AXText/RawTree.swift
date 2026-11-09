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

    public static func snapshot(_ tree: RawAXTree, ids: NodeIDSource, windowID: Int = 1) -> AXSnapshot {
        var focused: NodeID?
        var nodes = 0
        let window = node(tree.root, clip: tree.root.frame ?? tree.window.frame, ids: ids, focused: &focused, nodes: &nodes)
        let extra = (tree.attached ?? []).map { node($0, clip: $0.frame, ids: ids, focused: &focused, nodes: &nodes) }
        let info = WindowInfo(id: windowID, title: tree.window.title, frame: tree.window.frame, main: true, focused: true, minimized: false, onScreen: true, space: .current)
        return AXSnapshot(
            app: AppFacts(pid: 0, bundleId: tree.app.bundleId, name: tree.app.name),
            window: info,
            roots: [window] + extra,
            focusedID: focused,
            ambientActions: ObservationTables.ambientActions,
            visited: nodes,
            partial: tree.walk.capped,
            walkMs: tree.walk.ms
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

    /// One recorded node and its subtree, cut to the viewport. `clip` nil: no clip.
    static func node(_ raw: RawAXNode, clip: Rect?, ids: NodeIDSource, focused: inout NodeID?, nodes: inout Int) -> AXNode {
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
                           invalid: raw.invalid, modal: raw.modal, busy: raw.busy, loaded: raw.loaded),
            frame: raw.frame, actions: raw.actions ?? [],
            // the recorder checks every node and leaves the list out when nothing is settable
            settable: Set(raw.settable ?? []),
            selectedTextRange: raw.selectedTextRange
        )
        let inner = Viewport.childClip(role: raw.role, frame: raw.frame, clip: clip)
        // tables and outlines list visible rows: their other children (columns, a header) are judged by frame
        let rowsOnly = raw.role == "AXTable" || raw.role == "AXOutline"
        var marked = Set(raw.children.indices.filter { raw.children[$0].visible != nil && (!rowsOnly || raw.children[$0].role == "AXRow") })
        let firstVisible = raw.children.indices.first { marked.contains($0) && raw.children[$0].visible == true }
        // a list naming no visible row is not believed (IntelliJ's is empty with its rows on screen): judge by frame
        if firstVisible == nil { marked = [] }
        var hidden = Hidden()
        let sliver = Viewport.clipRoles.contains(raw.role)
        var slivers: [Int] = []
        var firstShown: Int?
        for (i, child) in raw.children.enumerated() {
            // a child the list names as hidden is counted; any other is judged by its frame too
            // (Chrome lists every child of an overflow box as visible)
            if marked.contains(i), child.visible != true {
                if let first = firstVisible, i < first { hidden.above += 1 } else { hidden.below += 1 }
            } else if let side = Viewport.missed(child.frame, inner, sliver: sliver) {
                switch side {
                case .above: hidden.above += 1
                case .below: hidden.below += 1
                case .sliver: slivers.append(i)
                }
            } else {
                firstShown = firstShown ?? i
                n.children.append(node(child, clip: inner, ids: ids, focused: &focused, nodes: &nodes))
            }
        }
        hidden = hidden + Viewport.slivers(slivers, firstShown: firstShown)
        if !hidden.isEmpty { n.hidden = hidden }
        return n
    }
}
