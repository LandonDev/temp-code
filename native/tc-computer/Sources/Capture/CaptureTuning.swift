import ComputerProtocol
import Foundation

/// Every number the Capture module runs on, in one place (docs/computer-protocol.md §6). The
/// ones the wire states come from `ComputerDefaults`, generated from `SHOT` and `PREVIEW_STREAM`
/// in protocol.ts; `src/shared/computer/captureParity.test.ts` reads this file with fixed
/// patterns and fails when one of them is written as a literal here: keep each a single
/// `public static let name = value` line.
public enum CaptureTuning {
    // Screenshots (SHOT in protocol.ts)
    public static let jpegQuality = ComputerDefaults.Shot.jpegQuality
    public static let edgeDefault = ComputerDefaults.Shot.defaultMaxEdge
    public static let edgeRange = ComputerDefaults.Shot.minMaxEdge...ComputerDefaults.Shot.maxMaxEdge
    public static let pixelCap = ComputerDefaults.Shot.maxPixels
    /// Flatness at or above which a shot with no named format is also tried as PNG (A1).
    public static let flatPNG = 0.85
    public static let shotTimeout: Duration = .seconds(5)
    /// ScreenCaptureKit's window list and a stream's start, each bounded: its Swift overlay can leak its
    /// continuation and never answer (a web leg's read hung for good on 2026-11-11), and a read then goes on without
    /// the window's pixels instead of waiting
    public static let listTimeout: Duration = .seconds(3)
    public static let streamStartTimeout: Duration = .seconds(3)

    // The preview stream (PREVIEW_STREAM in protocol.ts)
    public static let streamFPSDefault = ComputerDefaults.PreviewStream.defaultFps
    public static let streamFPSRange = ComputerDefaults.PreviewStream.minFps...ComputerDefaults.PreviewStream.maxFps
    public static let streamEdgeDefault = ComputerDefaults.PreviewStream.defaultMaxEdge
    public static let streamEdgeRange = ComputerDefaults.PreviewStream.minMaxEdge...ComputerDefaults.Shot.maxMaxEdge
    /// A frame's JPEG stays under this, so its base64 line with the JSON around it fits the
    /// wire's 512 KiB frame cap.
    public static let frameJPEGCap = 380 * 1_024
    public static let frameQualityLadder = [jpegQuality, 0.7, 0.55]
    public static let unackedSlots = ComputerDefaults.PreviewStream.maxUnacked
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
    /// Points from the window's top-left the watch never counts: macOS draws its sharing badge
    /// there while a capture runs (docs/computer-protocol.md §22.8, `TITLE_BAR_CORNER` in observation.ts).
    public static let titleBarCorner = CGSize(width: 96, height: 32)
}

extension Duration {
    /// The duration in milliseconds, for the pure types' injected clocks.
    @usableFromInline var milliseconds: Double {
        let (seconds, attoseconds) = components
        return Double(seconds) * 1_000 + Double(attoseconds) / 1e15
    }
}
