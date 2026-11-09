import Foundation

/// A session pixel ↔ a screen point (docs/computer-protocol.md §6, A6). The session's space is
/// the target window's screenshot: origin at the window frame's top-left, `scale` pixels per
/// window point. Input and the shell both map through here, so a click lands where the model saw it.
public enum CoordinateMapping {
    /// The screen point at the centre of a session pixel: `origin + (p + 0.5) / scale`.
    public static func screenPoint(pixel: [Int], windowOrigin: CGPoint, scale: Double) -> CGPoint {
        precondition(pixel.count == 2, "a session pixel is [x, y]")
        return CGPoint(
            x: Double(windowOrigin.x) + (Double(pixel[0]) + 0.5) / scale,
            y: Double(windowOrigin.y) + (Double(pixel[1]) + 0.5) / scale
        )
    }

    /// The session pixel a screen point falls in: `floor((s − origin) × scale)`.
    /// `pixel(screenPoint(p)) == p` for every pixel.
    public static func pixel(screenPoint: CGPoint, windowOrigin: CGPoint, scale: Double) -> [Int] {
        [
            Int(((Double(screenPoint.x) - Double(windowOrigin.x)) * scale).rounded(.down)),
            Int(((Double(screenPoint.y) - Double(windowOrigin.y)) * scale).rounded(.down)),
        ]
    }
}
