import ComputerProtocol
import Foundation

/// The size budget (spec §4.5, plan §4.3). Bytes are the final text's UTF-8
/// bytes: quoting, header, summary lines and footer included. The footer's
/// worst case is reserved first, then lists fold, then elements leave by
/// class, then the protected lines shorten (A12).
public enum TextBudget {
    public struct Outcome: Sendable {
        public var omitted: Int
        public var footer: String?
    }

    public static func footer(omitted: Int, element: Int) -> String {
        "(truncated: \(omitted) elements left out; observe with element: \(element) to see one part whole)"
    }

    public static func fit(_ layout: inout Layout, header: HeaderFacts, budget: Int) -> Outcome {
        var fitter = Fitter(layout: layout, header: header, budget: budget)
        let outcome = fitter.run()
        layout = fitter.layout
        return outcome
    }

    struct Fitter {
        var layout: Layout
        let header: HeaderFacts
        let budget: Int
        var bytes = 0
        var limit = 0
        var omitted = 0
        /// row → elements it lost, credited to its nearest printing ancestor at the end
        var lost: [Int: Int] = [:]
        var protected: Set<Int> = []
        /// each row's line bytes with its indent and newline, 0 once it no longer prints
        var rowBytes: [Int] = []
        var depth: [Int] = []

        init(layout: Layout, header: HeaderFacts, budget: Int) {
            self.layout = layout
            self.header = header
            self.budget = budget
        }

        var fits: Bool { bytes <= limit }

        /// Every row's bytes and the total, from scratch.
        mutating func measure() {
            depth = layout.depths()
            rowBytes = layout.rows.indices.map { lineBytes($0) }
            bytes = layout.header(header).utf8.count + (layout.othersLine.map { 1 + $0.utf8.count } ?? 0) + rowBytes.reduce(0, +)
        }

        func lineBytes(_ r: Int) -> Int { layout.prints(r) ? 1 + Layout.indent(depth[r]).utf8.count + layout.body(r).utf8.count : 0 }

        /// One row's text changed: its bytes again.
        mutating func remeasure(_ r: Int) {
            let now = lineBytes(r)
            bytes += now - rowBytes[r]
            rowBytes[r] = now
        }

        mutating func run() -> Outcome {
            measure()
            guard bytes > budget else { return Outcome(omitted: 0, footer: nil) }
            let total = layout.rows.reduce(0) { $0 + $1.elements }
            let maxIndex = layout.rows.reduce(0) { max($0, $1.kind == .range ? $1.last : $1.index) }
            limit = budget - 1 - footer(omitted: total, element: maxIndex).utf8.count
            protected = layout.protectedRows(focused: header.focused)
            foldLists()
            if !fits { dropByClass() }
            if !fits { shorten() }
            guard omitted > 0 else { return Outcome(omitted: 0, footer: nil) }
            // credit each loss to the nearest container still printing; the most, the earlier on a tie
            var credit: [Int: Int] = [:]
            for (r, n) in lost {
                var c: Int? = r
                while let q = c, layout.rows[q].removed { c = layout.rows[q].parent }
                credit[c ?? 0, default: 0] += n
            }
            let worst = credit.max { a, b in a.value != b.value ? a.value < b.value : a.key > b.key }!.key
            return Outcome(omitted: omitted, footer: footer(omitted: omitted, element: layout.rows[worst].index))
        }

        /// Rows of a subtree, the root included, that still print.
        func subtree(_ r: Int) -> [Int] { (r..<layout.rows[r].end).filter { !layout.rows[$0].removed } }

        /// Take rows out of the text; the elements they held.
        mutating func remove(_ rows: [Int]) -> Int {
            var elements = 0
            for r in rows {
                elements += layout.rows[r].elements
                layout.rows[r].removed = true
                bytes -= rowBytes[r]
                rowBytes[r] = 0
            }
            return elements
        }

        /// Step 1: the largest lists keep a run of whole rows up to a fifth of the budget.
        mutating func foldLists() {
            // a subtree's bytes from prefix sums over the rows in reading order
            var prefix = [0]
            prefix.reserveCapacity(rowBytes.count + 1)
            for b in rowBytes { prefix.append(prefix.last! + b) }
            func size(_ r: Int) -> Int { prefix[layout.rows[r].end] - prefix[r] }
            let lists = layout.rows.indices.filter { layout.rows[$0].isList && !layout.rows[$0].removed }
                .map { list in (list, children(of: list).reduce(0) { $0 + size($1) }) }
                .sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0 < $1.0 }
            for (list, _) in lists {
                if fits { return }
                // a list inside one already folded away is gone with it
                if layout.rows[list].removed { continue }
                let kids = children(of: list)
                guard !kids.isEmpty else { continue }
                // sizes from the rows as they print now (an earlier fold may have emptied a nested list)
                let sizes = kids.map { k in subtree(k).reduce(0) { $0 + rowBytes[$1] } }
                let cap = budget / 5
                var lo: Int, hi: Int
                if let f = kids.firstIndex(where: { protected.contains($0) }) {
                    lo = f
                    hi = f
                    var used = sizes[f]
                    var after = true, before = true
                    while after || before {
                        if after { if hi + 1 < kids.count, used + sizes[hi + 1] <= cap { hi += 1; used += sizes[hi] } else { after = false } }
                        if before { if lo > 0, used + sizes[lo - 1] <= cap { lo -= 1; used += sizes[lo] } else { before = false } }
                    }
                } else {
                    lo = 0
                    hi = -1
                    var used = 0
                    while hi + 1 < kids.count, used + sizes[hi + 1] <= cap {
                        hi += 1
                        used += sizes[hi]
                    }
                }
                guard lo > 0 || hi < kids.count - 1 else { continue }
                var moreAbove = 0, moreBelow = 0
                for (k, child) in kids.enumerated() where k < lo || k > hi {
                    let rowsOut = layout.rows[child].kind == .range ? layout.rows[child].elements : 1
                    if k < lo { moreAbove += rowsOut } else { moreBelow += rowsOut }
                    let n = remove(subtree(child))
                    omitted += n
                    lost[list, default: 0] += n
                }
                let more = layout.rows[list].end - 1
                if more > list, layout.rows[more].kind == .more {
                    layout.rows[more].hidden = layout.rows[more].hidden + Hidden(above: moreAbove, below: moreBelow)
                    remeasure(more)
                }
            }
        }

