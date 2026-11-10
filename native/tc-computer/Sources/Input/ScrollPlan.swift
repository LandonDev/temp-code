import ComputerProtocol

/// Which of a scroll area's bars a direction moves, and which way (docs/computer-protocol.md §24.5).
public enum ScrollBarAxis: Equatable, Sendable {
    /// AXVerticalScrollBar
    case vertical
    /// AXHorizontalScrollBar
    case horizontal

    public var attribute: String { self == .vertical ? "AXVerticalScrollBar" : "AXHorizontalScrollBar" }
}

/// The bar for a direction and the sign of the move: down and right raise its value toward 1.
public func scrollBar(for direction: ScrollDirection) -> (axis: ScrollBarAxis, sign: Double)? {
    switch direction {
    case .down: (.vertical, 1)
    case .up: (.vertical, -1)
    case .right: (.horizontal, 1)
    case .left: (.horizontal, -1)
    default: nil
    }
}

/// The share of the bar `clicks` wheel clicks move: `clicks × pointsPerClick / (content − visible)`;
/// nil when the content is no longer than the view along the axis, so nothing scrolls.
public func barDelta(clicks: Int, content: Double, visible: Double, pointsPerClick: Double = Double(InputTables.scrollPointsPerClick)) -> Double? {
    let range = content - visible
    guard range > 0 else { return nil }
    return Double(max(1, clicks)) * pointsPerClick / range
}

public enum ScrollBarMove: Equatable, Sendable {
    /// set AXValue to this
    case set(Double)
    /// the bar is already at the end the direction goes to: `none` at once
    case atEnd
    /// the content fits the view: no bar to move
    case none
}

/// Where a scroll puts its bar: `value ± delta`, clamped to 0…1.
public func scrollBarMove(value: Double, direction: ScrollDirection, clicks: Int, content: Double, visible: Double, pointsPerClick: Double = Double(InputTables.scrollPointsPerClick)) -> ScrollBarMove {
    guard let (_, sign) = scrollBar(for: direction), let delta = barDelta(clicks: clicks, content: content, visible: visible, pointsPerClick: pointsPerClick) else { return .none }
    if (sign > 0 && value >= 1) || (sign < 0 && value <= 0) { return .atEnd }
    let next = min(1, max(0, value + sign * delta))
    return next == value ? .atEnd : .set(next)
}
