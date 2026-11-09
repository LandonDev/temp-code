import ComputerProtocol
import Foundation

private typealias T = ObservationTables

/// What the diff compares of one element: name, value, states, caret or selection and actions. Geometry does not count.
public struct Compare: Sendable, Equatable {
    public var role: String
    public var name: String?
    public var valueHash: UInt64
    public var states: [String]
    public var caret: Int?
    public var selection: [Int]?
    public var actions: [String]

    public init(_ f: ElementFacts) {
        role = f.line.role
        name = f.line.name
        valueHash = f.valueHash
        states = f.line.states
        caret = f.line.caret
        selection = f.line.selection
        actions = f.line.actions
    }
}

/// One line of a full observation, in reading order.
public struct Row: Sendable {
    public enum Kind: Sendable, Equatable { case element, range, more, stub }

    public var kind: Kind
    /// element: its number; range: the first
    public var index: Int
    /// range: the last
    public var last: Int
    /// the row of the displayed parent
    public var parent: Int?
    /// one past the last row of this row's subtree
    public var end: Int
    public var facts: LineFacts
    /// element: name and value before their cut, so the budget can halve them (A12)
    public var fullName: String?
    public var fullValue: String?
    public var valueTotal: Int
    public var nameLimit: Int
    public var valueLimit: Int
    public var noActions = false
    /// global points
    public var frame: Rect?
    /// more: the counts
    public var hidden: Hidden
    public var cls: LineClass
    public var isList: Bool
    /// element: what the diff compares; range: one per member
    public var compares: [Compare]
    public var removed = false

    public var elements: Int {
        switch kind {
        case .element: 1
        case .range: last - index + 1
        case .more, .stub: 0
        }
    }

    public var isElementLine: Bool { kind == .element || kind == .range }

    /// The facts as this row prints them now: limits and dropped actions applied.
    var shown: LineFacts {
        // nothing shortened: the facts already print at the default cuts
        if !noActions, nameLimit == ComputerDefaults.ObservationText.nameMaxChars,
           valueLimit == ComputerDefaults.ObservationText.valueMaxChars || valueLimit == .max { return facts }
        var f = facts
        if kind == .element {
            if let n = fullName { f.name = Cut.name(n, max: nameLimit) }
            if let v = fullValue { f.value = valueLimit == .max ? v : Cut.value(v, total: valueTotal, max: valueLimit) }
            if noActions { f.actions = [] }
        }
        return f
    }
}

public struct HeaderFacts: Sendable, Equatable {
    public enum Change: Sendable { case diff, unchanged }

    public var focused: Int?
    public var loading: Bool
    public var change: Change?
    public var thin: Bool

    public init(focused: Int? = nil, loading: Bool = false, change: Change? = nil, thin: Bool = false) {
        self.focused = focused
        self.loading = loading
        self.change = change
        self.thin = thin
    }
}

/// A full observation as rows, before and after the budget; it renders the
/// text, and the diff prints added subtrees from it.
public struct Layout: Sendable {
    public var rows: [Row]
    public var app: String
    public var title: String
    public var appLimit = Int.max
    public var titleLimit = Int.max
    public var others: [OtherWindow]
    public var showOthers = true
    public var space: CoordinateSpace
    public var windowFrame: Rect
    public var geometry: Bool

    /// The rows of a kept tree, with range lines folded and summary and stub lines in place.
    public static func build(_ tree: KeptTree, _ indexed: Indexed, snapshot s: AXSnapshot, space: CoordinateSpace, geometry: Bool, wholeValues: Bool) -> Layout {
        var rows: [Row] = []
        func add(_ nodes: [KeptNode], parent: Int?, hidden: Hidden?) {
            let members = nodes.map { n -> Fold.Member in
                let bare = n.kind == .element && n.children.isEmpty && n.hidden == nil && n.facts.line.isBare
                return Fold.Member(index: n.kind == .element ? indexed.index[n.id]! : -1, role: n.facts.line.role, bare: bare)
            }
            var runs = Fold.runs(members)[...]
            var i = 0
            while i < nodes.count {
                if let run = runs.first, run.lowerBound == i {
                    runs.removeFirst()
                    let first = members[run.lowerBound].index, last = members[run.upperBound - 1].index
                    rows.append(Row(kind: .range, index: first, last: last, parent: parent, end: rows.count + 1, facts: LineFacts(role: members[i].role),
                                    valueTotal: 0, nameLimit: .max, valueLimit: .max, frame: nil, hidden: Hidden(), cls: nodes[i].facts.cls,
                                    isList: false, compares: nodes[run].map { Compare($0.facts) }))
                    i = run.upperBound
                    continue
                }
                let n = nodes[i]
                let r = rows.count
                switch n.kind {
                case .stub:
                    rows.append(Row(kind: .stub, index: 0, last: 0, parent: parent, end: r + 1, facts: LineFacts(role: n.facts.line.role, name: n.facts.line.name),
                                    valueTotal: 0, nameLimit: .max, valueLimit: .max, frame: n.frame, hidden: Hidden(), cls: .other, isList: false, compares: []))
                case .element:
                    let f = n.facts
                    rows.append(Row(kind: .element, index: indexed.index[n.id]!, last: 0, parent: parent, end: 0, facts: f.line,
                                    fullName: f.rawName, fullValue: f.fullValue, valueTotal: f.valueTotal,
                                    nameLimit: ComputerDefaults.ObservationText.nameMaxChars,
                                    valueLimit: wholeValues ? .max : ComputerDefaults.ObservationText.valueMaxChars,
                                    frame: n.frame, hidden: Hidden(), cls: f.cls, isList: n.isList, compares: [Compare(f)]))
                    add(n.children, parent: r, hidden: n.hidden)
                    rows[r].end = rows.count
                }
                i += 1
            }
            // a list's summary row always exists, empty until something is hidden, so the budget can fill it in place
            let isList = parent.map { rows[$0].isList } ?? false
            if let parent, (hidden.map { !$0.isEmpty } ?? false) || isList {
                rows.append(Row(kind: .more, index: 0, last: 0, parent: parent, end: rows.count + 1, facts: LineFacts(role: ""),
                                valueTotal: 0, nameLimit: .max, valueLimit: .max, frame: nil, hidden: hidden ?? Hidden(), cls: .other,
                                isList: false, compares: []))
            }
        }
        add(tree.roots, parent: nil, hidden: nil)
        return Layout(rows: rows, app: s.app.name, title: s.window.title, others: s.otherWindows, space: space, windowFrame: s.window.frame, geometry: geometry)
    }

