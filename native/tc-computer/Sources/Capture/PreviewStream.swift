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
    }

    private struct State {
        var gate = FrameGate<Sample>()
        var life = StreamLifecycle()
        var size: ShotSize
        var lastResizeMs = -Double.infinity
        var reason: StreamEndReason?
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
    private let queue: DispatchQueue
    private let state: OSAllocatedUnfairLock<State>
    private var stream: SCStream?
    private var clock: DispatchSourceTimer?

    init(windowID: UInt32, filter: SCContentFilter, points: CGSize, fps: Int, maxEdge: Int, onFrame: @escaping @Sendable (Frame) -> Void, log: @escaping @Sendable (String) -> Void) {
        self.windowID = windowID
        self.filter = filter
        self.pointPixelScale = Double(filter.pointPixelScale)
        self.fps = fps
        self.maxEdge = maxEdge
        self.onFrame = onFrame
        self.log = log
        let size = ShotGeometry.output(points: points, pointPixelScale: Double(filter.pointPixelScale), maxEdge: maxEdge)
        startSize = (size.width, size.height)
        queue = DispatchQueue(label: "tc.capture.preview.\(windowID).\(UUID().uuidString.prefix(8))")
        state = OSAllocatedUnfairLock(uncheckedState: State(size: size))
        super.init()
    }

    func start() async throws {
        let size = state.withLockUnchecked { $0.size }
        let stream = SCStream(filter: filter, configuration: configuration(size), delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        self.stream = stream
        try await stream.startCapture()
        queue.async { self.startClock() }
    }

    // MARK: StreamHandle

    func stop() async {
        queue.async {
            // The reason is ours before the stop goes out, so an error ScreenCaptureKit reports
            // while our own stopCapture is in flight never turns the shell's stop into `.error`.
            let command = self.state.withLockUnchecked { state -> StreamLifecycle.Command? in
                if state.reason == nil { state.reason = .stopped }
                return state.life.stop()
            }
            if let command { self.run(command) }
        }
        _ = await ended()
    }

    func ack(_ seq: Int) {
        queue.async {
            let (send, command) = self.state.withLockUnchecked { state -> (Sample?, StreamLifecycle.Command?) in
                let ack = state.gate.ack(seq, atMs: monotonicMs())
                return (ack.send, ack.resume ? state.life.resume() : nil)
            }
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
        let sample = Sample(buffer: buffer, contentRect: info.contentRect, scaleFactor: info.scaleFactor)
        let offered = state.withLockUnchecked { state -> Sample? in
            switch state.life.state {
            case .stopping, .stopped: return nil
            default: return state.gate.offer(sample)
            }
        }
        resizeIfNeeded(info.contentRect)
        if let offered { send(offered) }
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        queue.async {
            var reason = CaptureErrors.endReason(error)
            if case .error = reason, LiveWindows.bounds(self.windowID) == nil { reason = .windowClosed }
            self.end(reason)
        }
    }

    /// Encodes and sends a sample whose slot is reserved; a frame over the cap is dropped and
    /// the held sample, if any, takes its slot.
    private func send(_ sample: Sample) {
        guard let frame = encode(sample) else {
            if let next = state.withLockUnchecked({ $0.gate.notSent() }) { send(next) }
            return
        }
        let seq = state.withLockUnchecked { $0.gate.sent(atMs: monotonicMs()) }
        onFrame(Frame(seq: seq, jpeg: frame.data, width: frame.width, height: frame.height, ts: epochMs()))
    }

    /// The sample cropped to its window and fitted under the frame cap; nil (logged) drops it.
    private func encode(_ sample: Sample) -> (data: Data, width: Int, height: Int)? {
        var whole: CGImage?
        guard VTCreateCGImageFromCVPixelBuffer(sample.buffer, options: nil, imageOut: &whole) == noErr, let whole else {
            log("preview stream \(windowID): dropped a frame the pixel buffer could not become an image")
            return nil
        }
        let crop = sample.contentRect.map {
            ShotGeometry.contentCrop(contentRect: $0, pixelsPerPoint: sample.scaleFactor, bufferWidth: whole.width, bufferHeight: whole.height)
        }
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
            end(.windowClosed)
            return
        }
        let command = state.withLockUnchecked { state in state.gate.tick(atMs: monotonicMs()) ? state.life.pause() : nil }
        if let command { run(command) }
    }

    private func run(_ command: StreamLifecycle.Command) {
        switch command {
        case .stopCapture:
            stream?.stopCapture { _ in self.queue.async { self.completed() } }
        case .startCapture:
            stream?.startCapture { error in
                self.queue.async {
                    if let error {
                        self.end(CaptureErrors.endReason(error))
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

    /// The stream ended without a `stop()`: say why, and stop what is still capturing.
    private func end(_ reason: StreamEndReason) {
        let capturing = state.withLockUnchecked { state -> Bool in
            if state.reason == nil { state.reason = reason }
            return state.life.state == .running || state.life.state == .resuming
        }
        if capturing { stream?.stopCapture { _ in } }
        if let command = state.withLockUnchecked({ $0.life.endedBySystem() }) { run(command) }
    }

    private func finish() {
        clock?.cancel()
        clock = nil
        let (reason, waiters) = state.withLockUnchecked { state -> (StreamEndReason, [CheckedContinuation<StreamEndReason, Never>]) in
            let reason = state.reason ?? .stopped
            state.finished = reason
            defer { state.waiters = [] }
            return (reason, state.waiters)
        }
        stream = nil
        for waiter in waiters { waiter.resume(returning: reason) }
    }

    // MARK: Resize

    /// A content rect off the configured aspect by more than 1% means the window resized and the
    /// frame is letterboxed: the stream takes the window's live size, at most every 250 ms.
    private func resizeIfNeeded(_ contentRect: CGRect?) {
        guard let rect = contentRect, rect.width > 0, rect.height > 0 else { return }
        let due = state.withLockUnchecked { state -> Bool in
            let configured = Double(state.size.width) / Double(state.size.height)
            let actual = Double(rect.width) / Double(rect.height)
            return abs(actual - configured) / configured > CaptureTuning.resizeTolerance
                && monotonicMs() - state.lastResizeMs >= CaptureTuning.resizeEvery.milliseconds
        }
        guard due, let live = LiveWindows.bounds(windowID)?.size, live.width > 0, live.height > 0 else { return }
        let next = state.withLockUnchecked { state -> ShotSize in
            state.lastResizeMs = monotonicMs()
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
