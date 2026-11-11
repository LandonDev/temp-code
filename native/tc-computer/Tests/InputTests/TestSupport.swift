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
    private(set) var disarms = 0
    /// what the guard's tap dropped, as the replay's plan reads it
    var dropped: [GuardedEvent] = []
    /// the indices each replay posted, in order
    private(set) var replays: [[Int]] = []
    /// arm, replay and disarm, in order
    private(set) var log: [String] = []
    private var _report: GuardReport?
    var report: GuardReport? { lock.withLock { _report } }
    /// runs once, the next time `armed` is read, before it answers (a trip timed into a step's arming)
    var onArmedRead: (() -> Void)?
    var armed: Bool {
        if let hook = lock.withLock({ () -> (() -> Void)? in defer { onArmedRead = nil }; return onArmedRead }) { hook() }
        return lock.withLock { _armed }
    }
    var tripped: Bool { lock.withLock { _tripped } }

    func arm(onTrip: @escaping @Sendable () -> Void) {
        lock.withLock { _armed = true; _tripped = false; self.onTrip = onTrip; arms += 1; log.append("arm") }
    }

    func disarm() {
        lock.withLock {
            if _armed {
                let replayed = replays.joined().filter { dropped[$0].isDownLike }.count
                _report = GuardReport(mode: .active, dropped: dropped.filter(\.isDownLike).count, replayed: replayed)
            }
            _armed = false
            onTrip = nil
            disarms += 1
            log.append("disarm")
        }
    }

    /// Posts what the plan picks, asking `stillThere` before each down as the live tap does.
    func replay(plan: ([GuardedEvent]) -> [Int], stillThere: () -> Bool) {
        var posted: [Int] = []
        for i in plan(dropped) {
            if dropped[i].isDownLike, !stillThere() { break }
            posted.append(i)
        }
        lock.withLock { replays.append(posted); log.append("replay") }
    }

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
    /// how many `activate` calls miss before one takes: an app that ignored the first AXFrontmost
    var activationMisses = 0
    /// each app's focused element: Terminal's field is 11
    var focusedElements: [Int32: Int] = [1: 11]
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
        if activationMisses > 0 {
            activationMisses -= 1
            return false
        }
        front = app
        return true
    }
    func warpPointer(to p: ScreenPoint) { log.append("warp \(p.x),\(p.y)"); pointerAt = p }
    func focusedElement(pid: Int32) -> Int? { focusedElements[pid] }
    func sameElement(_ e: Int, pid: Int32) -> Bool { focusedElements[pid] == e }
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
    private var _personTokens: [[Int]] = []
    var heldEvents: [HeldEvent] { state.withLock { _heldEvents } }
    var personInput: [pid_t] { state.withLock { _personInput } }
    /// the call tokens each `onPersonInput` carried
    var personTokens: [[Int]] { state.withLock { _personTokens } }
    lazy var core: InputCore<FakeHost> = InputCore(
        host: host, watch: watch, sessionLock: lock, sink: sink, clock: clock, layout: USANSILayout(),
        onPersonInput: { [weak self] pid, tokens in
            self?.state.withLock {
                self?._personInput.append(pid)
                self?._personTokens.append(tokens)
            }
        },
        onHeld: { [weak self] e in self?.state.withLock { self?._heldEvents.append(e) } }
    )

    init() { lock = FakeLock(clock: clock) }

    func step<T>(_ tier: Tier, keys: Bool = false, call: SessionCall = SessionCall(), _ body: (inout StepContext) throws -> T) throws -> (T, SessionChange?, UInt64?) {
        try core.step(tier: tier, pid: 7, windowID: 70, window: 70, keys: keys, call: call, cancelled: { false }, body: body)
    }

    /// Waits up to 2 s for the between-calls path, which runs on another queue.
    func waitForPersonInput(count: Int = 1) {
        let deadline = Date().addingTimeInterval(2)
        while personInput.count < count, Date() < deadline { Thread.sleep(forTimeInterval: 0.005) }
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
