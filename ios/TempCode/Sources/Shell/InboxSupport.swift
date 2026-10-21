import Foundation
import SwiftUI
import TempCodeContract

// What the Inbox tab shares between its list and its detail: the avatar
// with its hairline outline, the state words and their one meaning color,
// the seen marks, the on-disk snapshot the list paints from, and the patch
// parser the detail reads hunks from. Nothing here belongs to Design/; lift
// what another screen wants.

/// A person's avatar: the image when GitHub has one, else their initial on
/// the fill step. A 1 px outline at 10 % (black in light, white in dark)
/// keeps a white avatar from dissolving into the background.
struct InboxAvatar: View {
    let url: String
    let login: String
    var size: CGFloat = 36
    @Environment(\.displayScale) private var scale

    var body: some View {
        ZStack {
            if let url = URL(string: url), !url.absoluteString.isEmpty {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        initial
                    }
                }
            } else {
                initial
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(Color.primary.opacity(0.1), lineWidth: 1 / scale))
        .accessibilityHidden(true)
    }

    private var initial: some View {
        ZStack {
            Color(.tertiarySystemFill)
            Text(login.first.map { String($0).uppercased() } ?? "")
                .font(.system(size: size * 0.42, weight: .medium, design: .rounded))
                .foregroundStyle(.secondary)
        }
    }
}

/// The one word a row or header carries about where an item stands, and the
/// color that means it. Open issues and plain open pull requests say nothing:
/// the glyph already says what they are.
struct InboxState {
    let text: String
    let tint: Color

    /// The desktop's `prNote` plus the closed states and a review asked of the viewer.
    static func of(_ item: GithubInboxItem, viewer: String?) -> InboxState? {
        switch item.state {
        case .merged: return InboxState(text: "Merged", tint: Tint.violet)
        case .closed: return InboxState(text: "Closed", tint: Color(.tertiaryLabel))
        default: break
        }
        guard item.kind == .pr else { return nil }
        if item.draft { return InboxState(text: "Draft", tint: Color(.tertiaryLabel)) }
        if item.reviewDecision.rawValue == "CHANGES_REQUESTED" { return InboxState(text: "Changes requested", tint: Tint.warning) }
        if let checks = item.checks?.rawValue, checks == "FAILURE" || checks == "ERROR" { return InboxState(text: "Checks failing", tint: Tint.destructive) }
        if item.reviewDecision.rawValue == "APPROVED" { return InboxState(text: "Approved", tint: Tint.success) }
        if let viewer, !viewer.isEmpty, item.reviewRequested.contains(where: { $0.caseInsensitiveCompare(viewer) == .orderedSame }) {
            return InboxState(text: "Review requested", tint: Tint.info)
        }
        return nil
    }

    /// A review's verdict on a comment: approved, changes requested, dismissed; a plain comment says nothing.
    static func ofReview(_ state: String) -> InboxState? {
        switch state.uppercased() {
        case "APPROVED": InboxState(text: "Approved", tint: Tint.success)
        case "CHANGES_REQUESTED": InboxState(text: "Changes requested", tint: Tint.warning)
        case "DISMISSED": InboxState(text: "Dismissed", tint: Color(.tertiaryLabel))
        default: nil
        }
    }
}

extension GithubInboxItem {
    var isPullRequest: Bool { kind == .pr }
    var kindGlyph: String { isPullRequest ? "arrow.triangle.pull" : "circle.circle" }
    var kindLabel: String { isPullRequest ? "Pull request" : "Issue" }
    var reference: String { "\(repo) #\(number)" }
    /// `updatedAt` as epoch milliseconds, 0 when GitHub's stamp does not parse.
    var updatedMs: Int { inboxMs(updatedAt) }
}

/// Epoch milliseconds of an ISO stamp from GitHub, 0 when it does not parse.
func inboxMs(_ iso: String) -> Int {
    let date = (try? Date(iso, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)))
        ?? (try? Date(iso, strategy: .iso8601))
    return date.map { Int($0.timeIntervalSince1970 * 1000) } ?? 0
}

/// What the user has looked at, the desktop's `inboxSeen` on the phone: one
/// stamp per item, unread while the item moved after it. The first snapshot
/// seeds everything older than a day as seen, so a fresh pairing shows what
/// is new rather than a wall of bold. Lives in UserDefaults; the marks are
/// this phone's own and never travel.
@MainActor
@Observable
final class InboxSeen {
    static let shared = InboxSeen()
    private static let key = "inbox.seen"
    private static let seededKey = "inbox.seen.seeded"
    private static let dayMs = 24 * 60 * 60 * 1000

    private var marks: [String: Int]
    private(set) var seeded: Bool

    private init() {
        marks = (UserDefaults.standard.dictionary(forKey: Self.key) as? [String: Int]) ?? [:]
        seeded = UserDefaults.standard.bool(forKey: Self.seededKey)
    }

