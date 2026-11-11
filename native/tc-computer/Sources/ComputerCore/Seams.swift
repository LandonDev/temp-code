import ComputerProtocol
import Foundation

#if canImport(ApplicationServices)
import ApplicationServices
#endif

// The joins the Service shell makes between the AX reader, Input and Capture
// (docs/computer-protocol.md §11). Generated wire types are used as they are;
// these are the rest. A thread may add members; renaming one is a change to
// the document first.
//
// ApplicationServices brings Carbon's own `WindowRef`, `Rect` and `Point`, so a
// file that imports it names the wire's as `ComputerProtocol.WindowRef` and so on.

/// A protocol failure any part throws; the Service shell turns it into a
/// step's error or a `-32000` JSON-RPC error.
public struct ComputerFailure: Error, Hashable, Sendable {
    public let error: ComputerError

    public init(_ error: ComputerError) {
        self.error = error
    }

    public init(_ kind: ComputerErrorKind, _ message: String) {
        self.error = ComputerError(kind: kind, message: message)
    }
}

/// What the Service shell asks the AX reader for, built from `state.get` or `ObserveOptions`.
public struct ObserveRequest: Sendable {
    public var window: ComputerProtocol.WindowRef?
    public var mode: ObservationMode
    /// one element's subtree, whole
    public var element: Int?
    public var budgetBytes: Int
    public var geometry: Bool
    public var menus: Bool
    public var space: CoordinateSpace
    /// the smart wait ended with a busy indicator showing: the header says ` · still loading`
    public var loading: Bool
    /// false when the call's screenshot policy is `never`: a thin tree is then not told to look at one
    public var noteThin: Bool
    /// the document line (§25.10): only for a host that listed `commit`, whose parser reads it
    public var document: Bool = false
    /// every menu the read walks is one the call closes after it: its lines carry the closed-menu note (§25.11)
    public var closingMenus: Bool = false

    public init(window: ComputerProtocol.WindowRef?, mode: ObservationMode, element: Int?, budgetBytes: Int, geometry: Bool, menus: Bool, space: CoordinateSpace, loading: Bool = false, noteThin: Bool = true) {
        self.window = window
        self.mode = mode
        self.element = element
        self.budgetBytes = budgetBytes
        self.geometry = geometry
        self.menus = menus
        self.space = space
        self.loading = loading
        self.noteThin = noteThin
    }
}

/// What the AX reader hands back; the shell adds epoch, session, seq, base, shot and waited.
public struct ObservationText: Sendable {
    public var kind: ObservationKind
    public var text: String
    public var stats: ObservationStats
    public var window: WindowInfo
    public var focused: Int?

    public init(kind: ObservationKind, text: String, stats: ObservationStats, window: WindowInfo, focused: Int?) {
        self.kind = kind
        self.text = text
        self.stats = stats
        self.window = window
        self.focused = focused
    }
}

/// What Input reports of one action.
public struct InputOutcome: Sendable {
    public var tier: Tier?
    public var via: InputVia?
    public var clipboard: ClipboardOutcome?
    /// the agent cursor after the action, session space
    public var cursor: [Int]?
    /// what a session-tier step changed on the Mac; the shell puts it on the step as `session`
    public var session: SessionChange?
    /// mach_absolute_time of the last event posted or AX change made; the typing and
    /// paste checks after it do not move it, and the smart wait counts from it
    public var lastInputAt: UInt64?
    /// a click-class action (the five clicks, `left_mouse_down`, `perform`): the point it acted at,
    /// session space; at `ax` the centre of the element's visible frame, never a pointer it moved (P2)
    public var clickAt: [Int]?
    /// what a fallback route acted on (§24.8): `File › Close`, `button "Save"`; the shell puts it on the step's `input.on`
    public var on: String?
    /// the step's effect when Input read it itself (§25.7: a web checkbox's or radio's value read back);
    /// the shell puts it on the step in place of the smart wait's
    public var effect: StepEffect?
    /// a `front` step's hold (§25.4); the shell puts it on the step as `front`
    public var front: FrontHold?
    /// what a step that saves (`save_as`) proved on disk; the shell puts it on the step as `disk`
    public var disk: DiskChange?

