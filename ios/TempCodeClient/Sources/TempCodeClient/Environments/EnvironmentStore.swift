import Foundation
import Observation
import TempCodeContract

public enum EnvironmentStoreError: Error, Hashable, Sendable {
    case invalidPairingLink
    case invalidKey
    /// The host issued a key for another audience (a bot key cannot drive the app).
    case notAClientKey
    case api(RemoteAPIError)
    /// The key could not be kept (the Keychain refused it).
    case keyStore(String)

    public var message: String {
        switch self {
        case .invalidPairingLink: "that is not a pairing link"
        case .invalidKey: "a key looks like tc_… followed by a secret"
        case .notAClientKey: "that key is for bots; make an app key"
        case .api(let error): error.message
        case .keyStore(let detail): "could not keep the key: \(detail)"
        }
    }
}

/// The paired environments, in the order they were added. The list is a JSON
/// file in Application Support; each key sits in the `KeyStore` under its
/// environment id. Pairing an id that is already here replaces its key and
/// keeps its place.
@MainActor @Observable
public final class EnvironmentStore {
    public private(set) var environments: [PairedEnvironment]
    public let keys: any KeyStore
    /// Where the list lives; the relayed hosts' file sits beside it.
    public let directory: URL
    private let api: RemoteAPI
    private let file: URL

    /// - Parameter directory: where `environments.json` lives; created if missing.
    public init(directory: URL, keys: any KeyStore, api: RemoteAPI = RemoteAPI()) {
        self.keys = keys
        self.directory = directory
        self.api = api
        self.file = directory.appending(path: "environments.json")
        self.environments = EnvironmentStore.load(file)
    }

    nonisolated public static func defaultDirectory() -> URL {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)) ?? FileManager.default.temporaryDirectory
        return base.appending(path: "TempCodeClient", directoryHint: .isDirectory)
    }

    public func environment(_ id: String) -> PairedEnvironment? {
        environments.first { $0.id == id }
    }

    /// Pairs with `<origin>/pair#<code>`: the code becomes a key, the key is
    /// kept, and the host's name and capabilities become the environment.
    /// `clientName` names the key on the host (what the host calls this
    /// phone); it is never the phone's name for the host.
    @discardableResult
    public func add(pairingLink text: String, clientName: String? = nil) async throws(EnvironmentStoreError) -> PairedEnvironment {
        guard let link = PairingLink(text) else { throw .invalidPairingLink }
        let paired: PairKeyResponse
        do {
            paired = try await api.pair(origin: link.origin, code: link.code, name: clientName)
        } catch {
            throw .api(error)
        }
        guard paired.audience == .client else { throw .notAClientKey }
        let hello = try? await api.hello(origin: link.origin, key: paired.key)
        let environment = PairedEnvironment(
            id: paired.environmentId,
            name: hello?.name ?? link.origin.host ?? paired.environmentId,
            origin: link.origin,
            caps: paired.caps,
            keyId: paired.keyId,
            keyName: paired.name,
            addedAt: Date().timeIntervalSince1970 * 1000
        )
        try keep(paired.key, for: environment.id)
        upsert(environment)
        return environment
    }

    /// Adds a host from a key made on the desktop: `/api/hello` with the key
    /// tells which environment it is and what it may do.
    @discardableResult
    public func add(origin: URL, key rawKey: String) async throws(EnvironmentStoreError) -> PairedEnvironment {
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
        let environment = PairedEnvironment(
            id: hello.environmentId,
            name: hello.name ?? hello.environmentId,
            origin: origin,
            caps: known.caps,
            keyId: known.id,
            keyName: known.name,
            addedAt: Date().timeIntervalSince1970 * 1000
        )
        try keep(key, for: environment.id)
        upsert(environment)
        return environment
    }

    private func keep(_ key: String, for id: String) throws(EnvironmentStoreError) {
        do {
            try keys.set(key, for: id)
        } catch {
            throw .keyStore(error.localizedDescription)
        }
    }

    /// The person's name for the host; an empty name, or the host's own,
    /// clears it so the host's name shows again.
    public func rename(_ id: String, to name: String) {
        guard let index = environments.firstIndex(where: { $0.id == id }) else { return }
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        let custom = trimmed.isEmpty || trimmed == environments[index].name ? nil : trimmed
        guard environments[index].customName != custom else { return }
        environments[index].customName = custom
        save()
    }

    /// Remembers what the host called itself in its hello; nothing is written when it is already known.
    public func setHostName(_ id: String, _ name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, let index = environments.firstIndex(where: { $0.id == id }), environments[index].name != trimmed else { return }
        environments[index].name = trimmed
        save()
    }

    /// Remembers the platform a hello named; nothing is written when it is already known.
    public func setPlatform(_ id: String, _ platform: String) {
        guard let index = environments.firstIndex(where: { $0.id == id }), environments[index].platform != platform else { return }
        environments[index].platform = platform
        save()
    }

    /// Forgets the host and its key. The caller stops its socket and clears its cache.
    public func remove(_ id: String) {
        environments.removeAll { $0.id == id }
        try? keys.remove(for: id)
        save()
    }

    private func upsert(_ environment: PairedEnvironment) {
        if let index = environments.firstIndex(where: { $0.id == environment.id }) {
            var kept = environment
            kept.addedAt = environments[index].addedAt
            kept.platform = kept.platform ?? environments[index].platform
            kept.customName = kept.customName ?? environments[index].customName
            environments[index] = kept
        } else {
            environments.append(environment)
        }
        save()
    }

    private static func load(_ file: URL) -> [PairedEnvironment] {
        guard let data = try? Data(contentsOf: file) else { return [] }
        return (try? JSONDecoder().decode([PairedEnvironment].self, from: data)) ?? []
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
