import ApplicationServices
import Capture
import CoreGraphics
import ComputerCore
import ComputerProtocol
import struct ComputerProtocol.Rect
import struct ComputerProtocol.WindowRef
import Foundation

extension Modules {
    /// The binary's modules. Capture is live; until the AX reader and Input builds land, every call
    /// into them answers that it is not built.
    public static func live() -> Modules {
        Modules(
            readers: { NotBuilt() },
            input: { _ in NotBuilt() },
            capture: { log in LiveCapture(log: log) },
            windows: NotBuilt(),
            prepare: { CaptureRuntime.prepare() }
        )
    }
}

/// Capture's `ScreenCaptureKitCapture`, with the shot names and the space a shot would have.
final class LiveCapture: CaptureSource, @unchecked Sendable {
    private let capture: ScreenCaptureKitCapture
    private let lock = NSLock()
    private var counters: [String: ShotCounter] = [:]

    init(log: @escaping @Sendable (String) -> Void) {
        capture = ScreenCaptureKitCapture(log: log)
    }

    func screenshot(windowID: UInt32, maxEdge: Int, regionPoints: Rect?, format: ShotFormat?, to stem: String) async throws -> Shot {
        try await capture.screenshot(windowID: windowID, maxEdge: maxEdge, regionPoints: regionPoints, format: format, to: stem)
    }

    func startStream(windowID: UInt32, fps: Int, maxEdge: Int, onFrame: @escaping @Sendable (Frame) -> Void) async throws -> any StreamHandle {
        try await capture.startStream(windowID: windowID, fps: fps, maxEdge: maxEdge, onFrame: onFrame)
    }

    func watch(windowID: UInt32) async throws -> any PixelChangeSignal {
        try await capture.watch(windowID: windowID)
    }

    func invalidate() { capture.invalidate() }

    /// `ShotGeometry.output` over the window's frame at its display's backing scale. A screenshot's
    /// edge is clamped as Capture clamps it; the preview's may sit under a screenshot's floor.
    func space(windowID: UInt32, frame: Rect, maxEdge: Int) -> CoordinateSpace {
        let edge = maxEdge >= ComputerDefaults.Shot.minMaxEdge ? ShotGeometry.clampEdge(maxEdge) : maxEdge
        let size = ShotGeometry.output(points: CGSize(width: frame.w, height: frame.h), pointPixelScale: LiveCapture.backingScale(frame), maxEdge: edge)
        return CoordinateSpace(width: size.width, height: size.height, scale: size.scale)
    }

    func nextStem(dataDir: String, session: String, action: String) throws -> String {
        let counter: ShotCounter = lock.withLock {
            if let counter = counters[dataDir] { return counter }
            let counter = ShotCounter(dataDir: dataDir)
            counters[dataDir] = counter
            return counter
        }
        return try ShotNaming.stem(dataDir: dataDir, session: session, counter: counter.next(session: session), action: action)
    }

    func forget(session: String) {
        let all = lock.withLock { Array(counters.values) }
        for counter in all { counter.forget(session: session) }
    }

    /// Pixels per point of the display under the frame's centre (global top-left points), else the main display's.
    static func backingScale(_ frame: Rect) -> Double {
        var display = CGMainDisplayID()
        var found: CGDirectDisplayID = 0
        var count: UInt32 = 0
        let centre = CGPoint(x: frame.x + frame.w / 2, y: frame.y + frame.h / 2)
        if CGGetDisplaysWithPoint(centre, 1, &found, &count) == .success, count > 0 { display = found }
        guard let mode = CGDisplayCopyDisplayMode(display), mode.width > 0 else { return 2 }
        return Double(mode.pixelWidth) / Double(mode.width)
    }
}

/// Stands in for a module that has not landed.
final class NotBuilt: ReaderPool, WindowSource, InputPerforming, @unchecked Sendable {
    private var failure: ComputerError {
        ComputerError(kind: .captureFailed, message: "This build of tc-computer has no AX reader or Input module yet.")
    }

    func reader(session: String, pid: pid_t) throws -> any AppReading { throw failure }
    func close(session: String) {}
    func resolve(pid: pid_t, ref: WindowRef?) throws -> (element: AXUIElement, info: WindowInfo) { throw failure }
    func list(pid: pid_t) throws -> [WindowInfo] { throw failure }
    func windowID(of element: AXUIElement, pid: pid_t) -> UInt32? { nil }
    func perform(_ action: ComputerAction, on target: InputTarget, tiers: [Tier]) throws -> InputOutcome { throw failure }
    func probe(_ target: InputTarget, classes: [ActionClass]) throws -> ProbeReport { throw failure }
    func restoreSession() throws -> SessionRestore { throw failure }
    func releaseHeld(pid: pid_t) {}
    func releaseStale(_ record: HeldRecord) {}
}
