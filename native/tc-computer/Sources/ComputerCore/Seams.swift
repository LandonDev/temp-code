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

    public init(tier: Tier?, via: InputVia?, clipboard: ClipboardOutcome?, cursor: [Int]?, session: SessionChange? = nil, lastInputAt: UInt64? = nil, clickAt: [Int]? = nil) {
        self.tier = tier
        self.via = via
        self.clipboard = clipboard
        self.cursor = cursor
        self.session = session
        self.lastInputAt = lastInputAt
        self.clickAt = clickAt
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

    public init(pid: pid_t, windowID: UInt32, windowFrame: ComputerProtocol.Rect, window: AXUIElement, space: CoordinateSpace, element: ResolvedElement?, startElement: ResolvedElement?, cursor: [Int]?, cancelled: @escaping @Sendable () -> Bool = { false }) {
        self.pid = pid
        self.windowID = windowID
        self.windowFrame = windowFrame
        self.window = window
        self.space = space
        self.element = element
        self.startElement = startElement
        self.cursor = cursor
        self.cancelled = cancelled
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
}

/// Input. Every call is synchronous and runs off the main thread; every failure is a `ComputerFailure`.
public protocol InputPerforming {
    /// throws `needs_tier`, `invalid_key`, `interrupted`, `clipboard_busy`, `key_window_unavailable`, `session_unavailable`, …
    func perform(_ action: ComputerAction, on target: InputTarget, tiers: [Tier]) throws -> InputOutcome
    /// `input.probe`: which classes the app honours at the process tier, each put back through AX
    func probe(_ target: InputTarget, classes: [ActionClass]) throws -> ProbeReport
    /// `input.restoreSession`: puts back what the session tier changed, unless the person moved since;
    /// throws `session_unavailable` when another holder keeps the session lock
    func restoreSession() throws -> SessionRestore
    /// held-input cleanup (§5.1)
    func releaseHeld(pid: pid_t)
    /// the ups of a held record whose writer died, at its tier
    func releaseStale(_ record: HeldRecord)
}

#endif
