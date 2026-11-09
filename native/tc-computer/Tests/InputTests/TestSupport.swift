import ComputerCore
import ComputerProtocol
import Foundation
@testable import Input

// Carbon's own Rect and Point come with AppKit; the wire's are meant here.
typealias Rect = ComputerProtocol.Rect
typealias Point = ComputerProtocol.Point
// CoreServices (AERegistry.h) has a `TextRange` too; Input's is meant.
typealias TextRange = Input.TextRange

/// The repository's root, from this file's real path (the box's scratch package links the files in).
func repoRoot(_ file: String = #filePath) -> URL {
    URL(fileURLWithPath: file).resolvingSymlinksInPath()
        .deletingLastPathComponent() // InputTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // tc-computer
        .deletingLastPathComponent() // native
        .deletingLastPathComponent()
}

/// A clock moved by hand: sleeping advances it.
final class FakeClock: InputClock, @unchecked Sendable {
    private let lock = NSLock()
    private var now: Double = 1_000
    private var tick: UInt64 = 1

    func ticks() -> UInt64 { lock.withLock { tick += 1; return tick } }
    func seconds() -> Double { lock.withLock { now } }
    func epochSeconds() -> Double { lock.withLock { 1_800_000_000 + now } }
    func sleep(ms: Int) { advance(Double(ms) / 1000) }
    func advance(_ s: Double) { lock.withLock { now += s } }
}

/// A sink that keeps what it was given.
final class RecordingSink: EventSink, @unchecked Sendable {
    private let lock = NSLock()
    private var _posted: [(SyntheticEvent, EventRoute)] = []
    var posted: [(SyntheticEvent, EventRoute)] { lock.withLock { _posted } }
    var events: [SyntheticEvent] { posted.map(\.0) }
    func post(_ event: SyntheticEvent, route: EventRoute) { lock.withLock { _posted.append((event, route)) } }
    func clear() { lock.withLock { _posted = [] } }
}

final class FakeHold: MacLockHold, @unchecked Sendable {
    let lock: FakeLock
    private(set) var released = false
    init(_ lock: FakeLock) { self.lock = lock }
    func release() {
        guard !released else { return }
        released = true
        lock.free()
    }
}

/// A lock another holder may keep; a taken try advances the fake clock by its wait.
final class FakeLock: MacLock, @unchecked Sendable {
    private let state = NSLock()
    private var taken = false
    let clock: FakeClock
    private(set) var acquisitions = 0
    /// another service holds it
    var heldElsewhere = false
    init(clock: FakeClock) { self.clock = clock }

    func acquire(within seconds: Double) -> MacLockHold? {
        let ok = state.withLock { () -> Bool in
            guard !taken, !heldElsewhere else { return false }
            taken = true
            acquisitions += 1
            return true
        }
        if !ok { clock.advance(seconds); return nil }
        return FakeHold(self)
    }

    func free() { state.withLock { taken = false } }
    var isTaken: Bool { state.withLock { taken } }
}

final class FakeWatch: PersonWatching, @unchecked Sendable {
    private let lock = NSLock()
    private var _armed = false, _tripped = false
    private var onTrip: (@Sendable () -> Void)?
    private(set) var arms = 0
    /// runs once, the next time `armed` is read, before it answers (a trip timed into a step's arming)
    var onArmedRead: (() -> Void)?
    var armed: Bool {
        if let hook = lock.withLock({ () -> (() -> Void)? in defer { onArmedRead = nil }; return onArmedRead }) { hook() }
        return lock.withLock { _armed }
    }
    var tripped: Bool { lock.withLock { _tripped } }

    func arm(onTrip: @escaping @Sendable () -> Void) {
        lock.withLock { _armed = true; _tripped = false; self.onTrip = onTrip; arms += 1 }
    }

    func disarm() { lock.withLock { _armed = false; onTrip = nil } }

    /// The person touches a key or the mouse.
    func trip() {
        let call = lock.withLock { () -> (@Sendable () -> Void)? in
            guard _armed else { return nil }
            _tripped = true
            return onTrip
        }
        call?()
    }
}

