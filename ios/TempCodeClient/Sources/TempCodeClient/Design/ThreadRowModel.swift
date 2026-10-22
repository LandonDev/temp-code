import Foundation
import TempCodeContract

/// What one thread row reads. The shell builds it from a `SessionMeta` and
/// the cache's seen state; a fleet or needs-you row builds the same shape by
/// hand. Pure, so the precedence rules (failure over detail, tasks over
/// activity, the master tag) are tested here; the app's `ThreadRow` only draws it.
public struct ThreadRowModel: Hashable, Sendable {
    public var title: String
    public var type: ThreadType?
    public var status: SessionStatus
    /// Settled work the user has not looked at: the title goes semibold.
    public var unseen = false
    /// What the second line opens with; a sibling may compose it
    /// ("Sonnet 5.5", then "work"). The row never parses it.
    public var model: String
    /// `done/total current`, else the last activity (the host writes
    /// "Queued · waiting for X" there).
    public var detail: String?
    /// The host's verdict on a failed turn; shown in place of the detail, in destructive.
    public var failure: String?
    /// One muted word after the title. "Master" for a pinned master; nothing else sets it today.
    public var tag: String?
    public var updatedAt: Int
    public var busySince: Int?
    /// The spinner leads and the trailing time runs.
    public var running = false
    public var pinned = false
    /// A subagent under its root: one step in, the agent glyph instead of the type.
    public var agent: AgentType?

    public init(
        title: String,
        type: ThreadType? = nil,
        status: SessionStatus,
        unseen: Bool = false,
        model: String,
        detail: String? = nil,
        failure: String? = nil,
        tag: String? = nil,
        updatedAt: Int,
        busySince: Int? = nil,
        running: Bool = false,
        pinned: Bool = false,
        agent: AgentType? = nil
    ) {
        self.title = title
        self.type = type
        self.status = status
        self.unseen = unseen
        self.model = model
        self.detail = detail
        self.failure = failure
        self.tag = tag
        self.updatedAt = updatedAt
        self.busySince = busySince
        self.running = running
        self.pinned = pinned
        self.agent = agent
    }

    public init(session: SessionMeta, unseen: Bool = false) {
        let child = session.parentId != nil
        title = session.title.isEmpty ? (child ? "Subagent" : "Untitled") : session.title
        type = session.threadType
        status = session.status
        self.unseen = unseen
        model = ModelName.short(session.model)
        detail = Self.detail(of: session)
        failure = session.failureSummary
        tag = session.isMaster == true ? "Master" : PlanFlowState.rowTag(session)
        updatedAt = session.updatedAt
        busySince = session.busySince
        running = HomeModel.isLive(session)
        pinned = session.pinned
        agent = child ? session.agentType : nil
    }

    /// The second line's variable half: tasks first, since they say where the work is.
    public static func detail(of session: SessionMeta) -> String? {
        if let tasks = session.tasks, tasks.total > 0 {
            let count = "\(tasks.done)/\(tasks.total)"
            if let current = tasks.current, !current.isEmpty { return "\(count) \(current)" }
            return count
        }
        // The row's queued dot already says queued: the host's reason alone.
        if let activity = session.activity, !activity.isEmpty { return StripWords.reason(fromActivity: activity) }
        return nil
    }

    /// What the second line shows after the model.
    public enum SecondLine: Hashable, Sendable {
        /// The host's verdict, drawn in destructive.
        case failure(String)
        /// The tasks or activity; `nil` leaves the line's second half empty.
        case detail(String?)
    }

    /// A failure wins over the detail: the row must say what happened.
    public var secondLine: SecondLine {
        failure.map { .failure($0) } ?? .detail(detail)
    }

    /// The title, the glyphs and the pause mark go semibold together.
    public var emphasized: Bool { unseen }
}
