import ApplicationServices
import ComputerCore
import ComputerProtocol
import struct ComputerProtocol.WindowRef
import Foundation

/// What the shell needs of the AX reader's `AXReaders`: one reader per session × pid.
public protocol ReaderPool: Sendable {
    func reader(session: String, pid: pid_t) throws -> any AppReading
    func close(session: String)
}

/// What the shell needs of the reader's `WindowResolver` and `AppWindows`. Every call runs on a worker;
/// a window's element never leaves it.
public protocol WindowSource: Sendable {
    /// spec §2.1's order: by id, then exact title, then substring, else main, focused, first standard
    func resolve(pid: pid_t, ref: WindowRef?) throws -> (element: AXUIElement, info: WindowInfo)
    func list(pid: pid_t) throws -> [WindowInfo]
    /// the CGWindowID of an AX window element (`_AXUIElementGetWindow`, else the public match)
    func windowID(of element: AXUIElement, pid: pid_t) -> UInt32?
}

/// What Input is built with (input A11): the two Mac-wide locks, the pasteboard watch's word on a
/// recent foreign copy, and the two callbacks.
public struct InputWiring: Sendable {
    public var clipboardLock: any MacLock
    public var sessionLock: any MacLock
    /// a foreign pasteboard change within this many ms, `watchingSince` counted (`clipboard.state`'s rule)
    public var recentForeignCopy: @Sendable (_ withinMs: Int) -> Bool
    public var onPersonInput: @Sendable (pid_t) -> Void
    public var onHeld: @Sendable (HeldEvent) -> Void

    public init(clipboardLock: any MacLock, sessionLock: any MacLock, recentForeignCopy: @escaping @Sendable (_ withinMs: Int) -> Bool = { _ in false }, onPersonInput: @escaping @Sendable (pid_t) -> Void, onHeld: @escaping @Sendable (HeldEvent) -> Void) {
        self.clipboardLock = clipboardLock
        self.sessionLock = sessionLock
        self.recentForeignCopy = recentForeignCopy
        self.onPersonInput = onPersonInput
        self.onHeld = onHeld
    }
}

/// What the shell needs of Capture's `ScreenCaptureKitCapture` and its pure helpers.
public protocol CaptureSource: WindowCapturing, PixelWatching, Sendable {
    /// the shareable-window cache is read again (on `window/changed`)
    func invalidate()
    /// The space a screenshot of the window at `maxEdge` would have (`ShotGeometry.output` over the
    /// window's live frame and its display's backing scale).
    func space(windowID: UInt32, frame: Rect, maxEdge: Int) -> CoordinateSpace
    /// The next shot's path without its extension: `<dataDir>/shots/<session>/<nnnn>-<action>`
    /// (`ShotNaming.stem` over a `ShotCounter` that starts above the highest number on disk).
    func nextStem(dataDir: String, session: String, action: String) throws -> String
    /// `session.close`: the counter's memory goes, never the files
    func forget(session: String)
}

/// The three modules, as the shell builds them. The binary wires `Modules.live()`; the tests swap in fakes.
public struct Modules: Sendable {
    public var readers: @Sendable () -> any ReaderPool
    public var input: @Sendable (InputWiring) -> any InputPerforming
    /// built with the service's `log`, which reaches the host as a `log` warn
    public var capture: @Sendable (_ log: @escaping @Sendable (String) -> Void) -> any CaptureSource
    public var windows: any WindowSource
    /// Runs on the main thread before anything captures (`CaptureRuntime.prepare()`).
    public var prepare: @MainActor @Sendable () -> Void
    /// The person's Escape while `escape.watch` is on (P1): the binary's is the live event tap.
    public var escapeTap: @Sendable () -> any EscapeTapping

    public init(readers: @escaping @Sendable () -> any ReaderPool, input: @escaping @Sendable (InputWiring) -> any InputPerforming,
                capture: @escaping @Sendable (_ log: @escaping @Sendable (String) -> Void) -> any CaptureSource, windows: any WindowSource, prepare: @escaping @MainActor @Sendable () -> Void = {},
                escapeTap: @escaping @Sendable () -> any EscapeTapping = { LiveEscapeTap() }) {
        self.readers = readers
        self.input = input
        self.capture = capture
        self.windows = windows
        self.prepare = prepare
        self.escapeTap = escapeTap
    }
}
