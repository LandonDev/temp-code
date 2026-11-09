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

    /// The clip a node's children are judged against.
    public static func childClip(role: String, frame: Rect?, clip: Rect?) -> Rect? {
        guard clipRoles.contains(role), let f = frame, !isZero(f) else { return clip }
        return intersect(clip, f)
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
