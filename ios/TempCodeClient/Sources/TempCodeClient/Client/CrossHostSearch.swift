import Foundation
import TempCodeContract

/// One search over every paired host, the phone's port of the desktop's
/// src/renderer/src/lib/crossHostSearch.ts: every open host is asked in
/// parallel for the kinds the query and scope select, rows land as each
/// source answers, one score per hit that never reads the host, a file in
/// two copies of a paired project folded into one row on the newer copy,
/// and the `host:`, `type:` and `project:` tokens typed in the box. Pure:
/// no SwiftUI, every type `Sendable`, the calls injected as closures, so the
/// suites script it with fakes and a manual clock. It emits thread 4's
/// `SearchAnswer`, so the screen changes by one loop.

/// What a `type:` token names: threads (titles, transcript rows and a
/// thread's working notes), files (lines of a project's files), notes (the
/// app's notes), projects (a project or workspace by name). Mirrors
/// SEARCH_KINDS in appSearch.ts.
public nonisolated enum SearchKind: String, CaseIterable, Sendable, Hashable {
    case thread, file, note, project

    /// "threads" and "thread" both name the kind: one trailing `s` is stripped.
    public init?(token: String) {
        var value = token.lowercased()
        if value.hasSuffix("s") { value.removeLast() }
        self.init(rawValue: value)
    }

    /// The kinds a scope asks for when no `type:` token is typed.
    public static func kinds(of scope: SearchScope) -> Set<SearchKind> {
        switch scope {
        case .threads: [.thread, .note]
        case .files: [.file, .project]
        }
    }
}

/// The query box parsed: the words, filter tokens removed, single-spaced,
/// and the three filters. Mirrors parseSearchQuery.
public struct ParsedQuery: Sendable, Hashable {
    public var text: String
    /// Lowercased.
    public var host: String?
    /// nil when no `type:` token named a known kind.
    public var kinds: Set<SearchKind>?
    /// Lowercased.
    public var project: String?

    public init(text: String, host: String? = nil, kinds: Set<SearchKind>? = nil, project: String? = nil) {
        self.text = text
        self.host = host
        self.kinds = kinds
        self.project = project
    }

    private static let filterKeys: Set<String> = ["host", "type", "project"]

    /// A `key:value` token with key in {host, type, project} (case-insensitive
    /// key) is a filter, anything else a word; an empty value is a token still
    /// being typed and filters nothing; `type:` splits on commas and unions
    /// across several tokens.
    public static func parse(_ raw: String) -> ParsedQuery {
        var words: [String] = []
        var host: String?
        var project: String?
        var kinds: Set<SearchKind>?
        for token in raw.split(whereSeparator: \.isWhitespace) {
            guard let colon = token.firstIndex(of: ":"), colon > token.startIndex, filterKeys.contains(token[..<colon].lowercased()) else {
                words.append(String(token))
                continue
            }
            let key = token[..<colon].lowercased()
            let value = String(token[token.index(after: colon)...])
            if value.isEmpty { continue }
            switch key {
            case "host": host = value.lowercased()
            case "project": project = value.lowercased()
            default:
                let picked = value.split(separator: ",").compactMap { SearchKind(token: String($0)) }
                if !picked.isEmpty { kinds = (kinds ?? []).union(picked) }
            }
        }
        return ParsedQuery(text: words.joined(separator: " "), host: host, kinds: kinds, project: project)
    }
}

/// The three calls one host answers, as closures so the tests script them
/// and the view binds them to `EnvironmentClient.request`.
public struct SearchAsk: Sendable {
    public var threads: @Sendable (_ query: String) async throws -> SessionSearchResult
    public var files: @Sendable (_ cwd: String, _ query: String) async throws -> ProjectSearchResult
    public var notes: @Sendable (_ query: String) async throws -> NoteSearchResult

    public init(
        threads: @escaping @Sendable (_ query: String) async throws -> SessionSearchResult,
        files: @escaping @Sendable (_ cwd: String, _ query: String) async throws -> ProjectSearchResult,
        notes: @escaping @Sendable (_ query: String) async throws -> NoteSearchResult
    ) {
        self.threads = threads
        self.files = files
        self.notes = notes
    }
}

/// A paired host as the fan-out sees it, in rail order.
public struct SearchTarget: Sendable {
    public let id: String
    public let name: String
    public let open: Bool
    /// `hello.build.platform == "darwin"`; what `host:mac` names.
    public let isMac: Bool
    /// Root sessions only (parentId == nil), for titles and types.
    public let sessions: [SessionMeta]
    /// Unarchived projects in catalog order; the first
    /// `CrossHostSearch.projectsPerHost` are grepped, every one is matched by name.
    public let projects: [ProjectMeta]
    public let workspaces: [WorkspaceMeta]
    public let ask: SearchAsk

