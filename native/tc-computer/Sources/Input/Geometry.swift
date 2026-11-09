import ComputerCore
import ComputerProtocol

/// A point in global screen points, top-left origin; may be negative or past the main display.
public struct ScreenPoint: Equatable, Sendable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    public var pair: [Double] { [x, y] }

    public func distance(to other: ScreenPoint) -> Double {
        ((x - other.x) * (x - other.x) + (y - other.y) * (y - other.y)).squareRoot()
    }
}

/// A session-space point `[x, y]` on the window whose screenshot is `space`: `frame.origin + point / scale`.
/// Throws `out_of_bounds` unless `0 ≤ x < width` and `0 ≤ y < height`; nothing clamps.
public func toScreen(_ p: [Int], frame: ComputerProtocol.Rect, space: CoordinateSpace) throws -> ScreenPoint {
    guard p.count == 2, p[0] >= 0, p[0] < space.width, p[1] >= 0, p[1] < space.height else {
        let where_ = p.count == 2 ? "\(p[0]),\(p[1])" : "\(p)"
        throw ComputerFailure(ComputerError(
            kind: .outOfBounds,
            message: "\(where_) is outside the window's \(space.width)×\(space.height).",
            coordinate: p.count == 2 ? p : nil,
            space: space
        ))
    }
    return ScreenPoint(x: frame.x + Double(p[0]) / space.scale, y: frame.y + Double(p[1]) / space.scale)
}

/// A screen point in the window's session space, rounded.
public func toSpace(_ p: ScreenPoint, frame: ComputerProtocol.Rect, space: CoordinateSpace) -> [Int] {
    [Int(((p.x - frame.x) * space.scale).rounded()), Int(((p.y - frame.y) * space.scale).rounded())]
}

/// The overlap of two rects, nil when they do not meet.
public func intersect(_ a: ComputerProtocol.Rect, _ b: ComputerProtocol.Rect) -> ComputerProtocol.Rect? {
    let x0 = max(a.x, b.x), y0 = max(a.y, b.y)
    let x1 = min(a.x + a.w, b.x + b.w), y1 = min(a.y + a.h, b.y + b.h)
    guard x1 > x0, y1 > y0 else { return nil }
    return Rect(x: x0, y: y0, w: x1 - x0, h: y1 - y0)
}

public func centre(_ r: ComputerProtocol.Rect) -> ScreenPoint {
    ScreenPoint(x: r.x + r.w / 2, y: r.y + r.h / 2)
}

/// Where Input points at an element: the centre of its frame clipped to its scroll area's
/// visible frame and to the window; nil when nothing of it shows.
public func pointIn(_ frame: ComputerProtocol.Rect, visible: ComputerProtocol.Rect?, window: ComputerProtocol.Rect) -> ScreenPoint? {
    var shown: Rect? = frame
    if let visible { shown = shown.flatMap { intersect($0, visible) } }
    shown = shown.flatMap { intersect($0, window) }
    return shown.map(centre)
}

/// `out_of_bounds` for an element that does not show, its centre mapped into the space.
public func notShowing(_ frame: ComputerProtocol.Rect, index: Int?, window: ComputerProtocol.Rect, space: CoordinateSpace) -> ComputerFailure {
    let at = toSpace(centre(frame), frame: window, space: space)
    let name = index.map { "[\($0)]" } ?? "The element"
    return ComputerFailure(ComputerError(
        kind: .outOfBounds,
        message: "\(name) is outside the window's visible area; scroll it into view first.",
        element: index,
        coordinate: at,
        space: space
    ))
}
