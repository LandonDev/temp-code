import ComputerCore
import ComputerProtocol
import Foundation

/// A button Input holds down between calls (`left_mouse_down` until `left_mouse_up`), per pid.
struct Hold {
    var tier: Tier
    var route: EventRoute
    /// where the button is: the down's point, moved by drags while held
    var at: ScreenPoint
    /// monotonic seconds of the down
    var since: Double
}

/// Held input across calls: the per-pid button, its release by every releaser, the
/// 30 s auto-release, and the crash ledger's word for each (`onHeld`).
final class HeldInput: @unchecked Sendable {
    private let lock = NSLock()
    private var holds: [Int32: Hold] = [:]
    private let sink: EventSink
    private let clock: InputClock
    private let onHeld: @Sendable (HeldEvent) -> Void
    /// called after a session-tier hold is let go: the session driver lets its lock and the watch go
    var onSessionReleased: (@Sendable () -> Void)?

    init(sink: EventSink, clock: InputClock, onHeld: @escaping @Sendable (HeldEvent) -> Void) {
        self.sink = sink
        self.clock = clock
        self.onHeld = onHeld
    }

    func hold(pid: Int32) -> Hold? {
        lock.withLock { holds[pid] }
    }

    func allHolds() -> [Int32: Hold] {
        lock.withLock { holds }
    }

    func heldTier(pid: Int32) -> Tier? {
        hold(pid: pid)?.tier
    }

    /// Whether any session-tier hold is left (the watch stays armed while one is).
    var holdsSession: Bool {
        lock.withLock { holds.values.contains { $0.tier == .session } }
    }

    /// The record the shell's ledger keeps for a down that outlives one event pair.
    func record(pid: Int32, tier: Tier, kind: HeldRecord.Kind, button: MouseButton? = nil, at: ScreenPoint? = nil, keyCodes: [UInt16]? = nil) -> HeldRecord {
        HeldRecord(
            writer: Int32(ProcessInfo.processInfo.processIdentifier),
            pid: pid,
            tier: tier,
            kind: kind,
            button: button.map { b -> Int in
                switch b {
                case .left: 0
                case .right: 1
                case .middle: 2
                }
            },
            point: at.map { [Int($0.x.rounded()), Int($0.y.rounded())] },
            keyCodes: keyCodes,
            since: clock.epochSeconds()
        )
    }

    /// Before a down that outlives one event pair is posted.
    func pressing(_ record: HeldRecord) {
        onHeld(.pressing(record))
    }

    /// After its up is posted, whatever let it go.
    func released(pid: Int32, kind: HeldRecord.Kind) {
        onHeld(.released(pid: pid, kind: kind))
    }

    /// Keeps a button down past this call.
    func keep(pid: Int32, _ hold: Hold) {
        lock.withLock { holds[pid] = hold }
    }

    /// A drag while held moves where the button is.
    func moved(pid: Int32, to p: ScreenPoint) {
        lock.withLock { holds[pid]?.at = p }
    }

    /// Takes the hold out (for `left_mouse_up`, which posts its own up).
    func take(pid: Int32) -> Hold? {
        lock.withLock { holds.removeValue(forKey: pid) }
    }

    /// Posts the up for the pid's button at its tier and tells the ledger; a session hold's lock goes with it.
    func releaseAll(pid: Int32) {
        guard let h = take(pid: pid) else { return }
        sink.post(.up(.left, h.at, clickState: 1, flags: []), route: h.route)
        released(pid: pid, kind: .button)
        if h.tier == .session { onSessionReleased?() }
    }

    /// Every pid's holds.
    func releaseEverything() {
        for pid in lock.withLock({ Array(holds.keys) }) { releaseAll(pid: pid) }
    }

    /// The auto-release: a hold this old with no up is let go. Returns the pids it released.
    @discardableResult
    func sweep() -> [Int32] {
        let now = clock.seconds()
        let old = lock.withLock { holds.filter { now - $0.value.since >= InputTiming.heldReleaseS }.map(\.key) }
        for pid in old { releaseAll(pid: pid) }
        return old
    }
}
