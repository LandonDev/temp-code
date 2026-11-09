import Foundation

/// What Capture's streams did, as it happened: for the live proof (capture-proof) and the
/// shell's debug log. Nothing needs it to use Capture; with no `trace` closure nothing is built.
/// Called on the stream's own serial queue, so a handler must be quick and thread-safe.
public enum CaptureTrace: Sendable {
    /// Where a stream stopped from.
    public enum StopCause: Sendable, Equatable {
        /// ScreenCaptureKit's delegate said `didStopWithError`, with its domain and code.
        case delegate(domain: String, code: Int)
        /// The one-second check found the window's live bounds gone.
        case windowGone
        /// The watch went unused for `watchLinger`.
        case linger
        /// `stop()` on the handle.
        case handle
        /// `startCapture` failed.
        case startFailed(domain: String, code: Int)
    }

    /// A preview sample with new pixels, before flow control: its metadata as ScreenCaptureKit
    /// gave it, and whether a slot took it (false: held, or the stream is stopping).
    case previewSample(window: UInt32, displayTime: UInt64, contentRect: CGRect?, contentScale: Double?, scaleFactor: Double, bufferWidth: Int, bufferHeight: Int, crop: CGRect?, taken: Bool)
    /// A preview frame went to `onFrame`: `sampleTime` is its sample's display time.
    case previewFrame(window: UInt32, seq: Int, bytes: Int, width: Int, height: Int, encodeMs: Double, sampleTime: UInt64)
    /// Starvation stopped capturing; an ack started it again.
    case previewPaused(window: UInt32)
    case previewResumed(window: UInt32)
    case previewEnded(window: UInt32, cause: StopCause, reason: String)
    /// A watch sample, as the judge saw it: `dirty` exactly as ScreenCaptureKit gave it, and the
    /// rects the judge read (in frame pixels).
    case watchFrame(window: UInt32, complete: Bool, width: Int, height: Int, dirty: [CGRect]?, judged: [CGRect]?, counted: Bool, displayTime: UInt64)
    case watchStopped(window: UInt32, cause: StopCause)
}

public typealias CaptureTraceHandler = @Sendable (CaptureTrace) -> Void
