#if canImport(ScreenCaptureKit)

import AppKit
import Capture
import ComputerCore
import CoreMedia
import Darwin
import Foundation
import os
@preconcurrency import ScreenCaptureKit

/// Monotonic milliseconds on mach time's clock, so a frame's displayTime compares directly.
func nowMs() -> Double {
    Double(DispatchTime.now().uptimeNanoseconds) / 1e6
}

func machToMs(_ time: UInt64) -> Double {
    Double(time) * timebase / 1e6
}

private let timebase: Double = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return Double(info.numer) / Double(info.denom)
}()

/// Everything Capture's trace said, with when it arrived.
final class TraceLog: @unchecked Sendable {
    struct Entry: Sendable {
        let atMs: Double
        let event: CaptureTrace
    }

    private let entries = OSAllocatedUnfairLock<[Entry]>(initialState: [])

    func record(_ event: CaptureTrace) {
        let entry = Entry(atMs: nowMs(), event: event)
        entries.withLock { $0.append(entry) }
    }

    func since(_ ms: Double) -> [Entry] {
        entries.withLock { $0.filter { $0.atMs >= ms } }
    }

    struct WatchSeen {
        let atMs: Double
        let complete: Bool
        let counted: Bool
        let displayMs: Double
        let dirty: [CGRect]?
        let judged: [CGRect]?
        let width: Int
        let height: Int
    }

    func watchFrames(_ window: UInt32, since ms: Double, until end: Double = .infinity) -> [WatchSeen] {
        since(ms).compactMap { entry in
            guard entry.atMs <= end, case let .watchFrame(id, complete, width, height, dirty, judged, counted, displayTime) = entry.event, id == window else { return nil }
            return WatchSeen(atMs: entry.atMs, complete: complete, counted: counted, displayMs: machToMs(displayTime), dirty: dirty, judged: judged, width: width, height: height)
        }
    }
}

/// A preview stream's frames as the shell would get them, acked after `ackAfter` when `autoAck`.
final class FrameBox: @unchecked Sendable {
    struct Got: Sendable {
        let frame: Frame
        let atMs: Double
    }

    private let got = OSAllocatedUnfairLock<[Got]>(initialState: [])
    private let handle = OSAllocatedUnfairLock<(any StreamHandle)?>(uncheckedState: nil)
    private let acking = OSAllocatedUnfairLock<Bool>(initialState: true)
    /// Seconds.
    let ackAfter: Double

    init(autoAck: Bool, ackAfter: Double = 0.05) {
        acking.withLock { $0 = autoAck }
        self.ackAfter = ackAfter
    }

    func attach(_ stream: any StreamHandle) {
        handle.withLockUnchecked { $0 = stream }
    }

    var autoAck: Bool {
        get { acking.withLock { $0 } }
        set { acking.withLock { $0 = newValue } }
    }

    func onFrame(_ frame: Frame) {
        let entry = Got(frame: frame, atMs: nowMs())
        got.withLock { $0.append(entry) }
        if autoAck { ackLater(frame.seq) }
    }

    private func ackLater(_ seq: Int) {
        DispatchQueue.global().asyncAfter(deadline: .now() + ackAfter) {
            if let stream = self.handle.withLockUnchecked({ $0 }) {
                stream.ack(seq)
            } else {
                self.ackLater(seq)
            }
        }
    }

    func ack(_ seq: Int) {
        handle.withLockUnchecked { $0 }?.ack(seq)
    }

    var frames: [Got] { got.withLock { $0 } }
}

