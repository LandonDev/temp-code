import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The second key the test server mints: read, operate and approve.
extension LiveServer {
    static var operateKey: String { environment["TC_TEST_OPERATE_KEY"]! }
    static var operateKeyId: String { environment["TC_TEST_OPERATE_KEY_ID"]! }
    static var operateOnlyKey: String { environment["TC_TEST_OPERATE_ONLY_KEY"]! }
    static var operateOnlyKeyId: String { environment["TC_TEST_OPERATE_ONLY_KEY_ID"]! }
    static var threadPlan: String { environment["TC_TEST_THREAD_PLAN"]! }
    static var workspaceId: String { environment["TC_TEST_WORKSPACE_ID"]! }
    static var projectId: String { environment["TC_TEST_PROJECT_ID"]! }
    static var hasOperateKey: Bool { environment["TC_TEST_OPERATE_KEY"] != nil }

    /// A paired host whose key may act; `claimedCaps` lets a test claim more than the key holds.
    static func operateEnvironment(claimedCaps: [Capability] = [.read, .operate, .approve]) -> PairedEnvironment {
        PairedEnvironment(id: environmentId, name: "test host", origin: baseURL, caps: claimedCaps, keyId: operateKeyId, keyName: "ios-test-operate", addedAt: 0)
    }

    static func operateKeys() throws -> InMemoryKeyStore {
        let keys = InMemoryKeyStore()
        try keys.set(operateKey, for: environmentId)
        return keys
    }

    /// The actions the server's stubs recorded since the last clear.
    static func actions() async throws -> [[String: Any]] {
        (try await control("/actions")["actions"] as? [[String: Any]]) ?? []
    }

    static func clearActions() async throws {
        _ = try await control("/actions/clear", [:])
    }

    /// A client on the acting key, started, with the shell listed.
    @MainActor
    static func actingClient(claimedCaps: [Capability] = [.read, .operate, .approve]) async throws -> EnvironmentClient {
        let client = EnvironmentClient(environment: operateEnvironment(claimedCaps: claimedCaps), keys: try operateKeys(), cache: try SessionCache.inMemory())
        await client.start()
        #expect(await until { client.status.fresh && client.session(threadPlan) != nil })
        return client
    }

    @MainActor
    static func openLive(_ client: EnvironmentClient, _ id: String) async {
        await client.openThread(id)
        #expect(await until { client.threads[id]?.isLive == true && client.threads[id]?.isLoading == false })
    }
}

/// Nested in the live suite so the two never run at once: that suite drops every
/// socket and revokes the read key as it goes.
extension LiveServerTests {
@MainActor
@Suite(.enabled(if: LiveServer.isConfigured && LiveServer.hasOperateKey, "needs the live server: bun run ios:test:client"), .serialized)
struct ActionTests {
    @Test func `the fleet's Pause all reaches every running root of the host and no subagent; Start now reaches a queued root`() async throws {
        try await LiveServer.clearActions()
        let client = try await LiveServer.actingClient()
        #expect(await LiveServer.until { client.session("ios-batch-a-run") != nil && client.projects.contains { $0.name == "ios-fleet-project" } })
        // The test server's own project for this test: two running roots and a running subagent.
        let project = try #require(client.projects.first { $0.name == "ios-fleet-project" })
        let selection = client.batchSelection(.project(id: project.id, name: project.name, cwd: project.cwd))
        let running = ThreadBatch.targets(.pause, client.sessions, selection).map(\.id)
        #expect(Set(running) == ["ios-batch-a-run", "ios-batch-b-run"], "a subagent follows its parent: \(running)")
        let toast = try await client.batch(.pause, selection: selection)
        #expect(toast.failed.isEmpty, toast.summary)
        #expect(toast.succeeded == 2)
        let actions = try await LiveServer.actions()
        let paused = Set(actions.filter { $0["kind"] as? String == "pause" }.compactMap { $0["sessionId"] as? String })
        #expect(paused == ["ios-batch-a-run", "ios-batch-b-run"], "\(paused)")
        #expect(await LiveServer.until { client.session("ios-batch-a-run")?.status == .paused })
        // Back the way it was, through the fleet's Resume all over the same project.
        let resumed = try await client.batch(.resume, selection: selection)
        #expect(resumed.succeeded == 2, resumed.summary)
        #expect(await LiveServer.until { client.session("ios-batch-a-run")?.status == .running })

        if client.session("ios-queued")?.status == .queued {
            try await client.start("ios-queued")
            #expect(try await LiveServer.actions().contains { $0["kind"] as? String == "start" && $0["sessionId"] as? String == "ios-queued" })
        }
        await client.stop()
    }

