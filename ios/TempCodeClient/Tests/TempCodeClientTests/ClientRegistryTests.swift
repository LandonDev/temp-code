import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A store with two paired hosts on fake sockets: the host answers hello by
/// its origin, the clients mint tickets against a fake api.
@MainActor
private final class RegistryRig {
    let directory = FileManager.default.temporaryDirectory.appending(path: "tc-registry-\(UUID().uuidString)")
    let keys = InMemoryKeyStore()
    let cache: SessionCache
    let store: EnvironmentStore
    let sockets: [String: FakeSocketFactory] = ["env_a": FakeSocketFactory(), "env_b": FakeSocketFactory()]
    let registry: ClientRegistry

    init() async throws {
        cache = try SessionCache.inMemory()
        let host = RemoteAPI { request in
            let url = request.url!
            let id = "env_\(url.host()!.prefix(1))"
            let body = #"{"environmentId":"\#(id)","name":"\#(id)","version":"1.0.240","contract":\#(contractVersion),"key":{"id":"K1","name":"iphone","caps":["read"],"audience":"client"}}"#
            return (Data(body.utf8), HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        store = EnvironmentStore(directory: directory, keys: keys, api: host)
        let tickets = RemoteAPI { request in
            let body = #"{"ticket":"t","expiresIn":30}"#
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        let sockets = self.sockets
        let cache = self.cache
        let keys = self.keys
        registry = ClientRegistry(store: store, cache: cache) { environment in
            EnvironmentClient(environment: environment, keys: keys, cache: cache, api: tickets, connect: sockets[environment.id]!.factory, clock: ManualClock(random: [0]))
        }
        _ = try await store.add(origin: URL(string: "https://a.example")!, key: "tc_K1.secret", name: "A")
        _ = try await store.add(origin: URL(string: "https://b.example")!, key: "tc_K1.secret", name: "B")
    }

    func wait(_ predicate: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if predicate() { return true }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return false
    }

    /// Opens host `id`'s first socket and answers its shell listing.
    func bringUp(_ id: String) async -> FakeWebSocket {
        let fake = await sockets[id]!.socket(0)
        fake.hello(environmentId: id)
        var answered: Set<String> = []
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline, answered.count < 4 {
            for sent in fake.sentRequests where !answered.contains(sent.id) {
                switch sent.method {
                case "workspace.list", "project.list": fake.answer(id: sent.id, result: "[]")
                case "session.changes": fake.answer(id: sent.id, result: json(SessionChanges(reset: true, seq: 1, generation: "g")))
                case "session.list": fake.answer(id: sent.id, result: json(SessionPage(sessions: [], cursor: nil)))
                default: continue
                }
                answered.insert(sent.id)
            }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return fake
    }
}

@MainActor
@Suite struct ClientRegistryTests {
    @Test func `prepare makes a client per host without starting any`() async throws {
        let rig = try await RegistryRig()
        #expect(rig.registry.clients.isEmpty)
        rig.registry.prepare()
        #expect(Set(rig.registry.clients.keys) == ["env_a", "env_b"])
        #expect(rig.registry.ordered.map(\.environment.id) == ["env_a", "env_b"])
        #expect(rig.sockets.values.allSatisfy { $0.sockets.isEmpty }, "nothing connects until sync")
        #expect(rig.registry.clients.values.allSatisfy { $0.status == .idle })
        // A thread route can resolve and paint from the cache against the prepared client.
        try await rig.cache.store("env_a", sessionId: "s1", rows: [textRow("s1", seq: 1)], moreBefore: false)
        await rig.registry.client("env_a")?.openThread("s1")
        #expect(rig.registry.client("env_a")?.threads["s1"]?.rows.count == 1)
        let prepared = rig.registry.client("env_a")
        await rig.registry.sync()
        #expect(rig.registry.client("env_a") === prepared, "sync starts the prepared client rather than making another")
        #expect(await rig.wait { rig.registry.clients.values.allSatisfy { $0.status.transport == .connecting } })
        #expect(await rig.wait { rig.sockets.values.allSatisfy { $0.sockets.count == 1 } })
    }

    @Test func `allFresh waits for every host with a session and ignores one without`() async throws {
        let rig = try await RegistryRig()
        await rig.registry.sync()
        #expect(await rig.wait { rig.sockets["env_a"]!.sockets.count == 1 && rig.sockets["env_b"]!.sockets.count == 1 })
        #expect(rig.registry.allFresh, "nothing is open yet: there is nothing to wait for")
        let a = await rig.sockets["env_a"]!.socket(0)
        a.hello(environmentId: "env_a")
        #expect(await rig.wait { rig.registry.client("env_a")?.status.transport == .open })
        #expect(!rig.registry.allFresh, "a host with a session that has not listed holds the settle")
        _ = await rig.bringUp("env_a")
        #expect(await rig.wait { rig.registry.client("env_a")?.status.fresh == true })
        #expect(rig.registry.allFresh, "the host still connecting has no session to list on")
    }

    @Test func `the visible thread and the quiet publisher reach every client`() async throws {
        let rig = try await RegistryRig()
        var quiet = 0
        rig.registry.setQuietly { body in
            quiet += 1
            body()
        }
        rig.registry.prepare()
        rig.registry.setVisible(environmentId: "env_b", sessionId: "s9", listVisible: true)
        #expect(rig.registry.client("env_a")?.visibleThread == nil)
        #expect(rig.registry.client("env_b")?.visibleThread == "s9")
        #expect(rig.registry.clients.values.allSatisfy(\.listVisible))
        rig.registry.setVisible(environmentId: nil, sessionId: nil, listVisible: false)
        #expect(rig.registry.clients.values.allSatisfy { $0.visibleThread == nil && !$0.listVisible })
        // A client made before `setQuietly` publishes through it too: the first paint is quiet.
        await rig.registry.client("env_a")?.openThread("s1")
        #expect(quiet == 1)
        rig.registry.setQuietly { body in
            quiet += 10
            body()
        }
        await rig.registry.client("env_b")?.openThread("s2")
        #expect(quiet == 11, "a later publisher replaces the earlier one on every client")
    }
}
