import Foundation

/// A running app (with a pid) or an installed one (with a path).
public struct AppCandidate: Sendable, Equatable {
    public var pid: Int32?
    public var bundleId: String?
    public var name: String
    /// the bundle's path
    public var path: String?

    public init(pid: Int32? = nil, bundleId: String? = nil, name: String, path: String? = nil) {
        self.pid = pid
        self.bundleId = bundleId
        self.name = name
        self.path = path
    }
}

public enum AppMatch: Sendable, Equatable {
    case running(pid: Int32)
    /// an installed app or a path; only when launch is true
    case launch(path: String)
    /// at most five names, closest first; `launchable` when an installed app would match with launch
    case notFound(candidates: [String], launchable: Bool)
}

/// Resolving `AppRef.app` (docs/computer-protocol.md §2.1, shell A6).
public enum AppMatcher {
    public static let maxCandidates = 5

    /// A bundle id exactly; then a running app's name, case-insensitively; then an absolute `.app` path
    /// (the running app whose bundle it is, else launch it); then an installed app's name or bundle id,
    /// with launch; then a unique case-insensitive prefix of a running app's name.
    public static func match(_ query: String, running: [AppCandidate], installed: [AppCandidate], launch: Bool) -> AppMatch {
        let live = running.filter { $0.pid != nil }
        let lower = query.lowercased()
        if let app = live.first(where: { $0.bundleId == query }), let pid = app.pid { return .running(pid: pid) }
        if let app = live.first(where: { $0.name.lowercased() == lower }), let pid = app.pid { return .running(pid: pid) }
        if isAppPath(query) {
            let path = standardPath(query)
            if let app = live.first(where: { $0.path.map(standardPath) == path }), let pid = app.pid { return .running(pid: pid) }
            return launch ? .launch(path: path) : .notFound(candidates: [], launchable: true)
        }
        let installable = installed.first { $0.path != nil && ($0.bundleId == query || $0.name.lowercased() == lower) }
        if launch, let path = installable?.path { return .launch(path: path) }
        let prefixed = live.filter { $0.name.lowercased().hasPrefix(lower) }
        if prefixed.count == 1, let pid = prefixed[0].pid { return .running(pid: pid) }
        var names = candidates(query, among: live.map(\.name) + installed.map(\.name))
        if let installable {
            names.removeAll { $0 == installable.name }
            names = Array(([installable.name] + names).prefix(maxCandidates))
        }
        return .notFound(candidates: names, launchable: installable != nil)
    }

    public static func isAppPath(_ query: String) -> Bool {
        query.hasPrefix("/") && standardPath(query).hasSuffix(".app")
    }

    /// Names that start with the query, then those that contain it, then the smallest edit distance; five at most.
    public static func candidates(_ query: String, among names: [String]) -> [String] {
        let lower = query.lowercased()
        var seen = Set<String>()
        let unique = names.filter { seen.insert($0).inserted }
        func rank(_ name: String) -> (Int, Int, String) {
            let n = name.lowercased()
            if n.hasPrefix(lower) { return (0, 0, n) }
            if n.contains(lower) { return (1, 0, n) }
            return (2, editDistance(lower, n), n)
        }
        return unique.map { ($0, rank($0)) }.sorted { $0.1 < $1.1 }.prefix(maxCandidates).map(\.0)
    }

    public static func editDistance(_ a: String, _ b: String) -> Int {
        let a = Array(a), b = Array(b)
        guard !a.isEmpty else { return b.count }
        guard !b.isEmpty else { return a.count }
        var previous = Array(0...b.count)
        for i in 1...a.count {
            var current = [i] + Array(repeating: 0, count: b.count)
            for j in 1...b.count {
                current[j] = Swift.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1))
            }
            previous = current
        }
        return previous[b.count]
    }

    /// A path as one bundle reads under every spelling: `.` and `..` folded, links resolved, and macOS's
    /// `/private` before /tmp, /var and /etc dropped (Launch Services names a bundle under /tmp as /private/tmp).
    static func standardPath(_ path: String) -> String {
        var p = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
        while p.count > 1 && p.hasSuffix("/") { p.removeLast() }
        for dir in ["/tmp", "/var", "/etc"] where p.hasPrefix("/private" + dir + "/") || p == "/private" + dir {
            p.removeFirst("/private".count)
        }
        return p
    }
}
