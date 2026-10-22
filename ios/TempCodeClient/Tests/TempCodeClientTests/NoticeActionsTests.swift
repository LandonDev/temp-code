import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A client on a fake socket, brought up with the shell listed, for the
/// three actions the host's rows offer (the same rig the action tests use).
@MainActor
private final class NoticeRig {
    let clock = ManualClock(random: [0])
    let sockets = FakeSocketFactory()
    let keys = InMemoryKeyStore()
    let environment: PairedEnvironment
    let client: EnvironmentClient

    init(caps: [Capability]) throws {
        environment = PairedEnvironment(id: "env_test", name: "box", origin: URL(string: "https://box.example")!, caps: caps, keyId: "K1", keyName: "iphone", addedAt: 0)
        try keys.set("tc_K1.secret", for: "env_test")
        let api = RemoteAPI { request in
            (Data(#"{"ticket":"t","expiresIn":30}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        client = EnvironmentClient(environment: environment, keys: keys, cache: try SessionCache.inMemory(), api: api, connect: sockets.factory, clock: clock)
    }

    /// Brings the socket up with the shell listed.
    func open() async throws -> FakeWebSocket {
        await client.start()
        let fake = await sockets.socket(0)
        fake.hello(caps: environment.caps.map(\.rawValue))
        var answered: Set<String> = []
        for _ in 0..<4000 {
            for sent in fake.sentRequests where !answered.contains(sent.id) {
                switch sent.method {
                case "workspace.list": fake.answer(id: sent.id, result: json([sampleWorkspace("w1")]))
                case "project.list": fake.answer(id: sent.id, result: json([sampleProject("p1")]))
                // The client asks for the change log at open; reset makes it list whole.
                case "session.changes": fake.answer(id: sent.id, result: json(SessionChanges(reset: true, seq: 1, generation: "g")))
                case "session.list": fake.answer(id: sent.id, result: json(SessionPage(sessions: [sampleSession("s1")], cursor: nil)))
                default: continue
                }
                answered.insert(sent.id)
            }
            if client.status.transport == .open, client.status.fresh { return fake }
            await Task.yield()
        }
        throw TransportError.notConnected
    }

    func request(_ fake: FakeWebSocket, _ method: String) async -> (id: String, method: String, params: JSONValue)? {
        for _ in 0..<4000 {
            if let match = fake.sentRequests.first(where: { $0.method == method }) { return match }
            await Task.yield()
        }
        return nil
    }
}

@MainActor
@Suite struct NoticeActionsTests {
    @Test func `a read key is refused before the wire for all three`() async throws {
        let rig = try NoticeRig(caps: [.read])
        let fake = try await rig.open()
        await #expect(throws: ActionError.blocked(.readOnly)) { try await rig.client.continueThread("s1") }
        await #expect(throws: ActionError.blocked(.readOnly)) { _ = try await rig.client.reroute("s1") }
        await #expect(throws: ActionError.blocked(.readOnly)) { try await rig.client.mergeAnyway("s1", runId: "r1") }
        #expect(fake.sentRequests.allSatisfy { !["session.continue", "session.reroute", "review.override"].contains($0.method) })
        await rig.client.stop()
    }

    @Test func `an operate-only key may retry but not merge past a review`() async throws {
        let rig = try NoticeRig(caps: [.read, .operate])
        let fake = try await rig.open()
        await #expect(throws: ActionError.blocked(.noApprove)) { try await rig.client.mergeAnyway("s1", runId: "r1") }
        let retrying = Task { try await rig.client.continueThread("s1") }
        let request = try #require(await rig.request(fake, "session.continue"))
        #expect(request.params == .object(["sessionId": .string("s1")]))
        fake.answer(id: request.id, result: "null")
        try await retrying.value
        await rig.client.stop()
    }

    @Test func `reroute sends the id and decodes where the thread landed`() async throws {
        let rig = try NoticeRig(caps: [.read, .operate, .approve])
        let fake = try await rig.open()
        let routing = Task { try await rig.client.reroute("s1") }
        let request = try #require(await rig.request(fake, "session.reroute"))
        #expect(request.params == .object(["sessionId": .string("s1")]))
        fake.answer(id: request.id, result: #"{"account":"a@b","moved":true}"#)
        let answer = try await routing.value
        #expect(answer == RerouteAnswer(account: "a@b", moved: true))
        await rig.client.stop()
    }

    @Test func `merge anyway names the run and a host refusal comes back as refused`() async throws {
        let rig = try NoticeRig(caps: [.read, .operate, .approve])
        let fake = try await rig.open()
        let merging = Task { try await rig.client.mergeAnyway("s1", runId: "r-held") }
        let request = try #require(await rig.request(fake, "review.override"))
        #expect(request.params == .object(["sessionId": .string("s1"), "runId": .string("r-held")]))
        fake.refuse(id: request.id, error: "no held review r-held")
        await #expect(throws: ActionError.refused(message: "no held review r-held", forbidden: false)) { try await merging.value }
        await rig.client.stop()
    }
}
