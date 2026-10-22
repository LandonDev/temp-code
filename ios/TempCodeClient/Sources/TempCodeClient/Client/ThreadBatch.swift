import Foundation
import TempCodeContract

/// The fleet switches on the phone: the desktop's `threadBatch.ts` as pure
/// values. One action over every qualifying root of a scope; what qualifies
/// is `targets`, what the confirm says is `confirm`, what the toast says is
/// `toast`. Subagents follow their parent: only roots are selected, and the
/// host acts on trees. The phone has no "everywhere": each host's menu is
/// that host, so a scope is the host or one of its projects.
public enum BatchAction: String, CaseIterable, Sendable, Hashable {
    case pause, resume, stop, archiveDone

    /// The host's name for the action (`session.batch`'s `action`).
    public var wire: Methods.SessionBatch.Params.Action {
        switch self {
        case .pause: .pause
        case .resume: .resume
        case .stop: .stop
        case .archiveDone: .archive
        }
    }
}

public enum BatchScope: Sendable, Hashable {
    /// Every root on the host (the host's menu; one host per client).
    case host(name: String)
    /// Roots placed in the project.
    case project(id: String, name: String, cwd: String)
}

/// What `targets` needs beside the metas: the scope and the seen marks the
/// Archive done rule reads.
public struct BatchSelection: Sendable, Hashable {
    public var scope: BatchScope
    /// `client.seen`: the person's last look per thread.
    public var seen: [String: SeenMark]
    /// Threads with no seen mark count as seen up to this time (the pairing).
    public var floor: Int
    /// Clock milliseconds.
    public var now: Int

    public init(scope: BatchScope, seen: [String: SeenMark] = [:], floor: Int = 0, now: Int) {
        self.scope = scope
        self.seen = seen
        self.floor = floor
        self.now = now
    }
}

/// The confirm sheet's words for a count computed live.
public struct BatchConfirmCopy: Sendable, Hashable {
    public var title: String
    public var body: String
    public var confirmLabel: String
    public var danger: Bool
    /// The Archive done clause with its switch; nil when there is nothing to release.
    public var cleanup: String?
}

public struct BatchFailure: Sendable, Hashable {
    public var sessionId: String
    public var title: String
    public var error: String

    public init(sessionId: String, title: String, error: String) {
        self.sessionId = sessionId
        self.title = title
        self.error = error
    }
}

/// One line for the toast; the failed threads come back for the links.
public struct BatchToast: Sendable, Hashable {
    /// "Paused 14 · 1 failed: Search (harness not responding)"
    public var summary: String
    public var succeeded: Int
    public var failed: [BatchFailure]
}

public enum ThreadBatch {
    /// Idle for at least this long before Archive done takes a thread.
    public static let archiveDoneAgeMs = 10 * 60_000

    // A queued thread (created, not booted) is not live: Pause and Resume
    // leave it. Stop takes it as "remove from the queue" and Archive done
    // takes it too (it holds no turn); the host archives it on both.
    private static let live: Set<SessionStatus> = [.starting, .running, .waiting]

    public static func isQueued(_ m: SessionMeta) -> Bool { m.status == .queued }

    /// A thread with a turn in flight somewhere in its tree, not paused. A
    /// watching master is not live by itself.
    public static func hasRunningTurn(_ m: SessionMeta) -> Bool {
        if m.status == .paused { return false }
        return live.contains(m.status) || m.treeHasLiveWork == true
    }

    /// Paused anywhere in the tree, or stopped by a restart.
    static func isPausedOrStopped(_ m: SessionMeta) -> Bool {
        m.status == .paused || m.treeHasPaused == true || m.status == .stopped
    }

