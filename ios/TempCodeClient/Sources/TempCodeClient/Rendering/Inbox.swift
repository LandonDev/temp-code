import Foundation
import TempCodeContract

/// One inbox item and the host it came from.
public struct InboxEntry: Identifiable, Hashable, Sendable {
    public let environmentId: String
    public let hostName: String
    public let item: GithubInboxItem
    /// `item.updatedAt` in clock milliseconds; 0 when it does not parse.
    public let updatedMs: Int

    public init(environmentId: String, hostName: String, item: GithubInboxItem, updatedMs: Int) {
        self.environmentId = environmentId
        self.hostName = hostName
        self.item = item
        self.updatedMs = updatedMs
    }

    public var id: String { InboxModel.key(environmentId: environmentId, item: item) }
}

/// The meaning a status word carries; the app maps each to its one color.
public enum InboxTone: Sendable, Hashable {
    case info, success, warning, destructive, violet, plain
}

/// The one word an item carries beyond its title, with what it means.
public struct InboxStatus: Hashable, Sendable {
    public let text: String
    public let tone: InboxTone

    public init(text: String, tone: InboxTone) {
        self.text = text
        self.tone = tone
    }
}

/// The inbox's rules (the desktop's InboxView.tsx and github.ts), pure: the
/// sort across hosts, the status word, the seen marks, the notices.
public enum InboxModel {
    public static func key(environmentId: String, item: GithubInboxItem) -> String {
        "\(environmentId):\(item.repo)#\(item.number)"
    }

    /// An ISO 8601 stamp in clock milliseconds; 0 when it does not parse.
    public static func ms(_ iso: String) -> Int {
        let date = (try? Date(iso, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)))
            ?? (try? Date(iso, strategy: .iso8601))
        guard let date else { return 0 }
        return Int(date.timeIntervalSince1970 * 1000)
    }

    public struct Host: Sendable {
        public let environmentId: String
        public let name: String
        public let snapshot: GithubInboxSnapshot?

        public init(environmentId: String, name: String, snapshot: GithubInboxSnapshot?) {
            self.environmentId = environmentId
            self.name = name
            self.snapshot = snapshot
        }
    }

    /// Every item of every host, newest first; ties by repo, then kind
    /// ("issue" before "pr"), then number descending (the desktop's sortInboxItems).
    public static func entries(_ hosts: [Host]) -> [InboxEntry] {
        var out: [InboxEntry] = []
        for host in hosts {
            guard let snapshot = host.snapshot else { continue }
            for repo in snapshot.repos {
                for item in repo.items {
                    out.append(InboxEntry(environmentId: host.environmentId, hostName: host.name, item: item, updatedMs: ms(item.updatedAt)))
                }
            }
        }
        return out.sorted {
            if $0.updatedMs != $1.updatedMs { return $0.updatedMs > $1.updatedMs }
            if $0.item.repo != $1.item.repo { return $0.item.repo < $1.item.repo }
            if $0.item.kind.rawValue != $1.item.kind.rawValue { return $0.item.kind.rawValue < $1.item.kind.rawValue }
            return $0.item.number > $1.item.number
        }
    }

    /// The one word beyond the title, or nil for an open item that waits on
    /// nothing in particular. The desktop's `prNote` plus "Your review".
    public static func status(of item: GithubInboxItem, viewer: String?) -> InboxStatus? {
        let isPr = item.kind == .pr
        switch item.state {
        case .merged: return InboxStatus(text: "Merged", tone: .violet)
        case .closed: return InboxStatus(text: "Closed", tone: isPr ? .destructive : .plain)
        default: break
        }
        guard isPr else { return nil }
        if item.draft { return InboxStatus(text: "Draft", tone: .plain) }
        if item.reviewDecision.rawValue == "CHANGES_REQUESTED" { return InboxStatus(text: "Changes requested", tone: .warning) }
        if let checks = item.checks?.rawValue, checks == "FAILURE" || checks == "ERROR" { return InboxStatus(text: "Checks failing", tone: .destructive) }
        if item.reviewDecision.rawValue == "APPROVED" { return InboxStatus(text: "Approved", tone: .success) }
        if let viewer, !viewer.isEmpty, item.reviewRequested.contains(where: { $0.caseInsensitiveCompare(viewer) == .orderedSame }) {
            return InboxStatus(text: "Your review", tone: .info)
        }
        return nil
    }

    /// A comment's review verdict (the desktop's githubReviewStateLabel); a plain comment needs no word.
    public static func reviewVerdict(_ state: String) -> InboxStatus? {
        switch state.uppercased() {
        case "APPROVED": InboxStatus(text: "Approved", tone: .success)
        case "CHANGES_REQUESTED": InboxStatus(text: "Requested changes", tone: .warning)
        case "DISMISSED": InboxStatus(text: "Dismissed", tone: .plain)
        default: nil
        }
    }

    // MARK: seen marks (entry id → the updatedMs read)

    public static func isUnread(_ entry: InboxEntry, seen: [String: Int]) -> Bool {
        guard let mark = seen[entry.id] else { return true }
        return mark < entry.updatedMs
    }

    public static func markRead(_ entry: InboxEntry, in seen: inout [String: Int]) {
        seen[entry.id] = max(entry.updatedMs, seen[entry.id] ?? 0)
    }

    public static func markUnread(_ entry: InboxEntry, in seen: inout [String: Int]) {
        seen[entry.id] = nil
    }

    /// On the first snapshot ever, rows older than this are seen; the newer ones are what is new.
    public static let seedWindowMs = 24 * 60 * 60 * 1000

    /// The marks the first snapshot ever adds: everything older than 24 h as of `now`.
    public static func seedSeen(_ snapshot: GithubInboxSnapshot, environmentId: String, now: Int) -> [String: Int] {
        let cutoff = now - seedWindowMs
        var out: [String: Int] = [:]
        for repo in snapshot.repos {
            for item in repo.items {
                let updated = ms(item.updatedAt)
                if updated < cutoff { out[key(environmentId: environmentId, item: item)] = updated }
            }
        }
        return out
    }

    /// What stands between the person and a full inbox: a key that cannot
    /// refresh first, then each host's gh problem and each repo's error,
    /// prefixed with the host's name only when there are several hosts.
    public static func notices(hosts: [Host], refreshDenied: Bool) -> [String] {
        var out: [String] = []
        if refreshDenied { out.append("This key reads the inbox but cannot refresh it.") }
        for host in hosts {
            guard let snapshot = host.snapshot else { continue }
            let prefix = hosts.count > 1 ? "\(host.name): " : ""
            if snapshot.auth.state != .ok, !snapshot.auth.message.isEmpty {
                out.append(prefix + snapshot.auth.message)
            }
            for repo in snapshot.repos {
                if let error = repo.error, !error.isEmpty { out.append("\(prefix)\(repo.repo): \(error)") }
            }
        }
        return out
    }
}