/// A raw SCStream of the proof's own, for scene 0: what ScreenCaptureKit gives before Capture
/// reads it (status, dirty rects, the content rect and its scales).
final class RawProbe: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    struct Sample: Sendable {
        let atMs: Double
        let status: Int
        let dirty: [CGRect]?
        let contentRect: CGRect?
        let contentScale: Double?
        let scaleFactor: Double?
        let bufferWidth: Int
        let bufferHeight: Int
        /// The bounding box of the buffer's non-black pixels (BGRA only, when asked).
        let content: CGRect?
        /// A hash of the whole buffer (plane 0), and of its top 10% and the rest.
        let hash: UInt64
        let topHash: UInt64
        let restHash: UInt64
    }

    private let samples = OSAllocatedUnfairLock<[Sample]>(initialState: [])
    private let measuring = OSAllocatedUnfairLock<Bool>(initialState: false)
    private let queue = DispatchQueue(label: "tc.capture-proof.raw")
    private var stream: SCStream?
    let bgra: Bool

    init(filter: SCContentFilter, width: Int, height: Int, bgra: Bool, fps: Int) throws {
        self.bgra = bgra
        super.init()
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.showsCursor = false
        configuration.ignoreShadowsSingleWindow = true
        configuration.ignoreGlobalClipSingleWindow = true
        configuration.captureResolution = .best
        configuration.pixelFormat = bgra ? kCVPixelFormatType_32BGRA : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        configuration.queueDepth = 3
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        self.stream = stream
    }

    func start() async throws { try await stream?.startCapture() }
    func stop() async { try? await stream?.stopCapture() }

    var measureContent: Bool {
        get { measuring.withLock { $0 } }
        set { measuring.withLock { $0 = newValue } }
    }

    func all() -> [Sample] { samples.withLock { $0 } }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let first = attachments.first,
              let status = first[.status] as? Int
        else { return }
        let rect = (first[.contentRect] as? NSDictionary).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) }
        let dirty = (first[.dirtyRects] as? [NSDictionary])?.compactMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) }
        var width = 0, height = 0
        var content: CGRect?
        var hashes: (UInt64, UInt64, UInt64) = (0, 0, 0)
        if let buffer = sampleBuffer.imageBuffer {
            width = CVPixelBufferGetWidth(buffer)
            height = CVPixelBufferGetHeight(buffer)
            if bgra, status == SCFrameStatus.complete.rawValue, measureContent { content = Self.contentBox(buffer) }
            hashes = Self.hashes(buffer)
        }
        let sample = Sample(
            atMs: nowMs(), status: status, dirty: dirty, contentRect: rect,
            contentScale: (first[.contentScale] as? NSNumber)?.doubleValue, scaleFactor: (first[.scaleFactor] as? NSNumber)?.doubleValue,
            bufferWidth: width, bufferHeight: height, content: content, hash: hashes.0, topHash: hashes.1, restHash: hashes.2
        )
        samples.withLock { $0.append(sample) }
    }

    static func hashes(_ buffer: CVPixelBuffer) -> (UInt64, UInt64, UInt64) {
        guard CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else { return (0, 0, 0) }
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let planar = CVPixelBufferIsPlanar(buffer)
        guard let base = planar ? CVPixelBufferGetBaseAddressOfPlane(buffer, 0) : CVPixelBufferGetBaseAddress(buffer) else { return (0, 0, 0) }
        let height = planar ? CVPixelBufferGetHeightOfPlane(buffer, 0) : CVPixelBufferGetHeight(buffer)
        let width = planar ? CVPixelBufferGetWidthOfPlane(buffer, 0) : CVPixelBufferGetWidth(buffer)
        let stride = planar ? CVPixelBufferGetBytesPerRowOfPlane(buffer, 0) : CVPixelBufferGetBytesPerRow(buffer)
        let rowBytes = planar ? width : width * 4
        var all: UInt64 = 1469598103934665603, top: UInt64 = 1469598103934665603, rest: UInt64 = 1469598103934665603
        let split = height / 10
        for y in 0..<height {
            let row = base.advanced(by: y * stride).assumingMemoryBound(to: UInt8.self)
            var h: UInt64 = 1469598103934665603
            for x in 0..<rowBytes { h = (h ^ UInt64(row[x])) &* 1099511628211 }
            all = (all ^ h) &* 1099511628211
            if y < split { top = (top ^ h) &* 1099511628211 } else { rest = (rest ^ h) &* 1099511628211 }
        }
        return (all, top, rest)
    }

    /// The box of pixels brighter than near-black: the window inside any letterbox bars.
    static func contentBox(_ buffer: CVPixelBuffer) -> CGRect? {
        guard CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else { return nil }
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer), stride = CVPixelBufferGetBytesPerRow(buffer)
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        var minX = width, minY = height, maxX = -1, maxY = -1
        for y in 0..<height {
            let row = bytes + y * stride
            for x in 0..<width {
                let pixel = row + x * 4
                if Int(pixel[0]) + Int(pixel[1]) + Int(pixel[2]) > 60 && pixel[3] > 0 {
                    minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
                }
            }
        }
        guard maxX >= minX, maxY >= minY else { return nil }
        return CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
    }
}

