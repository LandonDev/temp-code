import Foundation
import Observation
import TempCodeContract

/// The environments the app holds open: one client per paired environment,
/// created from the store and torn down when a host is removed. Foreground
/// and network changes fan out to every socket.
@MainActor @Observable
public final class ClientRegistry {
    public let store: EnvironmentStore
    public private(set) var clients: [String: EnvironmentClient] = [:]
    /// The phone's APNs token and what each host knows of it (thread L6).
    public let push: PushRegistrar
    private let cache: SessionCache
    private let make: @MainActor (PairedEnvironment) -> EnvironmentClient

    /// - Parameter make: how a client is built for an environment; tests
    ///   inject fake sockets here. The default speaks to the real host.
    public init(store: EnvironmentStore, cache: SessionCache, push: PushRegistrar? = nil, make: (@MainActor (PairedEnvironment) -> EnvironmentClient)? = nil) {
        self.store = store
        self.cache = cache
        self.push = push ?? PushRegistrar()
        let keys = store.keys
        self.make = make ?? { environment in EnvironmentClient(environment: environment, keys: keys, cache: cache) }
    }

    /// Hears every session meta of every host, now and for hosts paired later.
    public func setSessionObserver(_ observer: (@MainActor (EnvironmentClient, [SessionMeta]) -> Void)?) {
        sessionObserver = observer
        for client in clients.values { client.sessionObserver = observer }
    }
    private var sessionObserver: (@MainActor (EnvironmentClient, [SessionMeta]) -> Void)?

    /// A client for every stored environment, not yet started: the first frame
    /// of a cold launch can resolve a restored thread route against it and
    /// paint that thread from the cache before anything connects.
    public func prepare() {
        for environment in store.environments where clients[environment.id] == nil {
            let client = make(environment)
            client.push = push
            client.sessionObserver = sessionObserver
            client.quietly = quietly
            clients[environment.id] = client
        }
    }

    /// Clients for every stored environment, started; newest additions started too.
    public func sync() async {
        prepare()
        for environment in store.environments {
            await clients[environment.id]?.start()
        }
        for id in clients.keys where store.environment(id) == nil {
            await clients.removeValue(forKey: id)?.remove()
        }
    }

    public func client(_ id: String) -> EnvironmentClient? { clients[id] }

    /// What is on screen: the thread (on whichever host), and whether Home's
    /// lists are. Every client publishes what nobody is looking at quietly.
    public func setVisible(environmentId: String?, sessionId: String?, listVisible: Bool) {
        for (id, client) in clients {
            client.visibleThread = id == environmentId ? sessionId : nil
            client.listVisible = listVisible
        }
    }

    /// How a change nobody is looking at is published, for every client now and later.
    public func setQuietly(_ quietly: @escaping @MainActor (() -> Void) -> Void) {
        self.quietly = quietly
        for client in clients.values { client.quietly = quietly }
    }
    private var quietly: @MainActor (() -> Void) -> Void = { $0() }

    /// Every host has listed on its live session (or has no session to list on).
    public var allFresh: Bool {
        clients.values.allSatisfy { $0.status.fresh || $0.status.transport != .open }
    }

    /// The store's order.
    public var ordered: [EnvironmentClient] {
        store.environments.compactMap { clients[$0.id] }
    }

    public func add(pairingLink: String, name: String? = nil) async throws(EnvironmentStoreError) -> EnvironmentClient {
        let environment = try await store.add(pairingLink: pairingLink, name: name)
        await sync()
        return clients[environment.id]!
    }

    public func add(origin: URL, key: String, name: String? = nil) async throws(EnvironmentStoreError) -> EnvironmentClient {
        let environment = try await store.add(origin: origin, key: key, name: name)
        await sync()
        return clients[environment.id]!
    }

    public func remove(_ id: String) async {
        store.remove(id)
        await sync()
    }

    public func setForeground(_ foreground: Bool) async {
        for client in clients.values { await client.setForeground(foreground) }
    }

    public func setOnline(_ online: Bool) async {
        for client in clients.values { await client.setOnline(online) }
    }
}
