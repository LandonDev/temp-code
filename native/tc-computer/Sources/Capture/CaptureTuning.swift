import Foundation

/// Every number the Capture module runs on, in one place (docs/computer-protocol.md §6).
/// `src/shared/computer/captureParity.test.ts` reads this file with fixed patterns and holds the
/// mirrored values equal to `SHOT` and `PREVIEW_STREAM` in protocol.ts: keep each one a single
/// `public static let name = literal` line.
public enum CaptureTuning {
    // Screenshots (SHOT in protocol.ts)
    public static let jpegQuality = 0.85
    public static let edgeDefault = 1_280
    public static let edgeRange = 512...2_576
    public static let pixelCap = 3_750_000
    /// Flatness at or above which a shot with no named format is also tried as PNG (A1).
    public static let flatPNG = 0.85
    public static let shotTimeout: Duration = .seconds(5)

    // The preview stream (PREVIEW_STREAM in protocol.ts)
    public static let streamFPSDefault = 4
    public static let streamFPSRange = 1...15
    public static let streamEdgeDefault = 960
    public static let streamEdgeRange = 256...2_576
    /// A frame's JPEG stays under this, so its base64 line with the JSON around it fits the
    /// wire's 512 KiB frame cap.
    public static let frameJPEGCap = 380 * 1_024
    public static let frameQualityLadder = [0.85, 0.7, 0.55]
    public static let unackedSlots = 2
    /// A frame unacked this long stops the stream's capture until the next ack.
    public static let starveAfter: Duration = .seconds(5)
    /// The stream's own clock for the starvation check.
    public static let streamTick: Duration = .seconds(1)
    /// A content rect off the configured aspect by more than this resizes the stream.
    public static let resizeTolerance = 0.01
    public static let resizeEvery: Duration = .milliseconds(250)
    public static let streamQueueDepth = 3

    // The watch stream (the pixel signal for the smart wait)
    public static let watchEdge = 256
    public static let watchFPS = 10
    public static let watchLinger: Duration = .seconds(30)
    public static let baselineWait: Duration = .milliseconds(300)

    public static let changeRule = ChangeRule.standard
}

extension Duration {
    /// The duration in milliseconds, for the pure types' injected clocks.
    @usableFromInline var milliseconds: Double {
        let (seconds, attoseconds) = components
        return Double(seconds) * 1_000 + Double(attoseconds) / 1e15
    }
}
