import Foundation
import TempCodeContract

/// Why a thread cannot take an action right now: the host is not reachable,
/// or the key may not. One value, one line the field or the card carries.
public enum ActionBlock: Sendable, Hashable {
    case connecting
    /// `retryAt` is clock milliseconds of the next attempt, when one is scheduled.
    case reconnecting(retryAt: Double?)
    case offline(reason: String?)
    case halted(HaltReason)
    case unauthorized
    case suspended
    /// The key reads but does not operate.
    case readOnly
    /// The key operates but does not approve.
    case noApprove

    /// The line shown in the composer field or under a card. `now` is clock
    /// milliseconds, for the retry countdown.
    public func text(now: Double) -> String {
        switch self {
        case .connecting:
            return "Connecting…"
        case .reconnecting(let retryAt):
            guard let retryAt else { return "Reconnecting…" }
            let seconds = max(0, Int(((retryAt - now) / 1000).rounded()))
            return seconds > 0 ? "Reconnecting in \(seconds) s" : "Reconnecting…"
        case .offline(let reason):
            return reason ?? "Offline"
        case .halted(let halt):
            switch halt {
            case .identityChanged: return "This host is not the one that was paired"
            case .contractMismatch(let app, let host): return host > app ? "Update the app to act on this host" : "Update the host to act on it"
            }
        case .unauthorized:
            return "The key was refused"
        case .suspended:
            return "Paused in the background"
        case .readOnly:
            return "This key can read but not act"
        case .noApprove:
            return "This key can't approve"
        }
    }

    /// The host is the problem, not the key: a retry can lift it.
    public var isTransient: Bool {
        switch self {
        case .readOnly, .noApprove, .halted, .unauthorized: false
        default: true
        }
    }
}

/// What an action threw: the block it hit before the wire, or what the host said.
public enum ActionError: Error, Hashable, Sendable {
    case blocked(ActionBlock)
    /// The host answered no; `forbidden` is the key's capabilities saying so.
    case refused(message: String, forbidden: Bool)

    public var message: String {
        switch self {
        case .blocked(let block): block.text(now: Date().timeIntervalSince1970 * 1000)
        case .refused(let message, _): message
        }
    }

    static func wrap(_ error: any Error) -> ActionError {
        if let action = error as? ActionError { return action }
        if let transport = error as? TransportError {
            switch transport {
            case .notConnected: return .blocked(.reconnecting(retryAt: nil))
            case .closed: return .blocked(.reconnecting(retryAt: nil))
            case .server(_, let message): return .refused(message: Self.plain(message), forbidden: transport.isForbidden)
            case .decoding(_, let detail): return .refused(message: detail, forbidden: false)
            case .cancelled: return .refused(message: "cancelled", forbidden: false)
            }
        }
        return .refused(message: String(describing: error), forbidden: false)
    }

    /// `forbidden: session.send needs operate` reads better as what to do.
    private static func plain(_ message: String) -> String {
        guard message.hasPrefix("forbidden") else { return message }
        return message.contains("approve") ? ActionBlock.noApprove.text(now: 0) : ActionBlock.readOnly.text(now: 0)
    }
}

/// A user turn this device sent and the host has not echoed back. The echo
/// is the `user-text` row with the same text; it clears the pending turn.
public struct PendingTurn: Sendable, Hashable, Identifiable {
    public let id: UUID
    public var text: String
    /// Clock milliseconds when it left.
    public var sentAt: Int

    public init(id: UUID = UUID(), text: String, sentAt: Int) {
        self.id = id
        self.text = text
        self.sentAt = sentAt
    }

    /// How a pending turn sits in the transcript: a user turn with a seq
    /// below every persisted row, ordered by send.
    public func entry(index: Int) -> ThreadEntry {
        ThreadEntry(item: .user(UserTurn(seq: -100_000 - index, ts: sentAt, text: text, attachments: [], model: nil, reasoning: nil, completedTs: nil, costUsd: nil)))
    }
}