    func isUnread(_ entry: InboxEntry) -> Bool {
        (marks[entry.key] ?? 0) < entry.updatedMs
    }

    func markSeen(_ entry: InboxEntry) {
        guard isUnread(entry) else { return }
        marks[entry.key] = entry.updatedMs
        save()
    }

    func markUnread(_ entry: InboxEntry) {
        guard !isUnread(entry) else { return }
        marks[entry.key] = 0
        save()
    }

    /// The first snapshot ever: items older than a day start as seen.
    func seed(_ entries: [InboxEntry], now: Int = Int(Date.now.timeIntervalSince1970 * 1000)) {
        guard !seeded, !entries.isEmpty else { return }
        for entry in entries where entry.updatedMs < now - Self.dayMs {
            marks[entry.key] = entry.updatedMs
        }
        seeded = true
        UserDefaults.standard.set(true, forKey: Self.seededKey)
        save()
    }

    private func save() {
        UserDefaults.standard.set(marks, forKey: Self.key)
    }
}

/// The last snapshot of every host on disk, so the tab paints the moment it
/// opens and the socket's answer lands as a diff. One JSON file per host
/// under Caches; a missing or stale file is just an empty tab until the
/// first answer.
@MainActor
enum InboxCache {
    private static var loaded: [String: GithubInboxSnapshot?] = [:]

    nonisolated private static var directory: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appending(path: "inbox", directoryHint: .isDirectory)
    }

    nonisolated private static func file(_ environmentId: String) -> URL {
        let safe = environmentId.map { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" ? $0 : "_" }
        return directory.appending(path: "\(String(safe)).json")
    }

    /// Read once per launch, then remembered.
    static func snapshot(_ environmentId: String) -> GithubInboxSnapshot? {
        if let hit = loaded[environmentId] { return hit }
        let value = (try? Data(contentsOf: file(environmentId))).flatMap { try? JSONDecoder().decode(GithubInboxSnapshot.self, from: $0) }
        loaded[environmentId] = .some(value)
        return value
    }

    static func store(_ snapshot: GithubInboxSnapshot, for environmentId: String) {
        loaded[environmentId] = .some(snapshot)
        let target = file(environmentId)
        let dir = directory
        Task.detached(priority: .utility) {
            guard let data = try? JSONEncoder().encode(snapshot) else { return }
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? data.write(to: target, options: .atomic)
        }
    }
}

// MARK: - The patch

/// One file of a pull request's patch, as the desktop's `parsePrPatch` and
/// `mergePrDiff` read it: the lines with their old and new numbers, or no
/// lines at all when the patch was held back and only `files` came.
struct PatchFile: Identifiable, Hashable {
    enum Status: String {
        case added, deleted, renamed, modified
    }

    let path: String
    let previousPath: String?
    let status: Status
    let binary: Bool
    let additions: Int
    let deletions: Int
    let lines: [PatchLine]

    var id: String { path }

    /// The patch split by file and merged with gh's per-file counts; the
    /// patch's own numbers win where it has lines. Over `cap` lines the rest
    /// is dropped and `truncated` says so.
    static func parse(_ diff: GitHubPrDiff, cap: Int = 2000) -> (files: [PatchFile], truncated: Bool) {
        let parsed = parsePatch(diff.patch)
        var byPath: [String: PatchFile] = [:]
        for file in parsed { byPath[file.path] = file }
        var out: [PatchFile] = []
        var used = Set<String>()
        for meta in diff.files {
            if let hit = byPath[meta.path] {
                used.insert(meta.path)
                out.append(PatchFile(path: hit.path, previousPath: hit.previousPath, status: hit.status, binary: hit.binary, additions: meta.additions, deletions: meta.deletions, lines: hit.lines))
            } else {
                out.append(PatchFile(path: meta.path, previousPath: nil, status: .modified, binary: false, additions: meta.additions, deletions: meta.deletions, lines: []))
            }
        }
        for file in parsed where !used.contains(file.path) && !diff.files.contains(where: { $0.path == file.path }) {
            out.append(file)
        }
        var budget = cap
        var truncated = diff.truncated
        out = out.map { file in
            if file.lines.count <= budget {
                budget -= file.lines.count
                return file
            }
            truncated = true
            let kept = Array(file.lines.prefix(max(0, budget)))
            budget = 0
            return PatchFile(path: file.path, previousPath: file.previousPath, status: file.status, binary: file.binary, additions: file.additions, deletions: file.deletions, lines: kept)
        }
        return (out, truncated)
    }

