import Foundation

/// The desktop's `flex-wrap` as arithmetic: items left to right, as many on
/// a line as fit the width, `spacing` apart; the next one starts a line
/// under the tallest of the last, `lineSpacing` below. An item wider than
/// the width sits alone on its line. A nil width (an unbounded proposal)
/// puts everything on one line. The app's `FlowLayout` places with it.
public enum FlowRows {
    public struct Size: Sendable, Hashable {
        public var width: Double
        public var height: Double

        public init(width: Double, height: Double) {
            self.width = width
            self.height = height
        }
    }

    public struct Placement: Sendable, Hashable {
        /// Each item's left and top edges, in order.
        public var xs: [Double]
        public var ys: [Double]
        /// Each item's width as placed.
        public var widths: [Double]
        /// The line each item sits on, from 0.
        public var lines: [Int]
        /// The whole arrangement: the widest line and every line's height.
        public var size: Size
    }

    public static func place(_ sizes: [Size], width: Double?, spacing: Double, lineSpacing: Double) -> Placement {
        var xs: [Double] = [], ys: [Double] = [], widths: [Double] = [], lines: [Int] = []
        var x = 0.0, y = 0.0, lineHeight = 0.0, widest = 0.0, line = 0
        for size in sizes {
            if x > 0, let width, x + spacing + size.width > width {
                y += lineHeight + lineSpacing
                x = 0
                lineHeight = 0
                line += 1
            }
            if x > 0 { x += spacing }
            xs.append(x)
            ys.append(y)
            widths.append(size.width)
            lines.append(line)
            x += size.width
            lineHeight = max(lineHeight, size.height)
            widest = max(widest, x)
        }
        return Placement(xs: xs, ys: ys, widths: widths, lines: lines, size: Size(width: widest, height: sizes.isEmpty ? 0 : y + lineHeight))
    }
}