    @Test func `a send lands on the host, echoes back as the user row, and the turn it starts can be stopped`() async throws {
        try await LiveServer.clearActions()
        let client = try await LiveServer.actingClient()
        let id = LiveServer.threadB
        await LiveServer.openLive(client, id)
        #expect(client.operateBlock == nil)
        try await client.send(id, text: "Hello from the phone")
        let actions = try await LiveServer.actions()
        #expect(actions.contains { $0["kind"] as? String == "send" && $0["sessionId"] as? String == id && $0["text"] as? String == "Hello from the phone" }, "\(actions)")
        #expect(await LiveServer.until { client.threads[id]?.pending.isEmpty == true }, "the echo retires the pending turn")
        let last = client.threads[id]?.fold.items.last { if case .user = $0.item { true } else { false } }
        if case .user(let turn)? = last?.item { #expect(turn.text == "Hello from the phone") } else { Issue.record("no user row") }
        #expect(await LiveServer.until { client.session(id)?.status == .running })
        #expect(client.threads[id]?.sending == false, "the host started the turn")

        try await client.stop(id)
        #expect(try await LiveServer.actions().contains { $0["kind"] as? String == "stop" && $0["sessionId"] as? String == id })
        #expect(await LiveServer.until { client.session(id)?.status == .idle })
        #expect(await LiveServer.until {
            client.threads[id]?.fold.items.contains { if case .system(let line) = $0.item { line.stopped } else { false } } == true
        }, "the stopped line shows")
        await client.stop()
    }

