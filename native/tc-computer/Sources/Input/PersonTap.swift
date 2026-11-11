import CoreGraphics
import Foundation

/// The person guard's live tap (docs/computer-protocol.md §14.9.1): an active `CGEventTap` at the
/// session tap point, appended after the taps already there (the escape tap is head-inserted, so it
/// sees each event first), on a run loop thread of its own. Made once, at the first guarded step,
/// and enabled only while a guard is on. `PersonGuardRule` decides each event; what it drops for the
/// replay is buffered as copies, at most `guardReplayMax` of them plus the ups of buffered downs.
public final class LivePersonTap: PersonTapping, @unchecked Sendable {
    /// What the callback reads and writes. The lock is held for a field copy or one rule step, never longer.
    fileprivate final class State: @unchecked Sendable {
        let lock = NSLock()
        var active = false
        var rule = PersonGuardRule()
        var rearm = TapRearm()
        var buffer: [(GuardedEvent, CGEvent)] = []
        /// buffered entries that count toward the cap (every one but the ups of buffered downs)
        var capped = 0
        /// keys and modifiers whose buffered down awaits its up
        var bufferedDowns: Set<UInt16> = []
        var tripped = false
        var onTrip: (@Sendable () -> Void)?
        var replayed = 0
        var port: CFMachPort?
    }

    private let state = State()
    private let make = NSLock()
    private var made = false
    private var failed = false

    public init() {}

    public func enable(onTrip: @escaping @Sendable () -> Void) -> Bool {
        guard let port = madePort() else { return false }
        state.lock.withLock {
            state.rule.reset()
            state.rearm.reset()
            state.buffer = []
            state.capped = 0
            state.bufferedDowns = []
            state.tripped = false
            state.replayed = 0
            state.onTrip = onTrip
            state.active = true
        }
        CGEvent.tapEnable(tap: port, enable: true)
        return true
    }

    public func disable() -> GuardReport {
        let (port, report): (CFMachPort?, GuardReport) = state.lock.withLock {
            state.active = false
            state.onTrip = nil
            state.buffer = []
            return (state.port, GuardReport(mode: .active, dropped: state.rule.dropped, replayed: state.replayed, rearmed: state.rearm.rearmed))
        }
        if let port { CGEvent.tapEnable(tap: port, enable: false) }
        return report
    }

    public func replay(plan: ([GuardedEvent]) -> [Int], gapMs: Int, stillThere: () -> Bool) {
        var posted = Set<Int>()
        var down: Set<UInt16> = []
        var gone = false
        while true {
            let events = state.lock.withLock { state.buffer.map(\.0) }
            var picks = plan(events).filter { !posted.contains($0) }
            // the person's app lost its field: only the ups of what went down still go
            if gone { picks = picks.filter { ReplayPlanLive.lets(events[$0], goOfAny: down) } }
            guard let i = picks.first else { break }
            let (g, e) = state.lock.withLock { state.buffer[i] }
            if g.isDownLike, !stillThere() {
                gone = true
                continue
            }
            guard let copy = e.copy() else { break }
            copy.setIntegerValueField(.eventSourceUserData, value: TC_EVENT_MARK)
            copy.post(tap: .cgSessionEventTap)
            posted.insert(i)
            ReplayPlanLive.track(g, &down)
            if g.isDownLike { state.lock.withLock { state.replayed += 1 } }
            Thread.sleep(forTimeInterval: Double(gapMs) / 1000)
        }
    }

    /// Makes the tap once per process; nil (and never again) when the system refuses it.
    private func madePort() -> CFMachPort? {
        make.lock()
        defer { make.unlock() }
        if failed { return nil }
        if made { return state.lock.withLock { state.port } }
        let guarded: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel]
        let mask = guarded.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        let retained = Unmanaged.passRetained(state)
        guard let port = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .defaultTap,
            eventsOfInterest: mask, callback: personTapCallback, userInfo: retained.toOpaque()
        ) else {
            retained.release()
            failed = true
            return nil
        }
        // made disabled: a disabled tap is skipped by the system until a guard enables it
        CGEvent.tapEnable(tap: port, enable: false)
        state.lock.withLock { state.port = port }
        let source = CFMachPortCreateRunLoopSource(nil, port, 0)
        let thread = Thread {
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
            // the process's life: the tap goes with the process (§14.9.2)
            CFRunLoopRun()
        }
        thread.name = "tc-computer.person-guard"
        thread.qualityOfService = .userInteractive
        thread.start()
        made = true
        return port
    }
}

