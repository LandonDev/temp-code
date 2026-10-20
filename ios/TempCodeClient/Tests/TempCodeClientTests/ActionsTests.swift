import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func planSession(_ id: String = "plan1", title: String = "Plan: Move the history", permission: PermissionPolicy = .edits) -> SessionMeta {
    SessionMeta(id: id, parentId: nil, projectId: "p1", workspaceId: "w1", threadType: .planning, planPath: "/tmp/repo/.temp-code/plan-\(id).md", provider: .claude, model: "claude-opus-5-5", reasoning: .high, agentType: .implementer, title: title, cwd: "/tmp/repo", status: .idle, pinned: false, archived: false, permission: permission, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, account: nil, activity: nil, activityKind: nil, tasks: nil, goal: nil, context: nil, canContinue: nil, treeCanContinue: nil, treeHasLiveWork: nil, treeHasPaused: nil, treeFrozenActiveElapsed: nil, threadRules: nil, createdAt: 1, updatedAt: 2)
}

private func pairedEnvironment(caps: [Capability]) -> PairedEnvironment {
    PairedEnvironment(id: "env_test", name: "box", origin: URL(string: "https://box.example")!, caps: caps, keyId: "K1", keyName: "iphone", addedAt: 0)
}

private func fields(_ value: some Encodable) throws -> [String: JSONValue] {
    let data = try JSONEncoder().encode(value)
    guard case .object(let fields) = try JSONDecoder().decode(JSONValue.self, from: data) else { throw TransportError.decoding(method: "test", detail: "not an object") }
    return fields
}

@Suite struct ActionGateTests {
    @Test func `the key's standing comes first: a read key is read-only whatever the socket does`() {
        let open = EnvironmentStatus(transport: .open, fresh: true)
        #expect(Actions.block(status: open, environment: pairedEnvironment(caps: [.read]), needs: .operate) == .readOnly)
        #expect(Actions.block(status: EnvironmentStatus(transport: .reconnecting), environment: pairedEnvironment(caps: [.read]), needs: .operate) == .readOnly)
        #expect(Actions.block(status: open, environment: pairedEnvironment(caps: [.read, .operate]), needs: .operate) == nil)
        #expect(Actions.block(status: open, environment: pairedEnvironment(caps: [.read, .operate]), needs: .approve) == .noApprove)
        #expect(Actions.block(status: open, environment: pairedEnvironment(caps: [.read]), needs: .approve) == .readOnly)
        #expect(Actions.block(status: open, environment: pairedEnvironment(caps: [.admin]), needs: .approve) == nil)
    }

    @Test func `with a key that may act, the socket decides`() {
        let env = pairedEnvironment(caps: [.read, .operate, .approve])
        #expect(Actions.block(status: EnvironmentStatus(transport: .connecting), environment: env, needs: .operate) == .connecting)
        #expect(Actions.block(status: EnvironmentStatus(transport: .reconnecting, nextRetryAt: 5_000), environment: env, needs: .operate) == .reconnecting(retryAt: 5_000))
        #expect(Actions.block(status: EnvironmentStatus(transport: .offline, lastError: "no route"), environment: env, needs: .operate) == .offline(reason: "no route"))
        let halt = HaltReason.contractMismatch(app: 3, host: 4)
        #expect(Actions.block(status: EnvironmentStatus(transport: .offline, halt: halt), environment: env, needs: .operate) == .halted(halt))
        #expect(Actions.block(status: EnvironmentStatus(transport: .unauthorized), environment: env, needs: .operate) == .unauthorized)
        #expect(Actions.block(status: EnvironmentStatus(transport: .suspended), environment: env, needs: .operate) == .suspended)
        #expect(Actions.block(status: EnvironmentStatus(transport: .open), environment: env, needs: .approve) == nil)
    }

    @Test func `the block's line counts down to the retry and says what the key lacks`() {
        #expect(ActionBlock.reconnecting(retryAt: 13_400).text(now: 10_000) == "Reconnecting in 3 s")
        #expect(ActionBlock.reconnecting(retryAt: 10_100).text(now: 10_000) == "Reconnecting…")
        #expect(ActionBlock.reconnecting(retryAt: nil).text(now: 0) == "Reconnecting…")
        #expect(ActionBlock.offline(reason: nil).text(now: 0) == "Offline")
        #expect(ActionBlock.readOnly.text(now: 0) == "This key can read but not act")
        #expect(ActionBlock.noApprove.text(now: 0) == "This key can't approve")
        #expect(ActionBlock.halted(.contractMismatch(app: 3, host: 4)).text(now: 0).hasPrefix("Update the app"))
        #expect(ActionBlock.readOnly.isTransient == false)
        #expect(ActionBlock.reconnecting(retryAt: nil).isTransient)
    }

