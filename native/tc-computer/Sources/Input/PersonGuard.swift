import ComputerProtocol
import Foundation

// The person guard (docs/computer-protocol.md §14.9), its pure half: what the tap drops,
// what goes back to the person's app after the restore, and when the guard ends. Foundation
// only, so the box runs these suites; PersonTap.swift is the live tap over CGEvent.

/// The event kinds the guard's tap sees, by CGEventType raw value. Pointer moves are not among them.
public enum GuardedEventType: UInt32, CaseIterable, Sendable {
    case leftMouseDown = 1
    case leftMouseUp = 2
    case rightMouseDown = 3
    case rightMouseUp = 4
    case leftMouseDragged = 6
    case rightMouseDragged = 7
    case keyDown = 10
    case keyUp = 11
    case flagsChanged = 12
    case scrollWheel = 22
    case otherMouseDown = 25
    case otherMouseUp = 26
    case otherMouseDragged = 27

    var isButtonDown: Bool { self == .leftMouseDown || self == .rightMouseDown || self == .otherMouseDown }
    var isButtonUp: Bool { self == .leftMouseUp || self == .rightMouseUp || self == .otherMouseUp }
    var isDrag: Bool { self == .leftMouseDragged || self == .rightMouseDragged || self == .otherMouseDragged }
}

/// CGEventFlags bits, by raw value.
public enum GuardFlags {
    public static let capsLock: UInt64 = 0x1_0000
    public static let shift: UInt64 = 0x2_0000
    public static let control: UInt64 = 0x4_0000
    public static let option: UInt64 = 0x8_0000
    public static let command: UInt64 = 0x10_0000
    public static let function: UInt64 = 0x80_0000

    /// A modifier key's flag bit, by its key code (left and right alike).
    static func bit(ofModifierKey code: UInt16) -> UInt64? {
        switch code {
        case 56, 60: shift
        case 59, 62: control
        case 58, 61: option
        case 55, 54: command
        case 57: capsLock
        case 63: function
        default: nil
        }
    }
}

/// One event the tap saw, as the rules read it.
public struct GuardedEvent: Equatable, Sendable {
    public let type: GuardedEventType
    /// `eventSourceUserData`
    public let mark: Int64
    public let keyCode: UInt16
    /// `mouseEventButtonNumber`: 0 left, 1 right, 2 and up the others
    public let button: Int
    /// CGEventFlags raw
    public let flags: UInt64
    public let autorepeat: Bool
    /// the event's own timestamp (ns since boot), compared with the escape tap's cut
    public let timestamp: UInt64

    public init(type: GuardedEventType, mark: Int64 = 0, keyCode: UInt16 = 0, button: Int = 0, flags: UInt64 = 0, autorepeat: Bool = false, timestamp: UInt64 = 0) {
        self.type = type
        self.mark = mark
        self.keyCode = keyCode
        self.button = button
        self.flags = flags
        self.autorepeat = autorepeat
        self.timestamp = timestamp
    }

    /// For a flags change: whether it presses its key (the key's bit is set in the new flags).
    /// Caps Lock toggles, so each of its changes is a press; a key the table lacks counts as one.
    var pressesModifier: Bool {
        guard type == .flagsChanged else { return false }
        guard let bit = GuardFlags.bit(ofModifierKey: keyCode), bit != GuardFlags.capsLock else { return true }
        return flags & bit != 0
    }

    /// A key down or a modifier press: what `dropped` and `replayed` count beside button downs and the wheel.
    var isDownLike: Bool {
        switch type {
        case .keyDown: true
        case .flagsChanged: pressesModifier
        case .scrollWheel: true
        default: type.isButtonDown
        }
    }
}

/// What the guard does with one event.
public enum GuardDecision: Equatable, Sendable {
    case pass
    /// `trip`: the person is back, the watch trips; `keep`: buffered for the replay
    case drop(trip: Bool, keep: Bool)
}

/// The guard's rule, event by event (§14.9.3). It keeps the downs it dropped, so an up whose
/// down reached an app before the guard still reaches it, and an up whose down it dropped never does.
public struct PersonGuardRule: Sendable {
    private var keys: Set<UInt16> = []
    private var modifiers: Set<UInt16> = []
    private var buttons: Set<Int> = []
    /// key downs, modifier presses, button downs and wheel events dropped, never ups
    public private(set) var dropped = 0