/// The catalog a host serves: providers with the models the installed CLIs can run.
public typealias Catalog = [String: ProviderInfo]

/// What the composer's chips ask of the next turn: the desktop's
/// `RunSettings`, where an absent field keeps the thread's own. Built with
/// `override(for:provider:model:reasoning:)`, which sends nothing when the
/// choice is the thread's current model, so a turn that changed nothing
/// carries no settings at all.
public struct TurnModel: Sendable, Hashable {
    public var provider: ProviderId?
    public var model: String?
    public var reasoning: Reasoning?

    public init(provider: ProviderId? = nil, model: String? = nil, reasoning: Reasoning? = nil) {
        self.provider = provider
        self.model = model
        self.reasoning = reasoning
    }

    /// Nothing differs from the thread: the send carries no settings.
    public var isEmpty: Bool { provider == nil && model == nil && reasoning == nil }

    /// The settings for a turn on `session` with the chips at `provider`,
    /// `model` and `reasoning`: nil when every chip matches the thread. A
    /// model change always names its provider (the host switches harness by
    /// the provider a model came with); a reasoning change alone names only
    /// the level, and a reasoning the model does not offer is left to the
    /// host's default.
    public static func override(for session: SessionMeta, provider: ProviderId, model: String, reasoning: Reasoning?) -> TurnModel? {
        let modelChanged = provider != session.provider || model != session.model
        let reasoningChanged = reasoning != nil && reasoning != session.reasoning
        guard modelChanged || reasoningChanged else { return nil }
        return TurnModel(
            provider: modelChanged ? provider : nil,
            model: modelChanged ? model : nil,
            reasoning: reasoningChanged || modelChanged ? reasoning : nil
        )
    }
}

/// Everything a `session.create` takes from the phone, with the desktop's
/// two recipes: a build seeded from a plan (PlanView's Start) and a fresh
/// thread from the chooser. Pure, so the payloads are tested without a host.
public struct ThreadDraft: Sendable, Hashable {
    public var threadType: ThreadType
    public var provider: ProviderId
    public var model: String
    public var reasoning: Reasoning?
    public var projectId: String?
    public var workspaceId: String?
    public var cwd: String?
    public var permission: PermissionPolicy?
    public var planPath: String?
    public var goal: String?
    public var title: String?
    /// The kickoff message sent right after the create, when there is one.
    public var brief: String?

    public init(threadType: ThreadType, provider: ProviderId, model: String, reasoning: Reasoning? = nil, projectId: String? = nil, workspaceId: String? = nil, cwd: String? = nil, permission: PermissionPolicy? = nil, planPath: String? = nil, goal: String? = nil, title: String? = nil, brief: String? = nil) {
        self.threadType = threadType
        self.provider = provider
        self.model = model
        self.reasoning = reasoning
        self.projectId = projectId
        self.workspaceId = workspaceId
        self.cwd = cwd
        self.permission = permission
        self.planPath = planPath
        self.goal = goal
        self.title = title
        self.brief = brief
    }

    /// The desktop's `agentTypeFor`: an orchestration thread is run by an orchestrator.
    public static func agentType(for type: ThreadType) -> AgentType {
        type == .orchestration ? .orchestrator : .implementer
    }

    /// The capability the create needs: a full-access thread skips every prompt, so it takes `approve`.
    public var needs: Capability { permission == .auto ? .approve : .operate }

    public var params: Methods.SessionCreate.Params {
        .init(
            provider: provider,
            model: model,
            reasoning: reasoning,
            agentType: Self.agentType(for: threadType),
            cwd: cwd,
            title: title,
            projectId: projectId.map { .set($0) },
            workspaceId: workspaceId.map { .set($0) },
            threadType: .set(threadType),
            planPath: planPath,
            permission: permission,
            goal: goal
        )
    }

