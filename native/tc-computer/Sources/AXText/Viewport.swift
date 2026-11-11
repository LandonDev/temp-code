import ComputerProtocol
import Foundation

/// The viewport cut (plan §3.4): what a walk reads of a container, and what it
/// only counts. The walker makes the cut while it walks; `cut` makes the same
/// cut offline on a recorded tree that holds every child.
public enum Viewport {
    /// AX roles whose non-zero frame narrows their descendants' clip.
    public static let clipRoles: Set<String> = ["AXList", "AXOutline", "AXTable", "AXScrollArea", "AXWebArea"]

    /// `sliver`: no side from geometry; above when it comes before the container's first shown child, else below.
    public enum Side: Sendable { case above, below, sliver }

    public static func isZero(_ r: Rect) -> Bool { r.w <= 0 || r.h <= 0 }

    /// Whether `frame` meets `clip`; nil clip is no clip.
    public static func meets(_ frame: Rect, _ clip: Rect?) -> Bool {
        guard let c = clip else { return true }
        return frame.x < c.x + c.w && frame.x + frame.w > c.x && frame.y < c.y + c.h && frame.y + frame.h > c.y
    }

    /// The intersection, zero-size when they do not meet; nil clip is no clip.
    public static func intersect(_ clip: Rect?, _ frame: Rect) -> Rect {
        guard let c = clip else { return frame }
        let x0 = max(c.x, frame.x), y0 = max(c.y, frame.y)
        let x1 = min(c.x + c.w, frame.x + frame.w), y1 = min(c.y + c.h, frame.y + frame.h)
        return Rect(x: x0, y: y0, w: max(0, x1 - x0), h: max(0, y1 - y0))
    }

    /// The roles whose AXVisibleChildren or AXVisibleRows the cut reads (the walker asks only these).
    public static let listRoles: Set<String> = ["AXList", "AXOutline", "AXTable"]

    /// Where a node sits relative to web content (§25.5).
    public struct Scope: Sendable, Equatable {
        /// inside a web area
        public var page: Bool
        /// inside a web area with no scroll area between: the page's own flow
        public var inFlow: Bool

        public init(page: Bool = false, inFlow: Bool = false) {
            self.page = page
            self.inFlow = inFlow
        }

        /// A window's tree outside any web area.
        public static let window = Scope()

        /// The scope the children of a node of `role` sit in.
        public func inside(_ role: String) -> Scope {
            if role == "AXWebArea" { return Scope(page: true, inFlow: true) }
            if role == "AXScrollArea" { return Scope(page: page, inFlow: false) }
            return self
        }

        /// A list of the page's own flow is judged by its rows' frames: its AXVisibleRows and
        /// AXVisibleChildren describe the physical viewport, not the read-ahead (Chrome answers `[]`).
        public var trustsVisibleLists: Bool { !inFlow }
    }

    /// The clip a node's children are judged against. `scope` is where the node itself sits; with one,
    /// a top-level web area's clip for its own document reads ahead (§25.5), from `webReadAheadAbove`
    /// visible heights above its visible rect to `webReadAheadBelow` below it. Nil: the physical cut alone
    /// (the busy scan, which looks for what shows).
    public static func childClip(role: String, frame: Rect?, clip: Rect?, scope: Scope? = nil) -> Rect? {
        guard clipRoles.contains(role), let f = frame, !isZero(f) else { return clip }
        let visible = intersect(clip, f)
        if role == "AXWebArea", let scope, !scope.page { return readAhead(visible) }
        return visible
    }

    /// A visible rect widened by the web read-ahead.
    public static func readAhead(_ visible: Rect) -> Rect {
        guard !isZero(visible) else { return visible }
        let above = Double(ComputerDefaults.AXWalk.webReadAheadAbove), below = Double(ComputerDefaults.AXWalk.webReadAheadBelow)
        return Rect(x: visible.x, y: visible.y - above * visible.h, w: visible.w, h: visible.h * (1 + above + below))
    }

    /// A child the walk does not descend into (its own stage A read): a popover or a menu hangs outside its
    /// window and is judged by its own frame, so it is never cut.
    public static func cut(role: String, frame: Rect?, clip: Rect?, sliver: Bool) -> Side? {
        if role == "AXPopover" || role == "AXMenu" { return nil }
        return missed(frame, clip, sliver: sliver)
    }

    /// Which side of the clip a frame that misses it lies on.
    public static func side(of frame: Rect, against clip: Rect) -> Side {
        if frame.y + frame.h <= clip.y { return .above }
        if frame.y >= clip.y + clip.h { return .below }
        return frame.x + frame.w <= clip.x ? .above : .below
    }

