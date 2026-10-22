import Foundation
import TempCodeContract

/// What a planning thread's header says about its plan (the desktop's
/// planFlow.ts): open while the planner writes, complete when `plan_complete`
/// stamped it and the thread is still live, waiting once it settled with no
/// build, started once the host linked a build.
public enum PlanFlowState: Sendable, Hashable {
    case open
    case complete
    case waiting
    /// `title` and `type` are nil when the build is not on this host.
    case started(buildId: String, title: String?, type: ThreadType?)

    /// The rule, from the meta and a lookup of this host's sessions.
    public static func of(_ plan: SessionMeta, session: (String) -> SessionMeta?) -> PlanFlowState {
        guard plan.threadType == .planning, plan.parentId == nil, plan.planCompletedAt != nil else { return .open }
        if let buildId = plan.implementationId {
            if let build = session(buildId) {
                // An archived build is over: the host starts a new one on the next Start.
                if !build.archived { return .started(buildId: buildId, title: build.title, type: build.threadType) }
            } else {
                return .started(buildId: buildId, title: nil, type: nil)
            }
        }
        switch plan.status {
        case .starting, .running, .waiting: return .complete
        default: return .waiting
        }
    }

    /// The header's line; nil for `.open` (no row at all).
    public var line: String? {
        switch self {
        case .open: nil
        case .complete: "Plan complete"
        case .waiting: "Waiting for you to start the build"
        case .started: "Build started"
        }
    }

    /// The thread row's tag: "Plan ready" for a complete plan with no build.
    public static func rowTag(_ meta: SessionMeta) -> String? {
        guard meta.threadType == .planning, meta.parentId == nil, meta.planCompletedAt != nil, meta.implementationId == nil else { return nil }
        return "Plan ready"
    }
}

/// The build's line back to its plan.
public enum PlanOrigin {
    /// "Planned in <title>" for a build with `planThreadId` whose plan this
    /// host lists (archived plans are the normal case), or nil.
    public static func line(for build: SessionMeta, session: (String) -> SessionMeta?) -> (planId: String, text: String)? {
        guard let planId = build.planThreadId, let plan = session(planId) else { return nil }
        let title = plan.title.isEmpty ? "Untitled" : plan.title
        return (planId, "Planned in \(title)")
    }
}

extension Methods.PlanImplement.Params.ThreadType {
    /// The thread type a build may take: orchestration, else implementation.
    public init(_ type: TempCodeContract.ThreadType) {
        self = type == .orchestration ? .orchestration : .implementation
    }
}

extension EnvironmentClient {
    /// Start the build from a complete plan the way the desktop does: one
    /// `plan.implement` call; the host picks the title, the seed and the
    /// project's plan settings, and answers the build's meta, adopted so the
    /// screen can push to it before the `sessions` push.
    public func implementPlan(_ planId: String, type: ThreadType, provider: ProviderId?, model: String?, reasoning: Reasoning?, context1m: Bool? = nil, permission: PermissionPolicy? = nil) async throws -> SessionMeta {
        if let block = operateBlock { throw ActionError.blocked(block) }
        let meta: SessionMeta
        do {
            meta = try await request(Methods.PlanImplement.self, .init(sessionId: planId, provider: provider, model: model, reasoning: reasoning, context1m: context1m, permission: permission, threadType: .init(type), goal: nil, threadRules: nil))
        } catch {
            throw ActionError.wrap(error)
        }
        adopt(meta)
        return meta
    }
}