/// Pixel checks on a decoded image (BGRA through Capture's Bitmap).
enum Pixels {
    /// The centre of the pure red marker, in image pixels (pixel centres at +0.5).
    static func redCentroid(_ bitmap: Bitmap, within area: CGRect? = nil) -> (centre: CGPoint, count: Int)? {
        var sumX = 0.0, sumY = 0.0, count = 0
        let box = area ?? CGRect(x: 0, y: 0, width: bitmap.width, height: bitmap.height)
        let x0 = max(0, Int(box.minX)), x1 = min(bitmap.width, Int(box.maxX.rounded(.up)))
        let y0 = max(0, Int(box.minY)), y1 = min(bitmap.height, Int(box.maxY.rounded(.up)))
        guard x0 < x1, y0 < y1 else { return nil }
        for y in y0..<y1 {
            for x in x0..<x1 {
                let i = y * bitmap.bytesPerRow + x * 4
                let b = bitmap.bytes[i], g = bitmap.bytes[i + 1], r = bitmap.bytes[i + 2]
                if r > 200, g < 60, b < 60 {
                    sumX += Double(x) + 0.5; sumY += Double(y) + 0.5; count += 1
                }
            }
        }
        guard count > 0 else { return nil }
        return (CGPoint(x: sumX / Double(count), y: sumY / Double(count)), count)
    }

    /// The share of pixels within `tolerance` of an RGB colour.
    static func share(_ bitmap: Bitmap, r: Int, g: Int, b: Int, tolerance: Int = 4, area: CGRect? = nil) -> Double {
        let box = area ?? CGRect(x: 0, y: 0, width: bitmap.width, height: bitmap.height)
        let x0 = max(0, Int(box.minX)), x1 = min(bitmap.width, Int(box.maxX))
        let y0 = max(0, Int(box.minY)), y1 = min(bitmap.height, Int(box.maxY))
        guard x0 < x1, y0 < y1 else { return 0 }
        var hits = 0
        for y in y0..<y1 {
            for x in x0..<x1 {
                let i = y * bitmap.bytesPerRow + x * 4
                if abs(Int(bitmap.bytes[i + 2]) - r) <= tolerance, abs(Int(bitmap.bytes[i + 1]) - g) <= tolerance, abs(Int(bitmap.bytes[i]) - b) <= tolerance {
                    hits += 1
                }
            }
        }
        return Double(hits) / Double((x1 - x0) * (y1 - y0))
    }

    /// The share of each edge (first and last row and column) that is near-black: letterbox bars.
    static func blackEdges(_ bitmap: Bitmap) -> [String: Double] {
        func dark(_ x: Int, _ y: Int) -> Bool {
            let i = y * bitmap.bytesPerRow + x * 4
            return Int(bitmap.bytes[i]) + Int(bitmap.bytes[i + 1]) + Int(bitmap.bytes[i + 2]) < 45
        }
        let w = bitmap.width, h = bitmap.height
        func shareOf(_ points: [(Int, Int)]) -> Double { Double(points.filter { dark($0.0, $0.1) }.count) / Double(max(points.count, 1)) }
        return [
            "top": shareOf((0..<w).map { ($0, 0) }),
            "bottom": shareOf((0..<w).map { ($0, h - 1) }),
            "left": shareOf((0..<h).map { (0, $0) }),
            "right": shareOf((0..<h).map { (w - 1, $0) }),
        ]
    }

