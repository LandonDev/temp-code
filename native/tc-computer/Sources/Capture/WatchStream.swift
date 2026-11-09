#if canImport(ScreenCaptureKit)

import ComputerCore
import CoreMedia
import CoreVideo
import Foundation
import os
@preconcurrency import ScreenCaptureKit

/// One window's pixel watch for the smart wait (docs/computer-protocol.md §7): a small SCStream
/// (256 px, 10 fps, never encoded) whose samples `ChangeJudge` reads: the compositor's dirty rects
/// confirmed cell by cell by the luma plane (a covered window's every frame is dirty, whole), or
/// the luma plane alone without them.
///
/// The first complete frame is the baseline: it never counts and it makes the signal live. The
/// stream stops `watchLinger` after its last use (a `watch` call, a read of `live` or
/// `lastChange`, a `waitLive`), and at once when the window goes; the next `watch` starts afresh.
final class WatchStream: NSObject, PixelChangeSignal, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private typealias Waiter = CheckedContinuation<Bool, Never>

    private struct State {
        var judge = ChangeJudge()
        var gate = BaselineGate<Waiter>()
        var linger: Linger
        var lastChange: UInt64 = 0
        var stopped = false
    }

    private let trace: CaptureTraceHandler?

    let windowID: UInt32
    private let filter: SCContentFilter
    private let size: ShotSize
    private let onStop: @Sendable (WatchStream) -> Void
    private let queue: DispatchQueue
    private let state: OSAllocatedUnfairLock<State>
    private var stream: SCStream?
    private var clock: DispatchSourceTimer?

    init(windowID: UInt32, filter: SCContentFilter, points: CGSize, trace: CaptureTraceHandler? = nil, onStop: @escaping @Sendable (WatchStream) -> Void) {
        self.windowID = windowID
        self.trace = trace
        self.filter = filter
        self.onStop = onStop
        size = ShotGeometry.output(points: points, pointPixelScale: Double(filter.pointPixelScale), maxEdge: CaptureTuning.watchEdge)
        queue = DispatchQueue(label: "tc.capture.watch.\(windowID)")
        state = OSAllocatedUnfairLock(uncheckedState: State(linger: Linger(startMs: monotonicMs())))
        super.init()
    }

    func start() async {
        let configuration = ScreenCaptureKitCapture.configuration(
            width: size.width,
            height: size.height,
            pixelFormat: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        )
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(CaptureTuning.watchFPS))
        configuration.queueDepth = CaptureTuning.streamQueueDepth
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        do {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            self.stream = stream
            try await stream.startCapture()
        } catch {
            let code = error as NSError
            queue.async { self.shutDown(capturing: false, cause: .startFailed(domain: code.domain, code: code.code)) }
            return
        }
        queue.async { self.startClock() }
    }

    // MARK: PixelChangeSignal

    var stopped: Bool { state.withLockUnchecked { $0.stopped } }

    var live: Bool {
        state.withLockUnchecked { state in
            state.linger.touch(atMs: monotonicMs())
            return state.gate.state == .live
        }
    }

    var lastChange: UInt64 {
        state.withLockUnchecked { state in
            state.linger.touch(atMs: monotonicMs())
            return state.lastChange
        }
    }

    func touch() {
        state.withLockUnchecked { $0.linger.touch(atMs: monotonicMs()) }
    }

    func waitLive(timeout: Duration) async -> Bool {
        touch()
        return await withCheckedContinuation { (continuation: Waiter) in
            switch state.withLockUnchecked({ $0.gate.wait(continuation) }) {
            case .now(let live):
                continuation.resume(returning: live)
            case .pending(let id):
                Task {
                    try? await Task.sleep(for: timeout)
                    if let waiter = self.state.withLockUnchecked({ $0.gate.timeout(id) }) { waiter.resume(returning: false) }
                }
            }
        }
    }

    // MARK: Samples

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, let info = FrameInfo(sampleBuffer) else { return }
        let status: WatchFrame.Status = switch info.status {
        case .complete: .complete
        case .idle: .idle
        default: .other
        }
        var width = size.width, height = size.height, luma: LumaGrid?
        if let buffer = sampleBuffer.imageBuffer {
            width = CVPixelBufferGetWidth(buffer)
            height = CVPixelBufferGetHeight(buffer)
            // Always: it says which cells changed without dirty rects, and confirms them with.
            if status == .complete { luma = Self.luma(buffer) }
        }
        let frame = WatchFrame(status: status, width: width, height: height, dirty: info.dirtyRects, luma: luma, atMs: machMs(info.displayTime))
        let (live, counted) = state.withLockUnchecked { state -> ([Waiter], Bool) in
            guard !state.stopped else { return ([], false) }
            let counted = state.judge.observe(frame)
            if counted { state.lastChange = info.displayTime }
            return (status == .complete ? state.gate.baseline() : [], counted)
        }
        trace?(.watchFrame(
            window: windowID, complete: status == .complete, width: width, height: height,
            dirty: info.dirtyRects, judged: frame.dirty, counted: counted, displayTime: info.displayTime
        ))
        for waiter in live { waiter.resume(returning: true) }
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        let code = error as NSError
        queue.async { self.shutDown(capturing: false, cause: .delegate(domain: code.domain, code: code.code)) }
    }

    /// The frame's luma plane averaged over the judge's cells.
    private static func luma(_ buffer: CVPixelBuffer) -> LumaGrid? {
        guard CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else { return nil }
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard CVPixelBufferGetPlaneCount(buffer) > 0, let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) else { return nil }
        let width = CVPixelBufferGetWidthOfPlane(buffer, 0), height = CVPixelBufferGetHeightOfPlane(buffer, 0)
        let bytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
        let plane = UnsafeRawBufferPointer(start: base, count: bytesPerRow * height)
        return PixelStats.lumaGrid(plane: plane, width: width, height: height, bytesPerRow: bytesPerRow, cell: CaptureTuning.changeRule.cell)
    }

    // MARK: Lifetime

    private func startClock() {
        // An error can stop the watch between startCapture returning and this running.
        guard !stopped else { return }
        let clock = DispatchSource.makeTimerSource(queue: queue)
        clock.schedule(deadline: .now() + .seconds(1), repeating: .seconds(1))
        clock.setEventHandler { [weak self] in self?.tick() }
        clock.resume()
        self.clock = clock
    }

    private func tick() {
        let expired = state.withLockUnchecked { $0.linger.expired(atMs: monotonicMs()) }
        if expired {
            shutDown(capturing: true, cause: .linger)
        } else if LiveWindows.bounds(windowID) == nil {
            shutDown(capturing: true, cause: .windowGone)
        }
    }

    private func shutDown(capturing: Bool, cause: CaptureTrace.StopCause) {
        let waiters = state.withLockUnchecked { state -> [Waiter]? in
            guard !state.stopped else { return nil }
            state.stopped = true
            return state.gate.stop()
        }
        clock?.cancel()
        clock = nil
        guard let waiters else { return }
        if capturing { stream?.stopCapture { _ in } }
        stream = nil
        for waiter in waiters { waiter.resume(returning: false) }
        trace?(.watchStopped(window: windowID, cause: cause))
        onStop(self)
    }
}

#endif