    /// The desktop's plan handoff (PlanView's Start): an implementation or
    /// orchestration thread in the plan's project, seeded from the plan file,
    /// with the finish line the desktop defaults to and its kickoff brief.
    /// `tasks` is the count of the plan's checklist.
    public static func build(from plan: SessionMeta, type: ThreadType, provider: ProviderId, model: String, reasoning: Reasoning?, tasks: Int, permission: PermissionPolicy? = nil) -> ThreadDraft {
        let base = plan.title.replacingOccurrences(of: "^Plan:?\\s*", with: "", options: [.regularExpression, .caseInsensitive])
        let goal = tasks > 0
            ? "Every task in the plan's checklist is checked off and typecheck passes"
            : "The plan is fully implemented and typecheck passes"
        let brief = type == .orchestration
            ? "Orchestrate implementation of the plan across subagents."
            : base.isEmpty ? "Implement the plan." : "Implement the plan \"\(base)\"."
        return ThreadDraft(
            threadType: type,
            provider: provider,
            model: model,
            reasoning: reasoning,
            projectId: plan.projectId,
            workspaceId: plan.workspaceId,
            cwd: plan.cwd,
            permission: permission ?? plan.permission,
            planPath: plan.planPath,
            goal: goal,
            title: base.isEmpty ? nil : base,
            brief: brief
        )
    }

    /// A fresh thread from the chooser: in a project, or a chat hung off the
    /// workspace when there is none. The first message is the user's.
    public static func thread(type: ThreadType, workspaceId: String, projectId: String?, provider: ProviderId, model: String, reasoning: Reasoning?, permission: PermissionPolicy?) -> ThreadDraft {
        ThreadDraft(
            threadType: type,
            provider: provider,
            model: model,
            reasoning: reasoning,
            projectId: projectId,
            workspaceId: projectId == nil ? workspaceId : nil,
            permission: permission
        )
    }
}

/// The gate every action runs before the wire.
public enum Actions {
    /// The block for an action needing `capability`, or nil when it may go.
    /// The key's standing comes first: it never changes by itself.
    public static func block(status: EnvironmentStatus, environment: PairedEnvironment, needs capability: Capability) -> ActionBlock? {
        if !environment.allows(capability) { return capability == .approve && environment.allows(.operate) ? .noApprove : .readOnly }
        switch status.transport {
        case .open: return nil
        case .connecting: return .connecting
        case .reconnecting: return .reconnecting(retryAt: status.nextRetryAt)
        case .offline: return status.halt.map { .halted($0) } ?? .offline(reason: status.lastError)
        case .unauthorized: return .unauthorized
        case .suspended: return .suspended
        }
    }
}

// MARK: - the actions

extension EnvironmentClient {
    /// Why the composer and the row actions are off right now, or nil.
    public var operateBlock: ActionBlock? { Actions.block(status: status, environment: environment, needs: .operate) }
    /// Why the approval card is read-only right now, or nil.
    public var approveBlock: ActionBlock? { Actions.block(status: status, environment: environment, needs: .approve) }

    /// A user message into a thread. The turn shows at once as pending and
    /// the strip says Sending… until the host echoes it or starts the turn;
    /// a refusal (not connected, a read-only key, the host saying no) drops
    /// the pending turn and throws the reason.
    public func send(_ sessionId: String, text: String, model: TurnModel? = nil, newPass: Bool? = nil) async throws {
        if let block = operateBlock { throw ActionError.blocked(block) }
        let turn = PendingTurn(text: text, sentAt: Int(Date().timeIntervalSince1970 * 1000))
        threads[sessionId]?.pending.append(turn)
        threads[sessionId]?.sending = true
        do {
            try await request(Methods.SessionSend.self, .init(sessionId: sessionId, text: text, provider: model?.provider, model: model?.model, reasoning: model?.reasoning, newPass: newPass))
        } catch {
            threads[sessionId]?.pending.removeAll { $0.id == turn.id }
            if threads[sessionId]?.pending.isEmpty == true { threads[sessionId]?.sending = false }
            throw ActionError.wrap(error)
        }
    }

