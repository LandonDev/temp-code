import Foundation
import TempCodeContract

/// The Search tab's pure side: the flat row model the screen draws, the
/// builder that shapes every host's raw answer into it, the match-range
/// arithmetic the rows set in weight, the debounce rule and the foot line.
/// No SwiftUI, every type `Sendable`, so the Swift Testing suites cover
/// it and the view stays a thin draw.
///
/// `CrossHostSearch` (merge, rank, fold, typed filters) maps its output onto
/// `SearchRow` and the view draws it; `SearchRows.build` is the single-host
/// shaping it grew from, kept with its suite.

/// What the field searches: threads by what was said in them, or lines of
/// a project's files. Files are offered only where an open host has a project.
public enum SearchScope: String, CaseIterable, Sendable {
    case threads
    case files
}

/// One row of the list, flat, in draw order. Ids are stable across answers
/// so an unchanged row keeps its identity and nothing re-enters.
public enum SearchRow: Identifiable, Sendable, Hashable {
    /// The thread a group of hits belongs to; opens the thread.
    case threadHead(ThreadHead)
    /// One matching row of the thread above it; opens the thread at that row.
    case hit(Hit)
    /// The project a group of file lines belongs to.
    case projectHead(ProjectHead)
    /// One matching line of a project file. A fact: the phone has no viewer.
    case file(FileHit)
    /// A project matched by name; the selector supplies these.
    case project(ProjectHit)
    /// One of the app's notes (`notes.search`). A fact: the phone has no note viewer.
    case note(NoteHit)
    /// A host cut its answer short, once per answer.
    case more

    public var id: String {
        switch self {
        case .threadHead(let head): "thread:\(head.environmentId):\(head.sessionId)"
        case .hit(let hit):
            hit.isNote
                ? "note:\(hit.environmentId):\(hit.sessionId)"
                : "hit:\(hit.environmentId):\(hit.sessionId):\(hit.seq ?? 0)"
        case .projectHead(let head): "phead:\(head.environmentId):\(head.projectId)"
        case .file(let file): "file:\(file.environmentId):\(file.path):\(file.line):\(file.column)"
        case .project(let project): "project:\(project.environmentId):\(project.projectId)"
        case .note(let note): "appnote:\(note.environmentId):\(note.noteId)"
        case .more: "more"
        }
    }

    public struct ThreadHead: Sendable, Hashable {
        public let environmentId: String
        public let sessionId: String
        public let title: String
        public let type: ThreadType?
        /// The host's name, only when several hosts are paired.
        public let host: String?

        public init(environmentId: String, sessionId: String, title: String, type: ThreadType?, host: String?) {
            self.environmentId = environmentId
            self.sessionId = sessionId
            self.title = title
            self.type = type
            self.host = host
        }
    }

    public struct Hit: Sendable, Hashable {
        public let environmentId: String
        public let sessionId: String
        /// nil for a note hit (seq 0 on the wire): the thread opens at its end.
        public let seq: Int?
        public let snippet: String
        /// The runs of `snippet` the query matched, as character offsets, for the view to set in weight.
        public let matches: [Range<Int>]
        public let ts: Int
        /// The hit is in the thread's working notes, not its transcript.
        public let isNote: Bool

        public init(environmentId: String, sessionId: String, seq: Int?, snippet: String, matches: [Range<Int>], ts: Int, isNote: Bool) {
            self.environmentId = environmentId
            self.sessionId = sessionId
            self.seq = seq
            self.snippet = snippet
            self.matches = matches
            self.ts = ts
            self.isNote = isNote
        }
    }

    public struct ProjectHead: Sendable, Hashable {
        public let environmentId: String
        public let projectId: String
        public let name: String
        public let branch: String?
        public let worktree: Bool
        public let host: String?

        public init(environmentId: String, projectId: String, name: String, branch: String?, worktree: Bool, host: String?) {
            self.environmentId = environmentId
            self.projectId = projectId
            self.name = name
            self.branch = branch
            self.worktree = worktree
            self.host = host
        }
    }

    public struct FileHit: Sendable, Hashable {
        public let environmentId: String
        public let path: String
        public let relative: String
        public let line: Int
        public let column: Int
        /// The line, leading whitespace trimmed; `matches` index into this text.
        public let preview: String
        public let matches: [Range<Int>]
        /// The names of the other hosts whose copy of a paired project holds
        /// this same line; the cross-host fold fills it.
        public var alsoOn: [String] = []
        /// This copy won the fold by its later mtime.
        public var newer = false

        public init(environmentId: String, path: String, relative: String, line: Int, column: Int, preview: String, matches: [Range<Int>], alsoOn: [String] = [], newer: Bool = false) {
            self.environmentId = environmentId
            self.path = path
            self.relative = relative
            self.line = line
            self.column = column
            self.preview = preview
            self.matches = matches
            self.alsoOn = alsoOn
            self.newer = newer
        }
    }