    public init(tier: Tier?, via: InputVia?, clipboard: ClipboardOutcome?, cursor: [Int]?, session: SessionChange? = nil, lastInputAt: UInt64? = nil, clickAt: [Int]? = nil, on: String? = nil, effect: StepEffect? = nil) {
        self.tier = tier
        self.via = via
        self.clipboard = clipboard
        self.cursor = cursor
        self.session = session
        self.lastInputAt = lastInputAt
        self.clickAt = clickAt
        self.on = on
        self.effect = effect
    }

    /// The same outcome with a hold's report.
    public func with(front: FrontHold?) -> InputOutcome {
        var out = self
        out.front = front
        return out
    }
}

/// One of the two Mac-wide locks every service shares (§1): the Service shell implements
/// both over `flock`, and Input takes them, since only it knows the tier a step will use.
public protocol MacLock: Sendable {
    /// Takes the lock, waiting at most `within` seconds; nil when it stayed taken.
    func acquire(within seconds: Double) -> MacLockHold?
}

/// A taken lock. `release` is idempotent.
public protocol MacLockHold: AnyObject, Sendable {
    func release()
}

/// A button or key Input holds down past one event pair: the shell writes these to
/// `<dataDir>/held.json`, so a service that dies holding input is let go at the next start.
public struct HeldRecord: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable { case button, key }
    /// the pid of the service that pressed it
    public var writer: Int32
    public var pid: Int32
    public var tier: Tier
    public var kind: Kind
    /// a button's number: 0 left, 1 right, 2 middle (absent: left)
    public var button: Int?
    /// a button's screen point, rounded
    public var point: [Int]?
    /// a key's virtual key codes, modifiers first; for a button, the modifiers held with it
    public var keyCodes: [UInt16]?
    /// epoch seconds
    public var since: Double

    public init(writer: Int32, pid: Int32, tier: Tier, kind: Kind, button: Int? = nil, point: [Int]? = nil, keyCodes: [UInt16]? = nil, since: Double) {
        self.writer = writer
        self.pid = pid
        self.tier = tier
        self.kind = kind
        self.button = button
        self.point = point
        self.keyCodes = keyCodes
        self.since = since
    }
}

/// Input's word to the shell's crash ledger: `pressing` before such a down is posted, `released` after its up.
public enum HeldEvent: Sendable, Equatable {
    case pressing(HeldRecord)
    case released(pid: Int32, kind: HeldRecord.Kind)
}

/// One preview frame from Capture; the shell maps the agent cursor into its pixels.
public struct Frame: Sendable {
    public let seq: Int
    public let jpeg: Data
    public let width: Int
    public let height: Int
    /// epoch ms
    public let ts: Double

    public init(seq: Int, jpeg: Data, width: Int, height: Int, ts: Double) {
        self.seq = seq
        self.jpeg = jpeg
        self.width = width
        self.height = height
        self.ts = ts
    }
}

public protocol StreamHandle: AnyObject {
    /// The frame size the stream started at: `capture.stream.start`'s `width` and `height`.
    var startSize: (width: Int, height: Int) { get }
    func stop() async
    /// `capture.stream.ack`: frees the flow-control slot of `seq` and every frame before it.
    func ack(_ seq: Int)
    /// Resolves once, when the stream ends for any reason; the shell sends `capture/streamEnded`.
    func ended() async -> StreamEndReason
}

/// Why a preview stream ended (`capture/streamEnded`'s `reason`).
public enum StreamEndReason: Equatable, Sendable {
    /// `capture.stream.stop`, or the person stopped capture from the menu bar
    case stopped
    case windowClosed
    /// the Screen Recording grant went
    case permission
    case error(String)

    public var wire: CaptureStreamEndedNotification.Params.Reason {
        switch self {
        case .stopped: .stopped
        case .windowClosed: .windowClosed
        case .permission: .permission
        case .error: .error
        }
    }
}

/// Capture's pixel signal for the smart wait (§7): one watch stream per window a session acts on.
public protocol PixelWatching: AnyObject {
    /// Starts the window's watch, or keeps a running one alive and returns the same signal.
    /// Returns at once; the signal goes live with the stream's baseline frame.
    func watch(windowID: UInt32) async throws -> any PixelChangeSignal
}

/// Whether a window's pixels are still changing, from the compositor's dirty rects.
public protocol PixelChangeSignal: AnyObject, Sendable {
    /// The stream has delivered its baseline and has not stopped.
    var live: Bool { get }
    /// mach_absolute_time of the last frame that counted as a change; 0 = none since the watch began.
    var lastChange: UInt64 { get }
    /// True at once when live; otherwise waits for the baseline, at most `timeout`. False once stopped.
    func waitLive(timeout: Duration) async -> Bool
}

