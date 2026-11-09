#if canImport(ScreenCaptureKit)

import CoreMedia
import Foundation
@preconcurrency import ScreenCaptureKit

/// What a stream sample's attachments say about it.
struct FrameInfo {
    let status: SCFrameStatus
    /// Where the window sits in the buffer, in points; times `scaleFactor` it is buffer pixels.
    let contentRect: CGRect?
    let scaleFactor: Double
    /// The content's size against the frame's: below 1 when the stream scales the window down.
    let contentScale: Double?
    /// The compositor's dirty rects; nil when the attachment is missing.
    let dirtyRects: [CGRect]?
    /// mach_absolute_time of the frame
    let displayTime: UInt64

    init?(_ sample: CMSampleBuffer) {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let first = attachments.first,
              let raw = first[.status] as? Int,
              let status = SCFrameStatus(rawValue: raw)
        else { return nil }
        self.status = status
        contentRect = (first[.contentRect] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) }
        scaleFactor = (first[.scaleFactor] as? NSNumber)?.doubleValue ?? 1
        contentScale = (first[.contentScale] as? NSNumber)?.doubleValue
        dirtyRects = (first[.dirtyRects] as? [NSDictionary])?.compactMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) }
        displayTime = (first[.displayTime] as? NSNumber)?.uint64Value ?? mach_absolute_time()
    }
}

/// The monotonic clock the pure types run on, in milliseconds.
func monotonicMs() -> Double {
    Double(DispatchTime.now().uptimeNanoseconds) / 1e6
}

/// Epoch milliseconds, for the wire's timestamps.
func epochMs() -> Double {
    Date().timeIntervalSince1970 * 1_000
}

/// mach_absolute_time units (a frame's `displayTime`) in milliseconds.
func machMs(_ time: UInt64) -> Double {
    Double(time) * machTimebase / 1e6
}

private let machTimebase: Double = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return Double(info.numer) / Double(info.denom)
}()

#endif
