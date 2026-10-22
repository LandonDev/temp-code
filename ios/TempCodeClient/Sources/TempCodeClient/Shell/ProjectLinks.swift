import Foundation
import TempCodeContract

/// One host's copy of a linked project.
public struct ProjectCopy: Sendable, Hashable {
    public var environmentId: String
    public var projectId: String

    public init(environmentId: String, projectId: String) {
        self.environmentId = environmentId
        self.projectId = projectId
    }
}

/// What a host is, for its glyph: a Mac, or a server (the box). A host whose
/// platform the phone has not heard is a server, as the settings home counts it.
public enum HostKind: Sendable, Hashable {
    case mac
    case server

    public init(platform: String?) {
        self = platform == "darwin" ? .mac : .server
    }

    /// The SF Symbol the glyph draws.
    public var symbol: String {
        switch self {
        case .mac: "laptopcomputer"
        case .server: "server.rack"
        }
    }
}

/// Where a project's settings are read and saved: the desktop's rule
/// (src/shared/projectLinks.ts `settingsHomeOf`) over the copies this phone
/// can see. Settings live on the box; the Mac's copy follows it.
public enum ProjectLinks {
    /// Among the copies of one linked project, the host whose platform is not
    /// `darwin`; two of one platform → the environment id that sorts first; a
    /// host not yet heard from counts as a box. Nil for no copies.
    public static func settingsHome(_ copies: [ProjectCopy], platformOf: (String) -> String?) -> ProjectCopy? {
        let ids = Set(copies.map(\.environmentId)).sorted()
        let boxes = ids.filter { platformOf($0) != "darwin" }
        guard let home = (boxes.isEmpty ? ids : boxes).first else { return nil }
        return copies.first { $0.environmentId == home }
    }

    /// Every copy of `project` (on `environmentId`) the phone holds: each
    /// host's project with the same `linkId`, at most one per host, in the
    /// order given; a project with no link is its own only copy.
    public static func copies(of project: ProjectMeta, on environmentId: String, hosts: [(environmentId: String, projects: [ProjectMeta])]) -> [ProjectCopy] {
        let own = ProjectCopy(environmentId: environmentId, projectId: project.id)
        let link = ProjectPairs.key(environmentId, project)
        guard link.hasPrefix("link:") else { return [own] }
        // A second row of one host under one link stays its own, as Home folds it.
        let first = hosts.first { $0.environmentId == environmentId }?.projects.first { ProjectPairs.key(environmentId, $0) == link }
        if let first, first.id != project.id { return [own] }
        var out: [ProjectCopy] = []
        for host in hosts {
            if host.environmentId == environmentId {
                out.append(own)
            } else if let copy = host.projects.first(where: { ProjectPairs.key(host.environmentId, $0) == link }) {
                out.append(ProjectCopy(environmentId: host.environmentId, projectId: copy.id))
            }
        }
        return out.contains(own) ? out : [own] + out
    }

    /// The settings sheet's target for the project a menu was opened on.
    public static func target(for project: ProjectMeta, on environmentId: String, hosts: [(environmentId: String, projects: [ProjectMeta])], platformOf: (String) -> String?) -> SettingsTarget {
        let all = copies(of: project, on: environmentId, hosts: hosts)
        let home = settingsHome(all, platformOf: platformOf) ?? ProjectCopy(environmentId: environmentId, projectId: project.id)
        return SettingsTarget(home: home, copies: all.count)
    }
}

/// Which copy the project settings sheet reads and saves, and what it says
/// about it. With one copy the sheet says nothing about where.
public struct SettingsTarget: Sendable, Hashable, Identifiable {
    public var home: ProjectCopy
    /// How many hosts hold a copy the phone can see.
    public var copies: Int

    public init(home: ProjectCopy, copies: Int) {
        self.home = home
        self.copies = copies
    }

    public var id: String { "\(home.environmentId)/\(home.projectId)" }

    /// The project lives on more than one host, so the sheet names the home.
    public var isLinked: Bool { copies > 1 }

    /// The footer under the last section: "Saved on box", only when linked.
    public func footer(hostName: String) -> String? {
        isLinked ? "Saved on \(hostName)" : nil
    }

    /// Why the sheet cannot save, or nil: the home's own block, named after
    /// the home when the project is linked ("Settings live on box. Offline").
    public func saveReason(_ block: ActionBlock?, hostName: String, now: Double) -> String? {
        guard let block else { return nil }
        let text = block.text(now: now)
        return isLinked ? "Settings live on \(hostName). \(text)" : text
    }
}
