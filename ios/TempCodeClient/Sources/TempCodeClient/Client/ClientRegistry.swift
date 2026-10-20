import Foundation
import Observation

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

    /// Clients for every stored environment, started; newest additions started too.
    public func sync() async {
        for environment in store.environments where clients[environment.id] == nil {
            let client = make(environment)
            client.push = push
            clients[environment.id] = client
            await client.start()
        }
        for id in clients.keys where store.environment(id) == nil {
            await clients.removeValue(forKey: id)?.remove()
        }
    }

    public func client(_ id: String) -> EnvironmentClient? { clients[id] }

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
