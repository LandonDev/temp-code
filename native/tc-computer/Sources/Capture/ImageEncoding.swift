import ComputerProtocol
import Foundation

/// How a shot and a frame are encoded (docs/computer-protocol.md §6). The rules here are pure;
/// the ImageIO calls are in ImageEncoding+ImageIO.swift.
///
/// A shot with no named format is JPEG 0.85, and also PNG when its flatness is at least
/// `CaptureTuning.flatPNG`, the PNG kept when it is no larger (A1): flat UI comes out lossless
/// where that costs nothing, photographic content stays JPEG. Preview frames are always JPEG.
public enum ImageEncoding {
    /// PNG only when it was made and is no larger than the JPEG.
    public static func choose(jpeg: Int, png: Int?) -> ShotFormat {
        if let png, png <= jpeg { return .png }
        return .jpeg
    }

    /// Whether a shot with no named format is worth a PNG too.
    public static func wantsPNG(flatness: Double) -> Bool {
        flatness >= CaptureTuning.flatPNG
    }

    /// A preview frame's JPEG: each quality of the ladder in turn until one fits `cap`; nil
    /// drops the frame (the stream logs one line).
    public static func frameJPEG(
        cap: Int = CaptureTuning.frameJPEGCap,
        qualities: [Double] = CaptureTuning.frameQualityLadder,
        encode: (Double) throws -> Data
    ) rethrows -> (data: Data, quality: Double)? {
        for quality in qualities {
            let data = try encode(quality)
            if data.count <= cap { return (data, quality) }
        }
        return nil
    }
}
