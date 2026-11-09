import ApplicationServices
import ComputerCore
import ComputerProtocol
import struct ComputerProtocol.WindowRef
import ComputerServiceKit
import Foundation

extension ComputerService {
    func registerCapture() {
        router.on("capture.screenshot") { [self] (p: Methods.CaptureScreenshot.Params, ctx) -> Shot in
            let target = try await resolveTarget(session: p.session, app: p.app, window: p.window, launch: p.launch ?? false, ctx: ctx)
            guard let lease = await slots.slot(target.pid).acquire(.shared, timeout: nil) else { throw Router.cancelledError }
            defer { lease.release() }
            let shot = try await takeShot(
                target, maxEdge: p.maxEdge ?? ComputerDefaults.Shot.defaultMaxEdge, region: p.region, format: p.format, action: "screenshot"
            )
            if p.region == nil {
                book.setSpace(target.session, window: target.windowID, CoordinateSpace(width: shot.width, height: shot.height, scale: shot.scale))
            }
            return shot
        }
        router.on("capture.stream.start") { [self] (p: Methods.CaptureStreamStart.Params, ctx) in try await startStream(p, ctx) }
        router.on("capture.stream.stop") { [self] (p: Methods.CaptureStreamStop.Params, _) -> Empty in
            if let entry = claimStream(p.stream) {
                await entry.handle.stop()
                notify("capture/streamEnded", CaptureStreamEndedNotification.Params(stream: entry.id, reason: .stopped))
            }
            return Empty()
        }
        router.onNotification("capture.stream.ack") { [self] params in
            guard let id = params["stream"]?.stringValue, let seq = params["seq"]?.intValue else { return }
            let entry = lock.withLock { streams[id] }
            entry?.handle.ack(seq)
        }
    }

    /// A preview stream on the window: each frame goes to the frame lane as `capture/frame` with the agent
    /// cursor in its pixels, and the stream's end becomes `capture/streamEnded`.
    private func startStream(_ p: Methods.CaptureStreamStart.Params, _ ctx: RequestContext) async throws -> Methods.CaptureStreamStart.Output {
        let target = try await resolveTarget(session: p.session, app: p.app, window: p.window, launch: p.launch ?? false, ctx: ctx)
        try await captureGuard(target)
        guard let lease = await slots.slot(target.pid).acquire(.shared, timeout: nil) else { throw Router.cancelledError }
        defer { lease.release() }
        if let old = claimStream(p.stream) { await old.handle.stop() }

        let maxEdge = p.maxEdge ?? ComputerDefaults.PreviewStream.defaultMaxEdge
        let size = capture.space(windowID: target.windowID, frame: target.info.frame, maxEdge: maxEdge)
        let id = p.stream
        let handle = try await capture.startStream(windowID: target.windowID, fps: p.fps ?? ComputerDefaults.PreviewStream.defaultFps, maxEdge: maxEdge) { [weak self] frame in
            self?.sendFrame(frame, stream: id, target: target)
        }
        let entry = StreamEntry(id: id, session: target.session, pid: target.pid, handle: handle)
        // a close that came while the stream started fences it out
        let kept = lock.withLock { () -> Bool in
            guard book.isOpen(target.session) && !ctx.cancel.isSet else { return false }
            streams[id] = entry
            return true
        }
        guard kept else {
            await handle.stop()
            throw Router.cancelledError
        }
        Task { [weak self] in
            let reason = await entry.handle.ended()
            guard let self, claimStream(id, only: entry.handle) != nil else { return }
            notify("capture/streamEnded", CaptureStreamEndedNotification.Params(stream: id, reason: reason.wire))
        }
        return Methods.CaptureStreamStart.Output(stream: id, width: size.width, height: size.height)
    }

    /// Takes a stream out of the table; whoever takes it sends its end, once.
    func claimStream(_ id: String, only handle: (any StreamHandle)? = nil) -> StreamEntry? {
        lock.withLock {
            guard let entry = streams[id], handle == nil || entry.handle === handle! else { return nil }
            streams[id] = nil
            return entry
        }
    }

    private func sendFrame(_ frame: Frame, stream: String, target: Resolved) {
        var cursor: [Int]?
        if let agent = book.cursor(target.session, pid: target.pid), agent.count == 2, frame.width > 0, target.info.frame.w > 0 {
            let space = book.space(target.session, window: target.windowID)
                ?? capture.space(windowID: target.windowID, frame: target.info.frame, maxEdge: ComputerDefaults.Shot.defaultMaxEdge)
            let origin = CGPoint(x: target.info.frame.x, y: target.info.frame.y)
            let screen = CoordinateMapping.screenPoint(pixel: agent, windowOrigin: origin, scale: space.scale)
            cursor = CoordinateMapping.pixel(screenPoint: screen, windowOrigin: origin, scale: Double(frame.width) / target.info.frame.w)
        }
        let params = CaptureFrameNotification.Params(
            stream: stream, seq: frame.seq, ts: frame.ts, width: frame.width, height: frame.height, format: .jpeg,
            data: frame.jpeg.base64EncodedString(), cursor: cursor
        )
        outbox.frame(notificationLine(method: "capture/frame", params: params))
    }
}

extension ComputerService {
    func registerInput() {
        router.on("input.probe") { [self] (p: Methods.InputProbe.Params, ctx) -> ProbeReport in
            let target = try await resolveTarget(session: p.session, app: p.app, window: p.window, launch: p.launch ?? false, ctx: ctx)
            guard let lease = await slots.slot(target.pid).acquire(.exclusive(session: p.session), timeout: nil) else { throw Router.cancelledError }
            defer { lease.release() }
            let box = InputBox(input: input)
            let flag = ctx.cancel
            let cursor = book.cursor(target.session, pid: target.pid)
            let space = book.space(target.session, window: target.windowID)
                ?? capture.space(windowID: target.windowID, frame: target.info.frame, maxEdge: ComputerDefaults.Shot.defaultMaxEdge)
            let info = target.info
            let pid = target.pid
            let windowID = target.windowID
            let classes = p.classes ?? [.scroll, .key, .click]
            return try await target.worker.run { state in
                guard let window = state.windows[windowID] else { throw ComputerError(kind: .windowNotFound, message: "The window is gone.") }
                let inputTarget = InputTarget(
                    pid: pid, windowID: windowID, windowFrame: info.frame, window: window, space: space,
                    element: nil, startElement: nil, cursor: cursor, cancelled: { flag.isSet }
                )
                return try box.input.probe(inputTarget, classes: classes)
            }
        }
        // it touches the frontmost app and the pointer, not one app's input: no slot, a queue of its own
        router.on("input.restoreSession") { [self] (_: Empty, _) -> SessionRestore in
            let box = InputBox(input: input)
            return try await blocking { try box.input.restoreSession() }
        }
    }
}