    public struct NoteHit: Sendable, Hashable {
        public let environmentId: String
        public let noteId: String
        public let title: String
        public let snippet: String
        /// The runs of `snippet` the query matched.
        public let matches: [Range<Int>]
        public let updatedAt: Int
        /// The host's name, only when several hosts are paired.
        public let host: String?

        public init(environmentId: String, noteId: String, title: String, snippet: String, matches: [Range<Int>], updatedAt: Int, host: String?) {
            self.environmentId = environmentId
            self.noteId = noteId
            self.title = title
            self.snippet = snippet
            self.matches = matches
            self.updatedAt = updatedAt
            self.host = host
        }
    }

    public struct ProjectHit: Sendable, Hashable {
        public let environmentId: String
        public let projectId: String
        public let name: String
        public let branch: String?
        public let worktree: Bool
        public let host: String?
        /// The runs of `name` the query matched.
        public let matches: [Range<Int>]

        public init(environmentId: String, projectId: String, name: String, branch: String?, worktree: Bool, host: String?, matches: [Range<Int>]) {
            self.environmentId = environmentId
            self.projectId = projectId
            self.name = name
            self.branch = branch
            self.worktree = worktree
            self.host = host
            self.matches = matches
        }
    }
}

/// One host's standing after a search, for the foot line.
public struct SearchHostFoot: Sendable, Hashable {
    public enum State: Sendable, Hashable {
        /// Asked and not yet done; `ms` is the time so far.
        case searching(ms: Int)
        case answered(ms: Int)
        case offline
        case failed
    }

    public let environmentId: String
    public let name: String
    public let state: State

    public init(environmentId: String, name: String, state: State) {
        self.environmentId = environmentId
        self.name = name
        self.state = state
    }
}

/// What the list shows: every host's answer to one query in one scope. The
/// next answer replaces it whole; nothing clears it first, so the screen
/// never flashes to empty between two queries.
public struct SearchAnswer: Sendable, Equatable {
    public var query = ""
    public var scope = SearchScope.threads
    public var rows: [SearchRow] = []
    public var hosts: [SearchHostFoot] = []

    public init(query: String = "", scope: SearchScope = .threads, rows: [SearchRow] = [], hosts: [SearchHostFoot] = []) {
        self.query = query
        self.scope = scope
        self.rows = rows
        self.hosts = hosts
    }

    public var isEmpty: Bool { rows.isEmpty }

    public static let none = SearchAnswer()
}

/// A paired host as the builder sees it: rail order, and whether it was open
/// (and so asked) for this query.
public struct SearchHost: Sendable, Hashable {
    public let id: String
    public let name: String
    public let open: Bool

    public init(id: String, name: String, open: Bool) {
        self.id = id
        self.name = name
        self.open = open
    }
}

/// One host's raw answer, as the view collected it.
public struct SearchHostAnswer: Sendable {
    /// One project's file matches, in the Files scope.
    public struct ProjectFiles: Sendable {
        public let project: ProjectMeta
        public let result: ProjectSearchResult

        public init(project: ProjectMeta, result: ProjectSearchResult) {
            self.project = project
            self.result = result
        }
    }

    public let environmentId: String
    public let name: String
    /// The host's sessions, for titles and types.
    public let sessions: [SessionMeta]
    /// The Threads scope's answer.
    public let threads: SessionSearchResult?
    /// The Files scope's answers, one per project asked.
    public let files: [ProjectFiles]
    public let elapsedMs: Int
    /// Every call threw.
    public let failed: Bool

    public init(environmentId: String, name: String, sessions: [SessionMeta], threads: SessionSearchResult? = nil, files: [ProjectFiles] = [], elapsedMs: Int, failed: Bool) {
        self.environmentId = environmentId
        self.name = name
        self.sessions = sessions
        self.threads = threads
        self.files = files
        self.elapsedMs = elapsedMs
        self.failed = failed
    }
}