/// A Mac with apps 1 (Terminal, in front) and 7 (TextEdit, the target, window 70).
final class FakeHost: SessionHost {
    typealias Window = Int
    var log: [String] = []
    var locked = false, secure = false
    var front: AppBrief? = AppBrief(pid: 1, bundleId: "com.apple.Terminal", name: "Terminal")
    var pointerAt = ScreenPoint(x: 100, y: 100)
    var idle: Double = 999
    var running: Set<Int> = [1, 7]
    var minimizedWindows: Set<Int> = []
    var focused: [Int32: Int] = [:]
    var refuseActivation = false
    var apps: [Int32: AppBrief] = [7: AppBrief(pid: 7, bundleId: "com.apple.TextEdit", name: "TextEdit"), 1: AppBrief(pid: 1, bundleId: "com.apple.Terminal", name: "Terminal")]
    /// called before each write, to let a test trip the watch mid-activation
    var beforeWrite: ((String) -> Void)?

    func screenLocked() -> Bool { locked }
    func secureInputOn() -> Bool { secure }
    func frontmost() -> AppBrief? { front }
    func pointer() -> ScreenPoint { pointerAt }
    func secondsSinceInput() -> Double { idle }
    func isRunning(pid: Int) -> Bool { running.contains(pid) }
    func minimized(_ w: Int) -> Bool { minimizedWindows.contains(w) }
    func unminimize(_ w: Int) throws { beforeWrite?("unminimize"); log.append("unminimize \(w)"); minimizedWindows.remove(w) }
    func bringForward(pid: Int32) throws {
        beforeWrite?("bringForward")
        log.append("bringForward \(pid)")
        if !refuseActivation { front = apps[pid] }
    }
    func raise(_ w: Int) throws {
        beforeWrite?("raise")
        log.append("raise \(w)")
        if !refuseActivation, let pid = front?.pid { focused[Int32(pid)] = w }
    }
    func isFocusedWindow(_ w: Int, pid: Int32) -> Bool { focused[pid] == w }
    func activate(_ app: AppBrief) -> Bool {
        log.append("activate \(app.pid)")
        guard running.contains(app.pid) else { return false }
        front = app
        return true
    }
    func warpPointer(to p: ScreenPoint) { log.append("warp \(p.x),\(p.y)"); pointerAt = p }
}

/// A core over the fakes, with what it told the shell.
final class Rig: @unchecked Sendable {
    let clock = FakeClock()
    let sink = RecordingSink()
    let host = FakeHost()
    let watch = FakeWatch()
    let lock: FakeLock
    private let state = NSLock()
    private var _heldEvents: [HeldEvent] = []
    private var _personInput: [pid_t] = []
    var heldEvents: [HeldEvent] { state.withLock { _heldEvents } }
    var personInput: [pid_t] { state.withLock { _personInput } }
    lazy var core: InputCore<FakeHost> = InputCore(
        host: host, watch: watch, sessionLock: lock, sink: sink, clock: clock, layout: USANSILayout(),
        onPersonInput: { [weak self] pid in self?.state.withLock { self?._personInput.append(pid) } },
        onHeld: { [weak self] e in self?.state.withLock { self?._heldEvents.append(e) } }
    )

    init() { lock = FakeLock(clock: clock) }

    func step<T>(_ tier: Tier, keys: Bool = false, _ body: (inout StepContext) throws -> T) throws -> (T, SessionChange?, UInt64?) {
        try core.step(tier: tier, pid: 7, windowID: 70, window: 70, keys: keys, cancelled: { false }, body: body)
    }
}

func pt(_ x: Double, _ y: Double) -> ScreenPoint { ScreenPoint(x: x, y: y) }

func kind(_ error: Error) -> ComputerErrorKind? {
    (error as? ComputerFailure)?.error.kind
}

/// A value a `@Sendable` closure may change.
final class Box<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: T
    init(_ value: T) { _value = value }
    var value: T {
        get { lock.withLock { _value } }
        set { lock.withLock { _value = newValue } }
    }
}
