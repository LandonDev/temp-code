import Foundation
import TempCodeContract

/// One project on two hosts: the Mac's checkout and the box's clone of one
/// repository. The hosts link their copies themselves (the Mac's linker,
/// src/main/server/remote/projectLinks.ts): every copy of a workspace carries
/// one `linkId`, and so does every copy of a project inside it. The phone
/// guesses nothing: two rows are copies of one only when they carry the same
/// link id; a row without one is a pair of one.
///
/// Within one host the first row with a link id keeps it, so a pair has at
/// most one member per host (the linker never gives two rows of one host the
/// same id; the rule keeps a bad catalog from folding a host into itself).
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
    /// "link:<linkId>", or "<env>:<workspace id>" for a row with no link.
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

    /// The fold key of a row with an optional link id: "link:<id>" when it
    /// carries one, else "<env>:<row id>", which never folds.
    public static func key(linkId: String?, environmentId: String, id: String) -> String {
        let link = linkId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return link.isEmpty ? "\(environmentId):\(id)" : "link:\(link)"
    }

    /// A workspace's fold key.
    public static func key(_ environmentId: String, _ workspace: WorkspaceMeta) -> String {
        key(linkId: workspace.linkId, environmentId: environmentId, id: workspace.id)
    }

    /// A project's fold key.
    public static func key(_ environmentId: String, _ project: ProjectMeta) -> String {
        key(linkId: project.linkId, environmentId: environmentId, id: project.id)
    }

    /// Hosts in registry order; within one host the first workspace with a key keeps it.
    /// Pairs come out in the order their keys were first seen.
    public static func pairs(_ hosts: [HostWorkspaces]) -> [ProjectPair] {
        var order: [String] = []
        var byKey: [String: ProjectPair] = [:]
        for host in hosts {
            for workspace in host.workspaces {
                let member = PairMember(environmentId: host.environmentId, workspaceId: workspace.id, cwd: normalize(workspace.path), name: workspace.name)
                var pairKey = key(host.environmentId, workspace)
                if byKey[pairKey]?.members.contains(where: { $0.environmentId == host.environmentId }) == true {
                    pairKey = "\(host.environmentId):\(workspace.id)"
                }
                var pair = byKey[pairKey] ?? ProjectPair(id: pairKey, name: workspace.name, members: [])
                pair.members.append(member)
                if byKey[pairKey] == nil { order.append(pairKey) }
                byKey[pairKey] = pair
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

    /// Whether a row names its host: only with more than one paired host.
    public static func showsHost(hostCount: Int) -> Bool { hostCount > 1 }
}
