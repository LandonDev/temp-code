import ComputerProtocol
import Foundation

/// One element as a full observation showed it: a line of its own, or a member of a range line.
public struct BaseLine: Sendable, Equatable {
    /// the displayed parent's number, 0 at the top
    public var parent: Int
    /// `[3] text area = "…"`, as shown, without geometry; a range member: `[7] ruler marker`
    public var body: String
    public var compare: Compare
    /// the first number of the range line it showed in
    public var range: Int?
}

/// What the model last saw of this session × app (plan §4.2): the structure for
/// identity, the shown lines for the diff text.
public struct Base: Sendable {
    public var windowID: Int
    /// every kept element of that read, before the budget
    public var structure: [Int: BaseNode]
    /// every shown element
    public var lines: [Int: BaseLine]
    /// parent (0: the top) → shown children in order
    public var order: [Int: [Int]]
    /// container → its `… n more` line; 0 → the `(truncated: …)` line
    public var summaries: [Int: String]
    /// parent → its stub lines
    public var stubs: [Int: [String]]
    public var others: [OtherWindow]
    public var fullBytes: Int
}

public enum FullReason: String, Sendable {
    case first, windowChanged, moved, reordered, tooLarge, reset
    /// the truncation footer or the other-windows line went away: no diff line says that
    case unsaid
}

public enum DiffOutcome: Sendable, Equatable {
    case unchanged
    case diff(String)
    case full(FullReason)
}

/// A full observation, rendered under the budget, and the base it leaves.
public struct Rendered: Sendable {
    public var layout: Layout
    public var header: HeaderFacts
    public var text: String
    public var footer: String?
    public var omitted: Int
    public var base: Base
}

public enum Diff {
    /// The base a rendered full observation leaves: every line it showed.
    public static func base(_ layout: Layout, structure: [Int: BaseNode], footer: String?, windowID: Int, fullBytes: Int) -> Base {
        var lines: [Int: BaseLine] = [:]
        var order: [Int: [Int]] = [:]
        var summaries: [Int: String] = [:]
        var stubs: [Int: [String]] = [:]
        let parentIndex = { (r: Int) -> Int in layout.liveParent(r).map { layout.rows[$0].index } ?? 0 }
        for r in layout.rows.indices where layout.prints(r) {
            let row = layout.rows[r]
            let p = parentIndex(r)
            switch row.kind {
            case .element:
                lines[row.index] = BaseLine(parent: p, body: layout.body(r, geometry: false), compare: row.compares[0], range: nil)
                order[p, default: []].append(row.index)
            case .range:
                for (k, i) in (row.index...row.last).enumerated() {
                    lines[i] = BaseLine(parent: p, body: "[\(i)] \(row.facts.role)", compare: row.compares[k], range: row.index)
                    order[p, default: []].append(i)
                }
            case .more: summaries[p] = layout.body(r)
            case .stub: stubs[p, default: []].append(layout.body(r))
            }
        }
        if let footer { summaries[0] = footer }
        return Base(windowID: windowID, structure: structure, lines: lines, order: order, summaries: summaries, stubs: stubs,
                    // the windows the model was shown: none when the budget left the line out
                    others: layout.othersLine == nil ? [] : layout.others, fullBytes: fullBytes)
    }