    /// The box of pixels that differ by more than 24 levels in a channel (JPEG noise stays under).
    static func differenceBox(_ a: Bitmap, _ b: Bitmap) -> CGRect? {
        guard a.width == b.width, a.height == b.height else { return CGRect(x: 0, y: 0, width: max(a.width, b.width), height: max(a.height, b.height)) }
        var minX = a.width, minY = a.height, maxX = -1, maxY = -1
        for y in 0..<a.height {
            for x in 0..<a.width {
                let i = y * a.bytesPerRow + x * 4
                if (0..<3).contains(where: { abs(Int(a.bytes[i + $0]) - Int(b.bytes[i + $0])) > 24 }) {
                    minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
                }
            }
        }
        return maxX < 0 ? nil : CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
    }

    /// Where the block (a colour of the palette) sits: the mean x of its pixels.
    static func blockX(_ bitmap: Bitmap, colour: CGColor) -> Double? {
        guard let c = colour.components, c.count >= 3 else { return nil }
        let r = Int(c[0] * 255), g = Int(c[1] * 255), b = Int(c[2] * 255)
        var sum = 0.0, count = 0
        for y in stride(from: 0, to: bitmap.height, by: 2) {
            for x in 0..<bitmap.width {
                let i = y * bitmap.bytesPerRow + x * 4
                if abs(Int(bitmap.bytes[i + 2]) - r) <= 12, abs(Int(bitmap.bytes[i + 1]) - g) <= 12, abs(Int(bitmap.bytes[i]) - b) <= 12 {
                    sum += Double(x); count += 1
                }
            }
        }
        return count > 50 ? sum / Double(count) : nil
    }
}

/// CPU time: the whole process, and the main thread alone (the proof's drawing).
enum Cpu {
    static func process() -> Double {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        return seconds(usage.ru_utime) + seconds(usage.ru_stime)
    }

    /// Call on the main thread.
    static func mainThread() -> Double {
        var info = thread_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<thread_basic_info>.size / MemoryLayout<integer_t>.size)
        let port = pthread_mach_thread_np(pthread_self())
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { thread_info(port, thread_flavor_t(THREAD_BASIC_INFO), $0, &count) }
        }
        guard result == KERN_SUCCESS else { return 0 }
        return Double(info.user_time.seconds) + Double(info.user_time.microseconds) / 1e6
            + Double(info.system_time.seconds) + Double(info.system_time.microseconds) / 1e6
    }

    private static func seconds(_ time: timeval) -> Double {
        Double(time.tv_sec) + Double(time.tv_usec) / 1e6
    }

    struct Span {
        let wallMs: Double
        let processMs: Double
        let mainMs: Double
        var processShare: Double { processMs / wallMs }
        var offMainShare: Double { (processMs - mainMs) / wallMs }
    }

    @MainActor static func measure(_ body: () async throws -> Void) async rethrows -> Span {
        let wall = nowMs(), process = process(), main = mainThread()
        try await body()
        return Span(wallMs: nowMs() - wall, processMs: (Cpu.process() - process) * 1_000, mainMs: (mainThread() - main) * 1_000)
    }
}

/// How long `body` took, in ms.
@MainActor func timed<T>(_ body: () async throws -> T) async rethrows -> (T, Double) {
    let start = nowMs()
    let value = try await body()
    return (value, nowMs() - start)
}

func pause(_ ms: Int) async {
    try? await Task.sleep(for: .milliseconds(ms))
}

#endif
