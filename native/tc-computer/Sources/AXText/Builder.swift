import ComputerProtocol
import Foundation

public struct BuildRequest: Sendable {
    public var mode: ObservationMode
    /// an element's number: that element's subtree, whole
    public var subtreeOf: Int?
    public var budgetBytes: Int
    public var geometry: Bool
    public var space: CoordinateSpace
    /// the wait ended busy (A4)
    public var loading: Bool
    /// false when the call's screenshot is `never` (A4)
    public var noteThin: Bool

    public init(mode: ObservationMode = .auto, subtreeOf: Int? = nil, budgetBytes: Int = ComputerDefaults.ObservationBudget.defaultBytes, geometry: Bool = false, space: CoordinateSpace, loading: Bool = false, noteThin: Bool = true) {
        self.mode = mode
        self.subtreeOf = subtreeOf
        self.budgetBytes = budgetBytes
        self.geometry = geometry
        self.space = space
        self.loading = loading
        self.noteThin = noteThin
    }
}

public struct Built: Sendable {
    public var kind: ObservationKind
    public var text: String
    public var stats: ObservationStats
    public var focused: Int?
    public var window: WindowInfo
    /// shown element → its line after `[<index>] `, without geometry
    public var briefs: [Int: String]
    /// why a full observation came back where an auto read asked for less
    public var fullReason: FullReason?
}

/// The pure half of a read: keep, index, fold, budget, render, diff, and the next base (plan §4.4).
public enum Builder {
    public static func build(_ s: AXSnapshot, _ request: BuildRequest, book: IndexBook, base: Base?) -> (Built, Base?) {
        let start = ContinuousClock.now
        let subtree = request.subtreeOf != nil
        let budget = min(max(request.budgetBytes, ComputerDefaults.ObservationBudget.minBytes), ComputerDefaults.ObservationBudget.maxBytes)
        let kept = Keep.tree(s, KeepOptions(wholeValues: subtree))
        let indexed = book.assign(kept, base: subtree ? nil : base, sameWindow: base?.windowID == s.window.id)
        var layout = Layout.build(kept, indexed, snapshot: s, space: request.space, geometry: request.geometry, wholeValues: subtree)
        let focused = layout.rows.first { $0.kind == .element && $0.facts.states.first == "focused" }?.index
        var header = HeaderFacts(focused: focused, loading: request.loading, change: nil, thin: kept.thin && request.noteThin)
        let fitted = TextBudget.fit(&layout, header: header, budget: budget)
        let full = layout.text(header, footer: fitted.footer)

        var briefs: [Int: String] = [:]
        for r in layout.rows.indices where layout.prints(r) {
            let row = layout.rows[r]
            if row.kind == .element { briefs[row.index] = Facts.body(row.shown) }
            if row.kind == .range { for i in row.index...row.last { briefs[i] = row.facts.role } }
        }
        let elements = layout.rows.indices.filter(layout.prints).reduce(0) { $0 + layout.rows[$1].elements }

        var kind: ObservationKind = .full
        var text = full
        var reason: FullReason?
        var next: Base?
        if subtree {
            kind = .subtree
        } else {
            let made = Diff.base(layout, structure: indexed.structure, footer: fitted.footer, windowID: s.window.id, fullBytes: full.utf8.count)
            next = made
            if let base, request.mode != .full {
                let rendered = Rendered(layout: layout, header: header, text: full, footer: fitted.footer, omitted: fitted.omitted, base: made)
                switch Diff.compute(base: base, now: rendered, moved: indexed.moved, reordered: indexed.reordered) {
                case .unchanged:
                    kind = .unchanged
                    header.change = .unchanged
                    text = layout.header(header)
                case .diff(let t):
                    kind = .diff
                    text = t
                case .full(let why):
                    reason = why
                }
            } else {
                reason = base == nil ? .first : nil
            }
        }
        let ms = Int((ContinuousClock.now - start) / .milliseconds(1))
        let stats = ObservationStats(elements: elements, lines: text.split(separator: "\n", omittingEmptySubsequences: false).count, bytes: text.utf8.count,
                                     omitted: fitted.omitted, thin: kept.thin, partial: s.partial, readMs: s.walkMs + ms)
        return (Built(kind: kind, text: text, stats: stats, focused: focused, window: s.window, briefs: briefs, fullReason: reason), next)
    }
}