    /// Stop the running turn; the host's `error { stopped: true }` row is what the transcript shows afterwards.
    public func stop(_ sessionId: String) async throws {
        try await act(.operate) { try await self.request(Methods.SessionInterrupt.self, .init(sessionId: sessionId)) }
    }

    /// Continue a paused thread.
    public func resume(_ sessionId: String) async throws {
        try await act(.operate) { try await self.request(Methods.SessionResume.self, .init(sessionId: sessionId)) }
    }

    /// Decide an approval. The card shows the decision at once and reverts if the host refuses.
    public func approve(_ sessionId: String, requestId: String, allow: Bool) async throws {
        if let block = approveBlock { throw ActionError.blocked(block) }
        threads[sessionId]?.decisions[requestId] = allow
        do {
            try await request(Methods.SessionApprove.self, .init(sessionId: sessionId, requestId: requestId, allow: allow))
        } catch {
            threads[sessionId]?.decisions[requestId] = nil
            throw ActionError.wrap(error)
        }
    }

    /// Answer a question: `answers[i]` is the chosen labels (or the typed text) for question `i`.
    public func answer(_ sessionId: String, requestId: String, answers: [[String]]) async throws {
        if let block = operateBlock { throw ActionError.blocked(block) }
        threads[sessionId]?.answers[requestId] = answers
        do {
            try await request(Methods.SessionAnswer.self, .init(sessionId: sessionId, requestId: requestId, answers: answers))
        } catch {
            threads[sessionId]?.answers[requestId] = nil
            throw ActionError.wrap(error)
        }
    }

    public func rename(_ sessionId: String, title: String) async throws {
        let trimmed = String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120))
        guard !trimmed.isEmpty else { return }
        try await act(.operate) { try await self.request(Methods.SessionRename.self, .init(sessionId: sessionId, title: trimmed)) }
    }

    public func setArchived(_ sessionId: String, _ archived: Bool) async throws {
        try await act(.operate) { try await self.request(Methods.SessionArchive.self, .init(sessionId: sessionId, archived: archived)) }
    }

    public func setPinned(_ sessionId: String, _ pinned: Bool) async throws {
        try await act(.operate) { try await self.request(Methods.SessionPin.self, .init(sessionId: sessionId, pinned: pinned)) }
    }

    /// Create a thread the way the desktop does: the create, the meta
    /// adopted so the screen can open before the `sessions` push, then the
    /// kickoff brief when the draft carries one.
    public func createThread(_ draft: ThreadDraft) async throws -> SessionMeta {
        if let block = Actions.block(status: status, environment: environment, needs: draft.needs) { throw ActionError.blocked(block) }
        let meta: SessionMeta
        do {
            meta = try await request(Methods.SessionCreate.self, draft.params)
        } catch {
            throw ActionError.wrap(error)
        }
        adopt(meta)
        if let brief = draft.brief {
            do {
                try await request(Methods.SessionSend.self, .init(sessionId: meta.id, text: brief))
            } catch {
                throw ActionError.wrap(error)
            }
        }
        return meta
    }

    /// The host's catalog, fetched once per session and kept; `refresh` asks the host to re-probe.
    public func loadCatalog(refresh: Bool = false) async -> Catalog? {
        if let catalog, !refresh { return catalog }
        guard let fetched = try? await request(Methods.CatalogGet.self, .init(refresh: refresh ? true : nil)) else { return catalog }
        catalog = fetched
        return fetched
    }

    private func act(_ capability: Capability, _ body: () async throws -> Void) async throws {
        if let block = Actions.block(status: status, environment: environment, needs: capability) { throw ActionError.blocked(block) }
        do {
            try await body()
        } catch {
            throw ActionError.wrap(error)
        }
    }
}