    public init() {}

    public mutating func reset() {
        self = PersonGuardRule()
    }

    public mutating func decide(_ e: GuardedEvent) -> GuardDecision {
        if e.mark == TC_EVENT_MARK { return .pass }
        switch e.type {
        case .keyDown:
            if e.autorepeat {
                // a key held since before the guard keeps its up; its repeats are dropped all the same
                guard keys.contains(e.keyCode) else { return .drop(trip: true, keep: false) }
                dropped += 1
                return .drop(trip: true, keep: true)
            }
            keys.insert(e.keyCode)
            dropped += 1
            return .drop(trip: true, keep: true)
        case .keyUp:
            return keys.remove(e.keyCode) != nil ? .drop(trip: false, keep: true) : .pass
        case .flagsChanged:
            if e.pressesModifier {
                // Caps Lock has no release to follow
                if GuardFlags.bit(ofModifierKey: e.keyCode) != GuardFlags.capsLock { modifiers.insert(e.keyCode) }
                dropped += 1
                return .drop(trip: true, keep: true)
            }
            return modifiers.remove(e.keyCode) != nil ? .drop(trip: false, keep: true) : .pass
        case .scrollWheel:
            dropped += 1
            return .drop(trip: true, keep: true)
        case let t where t.isButtonDown:
            buttons.insert(e.button)
            dropped += 1
            return .drop(trip: true, keep: true)
        case let t where t.isButtonUp:
            return buttons.remove(e.button) != nil ? .drop(trip: false, keep: false) : .pass
        case let t where t.isDrag:
            return buttons.contains(e.button) ? .drop(trip: false, keep: false) : .pass
        default:
            return .pass
        }
    }
}

/// What the replay's rule reads of the call and the restore.
public struct ReplayContext: Sendable {
    /// the person tripped the guard
    public var tripped: Bool
    /// the host's person-only idle at the call's start, aged to the guard's arm; nil: never replay
    public var personIdleMs: Int?
    /// what the restore did with the front app
    public var frontmost: RestoreOutcome
    /// the restored app's focused element is the one it had when the guard armed
    public var sameElement: Bool

    public init(tripped: Bool, personIdleMs: Int?, frontmost: RestoreOutcome, sameElement: Bool) {
        self.tripped = tripped
        self.personIdleMs = personIdleMs
        self.frontmost = frontmost
        self.sameElement = sameElement
    }

    /// The three conditions of §14.9.4, and the trip.
    public var allows: Bool {
        guard tripped, let idle = personIdleMs, idle < InputTiming.guardReplayIdleMs else { return false }
        return frontmost == .restored && sameElement
    }
}

/// A call that may use the session tier, as a session step sees it: its token (`InputPerforming.callBegan`),
/// the host's person-only idle at the call's start, and when the driver saw it begin.
public struct SessionCall: Sendable {
    public var token: Int?
    public var personIdleMs: Int?
    public var startedAt: Double?

    public init(token: Int? = nil, personIdleMs: Int? = nil, startedAt: Double? = nil) {
        self.token = token
        self.personIdleMs = personIdleMs
        self.startedAt = startedAt
    }

    /// The idle aged by the time from the call's start to the guard's arm: an app-slot wait or a
    /// batch's earlier steps can be long, and the person may have left meanwhile.
    public func idle(atArm now: Double) -> Int? {
        guard let personIdleMs else { return nil }
        guard let startedAt else { return personIdleMs }
        return personIdleMs + Int((max(0, now - startedAt) * 1000).rounded())
    }
}

/// What goes back to the person's app (§14.9.4): the dropped events' prefix of plain typing, and
/// the ups of the downs in it, which are kept outside the cap so no key is left down.
public enum ReplayPlan {
    /// Return, keypad Enter, Escape and the F-keys: never replayed.
    static let neverKeys: Set<UInt16> = [36, 76, 53, 122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90]