    @Test func `a forbidden answer from the host reads as what the key lacks`() {
        let send = ActionError.wrap(TransportError.server(method: "session.send", message: "forbidden: session.send needs operate"))
        #expect(send == .refused(message: "This key can read but not act", forbidden: true))
        let approve = ActionError.wrap(TransportError.server(method: "session.approve", message: "forbidden: session.approve needs approve"))
        #expect(approve == .refused(message: "This key can't approve", forbidden: true))
        #expect(ActionError.wrap(TransportError.notConnected) == .blocked(.reconnecting(retryAt: nil)))
        #expect(ActionError.wrap(TransportError.server(method: "session.rename", message: "unknown session")) == .refused(message: "unknown session", forbidden: false))
    }
}

@Suite struct ThreadDraftTests {
    @Test func `a build seeded from a plan carries the plan's project, file, cwd and the desktop's goal and brief`() throws {
        let plan = planSession()
        let draft = ThreadDraft.build(from: plan, type: .implementation, provider: .codex, model: "gpt-6.1-sol", reasoning: .high, tasks: 4)
        #expect(draft.title == "Move the history")
        #expect(draft.brief == "Implement the plan \"Move the history\".")
        #expect(draft.goal == "Every task in the plan's checklist is checked off and typecheck passes")
        #expect(draft.permission == .edits)
        #expect(draft.needs == .operate)
        let params = try fields(draft.params)
        #expect(params["threadType"] == .string("implementation"))
        #expect(params["agentType"] == .string("implementer"))
        #expect(params["provider"] == .string("codex"))
        #expect(params["model"] == .string("gpt-6.1-sol"))
        #expect(params["reasoning"] == .string("high"))
        #expect(params["projectId"] == .string("p1"))
        #expect(params["workspaceId"] == .string("w1"))
        #expect(params["cwd"] == .string("/tmp/repo"))
        #expect(params["planPath"] == .string("/tmp/repo/.temp-code/plan-plan1.md"))
        #expect(params["goal"] == .string("Every task in the plan's checklist is checked off and typecheck passes"))
        #expect(params["title"] == .string("Move the history"))
        #expect(params["permission"] == .string("edits"))
        #expect(params["parentId"] == nil, "nil means the server's default")
    }

    @Test func `an orchestration build is run by an orchestrator with its own brief; no tasks means the plain goal`() throws {
        let draft = ThreadDraft.build(from: planSession(title: "Untitled plan"), type: .orchestration, provider: .claude, model: "claude-opus-5-5", reasoning: nil, tasks: 0)
        #expect(draft.brief == "Orchestrate implementation of the plan across subagents.")
        #expect(draft.goal == "The plan is fully implemented and typecheck passes")
        #expect(draft.title == "Untitled plan")
        let params = try fields(draft.params)
        #expect(params["agentType"] == .string("orchestrator"))
        #expect(params["reasoning"] == nil)
        let bare = ThreadDraft.build(from: planSession(title: "Plan:"), type: .implementation, provider: .claude, model: "m", reasoning: nil, tasks: 1)
        #expect(bare.brief == "Implement the plan.")
        #expect(bare.title == nil)
    }

    @Test func `a full-access build needs approve; a chosen policy wins over the plan's`() {
        let auto = ThreadDraft.build(from: planSession(), type: .implementation, provider: .claude, model: "m", reasoning: nil, tasks: 1, permission: .auto)
        #expect(auto.permission == .auto)
        #expect(auto.needs == .approve)
    }

    @Test func `a fresh thread sits in its project, or hangs off the workspace as a chat with no project`() throws {
        let inProject = ThreadDraft.thread(type: .implementation, workspaceId: "w1", projectId: "p1", provider: .claude, model: "m", reasoning: .low, permission: .safe)
        let a = try fields(inProject.params)
        #expect(a["projectId"] == .string("p1"))
        #expect(a["workspaceId"] == nil)
        #expect(a["brief"] == nil)
        #expect(inProject.brief == nil)
        let chat = ThreadDraft.thread(type: .chat, workspaceId: "w1", projectId: nil, provider: .codex, model: "gpt-6-astra", reasoning: nil, permission: nil)
        let b = try fields(chat.params)
        #expect(b["projectId"] == nil)
        #expect(b["workspaceId"] == .string("w1"))
        #expect(b["threadType"] == .string("chat"))
        #expect(b["permission"] == nil)
    }

