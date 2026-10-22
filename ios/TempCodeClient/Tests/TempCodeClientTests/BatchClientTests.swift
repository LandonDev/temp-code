import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func batchFields(_ value: some Encodable) throws -> [String: JSONValue] {
    let data = try JSONEncoder().encode(value)
    guard case .object(let fields) = try JSONDecoder().decode(JSONValue.self, from: data) else { throw TransportError.decoding(method: "test", detail: "not an object") }
    return fields
}

private func batchEnvironment(_ caps: [Capability]) -> PairedEnvironment {
    PairedEnvironment(id: "env_test", name: "box", origin: URL(string: "https://box.example")!, caps: caps, keyId: "K1", keyName: "iphone", addedAt: 0)
}

/// A batch whose summary tells two states apart.
private func batchState(_ summary: String, masterId: String = "m") -> BatchState {
    let empty = BatchState.empty(masterId: masterId)
    return BatchState(masterId: masterId, rules: BatchRules(land: .asTheyFinish, steps: empty.rules.steps, then: .notify, summary: summary), steps: empty.steps, landed: [], pending: [], held: [], blocked: nil, finishedAt: nil)
}

/// A client on a fake socket with an in-memory cache and a key of `caps`.
@MainActor
private final class BatchRig {
    let sockets = FakeSocketFactory()
    let keys = InMemoryKeyStore()
    let client: EnvironmentClient

    init(caps: [Capability] = [.read, .operate]) throws {
        try keys.set("tc_K1.secret", for: "env_test")
        let api = RemoteAPI { request in
            let body = #"{"ticket":"t","expiresIn":30}"#
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        client = EnvironmentClient(environment: batchEnvironment(caps), keys: keys, cache: try SessionCache.inMemory(), api: api, connect: sockets.factory, clock: ManualClock(random: [0]))
    }

    /// Starts the client and says hello; the socket counts as open from then on.
    func open(caps: [String] = ["read", "operate"]) async -> FakeWebSocket {
        await client.start()
        let fake = await sockets.socket(0)
        fake.hello(caps: caps)
        _ = await wait { self.client.status.transport == .open }
        return fake
    }

    func wait(_ predicate: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if predicate() { return true }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return false
    }

    func request(_ fake: FakeWebSocket, _ method: String) async -> (id: String, method: String, params: JSONValue)? {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if let sent = fake.sentRequests.first(where: { $0.method == method }) { return sent }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return nil
    }
}

@MainActor
@Suite struct BatchClientTests {
    @Test("a batch push lands under its master's id") func pushLands() async throws {
        let rig = try BatchRig()
        let fake = await rig.open()
        fake.deliver(json(ServerPush.batch(BatchPush(state: batchState("first")))))
        #expect(await rig.wait { rig.client.batchState("m")?.rules.summary == "first" })
    }

    @Test("a second state inside the window waits and lands as the newest, about 500 ms after the first", .timeLimit(.minutes(1))) func coalesces() async throws {
        let rig = try BatchRig()
        rig.client.applyBatch(batchState("first"))
        #expect(rig.client.batchState("m")?.rules.summary == "first")
        rig.client.applyBatch(batchState("second"))
        rig.client.applyBatch(batchState("third"))
        #expect(rig.client.batchState("m")?.rules.summary == "first")
        try await Task.sleep(for: .milliseconds(1_200))
        #expect(rig.client.batchState("m")?.rules.summary == "third")
        // Another master has its own window.
        rig.client.applyBatch(batchState("other", masterId: "m2"))
        #expect(rig.client.batchState("m2")?.rules.summary == "other")
    }

    @Test("an answer that lands supersedes a push waiting in the window", .timeLimit(.minutes(1))) func answerSupersedes() async throws {
        let rig = try BatchRig()
        rig.client.applyBatch(batchState("first"))
        rig.client.applyBatch(batchState("stale push"))
        rig.client.publishBatch(batchState("answer"))
        try await Task.sleep(for: .milliseconds(1_200))
        #expect(rig.client.batchState("m")?.rules.summary == "answer")
    }

