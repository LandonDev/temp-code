import Foundation
import Synchronization
import Testing
import TempCodeContract
@testable import TempCodeClient

/// A registry holding one paired carrier (`env_box`) on fake sockets, with
/// the relayed hosts' store on a temp directory, so a relayed host's whole
/// life (the carrier's hello, the presence push, the lane's own hello, the
/// drop, the forget, the cold paint) can be watched end to end.
@MainActor
private final class RelayRig {
    static let carrierId = "env_box"
    static let macId = "env_mac"
    let directory: URL
    let clock = ManualClock(random: [0])
    let sockets = FakeSocketFactory()
    let keys = InMemoryKeyStore()
    let cache: SessionCache
    let store: EnvironmentStore
    let registrar: PushRegistrar
    let relayed: RelayedHosts
    let registry: ClientRegistry
    /// The Authorization header of every ticket mint, in order.
    let mints = Mutex<[String]>([])
    var now: Double = 1_000

    init(directory: URL? = nil, cache: SessionCache? = nil) throws {
        self.directory = directory ?? FileManager.default.temporaryDirectory.appending(path: "tc-relay-\(UUID().uuidString)")
        self.cache = try cache ?? SessionCache.inMemory()
        registrar = PushRegistrar(defaults: UserDefaults(suiteName: "relay-tests-\(UUID().uuidString)")!)
        let environment = PairedEnvironment(id: RelayRig.carrierId, name: "box", origin: URL(string: "https://box.example")!, caps: [.read, .operate], keyId: "K1", keyName: "iphone", addedAt: 0)
        try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
        try JSONEncoder().encode([environment]).write(to: self.directory.appending(path: "environments.json"))
        try keys.set("tc_K1.secret", for: environment.id)
        let mints = self.mints
        let api = RemoteAPI { request in
            mints.withLock { $0.append(request.value(forHTTPHeaderField: "Authorization") ?? "") }
            return (Data(#"{"ticket":"t","expiresIn":30}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        store = EnvironmentStore(directory: self.directory, keys: keys, api: api)
        let cache = self.cache
        let clock = clock
        let keys = keys
        let connect = sockets.factory
        relayed = RelayedHosts(directory: self.directory, now: { 1_000 })
        registry = ClientRegistry(store: store, cache: cache, push: registrar, relayed: relayed) { environment in
            EnvironmentClient(environment: environment, keys: keys, cache: cache, api: api, connect: connect, clock: clock)
        }
    }

    var carrier: EnvironmentClient? { registry.client(RelayRig.carrierId) }
    var mac: EnvironmentClient? { registry.client(RelayRig.macId) }

    /// Starts the registry, opens the carrier's socket with a hello that
    /// lists `hosts`, and answers the shell listing on it.
    func openCarrier(hosts: [String]) async -> FakeWebSocket {
        await registry.sync()
        let fake = await sockets.socket(0)
        fake.deliver(helloJSON(environmentId: RelayRig.carrierId, hosts: hosts))
        Task { await self.answer(fake) }
        _ = await wait { [self] in carrier?.status.transport == .open }
        return fake
    }

    func helloJSON(environmentId: String, hosts: [String]? = nil, via: String? = nil, presence: String? = nil) -> String {
        var fields = [#""push":"hello""#, #""environmentId":"\#(environmentId)""#, #""contract":\#(contractVersion)"#, #""caps":["read","operate"]"#, #""key":{"id":"K1","name":"iphone"}"#]
        if let hosts { fields.append(#""hosts":[\#(hosts.joined(separator: ","))]"#) }
        if let via { fields.append(#""via":"\#(via)""#) }
        if let presence { fields.append(#""presence":\#(presence)"#) }
        return "{\(fields.joined(separator: ","))}"
    }

    func presencePushJSON(_ hosts: [String]) -> String {
        #"{"push":"presence","hosts":[\#(hosts.joined(separator: ","))]}"#
    }

    /// Answers the shell listing and the push calls on a socket as the host would.
    func answer(_ fake: FakeWebSocket) async {
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

    var relayedFile: [RelayedHost] {
        (try? JSONDecoder().decode([RelayedHost].self, from: Data(contentsOf: directory.appending(path: "relayed.json")))) ?? []
    }
}

@Suite("RelayedHosts store")
struct RelayedHostsStoreTests {
    @Test @MainActor func `apply adds, keeps, moves, renames and drops by carrier, and says what changed`() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "tc-relay-store-\(UUID().uuidString)")
        var clock = 100.0
        let store = RelayedHosts(directory: directory, now: { clock })
        var changes: [RelayedChange] = []
        store.onChange = { changes.append($0) }

        store.apply([presence(id: "env_mac"), presence(id: "env_mini", name: "Mini")], via: "env_box")
        #expect(store.hosts.map(\.id) == ["env_mac", "env_mini"])
        #expect(changes.last?.added == ["env_mac", "env_mini"])
        #expect(store.host("env_mac")?.learnedAt == 100)
        #expect(store.state(of: "env_mac") == .available)
        #expect(store.state(of: "env_nope") == nil)

        // The same list again: no change, no call.
        let count = changes.count
        store.apply([presence(id: "env_mac"), presence(id: "env_mini", name: "Mini")], via: "env_box")
        #expect(changes.count == count)

        // A move stamps the phone's clock; the row keeps its learnedAt.
        clock = 200
        store.apply([presence(id: "env_mac", screen: "locked"), presence(id: "env_mini", name: "Mini")], via: "env_box")
        #expect(changes.last?.moved == [RelayedMove(id: "env_mac", state: .locked)])
        #expect(store.host("env_mac")?.stateSince == 200)
        #expect(store.host("env_mac")?.learnedAt == 100)

        // A rename alone is a change the registry must hear.
        store.apply([presence(id: "env_mac", name: "Studio", screen: "locked"), presence(id: "env_mini", name: "Mini")], via: "env_box")
        #expect(changes.last?.renamed == ["env_mac"])
        #expect(changes.last?.moved.isEmpty == true)

        // A host the carrier no longer lists goes; another carrier's rows stay.
        store.apply([presence(id: "env_other", name: "Other")], via: "env_box2")
        store.apply([presence(id: "env_mac", name: "Studio", screen: "locked")], via: "env_box")
        #expect(changes.last?.removed == ["env_mini"])
        #expect(store.hosts.map(\.id) == ["env_mac", "env_other"])
        #expect(store.hosts(via: "env_box2").map(\.id) == ["env_other"])

        // The file follows.
        let saved = try JSONDecoder().decode([RelayedHost].self, from: Data(contentsOf: directory.appending(path: "relayed.json")))
        #expect(saved.map(\.id) == ["env_mac", "env_other"])
        #expect(RelayedHosts(directory: directory).hosts == store.hosts)
    }

    @Test @MainActor func `update never adds and forget drops a carrier's hosts`() {
        let directory = FileManager.default.temporaryDirectory.appending(path: "tc-relay-store-\(UUID().uuidString)")
        let store = RelayedHosts(directory: directory, now: { 1 })
        var changes: [RelayedChange] = []
        store.onChange = { changes.append($0) }
        store.update(presence(id: "env_mac"), via: "env_box")
        #expect(store.hosts.isEmpty)
        store.apply([presence(id: "env_mac")], via: "env_box")
        store.update(presence(id: "env_mac", power: "asleep"), via: "env_box")
        #expect(store.state(of: "env_mac") == .asleep)
        #expect(changes.last?.moved == [RelayedMove(id: "env_mac", state: .asleep)])
        // The carrier's own id never becomes a relayed host.
        store.apply([presence(id: "env_box"), presence(id: "env_mac", power: "asleep")], via: "env_box")
        #expect(store.hosts.map(\.id) == ["env_mac"])
        store.forget(via: "env_box")
        #expect(store.hosts.isEmpty)
        #expect(changes.last?.removed == ["env_mac"])
        store.forget(via: "env_box")
        #expect(changes.last?.removed == ["env_mac"])
    }
}

@Suite("Relayed hosts in the registry")
struct RelayedHostsTests {
    @Test @MainActor func `the carrier's hello with hosts makes a relayed client after it`() async throws {
        let rig = try RelayRig()
        _ = await rig.openCarrier(hosts: [presenceJSON()])
        #expect(await rig.wait { rig.mac != nil })
        #expect(rig.registry.ordered.map(\.environment.id) == [RelayRig.carrierId, RelayRig.macId])
        let environment = try #require(rig.mac?.environment)
        #expect(environment.via == RelayRig.carrierId)
        #expect(environment.origin.absoluteString == "https://box.example")
        #expect(environment.caps == [.read, .operate])
        #expect(environment.socketURL.absoluteString == "wss://box.example/ws?host=env_mac")
        #expect(rig.registry.relayed(via: RelayRig.carrierId).map(\.environment.id) == [RelayRig.macId])
        #expect(rig.registry.carrier(of: RelayRig.macId)?.environment.id == RelayRig.carrierId)
        #expect(rig.registry.carrier(of: RelayRig.carrierId) == nil)
        // The lane: the carrier's origin with the host query, minted with the carrier's key.
        let lane = await rig.sockets.socket(1)
        #expect(rig.sockets.urls[1].absoluteString == "wss://box.example/ws?host=env_mac&ticket=t")
        #expect(rig.mints.withLock { $0 }.allSatisfy { $0 == "Bearer tc_K1.secret" })
        #expect(rig.mints.withLock { $0.count } == 2)
        #expect(rig.mac?.presence?.environmentId == RelayRig.macId)
        #expect(rig.mac?.relayState == .available)
        _ = lane
    }

    @Test @MainActor func `a presence push moves the state and the socket follows`() async throws {
        let rig = try RelayRig()
        let carrier = await rig.openCarrier(hosts: [presenceJSON()])
        #expect(await rig.wait { rig.mac != nil })
        let lane = await rig.sockets.socket(1)
        lane.deliver(rig.helloJSON(environmentId: RelayRig.macId, via: RelayRig.carrierId, presence: presenceJSON()))
        Task { await rig.answer(lane) }
        #expect(await rig.wait { rig.mac?.status.transport == .open })

        carrier.deliver(rig.presencePushJSON([presenceJSON(link: "down", since: 1_792_660_440_000)]))
        #expect(await rig.wait { rig.relayed.state(of: RelayRig.macId) == .unreachable })
        #expect(await rig.wait { rig.mac?.status.transport == .offline })
        let held = try #require(rig.mac?.presence)
        #expect(rig.mac?.status.lastError == RelayWords.heldLine(held, now: .now))
        #expect(rig.mac?.operateBlock == .offline(reason: RelayWords.heldLine(held, now: .now)))
        #expect(lane.cancelledWith != nil)
        // Nothing is tried while the carrier says down, however long.
        await rig.clock.advance(ms: 600_000)
        await rig.clock.settle()
        #expect(rig.sockets.sockets.count == 2)
        await rig.mac?.retry()
        await rig.clock.settle()
        #expect(rig.sockets.sockets.count == 2)

        carrier.deliver(rig.presencePushJSON([presenceJSON(link: "up")]))
        #expect(await rig.wait { rig.relayed.state(of: RelayRig.macId) == .available })
        // An attempt at once: a new lane.
        _ = await rig.sockets.socket(2)
        #expect(rig.sockets.sockets.count == 3)
        #expect(rig.mac?.status.attempts == 0)
    }

    @Test @MainActor func `a lane's own hello updates the row and never adds one`() async throws {
        let rig = try RelayRig()
        _ = await rig.openCarrier(hosts: [presenceJSON()])
        #expect(await rig.wait { rig.mac != nil })
        let lane = await rig.sockets.socket(1)
        lane.deliver(rig.helloJSON(environmentId: RelayRig.macId, via: RelayRig.carrierId, presence: presenceJSON(screen: "locked")))
        #expect(await rig.wait { rig.relayed.state(of: RelayRig.macId) == .locked })
        #expect(await rig.wait { rig.mac?.relayState == .locked })
        #expect(rig.mac?.stateSince == 1_000)
        // Locked keeps Send admitted: the socket and the key decide, not the presence.
        #expect(await rig.wait { rig.mac?.status.transport == .open })
        #expect(rig.mac?.relayBlock == nil)
        #expect(rig.mac?.operateBlock == nil)
        // A hello row for an unknown id adds nothing.
        rig.relayed.update(presence(id: "env_ghost"), via: RelayRig.carrierId)
        #expect(rig.relayed.hosts.map(\.id) == [RelayRig.macId])
        #expect(rig.registry.ordered.count == 2)
    }

    @Test @MainActor func `an asleep host blocks the composer with its line`() async throws {
        let rig = try RelayRig()
        let carrier = await rig.openCarrier(hosts: [presenceJSON()])
        #expect(await rig.wait { rig.mac != nil })
        let lane = await rig.sockets.socket(1)
        lane.deliver(rig.helloJSON(environmentId: RelayRig.macId, via: RelayRig.carrierId, presence: presenceJSON()))
        #expect(await rig.wait { rig.mac?.status.transport == .open })
        carrier.deliver(rig.presencePushJSON([presenceJSON(power: "asleep")]))
        #expect(await rig.wait { rig.mac?.relayState == .asleep })
        #expect(rig.mac?.status.transport == .open)
        #expect(rig.mac?.operateBlock == .hostAsleep(subject: "the Mac"))
        #expect(rig.mac?.approveBlock == .noApprove)
        await #expect(throws: ActionError.blocked(.hostAsleep(subject: "the Mac"))) {
            try await rig.mac?.send("s1", text: "hello")
        }
    }

    @Test @MainActor func `a host the carrier dropped goes, and its cache with it`() async throws {
        let rig = try RelayRig()
        let carrier = await rig.openCarrier(hosts: [presenceJSON()])
        #expect(await rig.wait { rig.mac != nil })
        try await rig.cache.upsertSessions(RelayRig.macId, [sampleSession("s1")])
        carrier.deliver(rig.presencePushJSON([]))
        #expect(await rig.wait { rig.mac == nil })
        #expect(rig.relayed.hosts.isEmpty)
        #expect(rig.registry.ordered.map(\.environment.id) == [RelayRig.carrierId])
        let shell = try await rig.cache.shell(RelayRig.macId)
        #expect(shell.sessions.isEmpty)
    }

    @Test @MainActor func `forgetting the carrier forgets the relayed hosts`() async throws {
        let rig = try RelayRig()
        _ = await rig.openCarrier(hosts: [presenceJSON()])
        #expect(await rig.wait { rig.mac != nil })
        await forgetHost(RelayRig.carrierId, registry: rig.registry)
        #expect(rig.carrier == nil)
        #expect(rig.mac == nil)
        #expect(rig.relayed.hosts.isEmpty)
        #expect(rig.relayedFile.isEmpty)
        #expect(rig.store.environment(RelayRig.carrierId) == nil)
    }

    @Test @MainActor func `a cold launch paints the relayed host from the cache`() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "tc-relay-cold-\(UUID().uuidString)")
        let cache = try SessionCache.inMemory()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let row = RelayedHost(id: RelayRig.macId, via: RelayRig.carrierId, presence: presence(screen: "locked"), learnedAt: 7, stateSince: 9)
        try JSONEncoder().encode([row]).write(to: directory.appending(path: "relayed.json"))
        try await cache.upsertSessions(RelayRig.macId, [sampleSession("s1", title: "On the Mac")])

        let rig = try RelayRig(directory: directory, cache: cache)
        // Before any socket answers: the relayed client is up with its cached list and its last presence.
        await rig.registry.sync()
        #expect(rig.registry.ordered.map(\.environment.id) == [RelayRig.carrierId, RelayRig.macId])
        #expect(rig.mac?.sessions.map(\.title) == ["On the Mac"])
        #expect(rig.mac?.relayState == .locked)
        #expect(rig.mac?.stateSince == 9)
        #expect(rig.mac?.environment.addedAt == 7)
        #expect(rig.sockets.urls.count == 2)
    }

    @Test @MainActor func `a cold launch holds an unreachable host's lane without trying`() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: "tc-relay-cold-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let row = RelayedHost(id: RelayRig.macId, via: RelayRig.carrierId, presence: presence(link: "down", since: 1_792_660_440_000), learnedAt: 7)
        try JSONEncoder().encode([row]).write(to: directory.appending(path: "relayed.json"))
        let rig = try RelayRig(directory: directory)
        await rig.registry.sync()
        #expect(rig.mac?.status.transport == .offline)
        let held = try #require(rig.mac?.presence)
        #expect(rig.mac?.status.lastError == RelayWords.heldLine(held, now: .now))
        await rig.clock.advance(ms: 60_000)
        await rig.clock.settle()
        // Only the carrier's socket was opened.
        #expect(rig.sockets.urls.count == 1)
    }

    @Test @MainActor func `relayed json survives a rewrite of the carrier's key`() async throws {
        let rig = try RelayRig()
        _ = await rig.openCarrier(hosts: [presenceJSON()])
        #expect(await rig.wait { rig.mac != nil })
        try await rig.cache.upsertSessions(RelayRig.macId, [sampleSession("s1")])
        let before = try #require(rig.mac)
        // Pair Again on the carrier: the same id, a new key.
        try rig.keys.set("tc_K2.secret", for: RelayRig.carrierId)
        rig.store.rename(RelayRig.carrierId, to: "box")
        let replaced = PairedEnvironment(id: RelayRig.carrierId, name: "box", origin: URL(string: "https://box.example")!, caps: [.read, .operate], keyId: "K2", keyName: "iphone 2", addedAt: 0)
        try JSONEncoder().encode([replaced]).write(to: rig.directory.appending(path: "environments.json"))
        let store = EnvironmentStore(directory: rig.directory, keys: rig.keys)
        #expect(store.environment(RelayRig.carrierId)?.keyId == "K2")
        #expect(RelayedHosts(directory: rig.directory).hosts.map(\.id) == [RelayRig.macId])
        // The registry rebuilds a relayed client whose carrier changed, keeping the cache.
        let rebuilt = PairedEnvironment.relayed(try #require(rig.relayed.host(RelayRig.macId)), through: replaced)
        #expect(rebuilt.keyId == "K2")
        #expect(rebuilt != before.environment)
        let shell = try await rig.cache.shell(RelayRig.macId)
        #expect(shell.sessions.map(\.id) == ["s1"])
    }

    @Test @MainActor func `the registrar skips a relayed client`() async throws {
        let rig = try RelayRig()
        await rig.registrar.setEnabled(true, clients: [])
        await rig.registrar.setDevice(PushRegistrar.Device(token: String(repeating: "ab", count: 32), bundleId: "dev.landon.tempcode.ios", environment: .sandbox), clients: [])
        _ = await rig.openCarrier(hosts: [presenceJSON()])
        #expect(await rig.wait { rig.mac != nil })
        let lane = await rig.sockets.socket(1)
        lane.deliver(rig.helloJSON(environmentId: RelayRig.macId, via: RelayRig.carrierId, presence: presenceJSON()))
        #expect(await rig.wait { rig.mac?.status.transport == .open })
        let mac = try #require(rig.mac)
        await rig.registrar.sync(mac)
        try? await Task.sleep(for: .milliseconds(50))
        #expect(!lane.sentRequests.contains { $0.method.hasPrefix("remote.push") })
        #expect(rig.registrar.statuses[RelayRig.macId] == nil)
    }
}
