import AppKit
import CoreGraphics
import Foundation

/// The listen-only key monitor (§26.5): a global NSEvent monitor of key downs, ups and flag changes on
/// main, run while any computer session is open (`InputPerforming.watchKeys`), its state seeded at the
/// start from `CGEventSource.keyState` and `flagsState`. While it is off, the session's event state
/// answers instead, so a hold outside a session still waits for a quiet keyboard.
public final class KeyMonitor: KeyboardState, @unchecked Sendable {
    private let lock = NSLock()
    private var state: KeyQuietState?
    private nonisolated(unsafe) var monitor: Any?
    private let fallback = SessionKeyboardState()

    public init() {}

    private static func now() -> Double { ProcessInfo.processInfo.systemUptime }

    public var running: Bool { lock.withLock { state != nil } }

    public func start() {
        guard lock.withLock({ state == nil }) else { return }
        let modifierKeys = Set(KeyCodes.modifierCodes.values).union([54, 57, 60, 61, 62, 63])
        let held = Set((CGKeyCode(0) ..< 128).filter { !modifierKeys.contains($0) && CGEventSource.keyState(.combinedSessionState, key: $0) })
        let flags = CGEventSource.flagsState(.combinedSessionState).rawValue
        let since = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
        lock.withLock { state = KeyQuietState(heldKeys: held, flags: flags, lastKeyDownAt: Self.now() - since) }
        _ = onMain { [self] in
            guard monitor == nil else { return }
            monitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown, .keyUp, .flagsChanged]) { [weak self] event in
                let kind: KeyQuietState.Kind = switch event.type {
                case .keyDown: .keyDown
                case .keyUp: .keyUp
                default: .flagsChanged
                }
                let mark = event.cgEvent?.getIntegerValueField(.eventSourceUserData) ?? 0
                let flags = event.cgEvent?.flags.rawValue ?? 0
                self?.lock.withLock { self?.state?.event(kind, keyCode: event.keyCode, flags: flags, mark: mark, at: Self.now()) }
            }
        }
    }

    public func stop() {
        lock.withLock { state = nil }
        _ = onMain { [self] in
            if let m = monitor { NSEvent.removeMonitor(m) }
            monitor = nil
        }
    }

    public func secondsSinceKeyDown() -> Double {
        lock.withLock { state?.secondsSinceKeyDown(now: Self.now()) } ?? fallback.secondsSinceKeyDown()
    }

    public func anyHeld() -> Bool {
        lock.withLock { state?.anyHeld } ?? fallback.anyHeld()
    }
}