    /// Key downs and ups without Command or Control, other than `neverKeys`, and the flag
    /// changes of Shift, Option and Caps Lock.
    public static func isPlainTyping(_ e: GuardedEvent) -> Bool {
        switch e.type {
        case .keyDown, .keyUp:
            return e.flags & (GuardFlags.command | GuardFlags.control) == 0 && !neverKeys.contains(e.keyCode)
        case .flagsChanged:
            guard let bit = GuardFlags.bit(ofModifierKey: e.keyCode) else { return false }
            return bit == GuardFlags.shift || bit == GuardFlags.option || bit == GuardFlags.capsLock
        default:
            return false
        }
    }

    /// The indices of `dropped` to post, in order. `cut`: the timestamp of an Escape the escape tap took.
    public static func plan(_ dropped: [GuardedEvent], cut: UInt64?, context: ReplayContext) -> [Int] {
        guard context.allows else { return [] }
        var out: [Int] = []
        var counted = 0
        var open = true
        var downKeys: Set<UInt16> = []
        var downModifiers: Set<UInt16> = []
        for (i, e) in dropped.enumerated() {
            if open {
                if let cut, e.timestamp >= cut { open = false }
                else if !isPlainTyping(e) { open = false }
            }
            if open {
                let upOfReplayed = upKey(e).map { downKeys.contains($0) || downModifiers.contains($0) } ?? false
                if !upOfReplayed {
                    if counted >= InputTiming.guardReplayMax {
                        open = false
                    } else {
                        counted += 1
                    }
                }
            }
            if open {
                out.append(i)
                track(e, keys: &downKeys, modifiers: &downModifiers)
            } else if let k = upKey(e), downKeys.contains(k) || downModifiers.contains(k) {
                // the up of a replayed down still goes, so nothing stays down
                out.append(i)
                track(e, keys: &downKeys, modifiers: &downModifiers)
            }
        }
        return out
    }

    /// The key an up or a modifier release lets go of.
    private static func upKey(_ e: GuardedEvent) -> UInt16? {
        switch e.type {
        case .keyUp: e.keyCode
        case .flagsChanged where !e.pressesModifier: e.keyCode
        default: nil
        }
    }

    private static func track(_ e: GuardedEvent, keys: inout Set<UInt16>, modifiers: inout Set<UInt16>) {
        switch e.type {
        case .keyDown: keys.insert(e.keyCode)
        case .keyUp: keys.remove(e.keyCode)
        case .flagsChanged:
            if GuardFlags.bit(ofModifierKey: e.keyCode) == GuardFlags.capsLock { break }
            if e.pressesModifier { modifiers.insert(e.keyCode) } else { modifiers.remove(e.keyCode) }
        default: break
        }
    }
}

public enum GuardMode: String, Sendable {
    case active
    /// the tap could not be made: the watch alone, nothing dropped
    case passive
}

/// What one guard did, answered on `input.restoreSession` as `personGuard`.
public struct GuardReport: Equatable, Sendable {
    public var mode: GuardMode
    public var dropped: Int
    public var replayed: Int
    public var rearmed: Int

    public init(mode: GuardMode, dropped: Int = 0, replayed: Int = 0, rearmed: Int = 0) {
        self.mode = mode
        self.dropped = dropped
        self.replayed = replayed
        self.rearmed = rearmed
    }

    public var wire: SessionRestore.PersonGuard {
        SessionRestore.PersonGuard(mode: mode == .active ? .active : .passive, dropped: dropped, replayed: replayed, rearmed: rearmed)
    }
}

/// When the guard is on (§14.9.2), over monotonic seconds; the session driver keeps one.
/// It also keeps the calls in flight, by token, each with its `personBack` mark (§14.9.5).
public struct GuardLife: Sendable {
    public private(set) var on = false
    private var nextToken = 0
    /// token → the person tripped the guard while the call ran
    private var calls: [Int: Bool] = [:]
    private var holding = false
    /// when the last call ended, the held input was let go or a step ended with neither
    private var quietSince: Double?
    private var trippedAt: Double?
    private var restoring = false

    public init() {}

    /// A session step armed the guard (every step calls this; the first turns it on).
    public mutating func armed(now: Double) {
        if !on {
            on = true
            trippedAt = nil
        }
        noteQuiet(now)
    }

    /// A step ended: with no call in flight and nothing held, the linger counts from here.
    public mutating func stepEnded(now: Double) {
        noteQuiet(now)
    }