/// The AX reader's change monitor on one app: the AXObserver and the shallow signature of the smart wait.
public protocol ChangeSignal: AnyObject {
    /// mach_absolute_time of the last AX notification
    var lastChange: UInt64 { get }
    /// the shallow signature of §7: never a full walk
    func signature() -> UInt64
    func busyIndicatorShowing() -> Bool
}

/// Capture.
public protocol WindowCapturing {
    /// `regionPoints`: the region already mapped from session pixels to window points by the shell.
    /// `format` nil chooses by content (A1). `stem` is the path without its extension
    /// (`ShotNaming.stem`); Capture adds `.jpg` or `.png` and `Shot.path` names the file written.
    func screenshot(windowID: UInt32, maxEdge: Int, regionPoints: ComputerProtocol.Rect?, format: ShotFormat?, to stem: String) async throws -> Shot
    func startStream(windowID: UInt32, fps: Int, maxEdge: Int, onFrame: @escaping @Sendable (Frame) -> Void) async throws -> any StreamHandle
}

#if canImport(ApplicationServices)

/// An index, live.
public struct ResolvedElement {
    public let index: Int
    public let element: AXUIElement
    public let role: String
    /// screen points
    public let frame: ComputerProtocol.Rect
    /// raw AX action names
    public let actions: [String]
    /// which of AXValue, AXSelectedText, AXSelectedTextRange, AXFocused, AXSelected are settable
    public let settable: Set<String>
    public let brief: ElementBrief

    public init(index: Int, element: AXUIElement, role: String, frame: ComputerProtocol.Rect, actions: [String], settable: Set<String>, brief: ElementBrief) {
        self.index = index
        self.element = element
        self.role = role
        self.frame = frame
        self.actions = actions
        self.settable = settable
        self.brief = brief
    }
}

/// What an action acts on: the shell resolves it, Input acts on it.
public struct InputTarget {
    public let pid: pid_t
    public let windowID: UInt32
    /// screen points
    public let windowFrame: ComputerProtocol.Rect
    /// the resolved window: the key-window check, raise, minimized
    public let window: AXUIElement
    /// to map a coordinate to a screen point
    public let space: CoordinateSpace
    public let element: ResolvedElement?
    public let startElement: ResolvedElement?
    /// the agent cursor `[x, y]`, session space
    public var cursor: [Int]?
    /// the shell's `$/cancel` flag for the call; Input checks it before every event and in every pause
    public let cancelled: @Sendable () -> Bool
    /// the call's `pasteQuietMs`: a paste refuses `recent-copy` when a foreign copy came within it
    public let pasteQuietMs: Int?
    /// the call's `ignored`: routes and process classes this app was seen to ignore, run last (§24.1)
    public let ignored: IgnoredRoutes?
    /// the call's token from `InputPerforming.callBegan`: a session step of a call the person came back during answers `interrupted` (§14.9.5)
    public let callToken: Int?
    /// the call's `personIdleMs`: the person guard gives typing back only when it was under 5 s (§14.9.4)
    public let personIdleMs: Int?
    /// §25.1: the process is Chromium (AXText `ChromiumBundle`); §25.6 to §25.9 apply inside its web areas
    /// and to its keys, and nowhere else
    public let chromium: Bool
    /// §25.9: the element the model's latest read showed focused (`expectFocus`, resolved), set only on the
    /// step it binds (Input's `FocusCheck.bindsExpectation`): a call's first step that sends keys or text,
    /// with no acting step before it, and on a retry only when no step of the call ran
    public let expectFocus: ResolvedElement?
    /// the reader's index and line for a live element, nil when the model's latest read never listed it:
    /// `focus_moved` names the focused element by them
    public let briefOf: (AXUIElement) -> ElementBrief?
    /// whether the app's AX tree changed since a tick (mach_absolute_time): a `front` hold's settle signal (§25.2)
    public var changedSince: (@Sendable (UInt64) -> Bool)?
    /// whether the step is expected to commit to disk before it acts (CommitRule.expectsBefore, decision 12);
    /// the shell's, since Input does not know the commit rule
    public var commitExpected: (@Sendable (ComputerAction) -> Bool)?

