import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A registry holding one paired host on a fake socket, with a registrar on
/// its own defaults, so `forgetHost` can be watched end to end.
@MainActor
private final class ForgetRig {
    static let environmentId = "env_forget"
    let directory = FileManager.default.temporaryDirectory.appending(path: "tc-forget-\(UUID().uuidString)")
    let clock = ManualClock(random: [0])
    let sockets = FakeSocketFactory()
    let keys = InMemoryKeyStore()
    let cache: SessionCache
    let store: EnvironmentStore
    let registrar: PushRegistrar
    let registry: ClientRegistry

    init() throws {
        cache = try SessionCache.inMemory()
        registrar = PushRegistrar(defaults: UserDefaults(suiteName: "forget-tests-\(UUID().uuidString)")!)
        let environment = PairedEnvironment(id: ForgetRig.environmentId, name: "box", origin: URL(string: "https://box.example")!, caps: [.read], keyId: "K1", keyName: "iphone", addedAt: 0)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode([environment]).write(to: directory.appending(path: "environments.json"))
        try keys.set("tc_K1.secret", for: environment.id)
        let api = RemoteAPI { request in
            (Data(#"{"ticket":"t","expiresIn":30}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        store = EnvironmentStore(directory: directory, keys: keys, api: api)
        let cache = cache
        let clock = clock
        let keys = keys
        let connect = sockets.factory
        registry = ClientRegistry(store: store, cache: cache, push: registrar) { environment in
            EnvironmentClient(environment: environment, keys: keys, cache: cache, api: api, connect: connect, clock: clock)
        }
    }

    var client: EnvironmentClient? { registry.client(ForgetRig.environmentId) }

    /// Starts the client, opens its socket with a hello and answers the
    /// shell listing and every push call as the host would.
    func open() async -> FakeWebSocket {
        await registry.sync()
        let fake = await sockets.socket(0)
        fake.hello(environmentId: ForgetRig.environmentId)
        Task { await self.answer(fake) }
        _ = await wait { [self] in
            guard let client else { return false }
            return client.status.transport == .open
        }
        return fake
    }

    private func answer(_ fake: FakeWebSocket) async {
        var answered: Set<String> = []
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            for sent in fake.sentRequests where !answered.contains(sent.id) {
                switch sent.method {
                case "workspace.list": fake.answer(id: sent.id, result: json([sampleWorkspace("w1")]))
                case "project.list": fake.answer(id: sent.id, result: json([sampleProject("p1")]))
                case "session.list": fake.answer(id: sent.id, result: json(SessionPage(sessions: [], cursor: nil)))
                case "remote.push.register", "remote.push.status":
                    fake.answer(id: sent.id, result: json(PushStatus(registered: true, relay: .ok, error: nil, events: [.needsYou], updatedAt: 1)))
                case "remote.push.unregister":
                    fake.answer(id: sent.id, result: json(PushStatus(registered: false, relay: .none, error: nil, events: [], updatedAt: nil)))
                default: continue
                }
                answered.insert(sent.id)
            }
            try? await Task.sleep(for: .milliseconds(1))
        }
    }

    func wait(_ predicate: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if predicate() { return true }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return false
    }
}

private let device = PushRegistrar.Device(token: String(repeating: "ab", count: 32), bundleId: "dev.landon.tempcode.ios", environment: .sandbox)

@Suite("forgetHost")
struct ForgetHostTests {
    @Test @MainActor func `unregisters push on the host before the environment leaves`() async throws {
        let rig = try ForgetRig()
        await rig.registrar.setEnabled(true, clients: [])
        await rig.registrar.setDevice(device, clients: [])
        let fake = await rig.open()
        #expect(await rig.wait { fake.sentRequests.contains { $0.method == "remote.push.register" } })
        #expect(rig.registrar.statuses[ForgetRig.environmentId]?.registered == true)

        await forgetHost(ForgetRig.environmentId, registry: rig.registry)

        // The unregister went out on the open socket; nothing can be sent once the client is removed.
        #expect(fake.sentRequests.contains { $0.method == "remote.push.unregister" })
        #expect(rig.store.environment(ForgetRig.environmentId) == nil)
        #expect(rig.client == nil)
        #expect(rig.registrar.statuses[ForgetRig.environmentId] == nil)
        let key = try rig.keys.key(for: ForgetRig.environmentId)
        #expect(key == nil)
    }

    @Test @MainActor func `a closed socket gets no request and the environment still leaves`() async throws {
        let rig = try ForgetRig()
        await rig.registrar.setEnabled(true, clients: [])
        await rig.registrar.setDevice(device, clients: [])
        await rig.registry.sync()
        // The socket is on its way (no hello), so nothing is open.
        let fake = await rig.sockets.socket(0)
        #expect(rig.client != nil)

        await forgetHost(ForgetRig.environmentId, registry: rig.registry)

        #expect(!fake.sentRequests.contains { $0.method == "remote.push.unregister" })
        #expect(rig.store.environment(ForgetRig.environmentId) == nil)
        #expect(rig.client == nil)
    }

    @Test @MainActor func `with push off nothing is asked of the host`() async throws {
        let rig = try ForgetRig()
        let fake = await rig.open()
        #expect(rig.client != nil)
        #expect(!rig.registrar.enabled)

        await forgetHost(ForgetRig.environmentId, registry: rig.registry)

        #expect(!fake.sentRequests.contains { $0.method == "remote.push.unregister" })
        #expect(!fake.sentRequests.contains { $0.method == "remote.push.register" })
        #expect(rig.store.environment(ForgetRig.environmentId) == nil)
        #expect(rig.client == nil)
    }
}
