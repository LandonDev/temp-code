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
    /// The key reads the settings but does not change them (admin).
    case noAdmin
    /// A relayed host is asleep: the relay refuses everything until it wakes.
    /// `subject` is `RelayWords.subject`: "the Mac", or the host's name.
    case hostAsleep(subject: String)
    /// A relayed host's link is down: the lane is closed. `since` is the
    /// formatted time (`RelayWords.since`).
    case hostUnreachable(subject: String, since: String)

    /// The line shown in the composer field or under a card. `now` is clock
    /// milliseconds, for the retry countdown.
    public func text(now: Double) -> String {
        switch self {
        case .hostAsleep(let subject):
            return "\(subject.capitalisedFirst) is asleep: reading only until it wakes"
        case .hostUnreachable(let subject, let since):
            return "\(subject.capitalisedFirst) is unreachable since \(since)"
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
        case .noAdmin:
            return "This key can read these settings but not change them"
        }
    }

    /// The host is the problem, not the key: a retry can lift it.
    public var isTransient: Bool {
        switch self {
        case .readOnly, .noApprove, .noAdmin, .halted, .unauthorized: false
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
            // A relayed host's state said no: the host's own words, one line.
            if case .server(_, let message) = transport, let refusal = RelayRefusal(message: message) {
                return .refused(message: refusal.line, forbidden: false)
            }
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
        if message.contains("admin") { return ActionBlock.noAdmin.text(now: 0) }
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
    /// A master's batch the thread joins (the board's add sheet).
    public var masterId: String?
    /// The sibling the thread waits for; the host queues it until that one is done.
    public var after: String?
    /// The thread that started it, for its settle reports.
    public var startedBy: String?
    /// The 1M context window, where the model offers it.
    public var context1m: Bool?

    public init(threadType: ThreadType, provider: ProviderId, model: String, reasoning: Reasoning? = nil, projectId: String? = nil, workspaceId: String? = nil, cwd: String? = nil, permission: PermissionPolicy? = nil, planPath: String? = nil, goal: String? = nil, title: String? = nil, brief: String? = nil, masterId: String? = nil, after: String? = nil, startedBy: String? = nil, context1m: Bool? = nil) {
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
        self.masterId = masterId
        self.after = after
        self.startedBy = startedBy
        self.context1m = context1m
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
            context1m: context1m,
            goal: goal,
            startedBy: startedBy,
            masterId: masterId,
            after: after
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

    /// A thread added to a master's batch from the board (the desktop's
    /// AddThreadDialog): in the master's project, workspace, directory and
    /// access, carrying the master's id as its batch and its starter, waiting
    /// for `after` when one is picked; the brief is its first message and the
    /// host titles it.
    public static func batch(brief: String, type: ThreadType, master: SessionMeta, provider: ProviderId, model: String, reasoning: Reasoning?, context1m: Bool?, after: String?) -> ThreadDraft {
        let text = brief.trimmingCharacters(in: .whitespacesAndNewlines)
        return ThreadDraft(
            threadType: type,
            provider: provider,
            model: model,
            reasoning: reasoning,
            projectId: master.projectId,
            workspaceId: master.workspaceId,
            cwd: master.cwd,
            permission: master.permission,
            brief: text.isEmpty ? nil : text,
            masterId: master.id,
            after: after,
            startedBy: master.id,
            context1m: context1m == true ? true : nil
        )
    }

    /// A fresh thread from the chooser: in a project, or a chat hung off the
    /// workspace when there is none. The first message is the user's, unless
    /// the sheet was opened prefilled (the Inbox's "Start a thread from an
    /// issue"): then `title` names the thread and `brief` is sent as its
    /// first message right after the create.
    public static func thread(type: ThreadType, workspaceId: String, projectId: String?, provider: ProviderId, model: String, reasoning: Reasoning?, permission: PermissionPolicy?, title: String? = nil, brief: String? = nil) -> ThreadDraft {
        let title = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let brief = brief?.trimmingCharacters(in: .whitespacesAndNewlines)
        return ThreadDraft(
            threadType: type,
            provider: provider,
            model: model,
            reasoning: reasoning,
            projectId: projectId,
            workspaceId: projectId == nil ? workspaceId : nil,
            permission: permission,
            title: title.flatMap { $0.isEmpty ? nil : $0 },
            brief: brief.flatMap { $0.isEmpty ? nil : $0 }
        )
    }
}

/// The gate every action runs before the wire.
public enum Actions {
    /// The block for an action needing `capability`, or nil when it may go.
    /// The key's standing comes first: it never changes by itself.
    public static func block(status: EnvironmentStatus, environment: PairedEnvironment, needs capability: Capability) -> ActionBlock? {
        if !environment.allows(capability) {
            if capability == .admin { return .noAdmin }
            return capability == .approve && environment.allows(.operate) ? .noApprove : .readOnly
        }
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
    public var operateBlock: ActionBlock? { block(needs: .operate) }
    /// Why the approval card is read-only right now, or nil.
    public var approveBlock: ActionBlock? { block(needs: .approve) }

    /// What a relayed host's presence forbids: asleep refuses everything, a
    /// down link closes the lane. Locked admits every call the phone makes,
    /// so it blocks nothing; nil on a paired host.
    public var relayBlock: ActionBlock? {
        guard let presence, let state = relayState else { return nil }
        switch state {
        case .asleep: return .hostAsleep(subject: RelayWords.subject(presence))
        case .unreachable: return .hostUnreachable(subject: RelayWords.subject(presence), since: RelayWords.since(presence.since, now: .now))
        case .available, .locked: return nil
        }
    }

    /// The key and the socket first (a held lane is `offline` with the
    /// presence line as `lastError`), then the relayed host's state.
    func block(needs capability: Capability) -> ActionBlock? {
        Actions.block(status: status, environment: environment, needs: capability) ?? relayBlock
    }

    /// A user message into a thread. The turn shows at once as pending and
    /// the strip says Sending… until the host echoes it or starts the turn;
    /// a refusal (not connected, a read-only key, the host saying no) drops
    /// the pending turn and throws the reason. `attachments` are files
    /// already on the host (`upload`), named by the turn; an empty list
    /// sends none.
    public func send(_ sessionId: String, text: String, model: TurnModel? = nil, attachments: [Attachment]? = nil, newPass: Bool? = nil) async throws {
        if let block = operateBlock { throw ActionError.blocked(block) }
        let turn = PendingTurn(text: text, sentAt: Int(Date().timeIntervalSince1970 * 1000))
        threads[sessionId]?.pending.append(turn)
        threads[sessionId]?.sending = true
        let named = attachments.flatMap { $0.isEmpty ? nil : $0 }
        do {
            try await request(Methods.SessionSend.self, .init(sessionId: sessionId, text: text, provider: model?.provider, model: model?.model, reasoning: model?.reasoning, attachments: named, newPass: newPass))
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

    /// Continue a paused thread, or bring back one whose harness is gone.
    public func resume(_ sessionId: String) async throws {
        try await act(.operate) { try await self.request(Methods.SessionResume.self, .init(sessionId: sessionId)) }
    }

    /// Start a queued batch thread now, ahead of the sibling it waits for.
    /// The host answers whether it started one; the `sessions` push says the rest.
    public func start(_ sessionId: String) async throws {
        try await act(.operate) { _ = try await self.request(Methods.SessionStart.self, .init(sessionId: sessionId)) }
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
        if let block = block(needs: draft.needs) { throw ActionError.blocked(block) }
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

    // MARK: a master's batch

    /// Set the batch's rules whole (`batch.setRules`); the answer lands as the batch's state.
    @discardableResult
    public func setBatchRules(_ masterId: String, _ rules: BatchRules) async throws -> BatchState {
        let state = try await acting(.operate) { try await self.request(Methods.BatchSetRules.self, RulesEdit.params(masterId: masterId, rules: rules)) }
        publishBatch(state)
        return state
    }

    /// Stop the batch's running shell or publish step; the host answers whether one stopped.
    @discardableResult
    public func stopBatchStep(_ masterId: String, stepId: String) async throws -> Bool {
        try await acting(.operate) { try await self.request(Methods.BatchStopStep.self, .init(masterId: masterId, stepId: stepId)).stopped }
    }

    /// Bring existing root threads into the batch; refusals come back with their reasons.
    @discardableResult
    public func adoptIntoBatch(_ masterId: String, _ sessionIds: [String]) async throws -> BatchAdoptResult {
        let result = try await acting(.operate) { try await self.request(Methods.BatchAdopt.self, .init(masterId: masterId, sessionIds: sessionIds)) }
        publishBatch(result.state)
        return result
    }

    /// Archive the batch's done children, or every one (the live ones stopped first); the master stays.
    @discardableResult
    public func archiveBatch(_ masterId: String, which: BoardActions.Which, removeResources: Bool) async throws -> SessionBatchResult {
        try await acting(.operate) { try await self.request(Methods.BatchArchive.self, .init(masterId: masterId, which: which.wire, removeResources: removeResources ? true : nil)) }
    }

    /// The fleet switches over a set of root threads (`session.batch`): every id answered.
    @discardableResult
    public func sessionBatch(_ action: Methods.SessionBatch.Params.Action, ids: [String]) async throws -> SessionBatchResult {
        try await acting(.operate) { try await self.request(Methods.SessionBatch.self, .init(action: action, ids: ids)) }
    }

    /// Pin a root thread as a master, or unpin it; admin only. The meta push says the rest.
    public func setMaster(_ sessionId: String, _ master: Bool) async throws {
        try await act(.admin) { try await self.request(Methods.SessionSetMaster.self, .init(sessionId: sessionId, master: master)) }
    }

    /// The host's catalog, fetched once per session and kept; `refresh` asks the host to re-probe.
    public func loadCatalog(refresh: Bool = false) async -> Catalog? {
        if let catalog, !refresh { return catalog }
        guard let fetched = try? await request(Methods.CatalogGet.self, .init(refresh: refresh ? true : nil)) else { return catalog }
        catalog = fetched
        return fetched
    }

    private func acting<T>(_ capability: Capability, _ body: () async throws -> T) async throws -> T {
        if let block = block(needs: capability) { throw ActionError.blocked(block) }
        do {
            return try await body()
        } catch {
            throw ActionError.wrap(error)
        }
    }

    private func act(_ capability: Capability, _ body: () async throws -> Void) async throws {
        if let block = block(needs: capability) { throw ActionError.blocked(block) }
        do {
            try await body()
        } catch {
            throw ActionError.wrap(error)
        }
    }
}