    public init(pid: pid_t, windowID: UInt32, windowFrame: ComputerProtocol.Rect, window: AXUIElement, space: CoordinateSpace, element: ResolvedElement?, startElement: ResolvedElement?, cursor: [Int]?, cancelled: @escaping @Sendable () -> Bool = { false }, pasteQuietMs: Int? = nil, ignored: IgnoredRoutes? = nil, callToken: Int? = nil, personIdleMs: Int? = nil, chromium: Bool = false, expectFocus: ResolvedElement? = nil, briefOf: @escaping (AXUIElement) -> ElementBrief? = { _ in nil }) {
        self.pid = pid
        self.windowID = windowID
        self.windowFrame = windowFrame
        self.window = window
        self.space = space
        self.element = element
        self.startElement = startElement
        self.cursor = cursor
        self.cancelled = cancelled
        self.pasteQuietMs = pasteQuietMs
        self.ignored = ignored
        self.callToken = callToken
        self.personIdleMs = personIdleMs
        self.chromium = chromium
        self.expectFocus = expectFocus
        self.briefOf = briefOf
    }
}

/// An open menu the last whole-window read walked (docs/computer-protocol.md §25.11): the AXMenu, the
/// element that opened it (a pop-up, a menu button, a menu bar item; nil for a context menu read as a
/// root), the opener's name and the items' titles.
public struct OpenMenu: @unchecked Sendable {
    public enum Opener: Sendable { case menuBar, popUp, context }
    public let menu: AXUIElement
    public let opener: AXUIElement?
    public let kind: Opener
    public let title: String
    public let items: [String]

    public init(menu: AXUIElement, opener: AXUIElement?, kind: Opener, title: String, items: [String]) {
        self.menu = menu
        self.opener = opener
        self.kind = kind
        self.title = title
        self.items = items
    }
}

/// The AX reader: one per session × pid.
public protocol AppReading: AnyObject {
    func observe(_ request: ObserveRequest) throws -> ObservationText
    /// throws `stale_element` or `no_such_element`
    func resolve(_ index: Int) throws -> ResolvedElement
    var changes: any ChangeSignal { get }
    /// forget the base: the next auto read is full (the shell dropped an observation it took)
    func resetBase()
    /// stop the change monitor and free the element handles
    func close()
    /// §25.2: the last window read's page (its selected tab and state); nil for a window with no tab strip,
    /// a process that is not Chromium, or an element read
    var lastPage: Page? { get }
    /// §25.9: the index and line the model's latest read gave a live element; nil when it listed none
    func brief(of element: AXUIElement) -> ElementBrief?
    /// §25.2: after a tab switch, the window's page holds the smart wait until it is there and loaded
    func watchPage(window: AXUIElement)
    /// the menus the last whole-window read walked, open then (§26.11)
    var openMenus: [OpenMenu] { get }
}

extension AppReading {
    public var lastPage: Page? { nil }
    public func brief(of element: AXUIElement) -> ElementBrief? { nil }
    public func watchPage(window: AXUIElement) {}
    public var openMenus: [OpenMenu] { [] }
}

/// Input. Every call is synchronous and runs off the main thread; every failure is a `ComputerFailure`.
public protocol InputPerforming {
    /// throws `needs_tier`, `invalid_key`, `interrupted`, `clipboard_busy`, `key_window_unavailable`, `session_unavailable`, …
    func perform(_ action: ComputerAction, on target: InputTarget, tiers: [Tier]) throws -> InputOutcome
    /// `input.probe`: which classes the app honours at the process tier, each put back through AX
    func probe(_ target: InputTarget, classes: [ActionClass]) throws -> ProbeReport
    /// `input.restoreSession`: puts back what the session tier changed, unless the person moved since;
    /// `afterInterrupt`, within 2 s of the person's trip, skips that check and keeps each half's own;
    /// throws `session_unavailable` when another holder keeps the session lock
    func restoreSession(afterInterrupt: Bool) throws -> SessionRestore
    /// held-input cleanup (§5.1)
    func releaseHeld(pid: pid_t)
    /// the ups of a held record whose writer died, at its tier
    func releaseStale(_ record: HeldRecord)
    /// a call that may use the session tier began, before any step; its token for `InputTarget.callToken`
    func callBegan(pid: pid_t) -> Int
    func callEnded(_ token: Int)
    /// the exit path: the person guard ends with the held input (§16.2)
    func endGuard()
}

extension InputPerforming {
    public func callBegan(pid: pid_t) -> Int { 0 }
    public func callEnded(_ token: Int) {}
    public func endGuard() {}
}

#endif