    /// Spec §4.4 with plan §4.2: full on another window, a move, a new order or
    /// a diff past 60% of the full text or 12,000 bytes; else the three groups,
    /// removed, changed, added, each in reading order.
    public static func compute(base: Base, now: Rendered, moved: Bool, reordered: Bool) -> DiffOutcome {
        let next = now.base
        if base.windowID != next.windowID { return .full(.windowChanged) }
        if moved { return .full(.moved) }
        if reordered { return .full(.reordered) }
        // the shown picture must change only by what the grammar can say
        for (i, line) in next.lines {
            if let old = base.lines[i], old.parent != line.parent { return .full(.moved) }
        }
        for (p, kids) in next.order {
            let common = kids.filter { base.lines[$0] != nil }
            let before = (base.order[p] ?? []).filter { next.lines[$0] != nil }
            if common != before { return .full(.reordered) }
        }
        if base.stubs != next.stubs { return .full(.moved) }

        var out: [String] = []
        // removed: each gone subtree by its root, a gone run of range members as one range line
        let gone = Set(base.lines.keys).subtracting(next.lines.keys)
        var removedRoots: [Int] = []
        walk(base.order, from: 0) { i in
            if gone.contains(i), !gone.contains(base.lines[i]!.parent) { removedRoots.append(i) }
        }
        out += runs(removedRoots, lines: base.lines).map { run in
            if run.count > 1 { return "- [\(run.first!)]–[\(run.last!)] \(run.count) × \(base.lines[run[0]]!.compare.role)" }
            let i = run[0]
            var inside = 0
            walk(base.order, from: i) { _ in inside += 1 }
            return "- " + base.lines[i]!.body + (inside > 0 ? " (and \(inside) inside)" : "")
        }

        // changed: the new line under its own number; a container whose summary moved carries it one level under
        let summaryChanged = Set(next.summaries.keys.filter { $0 != 0 && base.lines[$0] != nil && base.summaries[$0] != next.summaries[$0] })
            .union(base.summaries.keys.filter { $0 != 0 && next.lines[$0] != nil && next.summaries[$0] == nil })
        var bodies: [Int: Int] = [:]
        for r in now.layout.rows.indices where now.layout.prints(r) && now.layout.rows[r].kind == .element { bodies[now.layout.rows[r].index] = r }
        walk(next.order, from: 0) { i in
            guard let old = base.lines[i], let line = next.lines[i] else { return }
            // the shown line too: a budget's cut or dropped actions change what the model reads
            let facts = old.compare != line.compare || old.body != line.body
            guard facts || summaryChanged.contains(i) else { return }
            out.append("~ " + (bodies[i].map { now.layout.body($0) } ?? line.body))
            if summaryChanged.contains(i), let s = next.summaries[i] { out.append(Layout.indent(1) + s) }
        }

        // added: each new subtree by its root, siblings next to each other in one group
        let added = Set(next.lines.keys).subtracting(base.lines.keys)
        var addedRoots: [Int] = []
        walk(next.order, from: 0) { i in
            if added.contains(i), !added.contains(next.lines[i]!.parent) { addedRoots.append(i) }
        }
        var lastGroup: (parent: Int, after: Int)?
        for run in runs(addedRoots, lines: next.lines) {
            let p = next.lines[run[0]]!.parent
            let siblings = next.order[p] ?? []
            let at = siblings.firstIndex(of: run[0])!
            if lastGroup.map({ $0.parent != p || $0.after != at - 1 }) ?? true {
                out.append(p == 0 ? "+ at top:" : "+ in [\(p)]:")
            }
            lastGroup = (p, siblings.firstIndex(of: run.last!)!)
            if run.count > 1 || next.lines[run[0]]!.range != nil && bodies[run[0]] == nil {
                out.append(Layout.indent(1) + (run.count > 1 ? "[\(run.first!)]–[\(run.last!)] \(run.count) × \(next.lines[run[0]]!.compare.role)" : next.lines[run[0]]!.body))
            } else if let r = bodies[run[0]] {
                out += subtreeLines(now.layout, root: r)
            }
        }
        if let t = next.summaries[0], t != base.summaries[0] { out.append(t) }
        if base.summaries[0] != nil, next.summaries[0] == nil { return .full(.unsaid) }
        if !base.others.isEmpty, next.others.isEmpty { return .full(.unsaid) }
        if next.others != base.others, let o = now.layout.othersLine { out.insert(o, at: 0) }
        if out.isEmpty { return .unchanged }

        var header = now.header
        header.change = .diff
        let text = ([now.layout.header(header)] + out).joined(separator: "\n")
        let bytes = text.utf8.count
        if Double(bytes) > ComputerDefaults.ObservationBudget.diffMaxShare * Double(now.text.utf8.count) || bytes > ComputerDefaults.ObservationBudget.diffMaxBytes {
            return .full(.tooLarge)
        }
        return .diff(text)
    }

    /// Pre-order over shown elements under `from` (not `from` itself).
    static func walk(_ order: [Int: [Int]], from: Int, _ visit: (Int) -> Void) {
        for c in order[from] ?? [] {
            visit(c)
            walk(order, from: c, visit)
        }
    }

    /// Roots in reading order, a run of range members of one range kept together.
    static func runs(_ roots: [Int], lines: [Int: BaseLine]) -> [[Int]] {
        var out: [[Int]] = []
        for i in roots {
            if let r = lines[i]?.range, let last = out.last?.last, lines[last]?.range == r, last == i - 1 {
                out[out.count - 1].append(i)
            } else {
                out.append([i])
            }
        }
        return out
    }

    /// A row and its printing descendants, one level under an added marker.
    static func subtreeLines(_ layout: Layout, root: Int) -> [String] {
        let depth = layout.depths()
        return (root..<layout.rows[root].end).filter(layout.prints).map { Layout.indent(depth[$0] - depth[root] + 1) + layout.body($0) }
    }
}