    @Test func `an approval decided on the phone resolves on the host; a key that cannot approve is refused and the card reverts`() async throws {
        try await LiveServer.clearActions()
        // A key that operates but never approves, claiming approve: the host says no and the optimistic decision reverts.
        let readKeys = InMemoryKeyStore()
        try readKeys.set(LiveServer.operateOnlyKey, for: LiveServer.environmentId)
        let readClient = EnvironmentClient(environment: PairedEnvironment(id: LiveServer.environmentId, name: "test host", origin: LiveServer.baseURL, caps: [.read, .operate, .approve], keyId: LiveServer.operateOnlyKeyId, keyName: "ios-test-operate-only", addedAt: 0), keys: readKeys, cache: try SessionCache.inMemory())
        await readClient.start()
        #expect(await LiveServer.until { readClient.status.fresh })
        await LiveServer.openLive(readClient, "ios-waiting")
        do {
            try await readClient.approve("ios-waiting", requestId: "seed-approval", allow: false)
            Issue.record("the read key approved")
        } catch let error as ActionError {
            if case .refused(_, let forbidden) = error { #expect(forbidden) } else { Issue.record("expected the host's refusal, got \(error)") }
        }
        #expect(readClient.threads["ios-waiting"]?.decisions["seed-approval"] == nil, "reverted")
        #expect(try await LiveServer.actions().isEmpty)
        await readClient.stop()

        let client = try await LiveServer.actingClient()
        await LiveServer.openLive(client, "ios-waiting")
        let before = client.threads["ios-waiting"]?.fold.items.compactMap { if case .approval(let a) = $0.item { a } else { nil } }.first
        #expect(before?.allowed == nil)
        try await client.approve("ios-waiting", requestId: "seed-approval", allow: true)
        #expect(try await LiveServer.actions().contains { $0["kind"] as? String == "approve" && $0["requestId"] as? String == "seed-approval" && $0["allow"] as? Bool == true })
        #expect(await LiveServer.until {
            client.threads["ios-waiting"]?.fold.items.compactMap { if case .approval(let a) = $0.item { a } else { nil } }.first?.allowed == true
        })
        #expect(client.threads["ios-waiting"]?.decisions["seed-approval"] == nil, "the host's row replaced the overlay")
        await client.stop()
    }

    @Test func `an answer resolves the question on the host`() async throws {
        try await LiveServer.clearActions()
        let client = try await LiveServer.actingClient()
        await LiveServer.openLive(client, "ios-question")
        try await client.answer("ios-question", requestId: "seed-question", answers: [["Half up"]])
        let actions = try await LiveServer.actions()
        #expect(actions.contains { $0["kind"] as? String == "answer" && ($0["answers"] as? [[String]]) == [["Half up"]] }, "\(actions)")
        #expect(await LiveServer.until {
            client.threads["ios-question"]?.fold.items.compactMap { if case .question(let q) = $0.item { q } else { nil } }.first?.resolved == true
        })
        #expect(client.threads["ios-question"]?.answers["seed-question"] == nil)
        await client.stop()
    }

    @Test func `a build started from the plan is created in the plan's project, seeded from its file, and briefed`() async throws {
        try await LiveServer.clearActions()
        let client = try await LiveServer.actingClient()
        let plan = try #require(client.session(LiveServer.threadPlan))
        #expect(plan.planPath != nil)
        let draft = ThreadDraft.build(from: plan, type: .implementation, provider: .claude, model: "claude-haiku-5-5", reasoning: .low, tasks: 4)
        let built = try await client.createThread(draft)
        #expect(built.threadType == .implementation)
        #expect(built.planPath == plan.planPath)
        #expect(built.projectId == plan.projectId)
        #expect(built.model == "claude-haiku-5-5")
        #expect(built.reasoning == .low)
        #expect(built.title == plan.title)
        #expect(client.session(built.id) != nil, "adopted at once")
        let actions = try await LiveServer.actions()
        let create = actions.first { $0["kind"] as? String == "create" }
        #expect(create?["sessionId"] as? String == built.id)
        #expect(create?["planPath"] as? String == plan.planPath)
        #expect(create?["goal"] as? String == "Every task in the plan's checklist is checked off and typecheck passes")
        #expect(create?["agentType"] as? String == "implementer")
        #expect(actions.contains { $0["kind"] as? String == "send" && $0["sessionId"] as? String == built.id && $0["text"] as? String == "Implement the plan \"\(plan.title)\"." })
        #expect(await LiveServer.until { client.session(built.id)?.status == .running }, "the brief started the turn")
        try await client.setArchived(built.id, true)
        await client.stop()
    }

    @Test func `a new chat hangs off the workspace, and rename, pin and archive come back on the sessions push`() async throws {
        try await LiveServer.clearActions()
        let client = try await LiveServer.actingClient()
        let draft = ThreadDraft.thread(type: .chat, workspaceId: LiveServer.workspaceId, projectId: nil, provider: .claude, model: "claude-sonnet-5-5", reasoning: .low, permission: .safe)
        let chat = try await client.createThread(draft)
        #expect(chat.projectId == nil)
        #expect(chat.threadType == .chat)
        #expect(chat.permission == .safe)
        #expect(chat.workspaceId == LiveServer.workspaceId)
        #expect(try await LiveServer.actions().contains { $0["kind"] as? String == "send" } == false, "no brief for a chat")

        try await client.rename(chat.id, title: "Renamed from the phone")
        #expect(await LiveServer.until { client.session(chat.id)?.title == "Renamed from the phone" })
        try await client.setPinned(chat.id, true)
        #expect(await LiveServer.until { client.session(chat.id)?.pinned == true })
        try await client.setArchived(chat.id, true)
        #expect(await LiveServer.until { client.session(chat.id)?.archived == true })
        try await client.setArchived(chat.id, false)
        #expect(await LiveServer.until { client.session(chat.id)?.archived == false })
        let kinds = try await LiveServer.actions().map { $0["kind"] as? String ?? "" }
        #expect(kinds.contains("rename") && kinds.contains("pin") && kinds.filter { $0 == "archive" }.count == 2, "\(kinds)")
        try await client.setArchived(chat.id, true)
        await client.stop()
    }

    @Test func `a chosen full-access build needs approve: a key without it is refused before the wire`() async throws {
        let client = try await LiveServer.actingClient(claimedCaps: [.read, .operate])
        let plan = try #require(client.session(LiveServer.threadPlan))
        let draft = ThreadDraft.build(from: plan, type: .orchestration, provider: .claude, model: "claude-haiku-5-5", reasoning: .low, tasks: 4, permission: .auto)
        await #expect(throws: ActionError.blocked(.noApprove)) { try await client.createThread(draft) }
        #expect(client.approveBlock == .noApprove)
        #expect(client.operateBlock == nil)
        await client.stop()
    }

    @Test func `the host's catalog names the models the sheets offer`() async throws {
        let client = try await LiveServer.actingClient()
        let catalog = try #require(await client.loadCatalog())
        #expect(catalog["claude"]?.models.isEmpty == false)
        #expect(catalog.values.filter { !$0.models.isEmpty }.allSatisfy { !$0.defaultModel.isEmpty })
        await client.stop()
    }
}
}
