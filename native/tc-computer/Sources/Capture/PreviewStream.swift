#if canImport(ScreenCaptureKit)

import ComputerCore
import CoreMedia
import CoreVideo
import Foundation
import os
@preconcurrency import ScreenCaptureKit
import VideoToolbox

/// One preview stream: an SCStream on the window, frames out as JPEG while someone acks them
/// (docs/computer-protocol.md §6).
///
/// Only new pixels are sent: an `idle` sample sends nothing. `FrameGate` holds the flow control
/// (two frames out, the newest held) and the starvation clock; `StreamLifecycle` orders the
/// pause, resume and stop calls. Samples, acks, the clock and capture completions all run on the
/// stream's serial queue; the lock guards the state against `ended()` and `startSize` readers.
final class PreviewStream: NSObject, StreamHandle, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    /// A sample kept for sending: its buffer with the metadata to crop it by, so a sample held
    /// across a resize crops by its own content rect.
    struct Sample: @unchecked Sendable {
        let buffer: CVPixelBuffer
        let contentRect: CGRect?
        let scaleFactor: Double
        let displayTime: UInt64
    }

    private struct State {
        var gate = FrameGate<Sample>()
        var novelty = PixelNovelty()
        var life = StreamLifecycle()
        var size: ShotSize
        /// The window size (points) the stream is configured for.
        var points: CGSize
        var lastResizeMs = -Double.infinity
        var reason: StreamEndReason?
        var cause: CaptureTrace.StopCause?
        var finished: StreamEndReason?
        var waiters: [CheckedContinuation<StreamEndReason, Never>] = []
    }

    let startSize: (width: Int, height: Int)
    private let windowID: UInt32
    private let filter: SCContentFilter
    private let pointPixelScale: Double
    private let fps: Int
    private let maxEdge: Int
    private let onFrame: @Sendable (Frame) -> Void
    private let log: @Sendable (String) -> Void
    private let trace: CaptureTraceHandler?
    private let queue: DispatchQueue
    private let state: OSAllocatedUnfairLock<State>
    private var stream: SCStream?
    private var clock: DispatchSourceTimer?

    init(windowID: UInt32, filter: SCContentFilter, points: CGSize, fps: Int, maxEdge: Int, onFrame: @escaping @Sendable (Frame) -> Void, log: @escaping @Sendable (String) -> Void, trace: CaptureTraceHandler? = nil) {
        self.windowID = windowID
        self.filter = filter
        self.pointPixelScale = Double(filter.pointPixelScale)
        self.fps = fps
        self.maxEdge = maxEdge
        self.onFrame = onFrame
        self.log = log
        self.trace = trace
        let size = ShotGeometry.output(points: points, pointPixelScale: Double(filter.pointPixelScale), maxEdge: maxEdge)
        // The frames' size: the crop of the window inside the buffer, not the buffer.
        startSize = ShotGeometry.fitted(points: points, in: size)
        queue = DispatchQueue(label: "tc.capture.preview.\(windowID).\(UUID().uuidString.prefix(8))")
        state = OSAllocatedUnfairLock(uncheckedState: State(size: size, points: points))
        super.init()
    }

    func start() async throws {
        let size = state.withLockUnchecked { $0.size }
        let stream = SCStream(filter: filter, configuration: configuration(size), delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        self.stream = stream
        try await withDeadline(CaptureTuning.streamStartTimeout, failure: ComputerFailure.captureTimedOut) { try await stream.startCapture() }
        queue.async { self.startClock() }
    }

    // MARK: StreamHandle

    func stop() async {
        queue.async {
            // The reason is ours before the stop goes out, so an error ScreenCaptureKit reports
            // while our own stopCapture is in flight never turns the shell's stop into `.error`.
            let command = self.state.withLockUnchecked { state -> StreamLifecycle.Command? in
                if state.reason == nil { state.reason = .stopped }
                if state.cause == nil { state.cause = .handle }
                return state.life.stop()
            }
            if let command { self.run(command) }
        }
        _ = await ended()
    }

    func ack(_ seq: Int) {
        queue.async {
            let (send, command) = self.state.withLockUnchecked { state -> (Sample?, StreamLifecycle.Command?) in
                guard !state.life.isEnding else { return (nil, nil) }
                let ack = state.gate.ack(seq, atMs: monotonicMs())
                return (ack.send, ack.resume ? state.life.resume() : nil)
            }
            if command != nil { self.trace?(.previewResumed(window: self.windowID)) }
            if let command { self.run(command) }
            if let send { self.send(send) }
        }
    }

    func ended() async -> StreamEndReason {
        await withCheckedContinuation { continuation in
            let finished = state.withLockUnchecked { state -> StreamEndReason? in
                if state.finished == nil { state.waiters.append(continuation) }
                return state.finished
            }
            if let finished { continuation.resume(returning: finished) }
        }
    }

    // MARK: Samples

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, let info = FrameInfo(sampleBuffer), info.status == .complete, let buffer = sampleBuffer.imageBuffer else { return }
        // A complete sample of a covered window may hold the same pixels as the last: not new.
        let fingerprint = Self.fingerprint(buffer)
        let sample = Sample(buffer: buffer, contentRect: info.contentRect, scaleFactor: info.scaleFactor, displayTime: info.displayTime)
        let (offered, fresh) = state.withLockUnchecked { state -> (Sample?, Bool) in
            switch state.life.state {
            case .stopping, .stopped: return (nil, false)
            default:
                guard state.novelty.isNew(fingerprint: fingerprint, width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer)) else { return (nil, false) }
                return (state.gate.offer(sample), true)
            }
        }
        guard fresh else { return }
        if let trace {
            let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
            trace(.previewSample(
                window: windowID, displayTime: info.displayTime, contentRect: info.contentRect, contentScale: info.contentScale,
                scaleFactor: info.scaleFactor, bufferWidth: width, bufferHeight: height,
                crop: Self.crop(sample, bufferWidth: width, bufferHeight: height), taken: offered != nil
            ))
        }
        resizeIfNeeded(info.contentRect)
        if let offered { send(offered) }
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        queue.async {
            var reason = CaptureErrors.endReason(error)
            if case .error = reason, LiveWindows.bounds(self.windowID) == nil { reason = .windowClosed }
            let error = error as NSError
            self.end(reason, cause: .delegate(domain: error.domain, code: error.code), capturing: false)
        }
    }

    /// Encodes and sends a sample whose slot is reserved; a frame over the cap is dropped and
    /// the held sample, if any, takes its slot.
    private func send(_ sample: Sample) {
        let startMs = monotonicMs()
        guard let frame = encode(sample) else {
            if let next = state.withLockUnchecked({ $0.gate.notSent() }) { send(next) }
            return
        }
        let encodeMs = monotonicMs() - startMs
        let seq = state.withLockUnchecked { $0.gate.sent(atMs: monotonicMs()) }
        trace?(.previewFrame(window: windowID, seq: seq, bytes: frame.data.count, width: frame.width, height: frame.height, encodeMs: encodeMs, sampleTime: sample.displayTime))
        onFrame(Frame(seq: seq, jpeg: frame.data, width: frame.width, height: frame.height, ts: epochMs()))
    }

    /// The BGRA buffer's fingerprint (PixelStats.fingerprint).
    static func fingerprint(_ buffer: CVPixelBuffer) -> UInt64 {
        guard CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else { return 0 }
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return 0 }
        let height = CVPixelBufferGetHeight(buffer), bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        let plane = UnsafeRawBufferPointer(start: base, count: bytesPerRow * height)
        return PixelStats.fingerprint(plane: plane, rowBytes: CVPixelBufferGetWidth(buffer) * 4, height: height, bytesPerRow: bytesPerRow)
    }

    /// The part of the sample's buffer that holds the window.
    static func crop(_ sample: Sample, bufferWidth: Int, bufferHeight: Int) -> CGRect? {
        sample.contentRect.map {
            ShotGeometry.contentCrop(contentRect: $0, pixelsPerPoint: sample.scaleFactor, bufferWidth: bufferWidth, bufferHeight: bufferHeight)
        }
    }

    /// The sample cropped to its window and fitted under the frame cap; nil (logged) drops it.
    private func encode(_ sample: Sample) -> (data: Data, width: Int, height: Int)? {
        var whole: CGImage?
        guard VTCreateCGImageFromCVPixelBuffer(sample.buffer, options: nil, imageOut: &whole) == noErr, let whole else {
            log("preview stream \(windowID): dropped a frame the pixel buffer could not become an image")
            return nil
        }
        let crop = Self.crop(sample, bufferWidth: whole.width, bufferHeight: whole.height)
        let image = crop.flatMap { whole.cropping(to: $0) } ?? whole
        guard let jpeg = try? ImageEncoding.frameJPEG(encode: { try ImageEncoding.jpeg(image, quality: $0) }) else {
            log("preview stream \(windowID): dropped a frame still over \(CaptureTuning.frameJPEGCap / 1_024) KiB at quality \(CaptureTuning.frameQualityLadder.last ?? 0)")
            return nil
        }
        return (jpeg.data, image.width, image.height)
    }

    // MARK: The clock, the lifecycle and the end

    private func startClock() {
        // An error can end the stream between startCapture returning and this running.
        guard state.withLockUnchecked({ $0.finished == nil }) else { return }
        let clock = DispatchSource.makeTimerSource(queue: queue)
        let every = CaptureTuning.streamTick
        clock.schedule(deadline: .now() + every.timeInterval, repeating: every.timeInterval)
        clock.setEventHandler { [weak self] in self?.tick() }
        clock.resume()
        self.clock = clock
    }

    private func tick() {
        if LiveWindows.bounds(windowID) == nil {
            end(.windowClosed, cause: .windowGone, capturing: true)
            return
        }
        let command = state.withLockUnchecked { state in state.gate.tick(atMs: monotonicMs()) ? state.life.pause() : nil }
        if let command {
            trace?(.previewPaused(window: windowID))
            run(command)
        }
    }

    private func run(_ command: StreamLifecycle.Command) {
        switch command {
        case .stopCapture:
            stream?.stopCapture { _ in self.queue.async { self.completed() } }
        case .startCapture:
            stream?.startCapture { error in
                self.queue.async {
                    if let error {
                        let code = error as NSError
                        self.end(CaptureErrors.endReason(error), cause: .startFailed(domain: code.domain, code: code.code), capturing: false)
                    } else {
                        self.completed()
                    }
                }
            }
        case .finish:
            finish()
        }
    }

    private func completed() {
        if let next = state.withLockUnchecked({ $0.life.completed() }) { run(next) }
    }

    /// The stream ended without a `stop()`: say why. When ScreenCaptureKit may still be capturing
    /// (the window went before it said so), stop through the lifecycle, which waits for a start in
    /// flight; when it stopped the stream itself, finish at once.
    private func end(_ reason: StreamEndReason, cause: CaptureTrace.StopCause, capturing: Bool) {
        let command = state.withLockUnchecked { state -> StreamLifecycle.Command? in
            if state.reason == nil { state.reason = reason }
            if state.cause == nil { state.cause = cause }
            return capturing ? state.life.stop() : state.life.endedBySystem()
        }
        if let command { run(command) }
    }

    private func finish() {
        clock?.cancel()
        clock = nil
        let (reason, cause, waiters) = state.withLockUnchecked { state -> (StreamEndReason, CaptureTrace.StopCause, [CheckedContinuation<StreamEndReason, Never>]) in
            let reason = state.reason ?? .stopped
            state.finished = reason
            state.gate = FrameGate()   // drops a held sample's buffer
            defer { state.waiters = [] }
            return (reason, state.cause ?? .handle, state.waiters)
        }
        stream = nil
        trace?(.previewEnded(window: windowID, cause: cause, reason: "\(reason)"))
        for waiter in waiters { waiter.resume(returning: reason) }
    }

    // MARK: Resize

    /// A content rect off the aspect of the window size the stream was configured for by more than
    /// 1% means the window resized and the frame is letterboxed: the stream takes the window's live
    /// size, at most every 250 ms. (Against the window's aspect, not the buffer's: whole pixels put
    /// a short window's buffer more than 1% off its aspect for good.)
    private func resizeIfNeeded(_ contentRect: CGRect?) {
        guard let rect = contentRect, rect.width > 0, rect.height > 0 else { return }
        let due = state.withLockUnchecked { state -> Bool in
            let configured = Double(state.points.width) / Double(state.points.height)
            let actual = Double(rect.width) / Double(rect.height)
            return abs(actual - configured) / configured > CaptureTuning.resizeTolerance
                && monotonicMs() - state.lastResizeMs >= CaptureTuning.resizeEvery.milliseconds
        }
        guard due, let live = LiveWindows.bounds(windowID)?.size, live.width > 0, live.height > 0 else { return }
        let next = state.withLockUnchecked { state -> ShotSize in
            state.lastResizeMs = monotonicMs()
            state.points = live
            state.size = ShotGeometry.output(points: live, pointPixelScale: pointPixelScale, maxEdge: maxEdge)
            return state.size
        }
        stream?.updateConfiguration(configuration(next)) { _ in }
    }

    private func configuration(_ size: ShotSize) -> SCStreamConfiguration {
        let configuration = ScreenCaptureKitCapture.configuration(width: size.width, height: size.height, pixelFormat: kCVPixelFormatType_32BGRA)
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        configuration.queueDepth = CaptureTuning.streamQueueDepth
        return configuration
    }
}

extension Duration {
    var timeInterval: DispatchTimeInterval {
        .nanoseconds(Int(milliseconds * 1e6))
    }
}

#endif
