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
    /// §25.4's order, tabs included: the window and, for a ref that matched a browser tab, that tab; no side effect
    func resolveTab(pid: pid_t, ref: WindowRef?) throws -> (element: AXUIElement, info: WindowInfo, tab: TabHandle?)
    /// §25.4's selection (AXReader `TabSelect`): run only under the app's exclusive slot; throws `tab_in_use`
    /// for the person's front window unless `mode` is `any`, `timeout` or `action_unsupported` when the press does not take
    func selectTab(pid: pid_t, window: AXUIElement, tab: TabHandle, mode: TabsMode, waitMs: Int) throws -> TabSelection
    /// whether the matched tab reads selected now (a read's check after its shared lease)
    func tabSelected(_ tab: TabHandle) -> Bool
    /// §25.1: the process is Chromium, by its bundle
    func chromium(pid: pid_t) -> Bool
}

extension WindowSource {
    public func resolveTab(pid: pid_t, ref: WindowRef?) throws -> (element: AXUIElement, info: WindowInfo, tab: TabHandle?) {
        let (element, info) = try resolve(pid: pid, ref: ref)
        return (element, info, nil)
    }

    public func selectTab(pid: pid_t, window: AXUIElement, tab: TabHandle, mode: TabsMode, waitMs: Int) throws -> TabSelection {
        TabSelection(title: tab.title, switched: false, page: nil)
    }

    public func tabSelected(_ tab: TabHandle) -> Bool { tab.selected }

    public func chromium(pid: pid_t) -> Bool { false }
}

/// A tab a window ref matched: its element (which stays on the session × pid's worker), title and selection.
public struct TabHandle: @unchecked Sendable {
    public let element: AXUIElement
    public let title: String
    public let selected: Bool

    public init(element: AXUIElement, title: String, selected: Bool) {
        self.element = element
        self.title = title
        self.selected = selected
    }
}

/// What a selection did: the tab's title, whether it switched, and the page as its wait left it.
public struct TabSelection: Sendable, Equatable {
    public let title: String
    public let switched: Bool
    public let page: Page?

    public init(title: String, switched: Bool, page: Page?) {
        self.title = title
        self.switched = switched
        self.page = page
    }
}

/// What Input is built with (input A11): the two Mac-wide locks, the pasteboard watch's word on a
/// recent foreign copy, and the two callbacks.
public struct InputWiring: Sendable {
    public var clipboardLock: any MacLock
    public var sessionLock: any MacLock
    /// a foreign pasteboard change within this many ms, `watchingSince` counted (`clipboard.state`'s rule)
    public var recentForeignCopy: @Sendable (_ withinMs: Int) -> Bool
    /// the person tripped the guard between calls: the pid, and the tokens of the calls the trip is for
    public var onPersonInput: @Sendable (pid_t, [Int]) -> Void
    public var onHeld: @Sendable (HeldEvent) -> Void

    public init(clipboardLock: any MacLock, sessionLock: any MacLock, recentForeignCopy: @escaping @Sendable (_ withinMs: Int) -> Bool = { _ in false }, onPersonInput: @escaping @Sendable (pid_t, [Int]) -> Void, onHeld: @escaping @Sendable (HeldEvent) -> Void) {
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
