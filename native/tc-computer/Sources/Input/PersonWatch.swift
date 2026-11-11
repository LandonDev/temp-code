import AppKit
import Foundation

/// The person watch: a global NSEvent monitor on main for keys, modifiers, moves, the three
/// button downs, the drags and the wheel. An event whose CGEvent lacks TC_EVENT_MARK trips it.
/// With a tap (the session driver's watch), arming also enables the person guard's active tap
/// (§14.9), whose own drops trip it the same way; a tap the system refuses leaves it passive.
public final class PersonWatch: PersonWatching, @unchecked Sendable {
    private let lock = NSLock()
    private var _armed = false
    private var _tripped = false
    private var onTrip: (@Sendable () -> Void)?
    private nonisolated(unsafe) var monitor: Any?
    private let tap: PersonTapping?
    /// the tap is on for this arming
    private var tapOn = false
    private var _report: GuardReport?
    private static let warned = NSLock()
    private nonisolated(unsafe) static var didWarn = false

    /// `tap`: only the session driver's watch has one; tc-input-proof's idle gate stays passive.
    public init(tap: PersonTapping? = nil) {
        self.tap = tap
    }

    public var armed: Bool { lock.withLock { _armed } }
    public var tripped: Bool { lock.withLock { _tripped } }
    public var report: GuardReport? { lock.withLock { _report } }

    public func arm(onTrip: @escaping @Sendable () -> Void) {
        lock.withLock {
            _armed = true
            _tripped = false
            self.onTrip = onTrip
        }
        if let tap {
            let on = tap.enable { [weak self] in self?.trip() }
            lock.withLock { tapOn = on }
            if !on { Self.warnPassive() }
        }
        _ = onMain { [self] in
            guard monitor == nil else { return }
            let mask: NSEvent.EventTypeMask = [.keyDown, .flagsChanged, .mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel]
            monitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] event in
                let mark = event.cgEvent?.getIntegerValueField(.eventSourceUserData) ?? 0
                if isPersonEvent(userData: mark, type: UInt32(event.type.rawValue)) { self?.trip() }
            }
        }
    }

    public func disarm() {
        let (wasArmed, tapWasOn) = lock.withLock { () -> (Bool, Bool) in
            defer {
                _armed = false
                onTrip = nil
                tapOn = false
            }
            return (_armed, tapOn)
        }
        if wasArmed {
            let report = tapWasOn ? tap?.disable() : GuardReport(mode: .passive)
            lock.withLock { _report = report }
        }
        _ = onMain { [self] in
            if let m = monitor { NSEvent.removeMonitor(m) }
            monitor = nil
        }
    }

    public func replay(plan: ([GuardedEvent]) -> [Int], stillThere: () -> Bool) {
        guard lock.withLock({ tapOn }), let tap else { return }
        tap.replay(plan: plan, gapMs: InputTiming.eventGapMs, stillThere: stillThere)
    }

    private func trip() {
        let call = lock.withLock { () -> (@Sendable () -> Void)? in
            guard _armed, !_tripped else { return nil }
            _tripped = true
            return onTrip
        }
        call?()
    }

    private static func warnPassive() {
        let first = warned.withLock { () -> Bool in
            defer { didWarn = true }
            return !didWarn
        }
        if first { FileHandle.standardError.write(Data("[input] the person guard is passive: the system refused its event tap\n".utf8)) }
    }
}