    public init(id: String, name: String, open: Bool, isMac: Bool, sessions: [SessionMeta], projects: [ProjectMeta], workspaces: [WorkspaceMeta], ask: SearchAsk) {
        self.id = id
        self.name = name
        self.open = open
        self.isMac = isMac
        self.sessions = sessions
        self.projects = projects
        self.workspaces = workspaces
        self.ask = ask
    }
}

/// Where a path sits in its paired project, from thread 22's ProjectPairs.
public struct PairedPath: Sendable, Hashable {
    public let pairId: String
    public let pairName: String
    public let relative: String
    /// Members of the pair; a fold happens only when 2 or more.
    public let copies: Int

    public init(pairId: String, pairName: String, relative: String, copies: Int) {
        self.pairId = pairId
        self.pairName = pairName
        self.relative = relative
        self.copies = copies
    }
}

/// (environmentId, absolute path) → the pair holding it, or nil.
public typealias PairLookup = @Sendable (String, String) -> PairedPath?

/// One ranked hit, before it becomes rows. The kind is what `type:` filters
/// and what the ordering groups by. Scores are ints like the desktop's.
public enum SearchHit: Sendable, Hashable {
    /// A root thread whose title holds every query word.
    case title(ThreadTitle)
    /// A transcript row, or a thread's working notes (`isNote`).
    case message(Message)
    /// A line of a project file.
    case file(File)
    /// An app note.
    case note(Note)
    /// A project or workspace by name.
    case project(Project)

    public struct ThreadTitle: Sendable, Hashable {
        public var environmentId: String
        public var sessionId: String
        public var title: String
        public var type: ThreadType?
        public var cwd: String
        public var updatedAt: Int
        public var score: Int

        public init(environmentId: String, sessionId: String, title: String, type: ThreadType?, cwd: String, updatedAt: Int, score: Int = 0) {
            self.environmentId = environmentId
            self.sessionId = sessionId
            self.title = title
            self.type = type
            self.cwd = cwd
            self.updatedAt = updatedAt
            self.score = score
        }
    }

    public struct Message: Sendable, Hashable {
        public var environmentId: String
        public var sessionId: String
        public var title: String
        public var type: ThreadType?
        public var cwd: String
        public var updatedAt: Int
        public var seq: Int
        public var snippet: String
        public var ts: Int
        public var rank: Double?
        public var isNote: Bool
        public var score: Int

        public init(environmentId: String, sessionId: String, title: String, type: ThreadType?, cwd: String, updatedAt: Int, seq: Int, snippet: String, ts: Int, rank: Double?, isNote: Bool, score: Int = 0) {
            self.environmentId = environmentId
            self.sessionId = sessionId
            self.title = title
            self.type = type
            self.cwd = cwd
            self.updatedAt = updatedAt
            self.seq = seq
            self.snippet = snippet
            self.ts = ts
            self.rank = rank
            self.isNote = isNote
            self.score = score
        }
    }

    public struct File: Sendable, Hashable {
        public var environmentId: String
        public var projectId: String
        public var projectName: String
        public var branch: String?
        public var worktree: Bool
        public var path: String
        public var relative: String
        public var line: Int
        public var column: Int
        /// The line, leading whitespace dropped.
        public var preview: String
        public var mtime: Int?
        /// The other hosts' copies this row folded, as environment ids.
        public var alsoOn: [String]
        /// The fold chose this copy for its later mtime.
        public var newer: Bool

        public init(environmentId: String, projectId: String, projectName: String, branch: String?, worktree: Bool, path: String, relative: String, line: Int, column: Int, preview: String, mtime: Int?, alsoOn: [String] = [], newer: Bool = false) {
            self.environmentId = environmentId
            self.projectId = projectId
            self.projectName = projectName
            self.branch = branch
            self.worktree = worktree
            self.path = path
            self.relative = relative
            self.line = line
            self.column = column
            self.preview = preview
            self.mtime = mtime
            self.alsoOn = alsoOn
            self.newer = newer
        }
    }

    public struct Note: Sendable, Hashable {
        public var environmentId: String
        public var noteId: String
        public var title: String
        public var snippet: String
        public var updatedAt: Int
        public var cwd: String?
        public var score: Int

        public init(environmentId: String, noteId: String, title: String, snippet: String, updatedAt: Int, cwd: String?, score: Int = 0) {
            self.environmentId = environmentId
            self.noteId = noteId
            self.title = title
            self.snippet = snippet
            self.updatedAt = updatedAt
            self.cwd = cwd
            self.score = score
        }
    }

    public struct Project: Sendable, Hashable {
        public var environmentId: String
        public var projectId: String
        public var name: String
        public var branch: String?
        public var worktree: Bool
        public var path: String
        public var score: Int

        public init(environmentId: String, projectId: String, name: String, branch: String?, worktree: Bool, path: String, score: Int) {
            self.environmentId = environmentId
            self.projectId = projectId
            self.name = name
            self.branch = branch
            self.worktree = worktree
            self.path = path
            self.score = score
        }
    }

