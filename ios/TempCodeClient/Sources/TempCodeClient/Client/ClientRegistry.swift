import Foundation
import Observation
import TempCodeContract

/// The environments the app holds open: one client per paired environment
/// and one per host relayed through a paired one (the Mac through the box),
/// created from the store and the relayed hosts' store and torn down when a
/// host is removed. Foreground and network changes fan out to every socket.
@MainActor @Observable
public final class ClientRegistry {
    public let store: EnvironmentStore
    /// The hosts reached through a paired one, as their carriers last said.
    public let relayed: RelayedHosts
    public private(set) var clients: [String: EnvironmentClient] = [:]
    /// The phone's APNs token and what each host knows of it (thread L6).
    public let push: PushRegistrar
    private let cache: SessionCache
    private let make: @MainActor (PairedEnvironment) -> EnvironmentClient
    private var syncTask: Task<Void, Never>?

    /// - Parameter make: how a client is built for an environment; tests
    ///   inject fake sockets here. The default speaks to the real host.
    public init(store: EnvironmentStore, cache: SessionCache, push: PushRegistrar? = nil, relayed: RelayedHosts? = nil, make: (@MainActor (PairedEnvironment) -> EnvironmentClient)? = nil) {
        self.store = store
        self.cache = cache
        self.push = push ?? PushRegistrar()
        self.relayed = relayed ?? RelayedHosts(directory: store.directory)
        let keys = store.keys
        self.make = make ?? { environment in EnvironmentClient(environment: environment, keys: keys, cache: cache) }
        self.relayed.onChange = { [weak self] change in self?.relayedChanged(change) }
    }

    /// Hears every session meta of every host, now and for hosts paired later.
    public func setSessionObserver(_ observer: (@MainActor (EnvironmentClient, [SessionMeta]) -> Void)?) {
        sessionObserver = observer
        for client in clients.values { client.sessionObserver = observer }
    }
    private var sessionObserver: (@MainActor (EnvironmentClient, [SessionMeta]) -> Void)?

    /// A client for every stored environment and every host relayed through
    /// one, not yet started: the first frame of a cold launch can resolve a
    /// restored thread route against it and paint that thread from the cache
    /// before anything connects. A relayed client carries its last known
    /// presence from the start, so its first line and block are right.
    public func prepare() {
        for environment in wantedEnvironments() where clients[environment.id] == nil {
            clients[environment.id] = makeClient(environment)
        }
    }

    private func makeClient(_ environment: PairedEnvironment) -> EnvironmentClient {
        let client = make(environment)
        client.push = push
        client.sessionObserver = sessionObserver
        client.quietly = quietly
        client.relayObserver = { [weak self] client, hosts, whole in self?.heard(client, hosts, whole: whole) }
        client.platformObserver = { [weak self] client, platform in self?.store.setPlatform(client.environment.id, platform) }
        if let host = relayed.host(environment.id) {
            client.presence = host.presence
            client.stateSince = host.stateSince
        }
        return client
    }

    /// Clients for every stored environment and every relayed host whose
    /// carrier is stored, started; newest additions started too. A relayed
    /// client whose carrier's origin, key or name changed is rebuilt (its
    /// cache kept); clients outside the union are removed. Calls are
    /// serialized: one in flight finishes before the next looks.
    public func sync() async {
        let previous = syncTask
        let task = Task { [weak self] in
            await previous?.value
            await self?.runSync()
        }
        syncTask = task
        await task.value
    }

    private func runSync() async {
        let wanted = wantedEnvironments()
        for environment in wanted where environment.isRelayed {
            // Pair Again on the carrier, or the Mac renamed: the lane needs the new key or name.
            guard let existing = clients[environment.id], existing.environment != environment else { continue }
            await existing.stop()
            clients[environment.id] = nil
        }
        prepare()
        for environment in wanted {
            guard let client = clients[environment.id] else { continue }
            if let host = relayed.host(environment.id) {
                // The lane follows the carrier's word before it tries anything.
                await client.applyRelayState(host.state, presence: host.presence, since: host.stateSince)
            }
            await client.start()
        }
        let keep = Set(wanted.map(\.id))
        for id in clients.keys where !keep.contains(id) {
            await clients.removeValue(forKey: id)?.remove()
        }
    }

    /// The union, in rail order: each stored environment, then the hosts relayed through it.
    private func wantedEnvironments() -> [PairedEnvironment] {
        store.environments.flatMap { carrier in
            [carrier] + relayedHosts(via: carrier.id).map { PairedEnvironment.relayed($0, through: carrier) }
        }
    }

    /// The hosts relayed through `carrier` that are not paired directly: a
    /// host the phone reaches itself keeps its own pairing, never a lane.
    private func relayedHosts(via carrier: String) -> [RelayedHost] {
        let paired = Set(store.environments.map(\.id))
        return relayed.hosts(via: carrier).filter { !paired.contains($0.id) }
    }

    public func client(_ id: String) -> EnvironmentClient? { clients[id] }

    /// A host's platform: the live hello's, else the one the store remembers
    /// (a relayed host's from its presence); nil for a host never heard from.
    public func platform(_ id: String) -> String? {
        clients[id]?.status.lastHello?.build?.platform ?? store.environment(id)?.platform ?? clients[id]?.environment.platform
    }

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

    /// The store's order, each host followed by the hosts relayed through it.
    public var ordered: [EnvironmentClient] {
        wantedEnvironments().compactMap { clients[$0.id] }
    }

    /// The clients relayed through `carrier`, in the order they were learned.
    public func relayed(via carrier: String) -> [EnvironmentClient] {
        relayedHosts(via: carrier).compactMap { clients[$0.id] }
    }

    /// The client that carries the relayed host `id`; nil for a paired host.
    public func carrier(of id: String) -> EnvironmentClient? {
        guard let via = clients[id]?.environment.via ?? relayed.host(id)?.via else { return nil }
        return clients[via]
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

    /// Forgets a paired host, and every host relayed through it.
    public func remove(_ id: String) async {
        store.remove(id)
        relayed.forget(via: id)
        await sync()
    }

    public func setForeground(_ foreground: Bool) async {
        for client in clients.values { await client.setForeground(foreground) }
    }

    public func setOnline(_ online: Bool) async {
        for client in clients.values { await client.setOnline(online) }
    }

    // MARK: - presence

    /// A client's hello or `presence` push: a carrier's whole list lands under
    /// its id; a relayed lane's hello row updates its own row, and a
    /// `presence` push on a lane is the carrier's whole list.
    private func heard(_ client: EnvironmentClient, _ hosts: [HostPresence], whole: Bool) {
        if let via = client.environment.via {
            if whole {
                relayed.apply(hosts, via: via)
            } else if let own = hosts.first {
                relayed.update(own, via: via)
            }
        } else if whole {
            relayed.apply(hosts, via: client.environment.id)
        }
    }

    /// The store changed: a moved state reaches its client's socket; a host
    /// that came, went or was renamed rebuilds the set.
    private func relayedChanged(_ change: RelayedChange) {
        for move in change.moved {
            guard let client = clients[move.id], let host = relayed.host(move.id) else { continue }
            Task { await client.applyRelayState(move.state, presence: host.presence, since: host.stateSince) }
        }
        if change.needsSync { Task { await sync() } }
    }
}
