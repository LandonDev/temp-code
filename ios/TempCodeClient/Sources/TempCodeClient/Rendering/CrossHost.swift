import Foundation
import TempCodeContract

/// A thread on another host than its parent, named `<environmentId>:<sessionId>`.
public struct RemoteAgentId: Sendable, Hashable {
    public var environmentId: String
    public var sessionId: String

    public init(environmentId: String, sessionId: String) {
        self.environmentId = environmentId
        self.sessionId = sessionId
    }
}

/// Where an agent lives, from the two forms the wire has: a `<env>:<session>`
/// id (what the host's tools say; src/shared/contract-crosshost.ts) or an
/// `agent-spawned` row's `childSessionId` + `environmentId` (what the parent's
/// log says). A box thread's `spawn_agent` with `environmentId: 'mac'` runs
/// the child on the Mac as an ordinary thread there; the phone reads that
/// child from the Mac's client when the Mac is paired, and says so when it
/// is not.
public enum CrossHost {
    /// `env_<22 chars>` (src/main/server/remote/environment.ts).
    // Compiled once and only read.
    nonisolated(unsafe) static let environmentIdPattern = /^env_[A-Za-z0-9_-]{22}$/
    nonisolated(unsafe) static let sessionIdPattern = /^[A-Za-z0-9_-]{1,200}$/

    public static func encode(_ environmentId: String, _ sessionId: String) -> String {
        "\(environmentId):\(sessionId)"
    }

    /// nil for a local id (no colon) and for a malformed one (the text stays as an id on this host).
    public static func decode(_ agentId: String) -> RemoteAgentId? {
        guard let colon = agentId.firstIndex(of: ":") else { return nil }
        let environmentId = String(agentId[..<colon])
        let sessionId = String(agentId[agentId.index(after: colon)...])
        guard environmentId.wholeMatch(of: environmentIdPattern) != nil, sessionId.wholeMatch(of: sessionIdPattern) != nil else { return nil }
        return RemoteAgentId(environmentId: environmentId, sessionId: sessionId)
    }

    public struct Placement: Sendable, Hashable {
        public var environmentId: String
        public var sessionId: String
        /// The child lives on another host than its parent.
        public var remote: Bool
        /// That host is in this phone's registry.
        public var paired: Bool

        public init(environmentId: String, sessionId: String, remote: Bool, paired: Bool) {
            self.environmentId = environmentId
            self.sessionId = sessionId
            self.remote = remote
            self.paired = paired
        }
    }

    /// From a spawn row: the row's host when it names one, else the parent's (`home`).
    public static func placement(childSessionId: String, environmentId: String?, home: String, paired: Set<String>) -> Placement {
        let host = environmentId ?? home
        let remote = host != home
        return Placement(environmentId: host, sessionId: childSessionId, remote: remote, paired: !remote || paired.contains(host))
    }

    /// From an encoded id in text: a local or malformed id is a child on `home`.
    public static func placement(agentId: String, home: String, paired: Set<String>) -> Placement {
        guard let remote = decode(agentId) else {
            return Placement(environmentId: home, sessionId: agentId, remote: false, paired: true)
        }
        return placement(childSessionId: remote.sessionId, environmentId: remote.environmentId, home: home, paired: paired)
    }

    /// childSessionId → environmentId for every spawn row of a parent that names a host; the fold keeps only the id.
    public static func hosts(in rows: [EventRow]) -> [String: String] {
        var out: [String: String] = [:]
        for row in rows {
            guard case .agentSpawned(let spawned) = row.event, let host = spawned.environmentId else { continue }
            out[spawned.childSessionId] = host
        }
        return out
    }

    /// The one line a row shows for a child on a host that is not paired. The wire carries the id only,
    /// never a name, so the line never names the host.
    public static let unpairedNote = "on a host this phone is not paired with"

    /// The host word for a remote, paired child whose host has a name; nil otherwise.
    public static func hostWord(_ placement: Placement, names: [String: String]) -> String? {
        guard placement.remote, placement.paired else { return nil }
        return names[placement.environmentId]
    }
}