    public var environmentId: String {
        switch self {
        case .title(let hit): hit.environmentId
        case .message(let hit): hit.environmentId
        case .file(let hit): hit.environmentId
        case .note(let hit): hit.environmentId
        case .project(let hit): hit.environmentId
        }
    }

    /// Mirrors kindOf: title and message hits are threads.
    public var kind: SearchKind {
        switch self {
        case .title, .message: .thread
        case .file: .file
        case .note: .note
        case .project: .project
        }
    }

    /// A file has no score; it orders by mtime.
    public var score: Int {
        switch self {
        case .title(let hit): hit.score
        case .message(let hit): hit.score
        case .file: 0
        case .note(let hit): hit.score
        case .project(let hit): hit.score
        }
    }

    public var id: String {
        switch self {
        case .title(let hit): "title:\(hit.environmentId):\(hit.sessionId)"
        case .message(let hit): "message:\(hit.environmentId):\(hit.sessionId):\(hit.isNote ? "notes" : String(hit.seq))"
        case .file(let hit): "file:\(hit.environmentId):\(hit.path):\(hit.line):\(hit.column)"
        case .note(let hit): "note:\(hit.environmentId):\(hit.noteId)"
        case .project(let hit): "project:\(hit.environmentId):\(hit.projectId)"
        }
    }

    /// The path `project:` and the pairs read: a file's or project's path,
    /// else the thread's or note's cwd.
    var path: String? {
        switch self {
        case .title(let hit): hit.cwd
        case .message(let hit): hit.cwd
        case .file(let hit): hit.path
        case .note(let hit): hit.cwd
        case .project(let hit): hit.path
        }
    }
}

/// One host's standing while and after it answers.
public struct HostProgress: Sendable, Hashable {
    public enum State: Sendable, Hashable { case searching, done, skipped, failed }

    public let environmentId: String
    public let name: String
    public var state: State
    /// Milliseconds from the start to the host's last landed source.
    public var elapsedMs: Int
    /// "offline", or the first error's message.
    public var detail: String?

    public init(environmentId: String, name: String, state: State, elapsedMs: Int = 0, detail: String? = nil) {
        self.environmentId = environmentId
        self.name = name
        self.state = state
        self.elapsedMs = elapsedMs
        self.detail = detail
    }
}