/// One file of a pull request's changes: the metadata's counts and the
/// file's own slice of the unified patch, for the diff screen.
public struct InboxChange: Identifiable, Hashable, Sendable {
    public let path: String
    public let previousPath: String?
    public let additions: Int
    public let deletions: Int
    public let binary: Bool
    /// This file's `diff --git` block, or nil when the host's patch has none (truncated, or binary).
    public let patch: String?

    public init(path: String, previousPath: String? = nil, additions: Int = 0, deletions: Int = 0, binary: Bool = false, patch: String? = nil) {
        self.path = path
        self.previousPath = previousPath
        self.additions = additions
        self.deletions = deletions
        self.binary = binary
        self.patch = patch
    }

    public var id: String { path }

    /// "old → new" for a rename, else the path.
    public var displayPath: String {
        if let previousPath, previousPath != path { return "\(previousPath) → \(path)" }
        return path
    }
}

/// A unified patch split by file, the way the diff screen wants to receive it.
public enum InboxPatch {
    /// Splits a patch at every line that starts "diff --git " (content lines
    /// start with ' ', '+', '-' or '\', so never there). CRLF is normalised.
    /// Paths come from the `diff --git a/x b/y` line, overridden by
    /// `rename to` and `+++ b/…`; quotes and the `a/` `b/` prefixes are
    /// stripped; `Binary files` or `GIT binary patch` marks the file binary.
    /// A block cut short still counts: its lines are what the host kept.
    public static func split(_ patch: String) -> [InboxChange] {
        let text = patch.replacingOccurrences(of: "\r\n", with: "\n")
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        var blocks: [[Substring]] = []
        var rows = text.split(separator: "\n", omittingEmptySubsequences: false)
        if rows.last?.isEmpty == true { rows.removeLast() }
        for line in rows {
            if line.hasPrefix("diff --git ") || blocks.isEmpty { blocks.append([]) }
            blocks[blocks.count - 1].append(line)
        }
        return blocks.compactMap(parse)
    }