    @Test("loadBatch asks batch.get and keeps the answer") func loads() async throws {
        let rig = try BatchRig()
        let fake = await rig.open()
        let load = Task { await rig.client.loadBatch("m") }
        let sent = try #require(await rig.request(fake, "batch.get"))
        #expect(sent.params == .object(["masterId": .string("m")]))
        fake.answer(id: sent.id, result: json(batchState("loaded")))
        await load.value
        #expect(rig.client.batchState("m")?.rules.summary == "loaded")
    }

    @Test("setBatchRules sends every field and keeps the host's answer") func setsRules() async throws {
        let rig = try BatchRig()
        let fake = await rig.open()
        let rules = BatchRules(land: .allAtOnce, steps: [BatchStepSpec(id: "land", name: "Land", kind: .land)], then: .archiveChildren, summary: "Land then archive")
        let save = Task { try await rig.client.setBatchRules("m", rules) }
        let sent = try #require(await rig.request(fake, "batch.setRules"))
        guard case .object(let params) = sent.params, case .object(let sentRules)? = params["rules"] else { Issue.record("no rules"); return }
        #expect(params["masterId"] == .string("m"))
        #expect(sentRules["land"] == .string("all-at-once"))
        #expect(sentRules["then"] == .string("archive-children"))
        #expect(sentRules["summary"] == .string("Land then archive"))
        #expect(sentRules["steps"] != nil)
        fake.answer(id: sent.id, result: json(batchState("saved")))
        _ = try await save.value
        #expect(rig.client.batchState("m")?.rules.summary == "saved")
    }

    @Test("stopBatchStep answers whether a step stopped") func stopsAStep() async throws {
        let rig = try BatchRig()
        let fake = await rig.open()
        let stop = Task { try await rig.client.stopBatchStep("m", stepId: "smoke") }
        let sent = try #require(await rig.request(fake, "batch.stopStep"))
        #expect(sent.params == .object(["masterId": .string("m"), "stepId": .string("smoke")]))
        fake.answer(id: sent.id, result: #"{"stopped":true}"#)
        #expect(try await stop.value)
    }

    @Test("pinning a master needs admin: any key without it reads noAdmin before the wire") func setMasterNeedsAdmin() async throws {
        let operate = try BatchRig(caps: [.read, .operate])
        await #expect(throws: ActionError.blocked(.noAdmin)) { try await operate.client.setMaster("m", true) }
        let read = try BatchRig(caps: [.read])
        await #expect(throws: ActionError.blocked(.noAdmin)) { try await read.client.setMaster("m", true) }
        let open = EnvironmentStatus(transport: .open, fresh: true)
        #expect(Actions.block(status: open, environment: batchEnvironment([.read, .operate, .admin]), needs: .admin) == nil)
        #expect(Actions.block(status: open, environment: batchEnvironment([.read, .operate]), needs: .admin) == .noAdmin)
    }

    @Test("the add sheet's draft joins the batch with the master as starter") func batchDraft() throws {
        let master = meta("m", threadType: .chat, isMaster: true, projectId: "p", workspaceId: "w")
        let draft = ThreadDraft.batch(brief: "  Build the strip  ", type: .research, master: master, provider: .claude, model: "claude-fable-5-1", reasoning: .high, context1m: true, after: "sib")
        #expect(draft.brief == "Build the strip")
        #expect(draft.title == nil)
        let params = try batchFields(draft.params)
        #expect(params["masterId"] == .string("m"))
        #expect(params["startedBy"] == .string("m"))
        #expect(params["after"] == .string("sib"))
        #expect(params["context1m"] == .bool(true))
        #expect(params["projectId"] == .string("p"))
        #expect(params["cwd"] == .string("/repo"))
        #expect(params["threadType"] == .string("research"))
        let plain = try batchFields(ThreadDraft.batch(brief: "x", type: .implementation, master: master, provider: .claude, model: "m", reasoning: nil, context1m: false, after: nil).params)
        #expect(plain["context1m"] == nil)
        #expect(plain["after"] == nil)
    }
}