public nonisolated enum CrossHostSearch {
    public static let threadLimit = 60
    public static let noteLimit = 20
    public static let projectsPerHost = 8
    private static let week = 7 * 24 * 60 * 60 * 1000

    /// Every path is a pair of one, named after its folder; a pair of one
    /// never folds. For the tests, and for a screen with no workspaces listed.
    public static let noPairs: PairLookup = { _, path in
        PairedPath(pairId: path, pairName: folderName(path), relative: "", copies: 1)
    }

    /// Thread 22's pairs as the fold's lookup (relativeInPair): the deepest
    /// member folder on the host that holds the path wins, `copies` counts
    /// the hosts with the project.
    public static func pairLookup(_ pairs: [ProjectPair]) -> PairLookup {
        { environmentId, path in
            guard let found = ProjectPairs.relative(path, on: environmentId, in: pairs) else { return nil }
            return PairedPath(pairId: found.pair.id, pairName: found.pair.name, relative: found.relative, copies: found.pair.members.count)
        }
    }

    // MARK: run

    /// One search: every open target asked in parallel for the kinds the
    /// query and scope select; a `SearchAnswer` after every landed source,
    /// the last one with every host answered, failed or offline; the stream
    /// ends after it. Ends early when the task iterating it is cancelled
    /// (`onTermination` cancels the fan-out). The first value comes with the
    /// first landed source, so the view keeps its previous answer until
    /// then; with nothing to ask (no host matched, every host offline, or
    /// no source for the asked kinds) one answer comes at once.
    public static func run(
        raw: String,
        scope: SearchScope,
        targets: [SearchTarget],
        pairs: @escaping PairLookup,
        clock: any SocketClock,
        now: @escaping @Sendable () -> Int
    ) -> AsyncStream<SearchAnswer> {
        let (stream, continuation) = AsyncStream.makeStream(of: SearchAnswer.self, bufferingPolicy: .bufferingNewest(1))
        let start = clock.now
        let task = Task {
            await fanOut(raw: raw, scope: scope, targets: targets, pairs: pairs, clock: clock, start: start, now: now) { answer in
                continuation.yield(answer)
            }
            continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
        return stream
    }

    /// What one child task brings back: a source's hits, or its error.
    private struct Landed: Sendable {
        let environmentId: String
        let hits: [SearchHit]
        let truncated: Bool
        let error: String?
    }

    /// A host's bookkeeping while its sources are out.
    private struct HitGroup<Key: Hashable> {
        let key: Key
        var members: [SearchHit]
    }

    private struct ThreadKey: Hashable {
        let environmentId: String
        let sessionId: String
    }

    private struct FileKey: Hashable {
        let environmentId: String
        let projectId: String
    }

    private struct Pending {
        var left: Int
        var answered = 0
        var firstError: String?
        var hits: [SearchHit] = []
        var truncated = false
    }

    private static func fanOut(
        raw: String,
        scope: SearchScope,
        targets: [SearchTarget],
        pairs: @escaping PairLookup,
        clock: any SocketClock,
        start: Double,
        now: @escaping @Sendable () -> Int,
        emit: @Sendable (SearchAnswer) -> Void
    ) async {
        let parsed = ParsedQuery.parse(raw)
        let kinds = parsed.kinds ?? SearchKind.kinds(of: scope)
        let asked = hostsMatching(parsed.host, targets)
        let hostOrder = asked.map(\.id)
        let hostNames = Dictionary(asked.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        var progress: [String: HostProgress] = [:]
        var pending: [String: Pending] = [:]
        var sources: [(String, @Sendable () async throws -> Landed)] = []
        for target in asked {
            guard target.open else {
                progress[target.id] = HostProgress(environmentId: target.id, name: target.name, state: .skipped, detail: "offline")
                continue
            }
            let own = sourcesOf(target, text: parsed.text, kinds: kinds)
            pending[target.id] = Pending(left: own.asks.count, hits: own.local)
            progress[target.id] = HostProgress(environmentId: target.id, name: target.name, state: own.asks.isEmpty ? .done : .searching)
            for ask in own.asks { sources.append((target.id, ask)) }
        }
        let feetOf = { (progress: [String: HostProgress]) -> [SearchHostFoot] in
            feet(hostOrder.compactMap { progress[$0] })
        }
        let answerNow = { (progress: [String: HostProgress], pending: [String: Pending]) -> SearchAnswer in
            let perHost = pending.mapValues(\.hits)
            let merged = merge(perHost, hostOrder: hostOrder, pairs: pairs, kinds: kinds, project: parsed.project, now: now())
            let truncated = pending.values.contains { $0.truncated }
            let list = rows(merged, query: parsed.text, hostNames: hostNames, several: targets.count > 1, truncated: truncated)
            return SearchAnswer(query: raw, scope: scope, rows: list, hosts: feetOf(progress))
        }
        guard !sources.isEmpty else {
            if !Task.isCancelled { emit(answerNow(progress, pending)) }
            return
        }
        await withTaskGroup(of: Landed.self) { group in
            for (environmentId, source) in sources {
                group.addTask {
                    do {
                        return try await source()
                    } catch {
                        return Landed(environmentId: environmentId, hits: [], truncated: false, error: error.localizedDescription)
                    }
                }
            }
            for await landed in group {
                guard !Task.isCancelled else {
                    group.cancelAll()
                    return
                }
                guard var host = pending[landed.environmentId], var standing = progress[landed.environmentId] else { continue }
                host.left -= 1
                if let error = landed.error {
                    if host.firstError == nil { host.firstError = error }
                } else {
                    host.answered += 1
                    host.hits.append(contentsOf: landed.hits)
                    host.truncated = host.truncated || landed.truncated
                }
                standing.elapsedMs = max(0, Int(clock.now - start))
                if host.left == 0 {
                    let failed = host.answered == 0 && host.firstError != nil
                    standing.state = failed ? .failed : .done
                    standing.detail = failed ? host.firstError : nil
                }
                pending[landed.environmentId] = host
                progress[landed.environmentId] = standing
                let answer = answerNow(progress, pending)
                // A batch with nothing to show while another source is still out
                // would blank the list for a moment; the previous answer is the
                // better cue until rows land or every host has answered.
                let settled = progress.values.allSatisfy { $0.state != .searching }
                if !answer.rows.isEmpty || settled { emit(answer) }
            }
        }
    }

    /// The desktop's `sources` closure: the async calls one host is asked
    /// for the kinds, and the hits computed locally with no call (thread
    /// titles, projects and workspaces by name).
    private static func sourcesOf(_ target: SearchTarget, text: String, kinds: Set<SearchKind>) -> (asks: [@Sendable () async throws -> Landed], local: [SearchHit]) {
        var asks: [@Sendable () async throws -> Landed] = []
        var local: [SearchHit] = []
        let environmentId = target.id
        let ask = target.ask
        if kinds.contains(.thread) {
            let sessions = target.sessions
            asks.append {
                try Task.checkCancellation()
                let result = try await ask.threads(text)
                return Landed(environmentId: environmentId, hits: messageHits(environmentId, result.hits, sessions: sessions), truncated: result.truncated, error: nil)
            }
            local.append(contentsOf: titleHits(environmentId, sessions: sessions, text: text))
        }
        if kinds.contains(.note) {
            asks.append {
                try Task.checkCancellation()
                let result = try await ask.notes(text)
                let hits = result.hits.map { hit in
                    SearchHit.note(.init(environmentId: environmentId, noteId: hit.id, title: hit.title, snippet: hit.snippet, updatedAt: hit.updatedAt, cwd: hit.sourceCwd))
                }
                return Landed(environmentId: environmentId, hits: hits, truncated: result.truncated, error: nil)
            }
        }
        if kinds.contains(.file), !target.projects.isEmpty {
            let projects = Array(target.projects.prefix(projectsPerHost))
            asks.append {
                var hits: [SearchHit] = []
                var truncated = false
                var answered = 0
                var firstError: (any Error)?
                for project in projects {
                    // The person typed again: the hosts are spared the greps still to come.
                    try Task.checkCancellation()
                    do {
                        let result = try await ask.files(project.cwd, text)
                        answered += 1
                        truncated = truncated || result.truncated
                        hits.append(contentsOf: result.matches.map { match in
                            SearchHit.file(.init(
                                environmentId: environmentId,
                                projectId: project.id,
                                projectName: project.name,
                                branch: project.branch,
                                worktree: project.mode == .worktree,
                                path: match.path,
                                relative: match.relative,
                                line: match.line,
                                column: match.column,
                                preview: String(match.preview.drop(while: \.isWhitespace)),
                                mtime: match.mtime
                            ))
                        })
                    } catch {
                        if firstError == nil { firstError = error }
                    }
                }
                if answered == 0, let firstError { throw firstError }
                return Landed(environmentId: environmentId, hits: hits, truncated: truncated, error: nil)
            }
        }
        if kinds.contains(.project) {
            local.append(contentsOf: projectHits(target, text: text))
        }
        return (asks, local)
    }

    /// Transcript rows a host found as message hits, titled from its root
    /// sessions; a row of a session the phone does not know is dropped, as
    /// transcriptHits does. A `source: notes` row is the thread's notes.
    static func messageHits(_ environmentId: String, _ hits: [SessionSearchHit], sessions: [SessionMeta]) -> [SearchHit] {
        let byId = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return hits.compactMap { hit in
            guard let session = byId[hit.sessionId] else { return nil }
            return .message(.init(
                environmentId: environmentId,
                sessionId: hit.sessionId,
                title: session.title,
                type: session.threadType,
                cwd: session.cwd,
                updatedAt: session.updatedAt,
                seq: hit.seq,
                snippet: hit.snippet,
                ts: hit.ts,
                rank: hit.rank,
                isNote: hit.source == .notes
            ))
        }
    }

    /// The phone's stand-in for the desktop's fuzzy title match: a root
    /// session whose title holds every word of the text, case and
    /// diacritic insensitive.
    static func titleHits(_ environmentId: String, sessions: [SessionMeta], text: String) -> [SearchHit] {
        let terms = MatchRanges.terms(of: text)
        guard !terms.isEmpty else { return [] }
        return sessions.compactMap { session in
            guard session.parentId == nil, !session.title.isEmpty,
                  terms.allSatisfy({ !MatchRanges.ranges(in: session.title, query: $0).isEmpty })
            else { return nil }
            return .title(.init(environmentId: environmentId, sessionId: session.id, title: session.title, type: session.threadType, cwd: session.cwd, updatedAt: session.updatedAt))
        }
    }

    /// A project whose name holds the text (80) or whose cwd does (40), and
    /// each workspace likewise; nothing under two characters.
    static func projectHits(_ target: SearchTarget, text: String) -> [SearchHit] {
        guard text.count >= 2 else { return [] }
        let needle = text.lowercased()
        var out: [SearchHit] = []
        for project in target.projects {
            let score = project.name.lowercased().contains(needle) ? 80 : project.cwd.lowercased().contains(needle) ? 40 : 0
            guard score > 0 else { continue }
            out.append(.project(.init(environmentId: target.id, projectId: project.id, name: project.name, branch: project.branch, worktree: project.mode == .worktree, path: project.cwd, score: score)))
        }
        for workspace in target.workspaces {
            let score = workspace.name.lowercased().contains(needle) ? 80 : workspace.path.lowercased().contains(needle) ? 40 : 0
            guard score > 0 else { continue }
            out.append(.project(.init(environmentId: target.id, projectId: "ws:\(workspace.id)", name: workspace.name, branch: nil, worktree: false, path: workspace.path, score: score)))
        }
        return out
    }

    // MARK: the pure steps

    /// Mirrors hostsMatching: no token → every target; else a target whose
    /// lowercased name contains the token or whose id equals it, or the
    /// macOS host when the token is `mac`.
    public static func hostsMatching(_ token: String?, _ targets: [SearchTarget]) -> [SearchTarget] {
        guard let token, !token.isEmpty else { return targets }
        let needle = token.lowercased()
        return targets.filter { target in
            target.name.lowercased().contains(needle) || target.id.lowercased() == needle || (needle == "mac" && target.isMac)
        }
    }

    /// Mirrors matchesProject: the folder name of the hit's path or cwd,
    /// the pair's name when the pairs know the path, a file's project name
    /// and a project row's own name; true when any holds the token.
    public static func matchesProject(_ hit: SearchHit, token: String?, pairs: PairLookup) -> Bool {
        guard let token, !token.isEmpty else { return true }
        let needle = token.lowercased()
        var names: [String] = []
        if let path = hit.path, !path.isEmpty {
            names.append(folderName(path).lowercased())
            if let paired = pairs(hit.environmentId, path) { names.append(paired.pairName.lowercased()) }
        }
        switch hit {
        case .file(let file): names.append(file.projectName.lowercased())
        case .project(let project): names.append(project.name.lowercased())
        default: break
        }
        return names.contains { $0.contains(needle) }
    }

    /// Mirrors recencyBonus: 24 for now or the future, falling to 0 over a week.
    public static func recencyBonus(updatedAt: Int, now: Int) -> Int {
        guard updatedAt > 0 else { return 0 }
        let age = now - updatedAt
        if age <= 0 { return 24 }
        return max(0, Int((24 * (1 - Double(min(age, week)) / Double(week))).rounded()))
    }

    /// Mirrors scoreMessages, noteHits and searchConversationTitles: a
    /// message by its match quality against the best bm25 rank in the list
    /// (0.5 without a rank) and recency, a title 20 and recency, a note 12
    /// and recency. Nothing reads the host.
    public static func score(_ hits: [SearchHit], now: Int) -> [SearchHit] {
        var best = 0.0
        for case .message(let hit) in hits {
            if let rank = hit.rank, rank < best { best = rank }
        }
        return hits.map { hit in
            switch hit {
            case .message(var message):
                let quality: Double = if let rank = message.rank, best < 0 { min(1, rank / best) } else { 0.5 }
                message.score = 16 + Int((quality * 8).rounded()) + recencyBonus(updatedAt: message.updatedAt, now: now)
                return .message(message)
            case .title(var title):
                title.score = 20 + recencyBonus(updatedAt: title.updatedAt, now: now)
                return .title(title)
            case .note(var note):
                note.score = 12 + recencyBonus(updatedAt: note.updatedAt, now: now)
                return .note(note)
            case .file, .project:
                return hit
            }
        }
    }

    /// Mirrors dedupePairedFiles: the same line of the same relative path in
    /// two or more copies of a paired project is one row, the copy with the
    /// greatest mtime (none counts as −1), ties to the earliest host in
    /// `hostOrder`; `newer` when any two copies differed; `alsoOn` the other
    /// copies' hosts in `hostOrder`; the winner takes the first copy's place.
    public static func foldPairedFiles(_ hits: [SearchHit], pairs: PairLookup, hostOrder: [String]) -> [SearchHit] {
        let order = hostIndex(hostOrder)
        var keys: [Int: String] = [:]
        var groups: [String: [Int]] = [:]
        for (index, hit) in hits.enumerated() {
            guard case .file(let file) = hit, let paired = pairs(file.environmentId, file.path), paired.copies >= 2 else { continue }
            let key = "\(paired.pairId):\(paired.relative):\(file.line):\(file.column)"
            keys[index] = key
            groups[key, default: []].append(index)
        }
        var winners: [String: SearchHit.File] = [:]
        for (key, members) in groups where members.count > 1 {
            var copies = members.compactMap { index -> SearchHit.File? in
                if case .file(let file) = hits[index] { file } else { nil }
            }
            copies.sort { a, b in
                let am = a.mtime ?? -1, bm = b.mtime ?? -1
                if am != bm { return am > bm }
                return order(a.environmentId) < order(b.environmentId)
            }
            var winner = copies[0]
            winner.newer = Set(copies.map { $0.mtime ?? -1 }).count > 1
            winner.alsoOn = copies.dropFirst().map(\.environmentId).sorted { order($0) < order($1) }
            winners[key] = winner
        }
        var out: [SearchHit] = []
        var emitted: Set<String> = []
        for (index, hit) in hits.enumerated() {
            guard let key = keys[index], let winner = winners[key] else {
                out.append(hit)
                continue
            }
            if emitted.insert(key).inserted { out.append(.file(winner)) }
        }
        return out
    }

    /// Mirrors mergeCrossHost: every host's hits in `hostOrder`, scored,
    /// duplicates by id folded (mergeHits: the higher score wins, a project
    /// and a workspace at one path are one row), folded, the `type:` and `project:` filters applied, then ordered
    /// totally so a re-merge of the same input never reorders equal rows.
    public static func merge(_ perHost: [String: [SearchHit]], hostOrder: [String], pairs: PairLookup, kinds: Set<SearchKind>, project: String?, now: Int) -> [SearchHit] {
        let order = hostIndex(hostOrder)
        var hits: [SearchHit] = []
        for id in perHost.keys.sorted(by: { order($0) < order($1) || (order($0) == order($1) && $0 < $1) }) {
            hits.append(contentsOf: perHost[id] ?? [])
        }
        hits = dedupe(score(hits, now: now))
        hits = foldPairedFiles(hits, pairs: pairs, hostOrder: hostOrder)
        hits = hits.filter { kinds.contains($0.kind) }
        if let project { hits = hits.filter { matchesProject($0, token: project, pairs: pairs) } }
        return ordered(hits, hostOrder: hostOrder)
    }

    /// Mirrors mergeHits: one hit per id, the higher score kept, in first
    /// appearance order; a project row is keyed by its path, so a workspace
    /// and a project at the same folder are one row.
    static func dedupe(_ hits: [SearchHit]) -> [SearchHit] {
        var index: [String: Int] = [:]
        var out: [SearchHit] = []
        for hit in hits {
            let key = if case .project(let project) = hit { "project:\(project.environmentId):\(project.path)" } else { hit.id }
            if let at = index[key] {
                if hit.score > out[at].score { out[at] = hit }
            } else {
                index[key] = out.count
                out.append(hit)
            }
        }
        return out
    }

    /// Thread groups by best score, recency, host order and session id, a
    /// title first then messages by score and seq; then notes; then file
    /// groups by newest mtime, project name and host, lines by mtime,
    /// relative path and line; then projects by score, name and host.
    static func ordered(_ hits: [SearchHit], hostOrder: [String]) -> [SearchHit] {
        let order = hostIndex(hostOrder)
        var threads = grouped(hits) { hit -> ThreadKey? in
            switch hit {
            case .title(let title): ThreadKey(environmentId: title.environmentId, sessionId: title.sessionId)
            case .message(let message): ThreadKey(environmentId: message.environmentId, sessionId: message.sessionId)
            default: nil
            }
        }
        for at in threads.indices {
            threads[at].members.sort { a, b in
                switch (a, b) {
                case (.title, .message): return true
                case (.message, .title): return false
                case (.message(let x), .message(let y)):
                    if x.score != y.score { return x.score > y.score }
                    return x.seq < y.seq
                default: return false
                }
            }
        }
        func updatedAt(_ hit: SearchHit) -> Int {
            switch hit {
            case .title(let hit): hit.updatedAt
            case .message(let hit): hit.updatedAt
            case .note(let hit): hit.updatedAt
            default: 0
            }
        }
        threads.sort { a, b in
            let ascore = a.members.map(\.score).max() ?? 0, bscore = b.members.map(\.score).max() ?? 0
            if ascore != bscore { return ascore > bscore }
            let atime = a.members.map(updatedAt).max() ?? 0, btime = b.members.map(updatedAt).max() ?? 0
            if atime != btime { return atime > btime }
            if order(a.key.environmentId) != order(b.key.environmentId) { return order(a.key.environmentId) < order(b.key.environmentId) }
            return a.key.sessionId < b.key.sessionId
        }
        var notes: [SearchHit.Note] = []
        for case .note(let note) in hits { notes.append(note) }
        notes.sort { a, b in
            if a.score != b.score { return a.score > b.score }
            if a.updatedAt != b.updatedAt { return a.updatedAt > b.updatedAt }
            if order(a.environmentId) != order(b.environmentId) { return order(a.environmentId) < order(b.environmentId) }
            return a.noteId < b.noteId
        }
        var files = grouped(hits) { hit -> FileKey? in
            if case .file(let file) = hit { FileKey(environmentId: file.environmentId, projectId: file.projectId) } else { nil }
        }
        func mtime(_ hit: SearchHit) -> Int {
            if case .file(let file) = hit { file.mtime ?? -1 } else { -1 }
        }
        for at in files.indices {
            files[at].members.sort { a, b in
                guard case .file(let x) = a, case .file(let y) = b else { return false }
                if mtime(a) != mtime(b) { return mtime(a) > mtime(b) }
                if x.relative != y.relative { return x.relative < y.relative }
                return x.line < y.line
            }
        }
        func projectName(_ group: HitGroup<FileKey>) -> String {
            if case .file(let file) = group.members[0] { file.projectName } else { "" }
        }
        files.sort { a, b in
            let anewest = a.members.map(mtime).max() ?? -1, bnewest = b.members.map(mtime).max() ?? -1
            if anewest != bnewest { return anewest > bnewest }
            if projectName(a) != projectName(b) { return projectName(a) < projectName(b) }
            if order(a.key.environmentId) != order(b.key.environmentId) { return order(a.key.environmentId) < order(b.key.environmentId) }
            return a.key.projectId < b.key.projectId
        }
        var projects: [SearchHit.Project] = []
        for case .project(let project) in hits { projects.append(project) }
        projects.sort { a, b in
            if a.score != b.score { return a.score > b.score }
            if a.name != b.name { return a.name < b.name }
            if order(a.environmentId) != order(b.environmentId) { return order(a.environmentId) < order(b.environmentId) }
            return a.projectId < b.projectId
        }
        return threads.flatMap(\.members) + notes.map(SearchHit.note) + files.flatMap(\.members) + projects.map(SearchHit.project)
    }

    /// The map onto thread 4's rows: a thread group is a head then one hit
    /// per message (a title-only group is a head alone); a note is a note
    /// row; a file group is a project head then up to
    /// `SearchRows.filesPerProject` file rows with the other hosts' names;
    /// a project a project row; `.more` last when any host truncated or a
    /// file group was cut. Heads carry the host name only with several
    /// targets. Expects `merge`'s order.
    public static func rows(_ hits: [SearchHit], query: String, hostNames: [String: String], several: Bool, truncated: Bool) -> [SearchRow] {
        func host(_ environmentId: String) -> String? { several ? (hostNames[environmentId] ?? environmentId) : nil }
        func name(_ environmentId: String) -> String { hostNames[environmentId] ?? environmentId }
        var out: [SearchRow] = []
        var more = truncated
        var lastThread: ThreadKey?
        var lastProject: FileKey?
        var filesInProject = 0
        for hit in hits {
            switch hit {
            case .title(let title):
                let key = ThreadKey(environmentId: title.environmentId, sessionId: title.sessionId)
                if lastThread != key {
                    out.append(.threadHead(.init(environmentId: title.environmentId, sessionId: title.sessionId, title: title.title, type: title.type, host: host(title.environmentId))))
                    lastThread = key
                }
            case .message(let message):
                let key = ThreadKey(environmentId: message.environmentId, sessionId: message.sessionId)
                if lastThread != key {
                    out.append(.threadHead(.init(environmentId: message.environmentId, sessionId: message.sessionId, title: message.title, type: message.type, host: host(message.environmentId))))
                    lastThread = key
                }
                out.append(.hit(.init(
                    environmentId: message.environmentId,
                    sessionId: message.sessionId,
                    seq: message.isNote ? nil : message.seq,
                    snippet: message.snippet,
                    matches: MatchRanges.ranges(in: message.snippet, query: query),
                    ts: message.ts,
                    isNote: message.isNote
                )))
            case .note(let note):
                out.append(.note(.init(
                    environmentId: note.environmentId,
                    noteId: note.noteId,
                    title: note.title,
                    snippet: note.snippet,
                    matches: MatchRanges.ranges(in: note.snippet, query: query),
                    updatedAt: note.updatedAt,
                    host: host(note.environmentId)
                )))
            case .file(let file):
                let key = FileKey(environmentId: file.environmentId, projectId: file.projectId)
                if lastProject != key {
                    out.append(.projectHead(.init(environmentId: file.environmentId, projectId: file.projectId, name: file.projectName, branch: file.branch, worktree: file.worktree, host: host(file.environmentId))))
                    lastProject = key
                    filesInProject = 0
                }
                filesInProject += 1
                if filesInProject > SearchRows.filesPerProject {
                    more = true
                    continue
                }
                out.append(.file(.init(
                    environmentId: file.environmentId,
                    path: file.path,
                    relative: file.relative,
                    line: file.line,
                    column: file.column,
                    preview: file.preview,
                    matches: MatchRanges.ranges(in: file.preview, query: query),
                    alsoOn: file.alsoOn.map(name),
                    newer: file.newer
                )))
            case .project(let project):
                out.append(.project(.init(
                    environmentId: project.environmentId,
                    projectId: project.projectId,
                    name: project.name,
                    branch: project.branch,
                    worktree: project.worktree,
                    host: host(project.environmentId),
                    matches: MatchRanges.ranges(in: project.name, query: query)
                )))
            }
        }
        if more { out.append(.more) }
        return out
    }

    /// One foot per host in the order given: `.searching` while asked and
    /// not done, `.answered` when done (never under 1 ms, as the desktop's
    /// formatSeconds), `.offline` when skipped, `.failed`.
    public static func feet(_ progress: [HostProgress]) -> [SearchHostFoot] {
        progress.map { row in
            let state: SearchHostFoot.State = switch row.state {
            case .searching: .searching(ms: row.elapsedMs)
            case .done: .answered(ms: max(1, row.elapsedMs))
            case .skipped: .offline
            case .failed: .failed
            }
            return SearchHostFoot(environmentId: row.environmentId, name: row.name, state: state)
        }
    }

    // MARK: helpers

    /// Mirrors projectName: the last path component.
    static func folderName(_ path: String) -> String {
        let trimmed = path.split(separator: "/", omittingEmptySubsequences: true)
        return trimmed.last.map(String.init) ?? path
    }

    /// Hits sharing a key, in first-appearance order of the keys.
    private static func grouped<Key: Hashable>(_ hits: [SearchHit], by key: (SearchHit) -> Key?) -> [HitGroup<Key>] {
        var groups: [HitGroup<Key>] = []
        var index: [Key: Int] = [:]
        for hit in hits {
            guard let key = key(hit) else { continue }
            if let at = index[key] {
                groups[at].members.append(hit)
            } else {
                index[key] = groups.count
                groups.append(HitGroup(key: key, members: [hit]))
            }
        }
        return groups
    }

    /// A host's rank in rail order; one the order does not name sorts last.
    private static func hostIndex(_ hostOrder: [String]) -> (String) -> Int {
        let index = Dictionary(hostOrder.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        return { index[$0] ?? Int.max }
    }
}
