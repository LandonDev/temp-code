import ApplicationServices
import ComputerProtocol
import ComputerServiceKit
import CoreGraphics
import Foundation
import Input

/// The person's Escape while the host holds a session (P1, docs/computer-protocol.md §8). Only while
/// `escape.watch` is on does an active event tap run; `EscapeFilter` decides each key event.
public protocol EscapeTapping: AnyObject, Sendable {
    /// Starts the tap; `onPress` runs for each Escape key down it takes. Throws when the system refuses a tap.
    func start(onPress: @escaping @Sendable () -> Void) throws
    /// Ends the tap; idempotent.
    func stop()
}

/// `escape.watch`'s state: the tap while on, and the lease that ends it when the host stops renewing.
/// `on: false`, the lease running out and the exit path (`shutdown`, stdin EOF, the parent gone, a
/// signal) all end the tap.
final class EscapeWatch: Stoppable, @unchecked Sendable {
    private let lock = NSLock()
    private var lease = EscapeLease()
    private var tap: (any EscapeTapping)?
    private var timer: DispatchSourceTimer?
    private let makeTap: @Sendable () -> any EscapeTapping
    private let now: @Sendable () -> Double
    private let onPress: @Sendable (Double) -> Void
    private let warn: @Sendable (String) -> Void
    private let queue = DispatchQueue(label: "tc-computer.escape-lease")

    /// `now`: epoch ms; `onPress` gets the press's time.
    init(makeTap: @escaping @Sendable () -> any EscapeTapping, now: @escaping @Sendable () -> Double,
         onPress: @escaping @Sendable (Double) -> Void, warn: @escaping @Sendable (String) -> Void) {
        self.makeTap = makeTap
        self.now = now
        self.onPress = onPress
        self.warn = warn
    }

    var isOn: Bool { lock.withLock { tap != nil } }

    /// `escape.watch { on, leaseMs }`: on starts the tap or renews its lease; off ends it.
    func set(on: Bool, leaseMs: Int?) throws {
        guard on else {
            stop()
            return
        }
        try lock.withLock {
            if tap == nil {
                let made = makeTap()
                let now = self.now, onPress = self.onPress
                try made.start(onPress: { onPress(now()) })
                tap = made
            }
            lease.renew(now: now(), leaseMs: leaseMs)
        }
        arm(afterMs: Double(EscapeLease.clamp(leaseMs)))
    }

    /// The lease's timer: ends the tap once the host's renewal is late, else waits for the new end.
    func check() {
        let current = now()
        let (ended, left): ((any EscapeTapping)?, Double?) = lock.withLock {
            if lease.lapsed(now: current) {
                defer { tap = nil }
                return (tap, nil)
            }
            return (nil, lease.until.map { $0 - current })
        }
        if let ended {
            ended.stop()
            warn("the escape watch ended: the host stopped renewing it")
        } else if let left {
            arm(afterMs: left)
        }
    }

    func stop() {
        let ending: ((any EscapeTapping)?, DispatchSourceTimer?) = lock.withLock {
            lease.end()
            defer {
                tap = nil
                timer = nil
            }
            return (tap, timer)
        }
        ending.1?.cancel()
        ending.0?.stop()
    }

    private func arm(afterMs ms: Double) {
        let next = DispatchSource.makeTimerSource(queue: queue)
        next.schedule(deadline: .now() + max(ms, 1) / 1000)
        next.setEventHandler { [weak self] in self?.check() }
        let previous: DispatchSourceTimer? = lock.withLock {
            defer { timer = next }
            return timer
        }
        previous?.cancel()
        next.resume()
    }
}

/// The live tap: an active `CGEventTap` at the session tap point for key down and key up, on a run
/// loop thread of its own. It needs the Accessibility grant the service already holds.
public final class LiveEscapeTap: EscapeTapping, @unchecked Sendable {
    public init() {}

    private let lock = NSLock()
    private var port: CFMachPort?
    private var loop: CFRunLoop?

    public func start(onPress: @escaping @Sendable () -> Void) throws {
        let box = TapBox(onPress: onPress)
        let retained = Unmanaged.passRetained(box)
        let mask = (CGEventMask(1) << CGEventType.keyDown.rawValue) | (CGEventMask(1) << CGEventType.keyUp.rawValue)
        guard let port = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
            eventsOfInterest: mask, callback: escapeTapCallback, userInfo: retained.toOpaque()
        ) else {
            retained.release()
            throw ComputerError(kind: .permissionMissing, message: "TempCode needs the Accessibility permission to watch for Escape.", which: .accessibility)
        }
        box.port = port
        let source = CFMachPortCreateRunLoopSource(nil, port, 0)
        let started = LoopHolder()
        let thread = Thread {
            let loop = CFRunLoopGetCurrent()
            CFRunLoopAddSource(loop, source, .commonModes)
            CGEvent.tapEnable(tap: port, enable: true)
            started.set(loop)
            if loop != nil { CFRunLoopRun() }
            // the callback runs on this thread alone, so the box goes only once the loop is done
            retained.release()
        }
        thread.name = "tc-computer.escape"
        thread.start()
        let loop = started.wait()
        lock.withLock {
            self.port = port
            self.loop = loop
        }
    }

    public func stop() {
        let (port, loop): (CFMachPort?, CFRunLoop?) = lock.withLock {
            defer {
                self.port = nil
                self.loop = nil
            }
            return (self.port, self.loop)
        }
        if let port {
            CGEvent.tapEnable(tap: port, enable: false)
            CFMachPortInvalidate(port)
        }
        if let loop { CFRunLoopStop(loop) }
    }
}

/// What the C callback reaches through `userInfo`.
private final class TapBox: @unchecked Sendable {
    let onPress: @Sendable () -> Void
    /// set before the tap is enabled
    var port: CFMachPort?

    init(onPress: @escaping @Sendable () -> Void) {
        self.onPress = onPress
    }
}

/// Hands the tap thread's run loop back to `start`.
private final class LoopHolder: @unchecked Sendable {
    private let ready = DispatchSemaphore(value: 0)
    private var loop: CFRunLoop?

    func set(_ loop: CFRunLoop?) {
        self.loop = loop
        ready.signal()
    }

    func wait() -> CFRunLoop? {
        ready.wait()
        return loop
    }
}

private func escapeTapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, userInfo: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    let box = Unmanaged<TapBox>.fromOpaque(userInfo).takeUnretainedValue()
    switch type {
    case .tapDisabledByTimeout, .tapDisabledByUserInput:
        // the system turned the tap off; turn it on again
        if let port = box.port { CGEvent.tapEnable(tap: port, enable: true) }
        return Unmanaged.passUnretained(event)
    case .keyDown, .keyUp:
        let decision = EscapeFilter.decide(
            keycode: event.getIntegerValueField(.keyboardEventKeycode),
            marked: event.getIntegerValueField(.eventSourceUserData) == TC_EVENT_MARK,
            down: type == .keyDown,
            autorepeat: event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        )
        switch decision {
        case .pass:
            return Unmanaged.passUnretained(event)
        case .take(let press):
            if press { DispatchQueue.global(qos: .userInitiated).async(execute: box.onPress) }
            return nil
        }
    default:
        return Unmanaged.passUnretained(event)
    }
}
