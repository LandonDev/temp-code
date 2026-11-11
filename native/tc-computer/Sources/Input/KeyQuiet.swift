import Foundation

/// The keyboard as the `front` tier's quiet wait reads it (docs/computer-protocol.md §26.5, Sol S12 and
/// S13): the person's last key down and the keys and modifiers they hold, kept from a listen-only
/// monitor's key downs, ups and flag changes. An event carrying `TC_EVENT_MARK` is the service's own and
/// never counts, so a person's key right after one of ours always does. Pure: the monitor feeds it.
public struct KeyQuietState: Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case keyDown, keyUp, flagsChanged }

    /// the modifier flags that count as held (Caps Lock is a lock, not a key held down)
    public static let heldModifiers: UInt64 = GuardFlags.shift | GuardFlags.control | GuardFlags.option | GuardFlags.command | GuardFlags.function

    /// monotonic seconds of the person's last key down; nil when none since the monitor started
    public private(set) var lastKeyDownAt: Double?
    public private(set) var keys: Set<UInt16>
    public private(set) var modifiers: UInt64

    /// Seeded when the monitor starts, from the session's own state of the keys and the flags.
    public init(heldKeys: Set<UInt16> = [], flags: UInt64 = 0, lastKeyDownAt: Double? = nil) {
        keys = heldKeys
        modifiers = flags & Self.heldModifiers
        self.lastKeyDownAt = lastKeyDownAt
    }

    public mutating func event(_ kind: Kind, keyCode: UInt16, flags: UInt64, mark: Int64, at: Double) {
        guard mark != TC_EVENT_MARK else { return }
        switch kind {
        case .keyDown:
            lastKeyDownAt = at
            keys.insert(keyCode)
        case .keyUp:
            keys.remove(keyCode)
        case .flagsChanged:
            modifiers = flags & Self.heldModifiers
        }
    }

    public var anyHeld: Bool { !keys.isEmpty || modifiers != 0 }

    /// Seconds since the last key down at `now`; a day when none was seen.
    public func secondsSinceKeyDown(now: Double) -> Double {
        lastKeyDownAt.map { max(0, now - $0) } ?? 86_400
    }
}