        /// A row's direct element and range children that still print.
        func children(of r: Int) -> [Int] {
            var out: [Int] = []
            var c = r + 1
            while c < layout.rows[r].end {
                if layout.rows[c].isElementLine, !layout.rows[c].removed { out.append(c) }
                c = max(layout.rows[c].end, c + 1)
            }
            return out
        }

        /// Step 2: other elements, then text and headings, then interactive ones,
        /// each class in reverse reading order, never the protected path; an
        /// element with a printing element under it keeps its line.
        mutating func dropByClass() {
            var liveKids = [Int](repeating: 0, count: layout.rows.count)
            for r in layout.rows.indices where layout.rows[r].isElementLine && !layout.rows[r].removed {
                if let p = layout.liveParent(r) { liveKids[p] += 1 }
            }
            for cls in [LineClass.other, .text, .interactive] {
                for r in layout.rows.indices.reversed() {
                    if fits { return }
                    let row = layout.rows[r]
                    guard row.isElementLine, !row.removed, row.cls == cls, !protected.contains(r), liveKids[r] == 0 else { continue }
                    let n = remove(subtree(r))
                    omitted += n
                    lost[r, default: 0] += n
                    if let p = layout.liveParent(r) { liveKids[p] -= 1 }
                }
            }
        }

        /// Step 3 (A12): the other windows, the protected lines' actions, every
        /// quoted string halved down to 8 scalars, then outer ancestors other
        /// than the window line, their children rising.
        mutating func shorten() {
            if layout.othersLine != nil {
                layout.showOthers = false
                measure()
                if fits { return }
            }
            let path = protected.sorted()
            for r in path where !layout.rows[r].removed && !layout.rows[r].facts.actions.isEmpty {
                layout.rows[r].noActions = true
                measure()
                if fits { return }
            }
            enum Str { case app, title, name(Int), value(Int) }
            while !fits {
                var best: (Str, Int)?
                func consider(_ s: Str, _ text: String?, shown: Int) {
                    guard let text, shown > 8 else { return }
                    let size = Quote.json(text).utf8.count
                    if best.map({ size > $0.1 }) ?? true { best = (s, size) }
                }
                let a = Cut.name(layout.app, max: layout.appLimit), t = Cut.name(layout.title, max: layout.titleLimit)
                consider(.app, a, shown: min(layout.appLimit, layout.app.unicodeScalars.count))
                consider(.title, t, shown: min(layout.titleLimit, layout.title.unicodeScalars.count))
                for r in layout.rows.indices where layout.rows[r].kind == .element && !layout.rows[r].removed {
                    let row = layout.rows[r], shown = row.shown
                    if let n = row.fullName { consider(.name(r), shown.name, shown: min(row.nameLimit, n.unicodeScalars.count)) }
                    if let v = row.fullValue { consider(.value(r), shown.value, shown: min(row.valueLimit, v.unicodeScalars.count)) }
                }
                guard let (s, _) = best else { break }
                let half = { (n: Int) in max(8, n / 2) }
                switch s {
                case .app: layout.appLimit = half(min(layout.appLimit, layout.app.unicodeScalars.count))
                case .title: layout.titleLimit = half(min(layout.titleLimit, layout.title.unicodeScalars.count))
                case .name(let r): layout.rows[r].nameLimit = half(min(layout.rows[r].nameLimit, layout.rows[r].fullName!.unicodeScalars.count))
                case .value(let r): layout.rows[r].valueLimit = half(min(layout.rows[r].valueLimit, layout.rows[r].fullValue!.unicodeScalars.count))
                }
                measure()
            }
            // outer ancestors last: never the window line, never the focused line itself
            let focusedRow = path.max()
            for r in path where r != 0 && r != focusedRow && !layout.rows[r].removed {
                if fits { return }
                layout.rows[r].removed = true
                for c in (r + 1)..<layout.rows[r].end where layout.rows[c].parent == r && !layout.rows[c].isElementLine { layout.rows[c].removed = true }
                omitted += 1
                lost[r, default: 0] += 1
                measure()
            }
        }
    }
}