    /// A call that may use the session tier began; its token.
    public mutating func callBegan() -> Int {
        nextToken += 1
        calls[nextToken] = false
        quietSince = nil
        return nextToken
    }

    public mutating func callEnded(_ token: Int, now: Double) {
        calls[token] = nil
        noteQuiet(now)
    }

    public var callsInFlight: [Int] { calls.keys.sorted() }

    /// The person tripped the guard during this call.
    public func isMarked(_ token: Int) -> Bool { calls[token] == true }

    public mutating func holding(_ held: Bool, now: Double) {
        holding = held
        if held { quietSince = nil } else { noteQuiet(now) }
    }

    /// The person tripped the guard: every call in flight is marked; their tokens.
    public mutating func tripped(at: Double) -> [Int] {
        if trippedAt == nil { trippedAt = at }
        for t in calls.keys { calls[t] = true }
        return callsInFlight
    }

    public mutating func restoreBegan() { restoring = true }

    /// A restore that threw: the guard ends by its other rules.
    public mutating func restoreFailed() { restoring = false }

    /// The guard ended (a restore returned, the sweep, the exit path). The calls in flight keep their marks.
    public mutating func ended() {
        on = false
        trippedAt = nil
        restoring = false
        quietSince = nil
    }

    /// Whether the guard has outlived its rules at `now`.
    public func expired(now: Double) -> Bool {
        guard on, !restoring else { return false }
        if let t = trippedAt, now >= t + InputTiming.restoreAfterInterruptS { return true }
        guard calls.isEmpty, !holding, let q = quietSince else { return false }
        return now >= q + InputTiming.guardLingerS
    }

    private mutating func noteQuiet(_ now: Double) {
        if calls.isEmpty, !holding { quietSince = now }
    }
}

/// The system disabled the tap: enable it again once per guard for a timeout, always for user input (§14.9.6).
public struct TapRearm: Sendable {
    public enum Disabled: Sendable {
        case timeout
        case userInput
    }

    public private(set) var rearmed = 0
    private var timeouts = 0

    public init() {}

    public mutating func reset() {
        self = TapRearm()
    }

    /// Whether to enable the tap again.
    public mutating func disabled(_ why: Disabled) -> Bool {
        if why == .timeout {
            timeouts += 1
            guard timeouts <= InputTiming.guardTimeoutRearms else { return false }
        }
        rearmed += 1
        return true
    }
}

/// The escape tap's cut (§14.9.9): the timestamp of the person's Escape it took, written by its
/// callback before it returns; the earliest written since the guard armed.
public final class GuardCut: @unchecked Sendable {
    public static let shared = GuardCut()
    private let lock = NSLock()
    private var at: UInt64?

    public init() {}

    public var value: UInt64? { lock.withLock { at } }

    public func note(_ timestamp: UInt64) {
        lock.withLock { at = min(at ?? timestamp, timestamp) }
    }

    /// A guard armed: an old Escape never reaches it.
    public func clear() {
        lock.withLock { at = nil }
    }
}

/// The guard's active tap; LivePersonTap is the real one, the tests never make one.
public protocol PersonTapping: AnyObject, Sendable {
    /// Enables the tap for a new guard, its rule and buffer reset; false when it can't be made.
    func enable(onTrip: @escaping @Sendable () -> Void) -> Bool
    /// Posts, marked and `gapMs` apart, the buffered events `plan` picks from what it has buffered
    /// (asked again after each post, so what the person types meanwhile joins it), asking
    /// `stillThere` before each key down and modifier press and dropping the rest when it says no.
    func replay(plan: ([GuardedEvent]) -> [Int], gapMs: Int, stillThere: () -> Bool)
    /// Disables the tap and answers what it did since `enable`.
    func disable() -> GuardReport
    /// `enable`, and `onEscape` at the person's Escape the guard dropped (a `front` hold stops there,
    /// §26.5); a tap that cannot tell the key never calls it.
    func enableReportingEscape(onTrip: @escaping @Sendable () -> Void, onEscape: @escaping @Sendable () -> Void) -> Bool
}

extension PersonTapping {
    public func enableReportingEscape(onTrip: @escaping @Sendable () -> Void, onEscape: @escaping @Sendable () -> Void) -> Bool {
        enable(onTrip: onTrip)
    }
}
