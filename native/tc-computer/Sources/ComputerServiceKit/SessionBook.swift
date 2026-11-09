import ComputerProtocol
import Foundation

/// What the shell remembers per session: per app (pid) the observation `seq`, whether the last read
/// was thin, the agent cursor and the held tier; per window the session's coordinate space.
public final class SessionBook: @unchecked Sendable {
    private struct AppState {
        var seq = 0
        var lastThin = false
        var cursor: [Int]?
        var heldTier: Tier?
    }

    private struct SessionState {
        var apps: [Int32: AppState] = [:]
        var spaces: [UInt32: CoordinateSpace] = [:]
    }

    private let lock = NSLock()
    private var sessions: [String: SessionState] = [:]

    public init() {}

    /// Idempotent.
    public func open(_ session: String) {
        lock.locked { if sessions[session] == nil { sessions[session] = SessionState() } }
    }

    public func close(_ session: String) {
        lock.locked { _ = sessions.removeValue(forKey: session) }
    }

    public func isOpen(_ session: String) -> Bool { lock.locked { sessions[session] != nil } }

    public var openSessions: [String] { lock.locked { Array(sessions.keys) } }

    /// The seq and base an observation of `kind` takes: a full, diff or unchanged one counts up, a diff
    /// or unchanged one is against the seq before it, and a subtree carries the current seq.
    public func stamp(_ session: String, pid: Int32, kind: ObservationKind) -> (seq: Int, base: Int?) {
        lock.locked {
            var app = sessions[session]?.apps[pid] ?? AppState()
            let before = app.seq
            switch kind {
            case .subtree, .unknown:
                return (before, nil)
            case .full:
                app.seq += 1
                sessions[session]?.apps[pid] = app
                return (app.seq, nil)
            case .diff, .unchanged:
                app.seq += 1
                sessions[session]?.apps[pid] = app
                return (app.seq, before)
            }
        }
    }

    /// The last read of the app was thin (the wait counts pixels then; `effect` says unknown).
    public func noteThin(_ session: String, pid: Int32, thin: Bool) {
        update(session, pid) { $0.lastThin = thin }
    }

    public func lastThin(_ session: String, pid: Int32) -> Bool {
        lock.locked { sessions[session]?.apps[pid]?.lastThin ?? false }
    }

    /// The agent cursor, session space.
    public func setCursor(_ session: String, pid: Int32, _ cursor: [Int]?) {
        update(session, pid) { $0.cursor = cursor }
    }

    public func cursor(_ session: String, pid: Int32) -> [Int]? {
        lock.locked { sessions[session]?.apps[pid]?.cursor }
    }

    /// The tier of a button or key the session holds on the app; nil when none.
    public func setHeld(_ session: String, pid: Int32, tier: Tier?) {
        update(session, pid) { $0.heldTier = tier }
    }

    public func held(_ session: String, pid: Int32) -> Tier? {
        lock.locked { sessions[session]?.apps[pid]?.heldTier }
    }

    /// Every pid the session holds input on.
    public func heldPids(_ session: String) -> [Int32] {
        lock.locked { sessions[session]?.apps.filter { $0.value.heldTier != nil }.map(\.key).sorted() ?? [] }
    }

    /// The space of the session's last full screenshot or observation shot of the window.
    public func setSpace(_ session: String, window: UInt32, _ space: CoordinateSpace) {
        lock.locked { sessions[session]?.spaces[window] = space }
    }

    public func space(_ session: String, window: UInt32) -> CoordinateSpace? {
        lock.locked { sessions[session]?.spaces[window] }
    }

    private func update(_ session: String, _ pid: Int32, _ change: (inout AppState) -> Void) {
        lock.locked {
            guard sessions[session] != nil else { return }
            var app = sessions[session]?.apps[pid] ?? AppState()
            change(&app)
            sessions[session]?.apps[pid] = app
        }
    }
}

/// The check every call that names an element runs first (docs/computer-protocol.md §4.2).
public enum EpochCheck {
    /// nil when the call may go on; else the failure: invalid params for an element without an epoch,
    /// `stale_element` (`service-restarted`) for another process's epoch.
    public static func check(names element: Int?, epoch: String?, current: String) -> (any Error)? {
        guard let element else { return nil }
        guard let epoch else { return RPCFailure.invalidParams("epoch: a call that names an element carries the epoch of its observation") }
        guard epoch == current else {
            return ComputerError(kind: .staleElement, message: "[\(element)] is from before the service restarted; read the tree again.", element: element, reason: .serviceRestarted)
        }
        return nil
    }
}
