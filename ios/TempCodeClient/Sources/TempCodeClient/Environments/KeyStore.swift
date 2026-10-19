import Foundation
import Security
import Synchronization

/// Where a paired environment's key lives: the Keychain on the phone, memory
/// in tests. A key is `tc_<id>.<secret>`; nothing else ever stores it.
public protocol KeyStore: Sendable {
    func key(for environmentId: String) throws -> String?
    func set(_ key: String, for environmentId: String) throws
    func remove(for environmentId: String) throws
}

public enum KeyStoreError: Error, Hashable, Sendable {
    case keychain(OSStatus)
}

/// Generic-password items, one per environment id, readable after the first
/// unlock and never backed up to another device.
public struct KeychainKeyStore: KeyStore {
    public let service: String

    public init(service: String = "dev.landon.tempcode.remote-key") {
        self.service = service
    }

    private func query(_ environmentId: String) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: environmentId
        ]
    }

    public func key(for environmentId: String) throws -> String? {
        var query = query(environmentId)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        switch status {
        case errSecSuccess:
            guard let data = out as? Data else { return nil }
            return String(data: data, encoding: .utf8)
        case errSecItemNotFound:
            return nil
        default:
            throw KeyStoreError.keychain(status)
        }
    }

    public func set(_ key: String, for environmentId: String) throws {
        let data = Data(key.utf8)
        let update: [CFString: Any] = [kSecValueData: data]
        let status = SecItemUpdate(query(environmentId) as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw KeyStoreError.keychain(status) }
        var item = query(environmentId)
        item[kSecValueData] = data
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(item as CFDictionary, nil)
        guard added == errSecSuccess else { throw KeyStoreError.keychain(added) }
    }

    public func remove(for environmentId: String) throws {
        let status = SecItemDelete(query(environmentId) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeyStoreError.keychain(status) }
    }
}

/// Keys held in memory only: tests, previews, and the proof runs where the
/// key arrives in the process environment.
public final class InMemoryKeyStore: KeyStore {
    private let keys = Mutex<[String: String]>([:])

    public init() {}

    public func key(for environmentId: String) throws -> String? {
        keys.withLock { $0[environmentId] }
    }

    public func set(_ key: String, for environmentId: String) throws {
        keys.withLock { $0[environmentId] = key }
    }

    public func remove(for environmentId: String) throws {
        _ = keys.withLock { $0.removeValue(forKey: environmentId) }
    }
}
