import Foundation
import Observation
import TempCodeContract

public enum EnvironmentStoreError: Error, Hashable, Sendable {
    case invalidPairingLink
    case invalidKey
    /// The host issued a key for another audience (a bot key cannot drive the app).
    case notAClientKey
    case api(RemoteAPIError)

    public var message: String {
        switch self {
        case .invalidPairingLink: "that is not a pairing link"
        case .invalidKey: "a key looks like tc_… followed by a secret"
        case .notAClientKey: "that key is for bots; make an app key"
        case .api(let error): error.message
        }
    }
}

/// The paired environments, in the order they were added. The list is a JSON
/// file in Application Support; each key sits in the `KeyStore` under its
/// environment id. Pairing an id that is already here replaces its key and
/// keeps its place.
@MainActor @Observable
public final class EnvironmentStore {
    public private(set) var environments: [Environment]
    public let keys: any KeyStore
    private let api: RemoteAPI
    private let file: URL

    /// - Parameter directory: where `environments.json` lives; created if missing.
    public init(directory: URL, keys: any KeyStore, api: RemoteAPI = RemoteAPI()) {
        self.keys = keys
        self.api = api
        self.file = directory.appending(path: "environments.json")
        self.environments = EnvironmentStore.load(file)
    }

    nonisolated public static func defaultDirectory() -> URL {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)) ?? FileManager.default.temporaryDirectory
        return base.appending(path: "TempCodeClient", directoryHint: .isDirectory)
    }

    public func environment(_ id: String) -> Environment? {
        environments.first { $0.id == id }
    }

    /// Pairs with `<origin>/pair#<code>`: the code becomes a key, the key is
    /// kept, and the host's name and capabilities become the environment.
    @discardableResult
    public func add(pairingLink text: String, name: String? = nil) async throws(EnvironmentStoreError) -> Environment {
        guard let link = PairingLink(text) else { throw .invalidPairingLink }
        let paired: PairKeyResponse
        do {
            paired = try await api.pair(origin: link.origin, code: link.code, name: name)
        } catch {
            throw .api(error)
        }
        guard paired.audience == .client else { throw .notAClientKey }
        let hello = try? await api.hello(origin: link.origin, key: paired.key)
        let environment = Environment(
            id: paired.environmentId,
            name: name ?? hello?.name ?? link.origin.host ?? paired.environmentId,
            origin: link.origin,
            caps: paired.caps,
            keyId: paired.keyId,
            keyName: paired.name,
            addedAt: Date().timeIntervalSince1970 * 1000
        )
        try? keys.set(paired.key, for: environment.id)
        upsert(environment)
        return environment
    }

    /// Adds a host from a key made on the desktop: `/api/hello` with the key
    /// tells which environment it is and what it may do.
    @discardableResult
    public func add(origin: URL, key rawKey: String, name: String? = nil) async throws(EnvironmentStoreError) -> Environment {
        let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard key.hasPrefix("tc_"), key.contains(".") else { throw .invalidKey }
        let hello: HelloResponse
        do {
            hello = try await api.hello(origin: origin, key: key)
        } catch {
            throw .api(error)
        }
        guard let known = hello.key else { throw .api(.unauthorized("the host does not know this key")) }
        guard known.audience == .client else { throw .notAClientKey }
        let environment = Environment(
            id: hello.environmentId,
            name: name ?? hello.name,
            origin: origin,
            caps: known.caps,
            keyId: known.id,
            keyName: known.name,
            addedAt: Date().timeIntervalSince1970 * 1000
        )
        try? keys.set(key, for: environment.id)
        upsert(environment)
        return environment
    }

    public func rename(_ id: String, to name: String) {
        guard let index = environments.firstIndex(where: { $0.id == id }) else { return }
        environments[index].name = name
        save()
    }

    /// Forgets the host and its key. The caller stops its socket and clears its cache.
    public func remove(_ id: String) {
        environments.removeAll { $0.id == id }
        try? keys.remove(for: id)
        save()
    }

    private func upsert(_ environment: Environment) {
        if let index = environments.firstIndex(where: { $0.id == environment.id }) {
            var kept = environment
            kept.addedAt = environments[index].addedAt
            environments[index] = kept
        } else {
            environments.append(environment)
        }
        save()
    }

    private static func load(_ file: URL) -> [Environment] {
        guard let data = try? Data(contentsOf: file) else { return [] }
        return (try? JSONDecoder().decode([Environment].self, from: data)) ?? []
    }

    private func save() {
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(environments)
            try data.write(to: file, options: .atomic)
        } catch {
            // The list is rebuilt from the next pairing; losing it never loses a key.
        }
    }
}
