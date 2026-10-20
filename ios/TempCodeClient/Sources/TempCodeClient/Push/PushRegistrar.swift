import Foundation
import Observation
import TempCodeContract

/// Where a notification or a Live Activity tap lands: a thread on a host,
/// and the row to open on. Read off an APNs payload's `tc` object (what
/// infra/hub sends) or the activity's `tempcode://thread/<env>/<session>?seq=`.
public struct PushTarget: Sendable, Hashable {
    public var environmentId: String
    public var sessionId: String
    public var seq: Int?

    public init(environmentId: String, sessionId: String, seq: Int? = nil) {
        self.environmentId = environmentId
        self.sessionId = sessionId
        self.seq = seq
    }

    /// The `tc` object of a hub notification; a payload without a thread (a host down) is nil.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let tc = userInfo["tc"] as? [AnyHashable: Any],
              let environmentId = tc["environmentId"] as? String, !environmentId.isEmpty,
              let sessionId = tc["threadId"] as? String, !sessionId.isEmpty else { return nil }
        self.init(environmentId: environmentId, sessionId: sessionId, seq: PushTarget.int(tc["seq"]))
    }

    /// `tempcode://thread/<environment>/<session>?seq=<n>`, as the Live Activity's widgetURL.
    public init?(url: URL) {
        guard url.scheme == "tempcode", url.host == "thread" else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        let seq = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "seq" }?.value.flatMap(Int.init)
        self.init(environmentId: parts[0], sessionId: parts[1], seq: seq)
    }

    private static func int(_ value: Any?) -> Int? {
        switch value {
        case let n as Int: n
        case let n as Double: Int(n)
        case let s as String: Int(s)
        default: nil
        }
    }
}

/// The APNs token this phone holds and what each paired host knows of it.
/// A host learns the token when its socket opens (and again when the token
/// changes); turning the row off unregisters on every host. The hosts keep
/// the hub subscriptions; nothing here speaks to Apple or the hub.
@MainActor @Observable
public final class PushRegistrar {
    public struct Device: Sendable, Hashable, Codable {
        public var token: String
        public var bundleId: String
        public var environment: PushEnvironment

        public init(token: String, bundleId: String, environment: PushEnvironment) {
            self.token = token
            self.bundleId = bundleId
            self.environment = environment
        }
    }

    public enum Permission: String, Sendable, Codable {
        case unknown, granted, denied
    }

    public private(set) var enabled: Bool
    public private(set) var permission: Permission = .unknown
    public private(set) var device: Device?
    /// What the system said when it could not hand out a token.
    public private(set) var tokenError: String?
    /// Each host's answer, by environment id.
    public private(set) var statuses: [String: PushStatus] = [:]
    /// The last refusal per host: the transport, or the host saying no.
    public private(set) var failures: [String: String] = [:]
    /// What each host holds, so a reconnect sends a token only once.
    private var held: [String: Device]
    private let defaults: UserDefaults

    private enum Keys {
        static let enabled = "push.enabled"
        static let held = "push.held"
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        enabled = defaults.bool(forKey: Keys.enabled)
        held = defaults.data(forKey: Keys.held).flatMap { try? JSONDecoder().decode([String: Device].self, from: $0) } ?? [:]
    }

    public func setPermission(_ permission: Permission) {
        self.permission = permission
    }

    /// The system handed out a token (or a new one): every open host hears of it.
    public func setDevice(_ device: Device, clients: [EnvironmentClient]) async {
        tokenError = nil
        guard self.device != device else { return }
        self.device = device
        await syncAll(clients)
    }

    public func setTokenError(_ message: String) {
        tokenError = message
    }

    /// The row's switch. Off drops the registration on every host that holds one.
    public func setEnabled(_ on: Bool, clients: [EnvironmentClient]) async {
        guard enabled != on else { return }
        enabled = on
        defaults.set(on, forKey: Keys.enabled)
        await syncAll(clients)
    }

    public func syncAll(_ clients: [EnvironmentClient]) async {
        for client in clients { await sync(client) }
    }

    /// Brings one host in line: a register when it lacks the token, a status
    /// read when it has it, an unregister when the row is off.
    public func sync(_ client: EnvironmentClient) async {
        guard await client.socket.isOpen else { return }
        let id = client.environment.id
        guard enabled else {
            if held[id] != nil {
                if let status = try? await client.request(Methods.RemotePushUnregister.self, .init()) { statuses[id] = status }
                held[id] = nil
                persistHeld()
            }
            return
        }
        guard let device else {
            if let status = try? await client.request(Methods.RemotePushStatus.self, .init()) { statuses[id] = status }
            return
        }
        if held[id] == device, let status = try? await client.request(Methods.RemotePushStatus.self, .init()), status.registered {
            statuses[id] = status
            failures[id] = nil
            return
        }
        do {
            let status = try await client.request(Methods.RemotePushRegister.self, .init(token: device.token, bundleId: device.bundleId, environment: device.environment, events: nil))
            statuses[id] = status
            failures[id] = nil
            held[id] = device
            persistHeld()
        } catch {
            failures[id] = ActionError.wrap(error).message
        }
    }

    /// The host was removed from the phone.
    public func forget(_ environmentId: String) {
        statuses[environmentId] = nil
        failures[environmentId] = nil
        held[environmentId] = nil
        persistHeld()
    }

    /// The Live Activity token the phone holds for a thread (nil when it ended): the host relays updates to it.
    public func setActivityToken(_ client: EnvironmentClient, sessionId: String, token: String?) async {
        guard await client.socket.isOpen else { return }
        _ = try? await client.request(Methods.RemotePushActivity.self, .init(sessionId: sessionId, token: token, bundleId: device?.bundleId, environment: device?.environment))
    }

    private func persistHeld() {
        defaults.set(try? JSONEncoder().encode(held), forKey: Keys.held)
    }

    /// The Settings row's word, from the switch, the permission, the token and the hosts.
    public var summary: String {
        PushRegistrar.summary(enabled: enabled, permission: permission, hasDevice: device != nil, tokenError: tokenError, statuses: Array(statuses.values), failures: Array(failures.values))
    }

    nonisolated static func summary(enabled: Bool, permission: Permission, hasDevice: Bool, tokenError: String?, statuses: [PushStatus], failures: [String]) -> String {
        guard enabled else { return "Off" }
        if permission == .denied { return "Not allowed" }
        if tokenError != nil { return "Failed" }
        guard hasDevice else { return "Registering…" }
        let registered = statuses.filter(\.registered)
        if registered.contains(where: { $0.relay == .ok }) { return "On" }
        if registered.contains(where: { $0.relay == .failed }) || !failures.isEmpty { return "Failed" }
        if !registered.isEmpty { return "No relay" }
        return "Registering…"
    }
}
