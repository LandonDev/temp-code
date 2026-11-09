import AppKit
import Foundation

/// The person watch: a global NSEvent monitor on main for keys, modifiers, moves, the three
/// button downs, the drags and the wheel. An event whose CGEvent lacks TC_EVENT_MARK trips it.
public final class PersonWatch: PersonWatching, @unchecked Sendable {
    private let lock = NSLock()
    private var _armed = false
    private var _tripped = false
    private var onTrip: (@Sendable () -> Void)?
    private nonisolated(unsafe) var monitor: Any?

    public init() {}

    public var armed: Bool { lock.withLock { _armed } }
    public var tripped: Bool { lock.withLock { _tripped } }

    public func arm(onTrip: @escaping @Sendable () -> Void) {
        lock.withLock {
            _armed = true
            _tripped = false
            self.onTrip = onTrip
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
        lock.withLock {
            _armed = false
            onTrip = nil
        }
        _ = onMain { [self] in
            if let m = monitor { NSEvent.removeMonitor(m) }
            monitor = nil
        }
    }

    private func trip() {
        let call = lock.withLock { () -> (@Sendable () -> Void)? in
            guard _armed, !_tripped else { return nil }
            _tripped = true
            return onTrip
        }
        call?()
    }
}
