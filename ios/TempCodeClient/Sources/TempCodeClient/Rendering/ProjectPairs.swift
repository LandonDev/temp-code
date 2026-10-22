import Foundation
import TempCodeContract

/// The same project on two hosts: the Mac's checkout and the box's clone of
/// one repository. Home lists every host's workspaces under its own header;
/// the pairs say which copies are one project, so Home folds them into one
/// row and a path on either host has a partner on the other.
///
/// The desktop's rule (src/renderer/src/lib/projectPairs.ts), host-aware
/// because the phone's `WorkspaceMeta` carries no environment id (the client
/// is the host): two workspaces pair when they name the same GitHub
/// repository, else when their folders share a name. Within one host the
/// first workspace with a key keeps it, so a pair has at most one member per
/// host; a workspace with no partner is a pair of one.
///
/// Why no path map: the desktop also knows the Mac's path map (box
/// `/srv/agents/work/<X>` ↔ Mac `~/IdeaProjects/<X>`), but its default gives
/// both sides the same basename `<X>`, so the name rule already covers it;
/// and the map itself is a Mac setting (`harness.sync.pathMap`, admin) a
/// client key cannot read. The phone reads no map.
public struct PairMember: Sendable, Hashable {
    public var environmentId: String
    public var workspaceId: String
    /// The workspace folder on that host, no trailing slash.
    public var cwd: String
    public var name: String

    public init(environmentId: String, workspaceId: String, cwd: String, name: String) {
        self.environmentId = environmentId
        self.workspaceId = workspaceId
        self.cwd = cwd
        self.name = name
    }
}

public struct ProjectPair: Sendable, Hashable, Identifiable {
    /// "repo:<owner/name lowercased>" or "name:<basename lowercased>".
    public var id: String
    /// The first member's name: what every host's rows show.
    public var name: String
    public var members: [PairMember]

    public init(id: String, name: String, members: [PairMember]) {
        self.id = id
        self.name = name
        self.members = members
    }

    public var isPaired: Bool { members.count > 1 }
}

/// One host's workspaces, as its client lists them.
public struct HostWorkspaces: Sendable, Hashable {
    public var environmentId: String
    public var workspaces: [WorkspaceMeta]

    public init(environmentId: String, workspaces: [WorkspaceMeta]) {
        self.environmentId = environmentId
        self.workspaces = workspaces
    }
}

public enum ProjectPairs {
    /// Trailing slashes stripped; "" and "/" are "/".
    public static func normalize(_ path: String) -> String {
        ThreadGroups.normalize(path)
    }

    /// The last path segment, after normalizing.
    public static func basename(_ path: String) -> String {
        let stripped = normalize(path)
        return stripped.split(separator: "/").last.map(String.init) ?? stripped
    }

    /// "repo:…" when the workspace names a GitHub repository (trimmed, lowercased), else "name:…".
    public static func key(_ workspace: WorkspaceMeta) -> String {
        let repo = workspace.githubRepo?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        return repo.isEmpty ? "name:\(basename(workspace.path).lowercased())" : "repo:\(repo)"
    }

    /// Hosts in registry order; within one host the first workspace with a key keeps it,
    /// so a pair has at most one member per host. Pairs come out in the order their keys were first seen.
    public static func pairs(_ hosts: [HostWorkspaces]) -> [ProjectPair] {
        var order: [String] = []
        var byKey: [String: ProjectPair] = [:]
        for host in hosts {
            for workspace in host.workspaces {
                let key = key(workspace)
                var pair = byKey[key] ?? ProjectPair(id: key, name: workspace.name, members: [])
                if pair.members.contains(where: { $0.environmentId == host.environmentId }) { continue }
                pair.members.append(PairMember(environmentId: host.environmentId, workspaceId: workspace.id, cwd: normalize(workspace.path), name: workspace.name))
                if byKey[key] == nil { order.append(key) }
                byKey[key] = pair
            }
        }
        return order.compactMap { byKey[$0] }
    }

    /// The pair whose member on `environmentId` holds `path`; the deepest member folder wins
    /// when one workspace sits inside another.
    public static func pair(of path: String, on environmentId: String, in pairs: [ProjectPair]) -> (pair: ProjectPair, member: PairMember)? {
        let target = normalize(path)
        var best: (pair: ProjectPair, member: PairMember)?
        for pair in pairs {
            for member in pair.members where member.environmentId == environmentId {
                guard target == member.cwd || target.hasPrefix(member.cwd + "/") else { continue }
                if let current = best, current.member.cwd.count >= member.cwd.count { continue }
                best = (pair, member)
            }
        }
        return best
    }

    /// `path` relative to its pair member's folder ("" for the folder itself), or nil when no pair holds it.
    public static func relative(_ path: String, on environmentId: String, in pairs: [ProjectPair]) -> (pair: ProjectPair, relative: String)? {
        guard let found = pair(of: path, on: environmentId, in: pairs) else { return nil }
        let target = normalize(path)
        let relative = target == found.member.cwd ? "" : String(target.dropFirst(found.member.cwd.count + 1))
        return (found.pair, relative)
    }

    /// The other hosts' copies of the project that holds `path` on `environmentId`.
    public static func partners(of path: String, on environmentId: String, in pairs: [ProjectPair]) -> [PairMember] {
        guard let found = pair(of: path, on: environmentId, in: pairs) else { return [] }
        return found.pair.members.filter { $0.environmentId != environmentId }
    }

    /// Home's slot (`HomePairing.key`): the pair id for a workspace that is its host's first with
    /// that key, else "<env>:<workspace id>", so a second same-named folder on one host never folds.
    public static func homeKey(_ environmentId: String, _ workspace: WorkspaceMeta, hosts: [HostWorkspaces]) -> String {
        let key = key(workspace)
        let own = hosts.first { $0.environmentId == environmentId }?.workspaces ?? []
        let first = own.first { Self.key($0) == key }
        return first == nil || first?.id == workspace.id ? key : "\(environmentId):\(workspace.id)"
    }

    /// The closure Home's slot takes, over a snapshot of every host's workspaces.
    public static func homePairing(_ hosts: [HostWorkspaces]) -> @Sendable (String, WorkspaceMeta) -> String {
        { environmentId, workspace in homeKey(environmentId, workspace, hosts: hosts) }
    }

    /// Whether a row names its host: only with more than one paired host.
    public static func showsHost(hostCount: Int) -> Bool { hostCount > 1 }
}