    /// Does one root qualify for the action, scope aside.
    public static func qualifies(_ action: BatchAction, _ m: SessionMeta, seenAt: Int, now: Int) -> Bool {
        switch action {
        case .pause:
            return hasRunningTurn(m)
        case .stop:
            return hasRunningTurn(m) || isQueued(m)
        case .resume:
            return isPausedOrStopped(m)
        case .archiveDone:
            if isQueued(m) { return true }
            return (m.status == .idle || m.status == .done)
                && m.treeHasLiveWork != true
                && m.treeHasPaused != true
                && m.treeCanContinue != true
                && m.canContinue != true
                && m.updatedAt <= seenAt
                && now - m.updatedAt >= archiveDoneAgeMs
        }
    }

    /// Host: every root. Project: by `projectId`, or the legacy placement
    /// (no project, no workspace, the cwd is the project's).
    public static func inScope(_ m: SessionMeta, _ scope: BatchScope) -> Bool {
        switch scope {
        case .host:
            return true
        case .project(let id, _, let cwd):
            if m.projectId == id { return true }
            return m.projectId == nil && m.workspaceId == nil && trim(m.cwd) == trim(cwd)
        }
    }

    private static func trim(_ path: String) -> String {
        var out = Substring(path)
        while out.count > 1, out.hasSuffix("/") { out = out.dropLast() }
        return String(out)
    }

    /// The roots the action would touch right now, in the order given.
    public static func targets(_ action: BatchAction, _ metas: [SessionMeta], _ sel: BatchSelection) -> [SessionMeta] {
        metas.filter { m in
            m.parentId == nil
                && !m.archived
                && inScope(m, sel.scope)
                && qualifies(action, m, seenAt: sel.seen[m.id]?.at ?? sel.floor, now: sel.now)
        }
    }

    /// How many roots each action would touch: the menu rows' disabled state.
    public static func counts(_ metas: [SessionMeta], _ sel: BatchSelection) -> [BatchAction: Int] {
        var out: [BatchAction: Int] = [:]
        for action in BatchAction.allCases { out[action] = targets(action, metas, sel).count }
        return out
    }

    /// Resume needs no confirm: nothing is lost by resuming.
    public static func needsConfirm(_ action: BatchAction) -> Bool { action != .resume }

    public static func label(_ action: BatchAction) -> String {
        switch action {
        case .pause: "Pause all"
        case .resume: "Resume all"
        case .stop: "Stop all"
        case .archiveDone: "Archive done"
        }
    }

    public static func symbol(_ action: BatchAction) -> String {
        switch action {
        case .pause: "pause"
        case .resume: "play"
        case .stop: "stop"
        case .archiveDone: "archivebox"
        }
    }

    /// Where the action reaches, as the confirm's clause: "on the box", "in temp-code".
    public static func scopePhrase(_ scope: BatchScope) -> String {
        switch scope {
        case .host(let name): "on \(name)"
        case .project(_, let name, _): "in \(name)"
        }
    }

    private struct Verb {
        let imperative: String
        let past: String
        let noun: String
    }

    private static func verb(_ action: BatchAction) -> Verb {
        switch action {
        case .pause: Verb(imperative: "Pause", past: "Paused", noun: "running")
        case .resume: Verb(imperative: "Resume", past: "Resumed", noun: "paused")
        case .stop: Verb(imperative: "Stop", past: "Stopped", noun: "running")
        case .archiveDone: Verb(imperative: "Archive", past: "Archived", noun: "finished")
        }
    }

    private static func threads(_ n: Int) -> String { n == 1 ? "thread" : "threads" }

