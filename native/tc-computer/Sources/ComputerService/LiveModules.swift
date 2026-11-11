import ApplicationServices
import AXReader
import Capture
import Input
import CoreGraphics
import ComputerCore
import ComputerProtocol
import struct ComputerProtocol.Rect
import struct ComputerProtocol.WindowRef
import Foundation

extension Modules {
    /// The binary's modules: the AX reader, Input and Capture.
    public static func live() -> Modules {
        Modules(
            readers: { LiveReaders() },
            input: { wiring in
                InputEngine(clipboardLock: wiring.clipboardLock, sessionLock: wiring.sessionLock, recentForeignCopy: wiring.recentForeignCopy, onPersonInput: wiring.onPersonInput, onHeld: wiring.onHeld)
            },
            capture: { log in LiveCapture(log: log) },
            windows: LiveWindows(),
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

    /// `ShotGeometry.output` over the window's frame at its display's backing scale, the edge clamped
    /// as Capture clamps a screenshot's.
    func space(windowID: UInt32, frame: Rect, maxEdge: Int) -> CoordinateSpace {
        let size = ShotGeometry.output(points: CGSize(width: frame.w, height: frame.h), pointPixelScale: LiveCapture.backingScale(frame), maxEdge: ShotGeometry.clampEdge(maxEdge))
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

/// The AX reader's `AXReaders`: one reader per session × pid, numbers per session × app.
final class LiveReaders: ReaderPool, @unchecked Sendable {
    private let readers = AXReaders()

    func reader(session: String, pid: pid_t) throws -> any AppReading { try readers.reader(session: session, pid: pid) }
    func close(session: String) { readers.close(session: session) }
}

/// The AX reader's window resolution and listing (`AppWindows`).
struct LiveWindows: WindowSource {
    func resolve(pid: pid_t, ref: WindowRef?) throws -> (element: AXUIElement, info: WindowInfo) { try AppWindows.resolve(pid: pid, ref: ref) }
    func list(pid: pid_t) throws -> [WindowInfo] { AppWindows.list(pid: pid) }
    func windowID(of element: AXUIElement, pid: pid_t) -> UInt32? { AppWindows.windowID(of: element, pid: pid).flatMap { UInt32(exactly: $0) } }

    func resolveTab(pid: pid_t, ref: WindowRef?) throws -> (element: AXUIElement, info: WindowInfo, tab: TabHandle?) {
        let found = try AppWindows.resolveTarget(pid: pid, ref: ref)
        return (found.element, found.info, found.tab.map { TabHandle(element: $0.element, title: $0.title, selected: $0.selected) })
    }

    func selectTab(pid: pid_t, window: AXUIElement, tab: TabHandle, mode: TabsMode, waitMs: Int) throws -> TabSelection {
        let done = try TabSelect.select(pid: pid, window: window, tab: tab.element, tabs: mode, waitMs: waitMs)
        return TabSelection(title: done.title, switched: done.switched, page: done.page)
    }

    func tabSelected(_ tab: TabHandle) -> Bool { AppWindows.tabSelected(tab.element) }

    func chromium(pid: pid_t) -> Bool { AppWindows.isChromium(pid: pid) }
}