    @Test func `pending turns sit after the fold's rows, in the order they were sent`() {
        var state = ThreadState()
        state.pending = [PendingTurn(text: "first", sentAt: 10), PendingTurn(text: "second", sentAt: 11)]
        let entries = state.entries
        #expect(entries.count == 2)
        #expect(entries.map(\.seq) == [-100_000, -100_001])
        if case .user(let turn) = entries[1].item { #expect(turn.text == "second" && turn.ts == 11) } else { Issue.record("not a user turn") }
        #expect(Set(entries.map(\.id)).count == 2)
    }
}

/// A client on a fake socket whose key may act.
@MainActor
private final class ActingRig {
    let clock = ManualClock(random: [0])
    let sockets = FakeSocketFactory()
    let keys = InMemoryKeyStore()
    let environment: PairedEnvironment
    let client: EnvironmentClient

    init(caps: [Capability] = [.read, .operate, .approve]) throws {
        environment = pairedEnvironment(caps: caps)
        try keys.set("tc_K1.secret", for: "env_test")
        let api = RemoteAPI { request in
            (Data(#"{"ticket":"t","expiresIn":30}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        client = EnvironmentClient(environment: environment, keys: keys, cache: try SessionCache.inMemory(), api: api, connect: sockets.factory, clock: clock)
    }

    /// Brings the socket up with the shell listed and `s1` open and live.
    func open() async throws -> FakeWebSocket {
        await client.start()
        await client.openThread("s1")
        let fake = await sockets.socket(0)
        fake.hello(caps: environment.caps.map(\.rawValue))
        var answered: Set<String> = []
        for _ in 0..<4000 {
            for sent in fake.sentRequests where !answered.contains(sent.id) {
                switch sent.method {
                case "workspace.list": fake.answer(id: sent.id, result: json([sampleWorkspace("w1")]))
                case "project.list": fake.answer(id: sent.id, result: json([sampleProject("p1")]))
                case "session.list": fake.answer(id: sent.id, result: json(SessionPage(sessions: [sampleSession("s1")], cursor: nil)))
                case "session.subscribe": fake.answer(id: sent.id, result: "null")
                case "session.events": fake.answer(id: sent.id, result: json(EventsPage(rows: [textRow("s1", seq: 1)], moreBefore: false, moreAfter: false, reset: false)))
                default: continue
                }
                answered.insert(sent.id)
            }
            if client.threads["s1"]?.isLive == true, client.status.transport == .open { return fake }
            await Task.yield()
        }
        throw TransportError.notConnected
    }

    /// The `count`th request of `method` sent so far, once it has gone out.
    func request(_ fake: FakeWebSocket, _ method: String, count: Int = 1) async -> (id: String, method: String, params: JSONValue)? {
        for _ in 0..<4000 {
            let matching = fake.sentRequests.filter { $0.method == method }
            if matching.count >= count { return matching[count - 1] }
            await Task.yield()
        }
        return nil
    }

    func wait(_ predicate: () -> Bool) async -> Bool {
        for _ in 0..<4000 {
            if predicate() { return true }
            await Task.yield()
        }
        return false
    }

    func push(_ fake: FakeWebSocket, rows: [EventRow]) {
        fake.deliver(json(ServerPush.events(EventsPush(sessionId: "s1", rows: rows))))
    }
}

@MainActor
@Suite struct ClientActionTests {
    @Test func `a send shows at once as a pending turn and the host's echo retires it`() async throws {
        let rig = try ActingRig()
        let fake = try await rig.open()
        let sending = Task { try await rig.client.send("s1", text: "hello from the phone") }
        let request = try #require(await rig.request(fake, "session.send"))
        #expect(request.params == .object(["sessionId": .string("s1"), "text": .string("hello from the phone")]))
        #expect(rig.client.threads["s1"]?.pending.map(\.text) == ["hello from the phone"])
        #expect(rig.client.threads["s1"]?.sending == true)
        #expect(rig.client.threads["s1"]?.entries.last.map { if case .user(let turn) = $0.item { turn.text } else { "" } } == "hello from the phone")
        fake.answer(id: request.id, result: "null")
        try await sending.value
        #expect(rig.client.threads["s1"]?.pending.count == 1, "answered, not echoed yet")
        rig.push(fake, rows: [EventRow(sessionId: "s1", seq: 2, ts: 2, event: .userText(UserTextEvent(text: "hello from the phone", attachments: nil, model: nil, reasoning: nil, context1m: nil, fast: nil, ultrafast: nil, newPass: nil)))])
        #expect(await rig.wait { rig.client.threads["s1"]?.pending.isEmpty == true })
        #expect(rig.client.threads["s1"]?.sending == false)
        #expect(rig.client.threads["s1"]?.entries.count == 2, "the echo row stands in for the pending turn")
        await rig.client.stop()
    }

    @Test func `a send the host refuses drops its pending turn and throws what the host said`() async throws {
        let rig = try ActingRig()
        let fake = try await rig.open()
        let sending = Task { try await rig.client.send("s1", text: "try") }
        let request = try #require(await rig.request(fake, "session.send"))
        fake.refuse(id: request.id, error: "unknown session: s1")
        await #expect(throws: ActionError.refused(message: "unknown session: s1", forbidden: false)) { try await sending.value }
        #expect(rig.client.threads["s1"]?.pending.isEmpty == true)
        #expect(rig.client.threads["s1"]?.sending == false)
        await rig.client.stop()
    }

    @Test func `a send while the link is down is refused with the reason, nothing queued`() async throws {
        let rig = try ActingRig()
        let fake = try await rig.open()
        fake.drop()
        #expect(await rig.wait { rig.client.status.transport == .reconnecting })
        await #expect(throws: ActionError.self) { try await rig.client.send("s1", text: "later") }
        do {
            try await rig.client.send("s1", text: "later")
        } catch let error as ActionError {
            if case .blocked(.reconnecting) = error {} else { Issue.record("expected a reconnecting block, got \(error)") }
        }
        #expect(rig.client.threads["s1"]?.pending.isEmpty == true)
        #expect(rig.client.operateBlock != nil)
        await rig.client.stop()
    }

    @Test func `a read key is refused before the wire, and the block names it`() async throws {
        let rig = try ActingRig(caps: [.read])
        let fake = try await rig.open()
        await #expect(throws: ActionError.blocked(.readOnly)) { try await rig.client.send("s1", text: "no") }
        await #expect(throws: ActionError.blocked(.readOnly)) { try await rig.client.approve("s1", requestId: "r1", allow: true) }
        #expect(fake.sentRequests.contains { $0.method == "session.send" || $0.method == "session.approve" } == false)
        #expect(rig.client.operateBlock == .readOnly)
        #expect(rig.client.approveBlock == .readOnly)
        await rig.client.stop()
    }

    @Test func `an approval shows its decision at once and reverts when the host refuses`() async throws {
        let rig = try ActingRig()
        let fake = try await rig.open()
        rig.push(fake, rows: [EventRow(sessionId: "s1", seq: 2, ts: 2, event: .approvalRequest(ApprovalRequestEvent(requestId: "r1", toolName: "Bash", input: nil, title: "run bun test", callId: nil)))])
        #expect(await rig.wait { rig.client.threads["s1"]?.fold.items.contains { if case .approval = $0.item { true } else { false } } == true })

        let allowing = Task { try await rig.client.approve("s1", requestId: "r1", allow: true) }
        let request = try #require(await rig.request(fake, "session.approve"))
        #expect(request.params == .object(["sessionId": .string("s1"), "requestId": .string("r1"), "allow": .bool(true)]))
        #expect(rig.client.threads["s1"]?.decisions["r1"] == true)
        fake.refuse(id: request.id, error: "forbidden: session.approve needs approve")
        await #expect(throws: ActionError.refused(message: "This key can't approve", forbidden: true)) { try await allowing.value }
        #expect(rig.client.threads["s1"]?.decisions["r1"] == nil, "reverted")

        let denying = Task { try await rig.client.approve("s1", requestId: "r1", allow: false) }
        let second = try #require(await rig.request(fake, "session.approve", count: 2))
        fake.answer(id: second.id, result: "null")
        try await denying.value
        #expect(rig.client.threads["s1"]?.decisions["r1"] == false)
        rig.push(fake, rows: [EventRow(sessionId: "s1", seq: 3, ts: 3, event: .approvalResolved(ApprovalResolvedEvent(requestId: "r1", allow: false, auto: nil)))])
        #expect(await rig.wait { rig.client.threads["s1"]?.decisions["r1"] == nil })
        let item = rig.client.threads["s1"]?.fold.items.compactMap { if case .approval(let a) = $0.item { a } else { nil } }.first
        #expect(item?.allowed == false, "the fold carries the decision once the host confirms")
        await rig.client.stop()
    }

    @Test func `an answer shows at once and the resolved row retires the overlay`() async throws {
        let rig = try ActingRig()
        let fake = try await rig.open()
        let answering = Task { try await rig.client.answer("s1", requestId: "q1", answers: [["Half up"]]) }
        let request = try #require(await rig.request(fake, "session.answer"))
        #expect(request.params == .object(["sessionId": .string("s1"), "requestId": .string("q1"), "answers": .array([.array([.string("Half up")])])]))
        #expect(rig.client.threads["s1"]?.answers["q1"] == [["Half up"]])
        fake.answer(id: request.id, result: "null")
        try await answering.value
        rig.push(fake, rows: [EventRow(sessionId: "s1", seq: 2, ts: 2, event: .questionResolved(QuestionResolvedEvent(requestId: "q1", answers: [["Half up"]])))])
        #expect(await rig.wait { rig.client.threads["s1"]?.answers["q1"] == nil })
        await rig.client.stop()
    }

    @Test func `creating a thread adopts the meta before the push and sends the brief`() async throws {
        let rig = try ActingRig()
        let fake = try await rig.open()
        let draft = ThreadDraft.build(from: planSession(), type: .implementation, provider: .claude, model: "claude-opus-5-5", reasoning: .high, tasks: 2)
        let creating = Task { try await rig.client.createThread(draft) }
        let create = try #require(await rig.request(fake, "session.create"))
        guard case .object(let params) = create.params else { throw TransportError.notConnected }
        #expect(params["planPath"] == .string("/tmp/repo/.temp-code/plan-plan1.md"))
        #expect(params["threadType"] == .string("implementation"))
        fake.answer(id: create.id, result: json(sampleSession("built", title: "Move the history", updatedAt: 9)))
        #expect(await rig.wait { rig.client.session("built") != nil })
        let brief = try #require(await rig.request(fake, "session.send"))
        #expect(brief.params == .object(["sessionId": .string("built"), "text": .string("Implement the plan \"Move the history\".")]))
        fake.answer(id: brief.id, result: "null")
        let meta = try await creating.value
        #expect(meta.id == "built")
        #expect(rig.client.sessions.first?.id == "built", "newest first")
        await rig.client.stop()
    }

    @Test func `stop, resume, rename, archive and pin go out as their RPCs`() async throws {
        let rig = try ActingRig()
        let fake = try await rig.open()
        let stopping = Task { try await rig.client.stop("s1") }
        let stop = try #require(await rig.request(fake, "session.interrupt"))
        fake.answer(id: stop.id, result: "null")
        try await stopping.value
        let resuming = Task { try await rig.client.resume("s1") }
        let resume = try #require(await rig.request(fake, "session.resume"))
        fake.answer(id: resume.id, result: "null")
        try await resuming.value
        let renaming = Task { try await rig.client.rename("s1", title: "  A better name  ") }
        let rename = try #require(await rig.request(fake, "session.rename"))
        #expect(rename.params == .object(["sessionId": .string("s1"), "title": .string("A better name")]))
        fake.answer(id: rename.id, result: "null")
        try await renaming.value
        let archiving = Task { try await rig.client.setArchived("s1", true) }
        let archive = try #require(await rig.request(fake, "session.archive"))
        #expect(archive.params == .object(["sessionId": .string("s1"), "archived": .bool(true)]))
        fake.answer(id: archive.id, result: "null")
        try await archiving.value
        let pinning = Task { try await rig.client.setPinned("s1", true) }
        let pin = try #require(await rig.request(fake, "session.pin"))
        #expect(pin.params == .object(["sessionId": .string("s1"), "pinned": .bool(true)]))
        fake.answer(id: pin.id, result: "null")
        try await pinning.value
        // A blank rename never leaves the phone.
        try await rig.client.rename("s1", title: "   ")
        #expect(fake.sentRequests.filter { $0.method == "session.rename" }.count == 1)
        await rig.client.stop()
    }

    @Test func `the catalog is fetched once and kept`() async throws {
        let rig = try ActingRig()
        let fake = try await rig.open()
        let loading = Task { await rig.client.loadCatalog() }
        let request = try #require(await rig.request(fake, "catalog.get"))
        fake.answer(id: request.id, result: #"{"claude":{"id":"claude","label":"Claude","models":[{"id":"claude-opus-5-5","label":"Opus 5.5","reasoning":["medium","high"],"defaultReasoning":"high"}],"defaultModel":"claude-opus-5-5"}}"#)
        let catalog = await loading.value
        #expect(catalog?["claude"]?.models.first?.id == "claude-opus-5-5")
        #expect(rig.client.catalog?["claude"]?.defaultModel == "claude-opus-5-5")
        _ = await rig.client.loadCatalog()
        #expect(fake.sentRequests.filter { $0.method == "catalog.get" }.count == 1)
        await rig.client.stop()
    }
}