public nonisolated enum SearchRows {
    /// At most this many file rows per project.
    public static let filesPerProject = 40

    /// The one call the view makes: every host's raw answer becomes the flat
    /// list. `hosts` is every paired host in rail order, open or not;
    /// `answers` is one per host that was asked (an open host with none is
    /// `failed` in the foot, a closed one `offline`). Hosts keep rail order;
    /// a host's hits keep the order it ranked them in. This body is the slot
    /// for the cross-host selector.
    public static func build(query: String, scope: SearchScope, hosts: [SearchHost], answers: [SearchHostAnswer]) -> SearchAnswer {
        let several = hosts.count > 1
        let byHost = Dictionary(answers.map { ($0.environmentId, $0) }, uniquingKeysWith: { first, _ in first })
        var rows: [SearchRow] = []
        var more = false
        for host in hosts {
            guard let answer = byHost[host.id] else { continue }
            let hostName = several ? host.name : nil
            switch scope {
            case .threads:
                guard let result = answer.threads else { continue }
                for group in ThreadHits.group(environmentId: host.id, hits: result.hits, sessions: answer.sessions) {
                    rows.append(.threadHead(.init(environmentId: host.id, sessionId: group.sessionId, title: group.title, type: group.type, host: hostName)))
                    for hit in group.hits {
                        let isNote = hit.source == .notes
                        rows.append(.hit(.init(
                            environmentId: host.id,
                            sessionId: hit.sessionId,
                            seq: isNote ? nil : hit.seq,
                            snippet: hit.snippet,
                            matches: MatchRanges.ranges(in: hit.snippet, query: query),
                            ts: hit.ts,
                            isNote: isNote
                        )))
                    }
                }
                more = more || result.truncated
            case .files:
                for files in answer.files where !files.result.matches.isEmpty {
                    let project = files.project
                    rows.append(.projectHead(.init(environmentId: host.id, projectId: project.id, name: project.name, branch: project.branch, worktree: project.mode == .worktree, host: hostName)))
                    for match in files.result.matches.prefix(filesPerProject) {
                        let preview = String(match.preview.drop(while: \.isWhitespace))
                        rows.append(.file(.init(
                            environmentId: host.id,
                            path: match.path,
                            relative: match.relative,
                            line: match.line,
                            column: match.column,
                            preview: preview,
                            matches: MatchRanges.ranges(in: preview, query: query)
                        )))
                    }
                    more = more || files.result.truncated || files.result.matches.count > filesPerProject
                }
            }
        }
        if more { rows.append(.more) }
        let feet = hosts.map { host -> SearchHostFoot in
            let state: SearchHostFoot.State =
                if let answer = byHost[host.id] { answer.failed ? .failed : .answered(ms: answer.elapsedMs) }
                else if host.open { .failed }
                else { .offline }
            return SearchHostFoot(environmentId: host.id, name: host.name, state: state)
        }
        return SearchAnswer(query: query, scope: scope, rows: rows, hosts: feet)
    }

    /// "Mac 320 ms · box 1.2 s", "box …" while a host is still answering,
    /// "box offline", "box failed"; nil with one host.
    public static func footLine(_ hosts: [SearchHostFoot]) -> String? {
        guard hosts.count > 1 else { return nil }
        return hosts.map { host in
            switch host.state {
            case .searching: "\(host.name) …"
            case .answered(let ms): "\(host.name) \(duration(ms: ms))"
            case .offline: "\(host.name) offline"
            case .failed: "\(host.name) failed"
            }
        }.joined(separator: " · ")
    }

    /// "320 ms" under a second, else "1.2 s" with one decimal.
    public static func duration(ms: Int) -> String {
        if ms < 1000 { return "\(ms) ms" }
        let seconds = (Double(ms) / 100).rounded() / 10
        return String(format: "%.1f s", seconds)
    }
}

/// Where the query's words fall in a text, for the rows to set in weight.
public nonisolated enum MatchRanges {
    /// The query's words, longest first, so a longer term claims its run
    /// before a shorter one inside it; duplicates collapse.
    public static func terms(of query: String) -> [String] {
        var seen: Set<String> = []
        return query.split(whereSeparator: \.isWhitespace)
            .map(String.init)
            .filter { seen.insert($0).inserted }
            .sorted { $0.count > $1.count }
    }

    /// Every run of `text` a term matches, case and diacritic insensitive, as
    /// character offsets, sorted, non-overlapping: a run a longer term claimed
    /// is never claimed again by a shorter one inside it.
    public static func ranges(in text: String, query: String) -> [Range<Int>] {
        var claimed: [Range<String.Index>] = []
        for term in terms(of: query) {
            var from = text.startIndex
            while from < text.endIndex,
                  let found = text.range(of: term, options: [.caseInsensitive, .diacriticInsensitive], range: from..<text.endIndex) {
                if !found.isEmpty, !claimed.contains(where: { $0.overlaps(found) }) {
                    claimed.append(found)
                }
                from = found.isEmpty ? text.index(after: found.lowerBound) : found.upperBound
            }
        }
        return claimed
            .map { text.distance(from: text.startIndex, to: $0.lowerBound)..<text.distance(from: text.startIndex, to: $0.upperBound) }
            .sorted { $0.lowerBound < $1.lowerBound }
    }
}

/// When a query runs: a new text waits for the typing to pause; a scope
/// change or the same text runs at once; under two characters nothing is asked.
public nonisolated enum SearchDebounce {
    public static let typing: Duration = .milliseconds(250)
    public static let minimumLength = 2

    public static func delay(previousQuery: String, nextQuery: String) -> Duration {
        previousQuery == nextQuery ? .zero : typing
    }
}