/// The replay's bookkeeping of which keys it put down, for the live loop.
enum ReplayPlanLive {
    static func lets(_ e: GuardedEvent, goOfAny down: Set<UInt16>) -> Bool {
        switch e.type {
        case .keyUp: down.contains(e.keyCode)
        case .flagsChanged: !e.pressesModifier && down.contains(e.keyCode)
        default: false
        }
    }

    static func track(_ e: GuardedEvent, _ down: inout Set<UInt16>) {
        switch e.type {
        case .keyDown: down.insert(e.keyCode)
        case .keyUp: down.remove(e.keyCode)
        case .flagsChanged where GuardFlags.bit(ofModifierKey: e.keyCode) != GuardFlags.capsLock:
            if e.pressesModifier { down.insert(e.keyCode) } else { down.remove(e.keyCode) }
        default: break
        }
    }
}

private func guardedEvent(_ type: CGEventType, _ event: CGEvent) -> GuardedEvent? {
    guard let t = GuardedEventType(rawValue: type.rawValue) else { return nil }
    let button: Int = switch t {
    case .leftMouseDown, .leftMouseUp, .leftMouseDragged: 0
    case .rightMouseDown, .rightMouseUp, .rightMouseDragged: 1
    default: Int(event.getIntegerValueField(.mouseEventButtonNumber))
    }
    return GuardedEvent(
        type: t,
        mark: event.getIntegerValueField(.eventSourceUserData),
        keyCode: UInt16(truncatingIfNeeded: event.getIntegerValueField(.keyboardEventKeycode)),
        button: button,
        flags: event.flags.rawValue,
        autorepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0,
        timestamp: event.timestamp
    )
}

/// Constant work: a few field reads, one rule step, a buffer append, a dispatched trip.
private func personTapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, userInfo: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    let s = Unmanaged<LivePersonTap.State>.fromOpaque(userInfo).takeUnretainedValue()
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        let again: CFMachPort? = s.lock.withLock {
            guard s.active, s.rearm.disabled(type == .tapDisabledByTimeout ? .timeout : .userInput) else { return nil }
            return s.port
        }
        if let again { CGEvent.tapEnable(tap: again, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    guard let g = guardedEvent(type, event) else { return Unmanaged.passUnretained(event) }
    let (drop, trip): (Bool, (@Sendable () -> Void)?) = s.lock.withLock {
        // a disable that raced this event: pass it
        guard s.active else { return (false, nil) }
        guard case .drop(let trips, let keep) = s.rule.decide(g) else { return (false, nil) }
        if keep { buffer(g, event, in: s) }
        guard trips, !s.tripped else { return (true, nil) }
        s.tripped = true
        return (true, s.onTrip)
    }
    if let trip { DispatchQueue.global(qos: .userInitiated).async(execute: trip) }
    return drop ? nil : Unmanaged.passUnretained(event)
}

/// Appends a dropped event the replay may want, under the lock: the ups of buffered downs outside the cap.
private func buffer(_ g: GuardedEvent, _ event: CGEvent, in s: LivePersonTap.State) {
    let up = g.type == .keyUp || (g.type == .flagsChanged && !g.pressesModifier)
    if up {
        guard s.bufferedDowns.remove(g.keyCode) != nil, let copy = event.copy() else { return }
        s.buffer.append((g, copy))
        return
    }
    guard s.capped < InputTiming.guardReplayMax, let copy = event.copy() else { return }
    s.buffer.append((g, copy))
    s.capped += 1
    if g.type == .keyDown || (g.type == .flagsChanged && GuardFlags.bit(ofModifierKey: g.keyCode) != GuardFlags.capsLock) {
        s.bufferedDowns.insert(g.keyCode)
    }
}
