import Foundation

/// An image's size and how many of its pixels make one window point (both axes).
public struct ShotSize: Equatable, Sendable {
    public let width: Int
    public let height: Int
    public let scale: Double

    public init(width: Int, height: Int, scale: Double) {
        self.width = width
        self.height = height
        self.scale = scale
    }
}

/// The size math of a shot, a zoom and a frame (docs/computer-protocol.md §6). Pure.
public enum ShotGeometry {
    /// A screenshot's long edge, held to `CaptureTuning.edgeRange`. The preview and the watch
    /// size through `output` with their own edges and never pass through here.
    public static func clampEdge(_ maxEdge: Int) -> Int {
        min(max(maxEdge, CaptureTuning.edgeRange.lowerBound), CaptureTuning.edgeRange.upperBound)
    }

    /// The window at `pointPixelScale` native pixels per point, cut to `maxEdge` on its long edge
    /// and to `pixelCap` pixels, never upscaled. One scale for both axes, floored once, so a pixel
    /// maps back to the window inside one pixel.
    public static func output(
        points: CGSize,
        pointPixelScale: Double,
        maxEdge: Int,
        pixelCap: Int = CaptureTuning.pixelCap
    ) -> ShotSize {
        let pointsWidth = Double(points.width), pointsHeight = Double(points.height)
        let nativeWidth = pointsWidth * pointPixelScale, nativeHeight = pointsHeight * pointPixelScale
        guard nativeWidth > 0, nativeHeight > 0 else {
            return ShotSize(width: 1, height: 1, scale: pointPixelScale)
        }
        let k = min(
            1,
            Double(maxEdge) / max(nativeWidth, nativeHeight),
            (Double(pixelCap) / (nativeWidth * nativeHeight)).squareRoot()
        )
        let scale = pointPixelScale * k
        return ShotSize(width: pixels(pointsWidth * scale), height: pixels(pointsHeight * scale), scale: scale)
    }

    /// A zoom: the region (window points, clamped to the window) at full resolution fitted to
    /// `maxEdge`. Single-window capture ignores `sourceRect`, so the whole window is captured at
    /// the zoom's scale (`capture`, never written, so not held to the pixel cap) and `crop` cuts
    /// the region out of it, in that image's pixels. The crop's size is `output` of the region.
    public static func zoom(
        window: CGSize,
        region: CGRect,
        pointPixelScale: Double,
        maxEdge: Int
    ) -> (capture: ShotSize, crop: CGRect) {
        let area = clampedRegion(region, to: window)
        let fitted = output(points: area.size, pointPixelScale: pointPixelScale, maxEdge: clampEdge(maxEdge))
        let scale = fitted.scale
        let capture = ShotSize(
            width: pixels(Double(window.width) * scale),
            height: pixels(Double(window.height) * scale),
            scale: scale
        )
        let width = min(fitted.width, capture.width), height = min(fitted.height, capture.height)
        let x = min(Int((Double(area.minX) * scale).rounded(.down)), capture.width - width)
        let y = min(Int((Double(area.minY) * scale).rounded(.down)), capture.height - height)
        return (capture, CGRect(x: max(0, x), y: max(0, y), width: width, height: height))
    }

    /// The part of a stream's pixel buffer that holds the window: the sample's content rect
    /// times its pixels per point, rounded to whole pixels and kept inside the buffer. A sample
    /// held across a resize crops by its own metadata, never the stream's current size.
    public static func contentCrop(
        contentRect: CGRect,
        pixelsPerPoint: Double,
        bufferWidth: Int,
        bufferHeight: Int
    ) -> CGRect {
        let minX = clamp(Int((Double(contentRect.minX) * pixelsPerPoint).rounded()), 0, bufferWidth)
        let minY = clamp(Int((Double(contentRect.minY) * pixelsPerPoint).rounded()), 0, bufferHeight)
        let maxX = clamp(Int((Double(contentRect.maxX) * pixelsPerPoint).rounded()), minX, bufferWidth)
        let maxY = clamp(Int((Double(contentRect.maxY) * pixelsPerPoint).rounded()), minY, bufferHeight)
        guard maxX > minX, maxY > minY else {
            return CGRect(x: 0, y: 0, width: bufferWidth, height: bufferHeight)
        }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    /// The region inside the window; one that misses it entirely becomes the window point
    /// nearest its origin, so a zoom always has something to show.
    static func clampedRegion(_ region: CGRect, to window: CGSize) -> CGRect {
        let bounds = CGRect(origin: .zero, size: window)
        let area = region.standardized.intersection(bounds)
        if !area.isNull, area.width > 0, area.height > 0 { return area }
        let x = min(max(region.standardized.minX, 0), max(window.width - 1, 0))
        let y = min(max(region.standardized.minY, 0), max(window.height - 1, 0))
        return CGRect(x: x, y: y, width: min(1, window.width), height: min(1, window.height))
    }

    /// Whole pixels from a scaled length; the nudge keeps a length that is an integer in exact
    /// arithmetic (800 × 1.6) from flooring one short.
    static func pixels(_ length: Double) -> Int {
        max(1, Int((length + 1e-9).rounded(.down)))
    }

    private static func clamp(_ value: Int, _ low: Int, _ high: Int) -> Int {
        min(max(value, low), high)
    }
}