    static func parsePatch(_ patch: String) -> [PatchFile] {
        let text = patch.replacingOccurrences(of: "\r\n", with: "\n")
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        var blocks: [[Substring]] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("diff --git ") || blocks.isEmpty {
                blocks.append([line])
            } else {
                blocks[blocks.count - 1].append(line)
            }
        }
        return blocks.compactMap(parseFile)
    }

    private static func parseFile(_ lines: [Substring]) -> PatchFile? {
        var path = ""
        var previousPath: String?
        var status = Status.modified
        var binary = false
        var additions = 0
        var deletions = 0
        var out: [PatchLine] = []
        var oldNumber = 0
        var newNumber = 0
        var inHunk = false

        for raw in lines {
            let line = String(raw)
            if line.hasPrefix("diff --git ") {
                if let (a, b) = gitPaths(line) {
                    previousPath = a == b ? nil : a
                    path = b
                }
                continue
            }
            if line.hasPrefix("new file mode") { status = .added; continue }
            if line.hasPrefix("deleted file mode") { status = .deleted; continue }
            if line.hasPrefix("rename from ") { previousPath = unquote(String(line.dropFirst("rename from ".count))); status = .renamed; continue }
            if line.hasPrefix("rename to ") { path = unquote(String(line.dropFirst("rename to ".count))); status = .renamed; continue }
            if line.hasPrefix("Binary files ") || line.hasPrefix("GIT binary patch") { binary = true; continue }
            if line.hasPrefix("--- ") {
                let next = stripPath(String(line.dropFirst(4)))
                if next == "/dev/null" {
                    if status == .modified { status = .added }
                } else if !next.isEmpty, previousPath == nil, next != path {
                    previousPath = next
                }
                continue
            }
            if line.hasPrefix("+++ ") {
                let next = stripPath(String(line.dropFirst(4)))
                if next == "/dev/null" { status = .deleted } else if !next.isEmpty { path = next }
                continue
            }
            if line.hasPrefix("@@"), let (old, new) = hunkStart(line) {
                inHunk = true
                oldNumber = old
                newNumber = new
                out.append(PatchLine(index: out.count, kind: .hunk, text: line, oldNumber: nil, newNumber: nil))
                continue
            }
            guard inHunk else { continue }
            if line.hasPrefix("+") {
                additions += 1
                out.append(PatchLine(index: out.count, kind: .add, text: String(line.dropFirst()), oldNumber: nil, newNumber: newNumber))
                newNumber += 1
            } else if line.hasPrefix("-") {
                deletions += 1
                out.append(PatchLine(index: out.count, kind: .delete, text: String(line.dropFirst()), oldNumber: oldNumber, newNumber: nil))
                oldNumber += 1
            } else if line.hasPrefix("\\") {
                continue
            } else {
                out.append(PatchLine(index: out.count, kind: .context, text: line.isEmpty ? "" : String(line.dropFirst()), oldNumber: oldNumber, newNumber: newNumber))
                oldNumber += 1
                newNumber += 1
            }
        }
        guard !path.isEmpty else { return nil }
        return PatchFile(path: path, previousPath: previousPath, status: status, binary: binary, additions: additions, deletions: deletions, lines: out)
    }

    private static func hunkStart(_ line: String) -> (Int, Int)? {
        // @@ -12,7 +12,9 @@ …
        let parts = line.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
        guard parts.count >= 3, parts[1].hasPrefix("-"), parts[2].hasPrefix("+") else { return nil }
        let old = Int(parts[1].dropFirst().split(separator: ",").first ?? "") ?? 0
        let new = Int(parts[2].dropFirst().split(separator: ",").first ?? "") ?? 0
        return (old, new)
    }

    private static func gitPaths(_ line: String) -> (String, String)? {
        let rest = String(line.dropFirst("diff --git ".count))
        if rest.hasPrefix("\"") {
            // "a/quoted path" "b/quoted path"
            let parts = rest.split(separator: "\" \"", maxSplits: 1).map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "\"")) }
            guard parts.count == 2 else { return nil }
            return (stripPath(parts[0]), stripPath(parts[1]))
        }
        // a/x b/x: the split sits at " b/" after the a-side
        guard let range = rest.range(of: " b/") else { return nil }
        let a = String(rest[rest.startIndex..<range.lowerBound])
        let b = String(rest[range.upperBound...])
        return (stripPath(a), b)
    }

    private static func stripPath(_ value: String) -> String {
        var text = unquote(value.trimmingCharacters(in: .whitespaces))
        if let tab = text.firstIndex(of: "\t") { text = String(text[..<tab]) }
        if text.hasPrefix("a/") || text.hasPrefix("b/") { text = String(text.dropFirst(2)) }
        return text
    }

    private static func unquote(_ value: String) -> String {
        guard value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") else { return value }
        return String(value.dropFirst().dropLast())
    }
}

struct PatchLine: Identifiable, Hashable {
    enum Kind {
        case add, delete, context, hunk
    }

    let index: Int
    let kind: Kind
    let text: String
    let oldNumber: Int?
    let newNumber: Int?

    var id: Int { index }
}