    /// `diff.files` in the host's order, each with its block from
    /// `split(diff.patch)` by path and the counts from the metadata; blocks
    /// the metadata lacks appended after. An empty patch and empty metadata give [].
    public static func changes(_ diff: GitHubPrDiff) -> [InboxChange] {
        let parsed = split(diff.patch)
        if diff.files.isEmpty { return parsed }
        var byPath: [String: InboxChange] = [:]
        for change in parsed where byPath[change.path] == nil { byPath[change.path] = change }
        var out: [InboxChange] = []
        for meta in diff.files {
            let hit = byPath.removeValue(forKey: meta.path)
            out.append(InboxChange(path: meta.path, previousPath: hit?.previousPath, additions: meta.additions, deletions: meta.deletions, binary: hit?.binary ?? false, patch: hit?.patch))
        }
        for change in parsed where byPath[change.path] != nil {
            byPath[change.path] = nil
            out.append(change)
        }
        return out
    }

    private static func parse(_ lines: [Substring]) -> InboxChange? {
        var path = ""
        var previousPath: String?
        var binary = false
        var additions = 0
        var deletions = 0
        var inHunk = false
        for line in lines {
            if line.hasPrefix("diff --git ") {
                if let (from, to) = gitPaths(line.dropFirst("diff --git ".count)) {
                    previousPath = from == to ? nil : from
                    path = to
                }
                continue
            }
            if line.hasPrefix("rename from ") {
                previousPath = String(line.dropFirst("rename from ".count))
                continue
            }
            if line.hasPrefix("rename to ") {
                path = String(line.dropFirst("rename to ".count))
                continue
            }
            if line.hasPrefix("Binary files ") || line.hasPrefix("GIT binary patch") {
                binary = true
                continue
            }
            if !inHunk, line.hasPrefix("--- ") {
                let next = stripPath(line.dropFirst(4))
                if next != "/dev/null", !next.isEmpty, previousPath == nil, next != path { previousPath = next }
                continue
            }
            if !inHunk, line.hasPrefix("+++ ") {
                let next = stripPath(line.dropFirst(4))
                if next != "/dev/null", !next.isEmpty { path = next }
                continue
            }
            if line.hasPrefix("@@ ") {
                inHunk = true
                continue
            }
            guard inHunk else { continue }
            if line.hasPrefix("+") { additions += 1 } else if line.hasPrefix("-") { deletions += 1 }
        }
        guard !path.isEmpty else { return nil }
        if previousPath == path { previousPath = nil }
        return InboxChange(path: path, previousPath: previousPath, additions: additions, deletions: deletions, binary: binary, patch: lines.joined(separator: "\n"))
    }

    /// "a/x b/y" → ("x", "y"); the split is at " b/" (or ` "b/` for a quoted
    /// name), so the first path's own spaces survive.
    private static func gitPaths(_ rest: Substring) -> (String, String)? {
        if let range = rest.range(of: " \"b/") {
            return (stripPath(rest[rest.startIndex..<range.lowerBound]), stripPath(rest[rest.index(after: range.lowerBound)...]))
        }
        guard let range = rest.range(of: " b/") else { return nil }
        return (stripPath(rest[rest.startIndex..<range.lowerBound]), stripPath(rest[range.upperBound...]))
    }

    /// Drops the `a/` or `b/` prefix, the trailing tab stamp, and the quotes git puts around odd names.
    private static func stripPath(_ raw: Substring) -> String {
        var path = raw
        if let tab = path.firstIndex(of: "\t") { path = path[..<tab] }
        while path.first == " " { path = path.dropFirst() }
        while path.last == " " { path = path.dropLast() }
        if path.hasPrefix("\""), path.hasSuffix("\""), path.count >= 2 { path = path.dropFirst().dropLast() }
        if path.hasPrefix("a/") || path.hasPrefix("b/") { path = path.dropFirst(2) }
        return String(path)
    }
}
