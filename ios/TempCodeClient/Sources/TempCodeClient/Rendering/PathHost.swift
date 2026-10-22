import Foundation

/// One host's catalog roots: its project cwds and workspace paths, as it lists them.
public struct HostCatalog: Sendable, Hashable {
    public var environmentId: String
    public var roots: [String]

    public init(environmentId: String, roots: [String]) {
        self.environmentId = environmentId
        self.roots = roots
    }
}

/// Which host a path opens on. A path alone says nothing about where it
/// lives: `/tmp/shot.png` exists on the box when a box thread wrote it, and
/// the Mac has nothing there. The desktop's rule
/// (src/renderer/src/lib/pathHost.ts `hostForPath`), unchanged: a catalog
/// root is a definite answer; outside every root the thread's host; with no
/// thread, `primary`. On the phone `primary` is the thread's host again: the
/// phone has no disk and never opens a path without a thread.
public enum PathHost {
    public static func host(forPath path: String, owners: [String], threadHost: String?, primary: String) -> String {
        if let threadHost, owners.contains(threadHost) { return threadHost }
        return owners.first ?? threadHost ?? primary
    }

    /// Hosts whose catalog (a project cwd or a workspace path) holds `path`, in catalog order.
    /// Any root of a host makes it an owner; roots are not ranked by depth.
    public static func owners(of path: String, catalogs: [HostCatalog]) -> [String] {
        let target = ProjectPairs.normalize(path)
        return catalogs.compactMap { catalog in
            catalog.roots.contains { root in
                let root = ProjectPairs.normalize(root)
                return target == root || target.hasPrefix(root + "/")
            } ? catalog.environmentId : nil
        }
    }

    /// The convenience every screen calls: the thread's host stands in for `primary`.
    public static func host(ofPath path: String, threadHost: String, catalogs: [HostCatalog]) -> String {
        host(forPath: path, owners: owners(of: path, catalogs: catalogs), threadHost: threadHost, primary: threadHost)
    }

    /// `&host=<id>` on an `fs.media` URL: the host whose bytes they are; nil on a URL without it.
    public static func environment(ofMediaURL url: URL) -> String? {
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let value = components?.queryItems?.first { $0.name == "host" }?.value ?? ""
        return value.isEmpty ? nil : value
    }

    /// The desktop's `openFailureText`: an ENOENT, or a nil `file.read`, reads "No such file on <host>."
    /// ("No such file." with no host name); anything else keeps the host's words.
    public static func failureText(_ message: String?, hostName: String?) -> String {
        guard let message, !isMissing(message) else {
            return hostName.map { "No such file on \($0)." } ?? "No such file."
        }
        return message
    }

    private static func isMissing(_ message: String) -> Bool {
        message.contains(/\bENOENT\b/)
    }

    /// A photo the phone sends has no home on any host: the upload goes to the thread's host, whose
    /// `attachmentDir(session)` the fence admits. One rule, named so the composer and a test can say it.
    public static func uploadHost(threadHost: String) -> String { threadHost }
}