    /// A child the walk does not descend into: known, non-zero, and missing its clip. Under a
    /// clip container (`sliver`), a frame one point thin or less misses too: Chrome parks every
    /// row an overflow box scrolled away at its bottom edge as a 1-point sliver, whichever way
    /// it left, so its side comes from its place among the children (`Side.sliver`).
    public static func missed(_ frame: Rect?, _ clip: Rect?, sliver: Bool = false) -> Side? {
        guard let f = frame, !isZero(f), let c = clip else { return nil }
        if !meets(f, c) { return side(of: f, against: c) }
        if sliver, f.w <= 1 || f.h <= 1 { return .sliver }
        return nil
    }

    /// Slivers by their place: before the first shown child above, the rest below.
    public static func slivers(_ positions: [Int], firstShown: Int?) -> Hidden {
        var h = Hidden()
        for i in positions {
            if let f = firstShown, i < f { h.above += 1 } else { h.below += 1 }
        }
        return h
    }

    /// A container that lists its visible children: the ones before the first
    /// visible count above, the rest below. `visible` are child positions.
    public static func partition(childCount: Int, visible: [Int]) -> Hidden {
        let shown = Set(visible)
        guard let first = visible.min() else { return Hidden(above: 0, below: childCount) }
        var hidden = Hidden()
        for i in 0..<childCount where !shown.contains(i) {
            if i < first { hidden.above += 1 } else { hidden.below += 1 }
        }
        return hidden
    }

    /// The pixel line of a frame in a window's coordinate space: `(origin − window origin) × scale`, rounded.
    public static func pixels(_ frame: Rect, window: Rect, scale: Double) -> (x: Int, y: Int, w: Int, h: Int) {
        (Int(((frame.x - window.x) * scale).rounded()), Int(((frame.y - window.y) * scale).rounded()),
         Int((frame.w * scale).rounded()), Int((frame.h * scale).rounded()))
    }
}

/// One container's cut, the same code for the live walker and a recorded tree (`RawTree`), so the two
/// cut alike (the parity test): what its visible lists name, then each child counted or visited.
public enum ViewportCut {
    public enum Outcome<T> {
        case node(T)
        case hidden(Viewport.Side)
        case skip
    }

    /// What a list answered, as keys of its children: AXVisibleChildren; else AXVisibleRows and
    /// AXVisibleColumns, with AXRows and AXColumns naming which children those lists cover.
    public struct Lists<K: Hashable> {
        public var visibleChildren: [K]
        public var visibleRows: [K]
        public var rows: [K]

        public init(visibleChildren: [K] = [], visibleRows: [K] = [], rows: [K] = []) {
            self.visibleChildren = visibleChildren
            self.visibleRows = visibleRows
            self.rows = rows
        }
    }

    /// Each child's mark: true named visible, false left out of a list that covers it, nil judged by
    /// frame. A list of the page's own flow (`scope`) is never believed, nor one naming no child visible
    /// (IntelliJ's is empty with its rows on screen).
    public static func marks<K: Hashable>(_ keys: [K], lists: Lists<K>?, scope: Viewport.Scope) -> [Bool?] {
        let none = [Bool?](repeating: nil, count: keys.count)
        guard scope.trustsVisibleLists, let lists else { return none }
        var marks = none
        if !lists.visibleChildren.isEmpty {
            let shown = Set(lists.visibleChildren)
            marks = keys.map { shown.contains($0) }
        } else if !lists.visibleRows.isEmpty {
            let covered = Set(lists.rows), shown = Set(lists.visibleRows)
            marks = keys.map { covered.contains($0) ? shown.contains($0) : nil }
        }
        return marks.contains(true) ? marks : none
    }

    /// The children of one container: one its list leaves out is counted above when it comes before the
    /// first one the list names, else below; every other is visited (`visit` makes the frame check of the
    /// child's own read); slivers are counted by their place among the children shown.
    public static func children<C, T>(_ children: [C], marks: [Bool?], stop: () -> Bool = { false }, visit: (Int, C) throws -> Outcome<T>) rethrows -> (kept: [T], hidden: Hidden) {
        let firstVisible = marks.firstIndex { $0 == true }
        var hidden = Hidden()
        var kept: [T] = []
        var slivers: [Int] = []
        var firstShown: Int?
        for (i, child) in children.enumerated() {
            if stop() { break }
            if i < marks.count, marks[i] == false {
                if let first = firstVisible, i < first { hidden.above += 1 } else { hidden.below += 1 }
                continue
            }
            switch try visit(i, child) {
            case .node(let n):
                firstShown = firstShown ?? i
                kept.append(n)
            case .hidden(.above): hidden.above += 1
            case .hidden(.below): hidden.below += 1
            case .hidden(.sliver): slivers.append(i)
            case .skip: break
            }
        }
        return (kept, hidden + Viewport.slivers(slivers, firstShown: firstShown))
    }
}