    /// "Pause 15 running threads on the box?". `resources` is how many
    /// worktrees and simulators Archive done could release, nil when the host
    /// cannot say. `queued` is how many of the count are queued threads, which
    /// Stop and Archive done remove from the queue rather than stop or archive.
    public static func confirm(_ action: BatchAction, count: Int, scope: BatchScope, resources: Int? = nil, queued: Int = 0) -> BatchConfirmCopy {
        let v = verb(action)
        let whereClause = scopePhrase(scope)
        if count == 0 {
            return BatchConfirmCopy(
                title: "Nothing to \(v.imperative.lowercased()) \(whereClause)",
                body: "No \(v.noun) \(threads(2)) \(whereClause) right now.",
                confirmLabel: v.imperative,
                danger: false,
                cleanup: nil
            )
        }
        let acting = count - queued
        let removal: String? = queued > 0 ? "remove \(queued) from the queue" : nil
        let title: String
        if removal != nil, acting == 0 {
            title = "Remove \(queued) \(threads(queued)) from the queue \(whereClause)?"
        } else if let removal {
            title = "\(v.imperative) \(acting) \(v.noun) \(threads(acting)) and \(removal) \(whereClause)?"
        } else {
            title = "\(v.imperative) \(count) \(v.noun) \(threads(count)) \(whereClause)?"
        }
        let body: String
        if removal != nil, acting == 0 {
            body = "They have not started, so nothing is lost. Removed threads stay in the archive list."
        } else {
            switch action {
            case .pause:
                body = "Each thread keeps its place and picks up where it was when you resume it."
            case .stop:
                body = "Their turns end now. A stopped thread keeps its history and takes a new message." + (removal != nil ? " A queued thread leaves the queue for the archive list." : "")
            case .archiveDone, .resume:
                body = "Idle for more than ten minutes, read, and waiting on nothing. Archived threads stay in the archive list." + (removal != nil ? " A queued thread leaves the queue with them." : "")
            }
        }
        var cleanup: String?
        if action == .archiveDone, let resources, resources > 0 {
            cleanup = "and remove their \(resources) \(resources == 1 ? "worktree or simulator" : "worktrees and simulators")"
        }
        return BatchConfirmCopy(
            title: title,
            body: body,
            confirmLabel: "\(removal != nil && acting == 0 ? "Remove" : v.imperative) \(count)",
            danger: action == .stop || action == .archiveDone,
            cleanup: cleanup
        )
    }

    /// "Paused 14 · 1 failed: Search (harness not responding) and 2 more".
    public static func toast(_ action: BatchAction, succeeded: Int, failed: [BatchFailure]) -> BatchToast {
        var summary = "\(verb(action).past) \(succeeded)"
        if let first = failed.first {
            let rest = failed.count - 1
            summary += " · \(failed.count) failed: \(first.title) (\(first.error))"
            if rest > 0 { summary += " and \(rest) more" }
        }
        return BatchToast(summary: summary, succeeded: succeeded, failed: failed)
    }
}

// MARK: - the action

extension EnvironmentClient {
    /// The fleet switch: one `session.batch` over what qualifies now; the
    /// answer folded into a toast. A call that fails as a whole names every
    /// target; a key that cannot act is refused before the wire.
    public func batch(_ action: BatchAction, selection: BatchSelection, cleanup: Bool = false) async throws -> BatchToast {
        if let block = operateBlock { throw ActionError.blocked(block) }
        let targets = ThreadBatch.targets(action, sessions, selection)
        guard !targets.isEmpty else { return ThreadBatch.toast(action, succeeded: 0, failed: []) }
        let titleOf = Dictionary(targets.map { ($0.id, $0.title) }, uniquingKeysWith: { first, _ in first })
        do {
            let result = try await request(Methods.SessionBatch.self, .init(action: action.wire, ids: targets.map(\.id), cleanup: cleanup ? true : nil))
            let failed = result.failed.map { BatchFailure(sessionId: $0.sessionId, title: titleOf[$0.sessionId] ?? $0.sessionId, error: $0.error) }
            return ThreadBatch.toast(action, succeeded: result.succeeded.count, failed: failed)
        } catch {
            let wrapped = ActionError.wrap(error)
            return ThreadBatch.toast(action, succeeded: 0, failed: targets.map { BatchFailure(sessionId: $0.id, title: $0.title, error: wrapped.message) })
        }
    }

    /// The selection for a scope on this host, as the menus and the sheet read it.
    public func batchSelection(_ scope: BatchScope, now: Date = Date()) -> BatchSelection {
        BatchSelection(scope: scope, seen: seen, floor: Int(environment.addedAt), now: Int(now.timeIntervalSince1970 * 1000))
    }
}