    /// A row that prints: not removed, and a summary only when it counts something.
    public func prints(_ r: Int) -> Bool { !rows[r].removed && !(rows[r].kind == .more && rows[r].hidden.isEmpty) }

    /// The nearest printing ancestor of each row, and each row's depth under it.
    public func depths() -> [Int] {
        var depth = [Int](repeating: 0, count: rows.count)
        for r in rows.indices {
            var p = rows[r].parent
            while let q = p, rows[q].removed { p = rows[q].parent }
            depth[r] = p.map { depth[$0] + 1 } ?? 0
        }
        return depth
    }

    public func liveParent(_ r: Int) -> Int? {
        var p = rows[r].parent
        while let q = p, rows[q].removed { p = rows[q].parent }
        return p
    }

    /// A row's text after its indent and marker: `[3] text area = "…" focused caret 0`.
    public func body(_ r: Int, geometry: Bool? = nil) -> String {
        let row = rows[r]
        switch row.kind {
        case .element:
            var s = "[\(row.index)] " + Facts.body(row.shown)
            if geometry ?? self.geometry, let f = row.frame {
                let p = Viewport.pixels(f, window: windowFrame, scale: space.scale)
                s += " @\(p.x),\(p.y) \(p.w)×\(p.h)"
            }
            return s
        case .range:
            return "[\(row.index)]–[\(row.last)] \(row.last - row.index + 1) × \(row.facts.role)"
        case .more:
            let h = row.hidden
            if h.below > 0, h.above > 0 { return "… \(h.below) more below, \(h.above) above" }
            return h.below > 0 ? "… \(h.below) more below" : "… \(h.above) more above"
        case .stub:
            return "(" + row.facts.role + (row.facts.name.map { " " + Quote.json($0) } ?? "") + T.stubSuffix
        }
    }

    public static func indent(_ depth: Int) -> String {
        String(repeating: " ", count: ComputerDefaults.ObservationText.indentSpaces * min(depth, ComputerDefaults.ObservationText.maxDepth))
    }

    public func header(_ h: HeaderFacts) -> String {
        var parts = ["app " + Quote.json(Cut.name(app, max: appLimit)), "window " + Quote.json(Cut.name(title, max: titleLimit)), "\(space.width)×\(space.height)"]
        if let f = h.focused { parts.append("focused [\(f)]") }
        if h.loading { parts.append(T.headerLoading) }
        switch h.change {
        case .diff: parts.append(T.headerDiff)
        case .unchanged: parts.append(T.headerUnchanged)
        case nil: break
        }
        if h.thin { parts.append(T.headerThin) }
        return parts.joined(separator: T.headerSeparator)
    }

    public var othersLine: String? {
        guard showOthers, !others.isEmpty else { return nil }
        return T.otherWindowsPrefix + others.map { Quote.json($0.title) + ($0.minimized ? " minimized" : $0.otherSpace ? " other Space" : "") }.joined(separator: ", ")
    }

    /// Every printing row's line with its indent, in order.
    public func lines() -> [(row: Int, text: String)] {
        let depth = depths()
        return rows.indices.filter(prints).map { ($0, Layout.indent(depth[$0]) + body($0)) }
    }

    /// The full text: header, other windows, the rows, and the footer when there is one.
    public func text(_ h: HeaderFacts, footer: String? = nil) -> String {
        var out = [header(h)]
        if let o = othersLine { out.append(o) }
        out += lines().map(\.text)
        if let footer { out.append(footer) }
        return out.joined(separator: "\n")
    }

    /// UTF-8 bytes of the text without its footer.
    public func bytes(_ h: HeaderFacts) -> Int {
        var n = header(h).utf8.count
        if let o = othersLine { n += 1 + o.utf8.count }
        for l in lines() { n += 1 + l.text.utf8.count }
        return n
    }

    public func row(ofIndex index: Int) -> Int? {
        rows.firstIndex { !$0.removed && ($0.kind == .element ? $0.index == index : $0.kind == .range && (index >= $0.index && index <= $0.last)) }
    }

    /// The focused row and every ancestor of it, and the target window's row.
    public func protectedRows(focused: Int?) -> Set<Int> {
        var out: Set<Int> = rows.isEmpty ? [] : [0]
        guard let f = focused, var r = rows.firstIndex(where: { $0.kind == .element && $0.index == f }) as Int? else { return out }
        out.insert(r)
        while let p = rows[r].parent {
            out.insert(p)
            r = p
        }
        return out
    }
}
