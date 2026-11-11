import ComputerProtocol

/// The `scroll-into-view` route's target (docs/computer-protocol.md §25.6): in a web page, the element
/// AXScrollToVisible is called on so the page moves about as far as the wheel would have. The band is
/// the stretch `clicks × SCROLL_POINTS_PER_CLICK` deep just past the visible rect's edge in the scroll's
/// direction; the target is the kept element whose frame starts in it furthest along that direction
/// (scrolling down, the last in reading order), and whose frame meets the visible rect across it.
public struct IntoViewBand: Equatable, Sendable {
    public var visible: ComputerProtocol.Rect
    public var direction: ScrollDirection
    /// points past the edge
    public var distance: Double

    /// the band along the scroll's axis: `[from, to]`, in screen points
    var span: (from: Double, to: Double) {
        switch direction {
        case .up: (visible.y - distance, visible.y)
        case .left: (visible.x - distance, visible.x)
        case .right: (visible.x + visible.w, visible.x + visible.w + distance)
        default: (visible.y + visible.h, visible.y + visible.h + distance)
        }
    }

    var vertical: Bool { direction != .left && direction != .right }
}

public enum IntoViewPlan {
    /// The band a scroll of `clicks` reaches; nil for a direction that is no scroll's or an empty visible rect.
    public static func band(visible: ComputerProtocol.Rect, direction: ScrollDirection, clicks: Int, pointsPerClick: Int = InputTables.scrollPointsPerClick) -> IntoViewBand? {
        guard scrollBar(for: direction) != nil, visible.w > 0, visible.h > 0 else { return nil }
        return IntoViewBand(visible: visible, direction: direction, distance: Double(max(1, clicks) * pointsPerClick))
    }

    /// Where a frame starts along the scroll: its top edge (its left edge for a sideways scroll).
    static func start(_ f: ComputerProtocol.Rect, _ band: IntoViewBand) -> Double {
        band.vertical ? f.y : f.x
    }

    /// The frame meets the visible rect across the axis (a row of the page's own column, not one beside it).
    static func across(_ f: ComputerProtocol.Rect, _ band: IntoViewBand) -> Bool {
        let v = band.visible
        return band.vertical ? f.x < v.x + v.w && f.x + f.w > v.x : f.y < v.y + v.h && f.y + f.h > v.y
    }

    /// Whether the frame starts in the band: scrolling down, at or below the visible bottom and at most
    /// `distance` under it; scrolling up, above the visible top and at most `distance` over it.
    public static func starts(_ frame: ComputerProtocol.Rect, in band: IntoViewBand) -> Bool {
        guard frame.w > 0, frame.h > 0, across(frame, band) else { return false }
        let s = start(frame, band)
        let (from, to) = band.span
        switch band.direction {
        case .up, .left: return s >= from && s < to
        default: return s >= from && s <= to
        }
    }

    /// Whether a subtree under this frame can hold a target: an unknown frame may; a known one must
    /// reach into the band along the axis. The live scan skips the rest, so the 400 nodes go to the edge.
    public static func mayHold(_ frame: ComputerProtocol.Rect?, in band: IntoViewBand) -> Bool {
        guard let f = frame, f.w > 0 || f.h > 0 else { return true }
        let (from, to) = band.span
        let (lo, hi) = band.vertical ? (f.y, f.y + f.h) : (f.x, f.x + f.w)
        // a frame that ends on the visible edge may be cut there: Chrome 156 gives a page's table its frame cut to
        // the visible page, and its rows past the edge keep their own frames (2026-11-11)
        return hi >= from && lo <= to
    }

    /// Of the kept elements' frames in reading order, the target's index: the one starting in the band
    /// furthest along the scroll; of two at the same place, the later. Nil when none starts there.
    public static func choose(_ frames: [ComputerProtocol.Rect?], in band: IntoViewBand) -> Int? {
        var best: (index: Int, at: Double)?
        let forward = band.direction != .up && band.direction != .left
        for (i, f) in frames.enumerated() {
            guard let f, starts(f, in: band) else { continue }
            let at = start(f, band)
            if let b = best, forward ? at < b.at : at > b.at { continue }
            best = (i, at)
        }
        return best?.index
    }

    /// The target moved: its frame read back differs from before along the axis (by half a point or more).
    public static func moved(before: ComputerProtocol.Rect?, after: ComputerProtocol.Rect?, direction: ScrollDirection) -> Bool {
        guard let a = before, let b = after else { return false }
        let vertical = direction != .left && direction != .right
        return abs(vertical ? a.y - b.y : a.x - b.x) >= 0.5
    }
}
