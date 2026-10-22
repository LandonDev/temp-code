import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The phone's cross-host search, case by case against the desktop's
/// crossHostSearch.test.ts: the parser, the host and project matchers, the
/// fold, the scoring, the merge order, the rows, the streaming fan-out on
/// a manual clock, and the feet.

private let week = 7 * 24 * 60 * 60 * 1000
private let now = 1_700_000_000_000

// MARK: fixtures

/// `local:/Users/me/app` and `box:/work/app` paired as `app`; `local:/Users/me/solo` a pair of one.
private let pairs: PairLookup = { environmentId, path in
    let table: [(env: String, cwd: String, id: String, name: String, copies: Int)] = [
        ("local", "/Users/me/app", "app", "app", 2),
        ("box", "/work/app", "app", "app", 2),
        ("local", "/Users/me/solo", "solo", "solo", 1)
    ]
    for member in table where member.env == environmentId {
        if path == member.cwd {
            return PairedPath(pairId: member.id, pairName: member.name, relative: "", copies: member.copies)
        }
        if path.hasPrefix(member.cwd + "/") {
            return PairedPath(pairId: member.id, pairName: member.name, relative: String(path.dropFirst(member.cwd.count + 1)), copies: member.copies)
        }
    }
    return nil
}

private func session(_ id: String, title: String, type: ThreadType? = .chat, cwd: String = "/repo", updatedAt: Int = now, parentId: String? = nil) -> SessionMeta {
    SessionMeta(id: id, parentId: parentId, projectId: nil, workspaceId: nil, threadType: type, planPath: nil, provider: .claude, model: "claude-sonnet-5-5", reasoning: .low, agentType: .implementer, title: title, cwd: cwd, status: .idle, pinned: false, archived: false, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, tasks: nil, context: nil, createdAt: 1, updatedAt: updatedAt)
}

private func project(_ id: String, name: String, cwd: String, branch: String? = nil, mode: ProjectMode = .local) -> ProjectMeta {
    ProjectMeta(id: id, workspaceId: "w", name: name, mode: mode, branch: branch, cwd: cwd, archived: false, createdAt: 1)
}

private func workspace(_ id: String, name: String, path: String, link: String? = nil) -> WorkspaceMeta {
    WorkspaceMeta(id: id, name: name, path: path, git: true, linkId: link, createdAt: 1)
}

private struct Boom: Error, LocalizedError {
    let text: String
    var errorDescription: String? { text }
}

private let silent = SearchAsk(
    threads: { _ in SessionSearchResult(hits: [], truncated: false) },
    files: { _, _ in ProjectSearchResult(matches: [], truncated: false) },
    notes: { _ in NoteSearchResult(hits: [], truncated: false) }
)

private func target(_ id: String, name: String? = nil, open: Bool = true, isMac: Bool = false, sessions: [SessionMeta] = [], projects: [ProjectMeta] = [], workspaces: [WorkspaceMeta] = [], ask: SearchAsk = silent) -> SearchTarget {
    SearchTarget(id: id, name: name ?? id, open: open, isMac: isMac, sessions: sessions, projects: projects, workspaces: workspaces, ask: ask)
}

private func message(_ env: String, _ sessionId: String, seq: Int, snippet: String = "say hello", rank: Double? = nil, updatedAt: Int = now, title: String = "T", cwd: String = "/repo", isNote: Bool = false, score: Int = 0) -> SearchHit {
    .message(.init(environmentId: env, sessionId: sessionId, title: title, type: .chat, cwd: cwd, updatedAt: updatedAt, seq: seq, snippet: snippet, ts: 1, rank: rank, isNote: isNote, score: score))
}

private func title(_ env: String, _ sessionId: String, title: String = "Hello thread", cwd: String = "/repo", updatedAt: Int = now) -> SearchHit {
    .title(.init(environmentId: env, sessionId: sessionId, title: title, type: .planning, cwd: cwd, updatedAt: updatedAt))
}

private func file(_ env: String, _ path: String, relative: String, line: Int = 3, column: Int = 1, mtime: Int? = nil, projectId: String = "p", projectName: String = "app", preview: String = "hello there") -> SearchHit {
    .file(.init(environmentId: env, projectId: projectId, projectName: projectName, branch: nil, worktree: false, path: path, relative: relative, line: line, column: column, preview: preview, mtime: mtime))
}

private func note(_ env: String, _ id: String, title: String = "Note", snippet: String = "hello note", updatedAt: Int = now, cwd: String? = nil) -> SearchHit {
    .note(.init(environmentId: env, noteId: id, title: title, snippet: snippet, updatedAt: updatedAt, cwd: cwd))
}

private func projectHit(_ env: String, _ id: String, name: String, path: String, score: Int = 80) -> SearchHit {
    .project(.init(environmentId: env, projectId: id, name: name, branch: nil, worktree: false, path: path, score: score))
}

private func files(_ hits: [SearchHit]) -> [SearchHit.File] {
    hits.compactMap { if case .file(let file) = $0 { file } else { nil } }
}

/// Answers the search's calls when the test says so: a call waits for its
/// key, and a key resumed first is handed to the next call for it.
private actor Gate<Value: Sendable> {
    private var waiting: [String: CheckedContinuation<Value, any Error>] = [:]
    /// Results resumed before their call arrived, in order per key.
    private var ready: [String: [Result<Value, any Error>]] = [:]

    func wait(_ key: String) async throws -> Value {
        if var queue = ready[key], !queue.isEmpty {
            let result = queue.removeFirst()
            ready[key] = queue
            return try result.get()
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { waiting[key] = $0 }
        } onCancel: {
            Task { await self.cancel(key) }
        }
    }

    func resume(_ key: String, _ result: Result<Value, any Error>) {
        if let continuation = waiting.removeValue(forKey: key) {
            continuation.resume(with: result)
        } else {
            ready[key, default: []].append(result)
        }
    }

    private var cancelled: [String] = []

    private func cancel(_ key: String) {
        waiting.removeValue(forKey: key)?.resume(throwing: CancellationError())
        cancelled.append(key)
    }

    /// The keys whose waiting call was cancelled, once the handler had `ms` to run.
    func cancelledKeys(after ms: Int) async -> [String] {
        for _ in 0..<ms where cancelled.isEmpty {
            try? await Task.sleep(for: .milliseconds(1))
        }
        return cancelled
    }
}

private func feet(_ answer: SearchAnswer) -> [String: SearchHostFoot.State] {
    Dictionary(answer.hosts.map { ($0.environmentId, $0.state) }, uniquingKeysWith: { first, _ in first })
}

private func isSearching(_ state: SearchHostFoot.State) -> Bool {
    if case .searching = state { true } else { false }
}

/// Every answer up to and including the first with no host still searching;
/// the children land in whatever order the pool runs them.
private func untilSettled(_ answers: inout AsyncStream<SearchAnswer>.AsyncIterator) async -> [SearchAnswer] {
    var seen: [SearchAnswer] = []
    while let next = await answers.next(isolation: #isolation) {
        seen.append(next)
        if !next.hosts.contains(where: { isSearching($0.state) }) { break }
    }
    return seen
}

// MARK: parse

@Suite struct ParsedQueryTests {
    @Test func `lifts host, type and project tokens out of the words`() {
        let parsed = ParsedQuery.parse("gateway host:box trace type:thread,file project:Temp-Code")
        #expect(parsed.text == "gateway trace")
        #expect(parsed.host == "box")
        #expect(parsed.kinds == [.thread, .file])
        #expect(parsed.project == "temp-code")
    }

    @Test func `a token still being typed filters nothing`() {
        let parsed = ParsedQuery.parse("host: fts")
        #expect(parsed.text == "fts")
        #expect(parsed.host == nil)
        #expect(parsed.kinds == nil)
        #expect(parsed.project == nil)
    }

    @Test func `an unknown key is a word and an unknown type names no kind`() {
        let parsed = ParsedQuery.parse("url:http type:bogus")
        #expect(parsed.text == "url:http")
        #expect(parsed.kinds == nil)
    }

    @Test func `type tokens union and lose one trailing s`() {
        #expect(ParsedQuery.parse("type:notes type:files").kinds == [.note, .file])
        #expect(ParsedQuery.parse("TYPE:Threads").kinds == [.thread])
    }

    @Test func `whitespace alone is empty`() {
        #expect(ParsedQuery.parse("   ") == ParsedQuery(text: ""))
    }

    @Test func `the scope decides the kinds without a type token`() {
        #expect(SearchKind.kinds(of: .threads) == [.thread, .note])
        #expect(SearchKind.kinds(of: .files) == [.file, .project])
    }
}

// MARK: matchers

@Suite struct HostsMatchingTests {
    let laptop = target("env_1", name: "Laptop", isMac: true)
    let box = target("env_2", name: "box")

    @Test func `by name, by id, mac for the darwin host, every host without a token`() {
        #expect(CrossHostSearch.hostsMatching("BOX", [laptop, box]).map(\.id) == ["env_2"])
        #expect(CrossHostSearch.hostsMatching("env_1", [laptop, box]).map(\.id) == ["env_1"])
        #expect(CrossHostSearch.hostsMatching("mac", [laptop, box]).map(\.id) == ["env_1"])
        #expect(CrossHostSearch.hostsMatching("mac", [box]).isEmpty)
        #expect(CrossHostSearch.hostsMatching(nil, [laptop, box]).map(\.id) == ["env_1", "env_2"])
        #expect(CrossHostSearch.hostsMatching("zzz", [laptop, box]).isEmpty)
    }
}

@Suite struct MatchesProjectTests {
    @Test func `the pair's name matches both copies, in any case`() {
        let boxFile = file("box", "/work/app/src/a.ts", relative: "src/a.ts")
        #expect(CrossHostSearch.matchesProject(boxFile, token: "app", pairs: pairs))
        #expect(CrossHostSearch.matchesProject(boxFile, token: "APP", pairs: pairs))
        #expect(!CrossHostSearch.matchesProject(boxFile, token: "solo", pairs: pairs))
    }

    @Test func `without pairs a file still matches its project's name`() {
        let hit = file("box", "/work/app/src/a.ts", relative: "src/a.ts", projectName: "temp-code")
        #expect(CrossHostSearch.matchesProject(hit, token: "temp-code", pairs: CrossHostSearch.noPairs))
        #expect(!CrossHostSearch.matchesProject(hit, token: "other", pairs: CrossHostSearch.noPairs))
    }

    @Test func `a thread's cwd folder, a project row's name, and no token`() {
        #expect(CrossHostSearch.matchesProject(message("local", "s", seq: 1, cwd: "/Users/me/temp-code"), token: "temp", pairs: pairs))
        #expect(!CrossHostSearch.matchesProject(message("local", "s", seq: 1, cwd: "/Users/me/temp-code"), token: "other", pairs: pairs))
        #expect(CrossHostSearch.matchesProject(projectHit("box", "p", name: "Billing", path: "/work/x"), token: "bill", pairs: pairs))
        #expect(CrossHostSearch.matchesProject(note("box", "n"), token: nil, pairs: pairs))
    }
}

// MARK: fold

@Suite struct FoldPairedFilesTests {
    let older = file("local", "/Users/me/app/src/a.ts", relative: "src/a.ts", line: 3, mtime: 100)
    let newer = file("box", "/work/app/src/a.ts", relative: "src/a.ts", line: 3, mtime: 200)
    let otherLine = file("local", "/Users/me/app/src/a.ts", relative: "src/a.ts", line: 9, mtime: 100)

    @Test func `the same line in two copies folds to the newer copy, naming the other`() {
        let folded = files(CrossHostSearch.foldPairedFiles([older, otherLine, newer], pairs: pairs, hostOrder: ["local", "box"]))
        #expect(folded.map(\.environmentId) == ["box", "local"])
        #expect(folded.map(\.line) == [3, 9])
        #expect(folded[0].alsoOn == ["local"])
        #expect(folded[0].newer)
        #expect(folded[1].alsoOn.isEmpty)
    }

    @Test func `equal mtimes keep the first host in the order, without claiming newer`() {
        let localCopy = file("local", "/Users/me/app/src/a.ts", relative: "src/a.ts", mtime: 100)
        let boxCopy = file("box", "/work/app/src/a.ts", relative: "src/a.ts", mtime: 100)
        let kept = files(CrossHostSearch.foldPairedFiles([localCopy, boxCopy], pairs: pairs, hostOrder: ["local", "box"]))
        #expect(kept.map(\.environmentId) == ["local"])
        #expect(!kept[0].newer)
        #expect(kept[0].alsoOn == ["box"])
        let flipped = files(CrossHostSearch.foldPairedFiles([localCopy, boxCopy], pairs: pairs, hostOrder: ["box", "local"]))
        #expect(flipped.map(\.environmentId) == ["box"])
        #expect(flipped[0].alsoOn == ["local"])
    }

    @Test func `a file outside any pair or in a pair of one is left alone`() {
        let solo = file("local", "/Users/me/solo/a.ts", relative: "a.ts", mtime: 1)
        let loose = file("box", "/elsewhere/a.ts", relative: "a.ts", mtime: 1)
        let out = CrossHostSearch.foldPairedFiles([solo, loose, older], pairs: pairs, hostOrder: ["local", "box"])
        #expect(out == [solo, loose, older])
        #expect(CrossHostSearch.foldPairedFiles([older], pairs: CrossHostSearch.noPairs, hostOrder: ["local"]) == [older])
    }

    @Test func `a copy with no mtime loses to one that has one`() {
        let unknown = file("local", "/Users/me/app/src/a.ts", relative: "src/a.ts", mtime: nil)
        let folded = files(CrossHostSearch.foldPairedFiles([unknown, newer], pairs: pairs, hostOrder: ["local", "box"]))
        #expect(folded.map(\.environmentId) == ["box"])
        #expect(folded[0].newer)
    }
}

@Suite struct PairLookupTests {
    @Test func `linked copies on two hosts fold and a lone workspace is a pair of one`() {
        let found = ProjectPairs.pairs([
            HostWorkspaces(environmentId: "local", workspaces: [workspace("w1", name: "app", path: "/Users/me/app", link: "wl_app"), workspace("w2", name: "solo", path: "/Users/me/solo")]),
            HostWorkspaces(environmentId: "box", workspaces: [workspace("w3", name: "app", path: "/work/app", link: "wl_app")])
        ])
        let lookup = CrossHostSearch.pairLookup(found)
        #expect(lookup("box", "/work/app/src/a.ts") == PairedPath(pairId: "link:wl_app", pairName: "app", relative: "src/a.ts", copies: 2))
        #expect(lookup("local", "/Users/me/app") == PairedPath(pairId: "link:wl_app", pairName: "app", relative: "", copies: 2))
        #expect(lookup("local", "/Users/me/solo/x.ts")?.copies == 1)
        #expect(lookup("box", "/elsewhere/x.ts") == nil)
    }
}

// MARK: score

@Suite struct ScoreTests {
    @Test func `messages score by match quality and recency, never by host`() {
        let later = now + week
        let hits = [message("local", "a", seq: 1, rank: -2), message("box", "b", seq: 1, rank: -8), message("local", "c", seq: 1)]
        #expect(CrossHostSearch.score(hits, now: later).map(\.score) == [18, 24, 20])
        let swapped = [message("box", "a", seq: 1, rank: -2), message("local", "b", seq: 1, rank: -8), message("box", "c", seq: 1)]
        #expect(CrossHostSearch.score(swapped, now: later).map(\.score) == [18, 24, 20])
    }

    @Test func `titles take 20, notes 12, each plus recency; files keep no score`() {
        let scored = CrossHostSearch.score([title("local", "t"), note("box", "n"), file("box", "/work/app/a", relative: "a")], now: now)
        #expect(scored.map(\.score) == [44, 36, 0])
    }

    @Test func `recency falls from 24 to 0 over a week`() {
        #expect(CrossHostSearch.recencyBonus(updatedAt: 0, now: now) == 0)
        #expect(CrossHostSearch.recencyBonus(updatedAt: now + 5, now: now) == 24)
        #expect(CrossHostSearch.recencyBonus(updatedAt: now, now: now) == 24)
        #expect(CrossHostSearch.recencyBonus(updatedAt: now - week / 2, now: now) == 12)
        #expect(CrossHostSearch.recencyBonus(updatedAt: now - week, now: now) == 0)
        #expect(CrossHostSearch.recencyBonus(updatedAt: now - 3 * week, now: now) == 0)
    }
}

// MARK: merge

@Suite struct MergeTests {
    let perHost: [String: [SearchHit]] = [
        "box": [message("box", "b1", seq: 4, rank: -8, title: "Box thread"), file("box", "/work/app/src/a.ts", relative: "src/a.ts", mtime: 200), note("box", "n1")],
        "local": [message("local", "l1", seq: 2, rank: -2, title: "Local thread"), file("local", "/Users/me/app/src/a.ts", relative: "src/a.ts", mtime: 100), file("local", "/Users/me/solo/x.ts", relative: "x.ts", mtime: 50, projectId: "solo", projectName: "solo"), projectHit("local", "p", name: "app", path: "/Users/me/app")]
    ]
    let all: Set<SearchKind> = [.thread, .file, .note, .project]

    @Test func `every host's hits as one list, threads then notes then files then projects, scored without the host`() {
        let merged = CrossHostSearch.merge(perHost, hostOrder: ["local", "box"], pairs: pairs, kinds: all, project: nil, now: now)
        #expect(merged.map(\.id) == [
            "message:box:b1:4", "message:local:l1:2", "note:box:n1",
            "file:box:/work/app/src/a.ts:3:1", "file:local:/Users/me/solo/x.ts:3:1",
            "project:local:p"
        ])
        #expect(merged[0].score == 48)
        #expect(merged[1].score == 42)
        #expect(files(merged)[0].alsoOn == ["local"])
    }

    @Test func `the type filter keeps only the named kinds`() {
        let threads = CrossHostSearch.merge(perHost, hostOrder: ["local", "box"], pairs: pairs, kinds: [.thread], project: nil, now: now)
        #expect(threads.map(\.kind) == [.thread, .thread])
    }

    @Test func `the project filter keeps the hits of that project`() {
        let solo = CrossHostSearch.merge(perHost, hostOrder: ["local", "box"], pairs: pairs, kinds: all, project: "solo", now: now)
        #expect(solo.map(\.id) == ["file:local:/Users/me/solo/x.ts:3:1"])
        let app = CrossHostSearch.merge(perHost, hostOrder: ["local", "box"], pairs: pairs, kinds: [.file, .project], project: "app", now: now)
        #expect(app.map(\.id) == ["file:box:/work/app/src/a.ts:3:1", "project:local:p"])
    }

    @Test func `the order is total: the same input merges to the same ids, whatever the dictionary order`() {
        let first = CrossHostSearch.merge(perHost, hostOrder: ["local", "box"], pairs: pairs, kinds: all, project: nil, now: now)
        let again = CrossHostSearch.merge(perHost, hostOrder: ["local", "box"], pairs: pairs, kinds: all, project: nil, now: now)
        #expect(first.map(\.id) == again.map(\.id))
        let ties = ["box": [message("box", "s", seq: 1), message("box", "r", seq: 1)], "local": [message("local", "s", seq: 1)]]
        let ordered = CrossHostSearch.merge(ties, hostOrder: ["local", "box"], pairs: pairs, kinds: all, project: nil, now: now)
        #expect(ordered.map(\.id) == ["message:local:s:1", "message:box:r:1", "message:box:s:1"])
    }

    @Test func `one hit per id, and a workspace at a project's folder is one row`() {
        let hits = ["box": [
            file("box", "/work/app/a.ts", relative: "a.ts", projectId: "p1", projectName: "app"),
            file("box", "/work/app/a.ts", relative: "a.ts", projectId: "p2", projectName: "app"),
            projectHit("box", "p", name: "app", path: "/work/app", score: 40),
            projectHit("box", "ws:w", name: "app", path: "/work/app", score: 80)
        ]]
        let merged = CrossHostSearch.merge(hits, hostOrder: ["box"], pairs: pairs, kinds: [.file, .project], project: nil, now: now)
        #expect(merged.map(\.id) == ["file:box:/work/app/a.ts:3:1", "project:box:ws:w"])
    }

    @Test func `inside a thread the title comes first, then messages by score and seq`() {
        let hits = ["box": [message("box", "s", seq: 9, rank: -8), message("box", "s", seq: 2, rank: -8), title("box", "s"), message("box", "s", seq: 5, rank: -1)]]
        let merged = CrossHostSearch.merge(hits, hostOrder: ["box"], pairs: pairs, kinds: [.thread], project: nil, now: now)
        #expect(merged.map(\.id) == ["title:box:s", "message:box:s:2", "message:box:s:9", "message:box:s:5"])
    }
}

// MARK: rows

@Suite struct RowsTests {
    let names = ["local": "Mac", "box": "box"]

    @Test func `a title-only group is a head with no hits; a notes message is a hit with seq nil`() {
        let hits = [title("local", "t", title: "Hello thread"), message("box", "s", seq: 0, snippet: "hello in notes", title: "Box thread", isNote: true)]
        let rows = CrossHostSearch.rows(hits, query: "hello", hostNames: names, several: true, truncated: false)
        #expect(rows.map(\.id) == ["thread:local:t", "thread:box:s", "note:box:s"])
        guard case .threadHead(let head) = rows[0], case .hit(let hit) = rows[2] else {
            Issue.record("rows are not a head and a hit")
            return
        }
        #expect(head.host == "Mac")
        #expect(hit.seq == nil)
        #expect(hit.isNote)
        #expect(hit.matches == [0..<5])
    }

    @Test func `a folded file row carries the other hosts' names, a note is a note row, more once`() {
        var folded = SearchHit.File(environmentId: "box", projectId: "p", projectName: "app", branch: "main", worktree: false, path: "/work/app/src/a.ts", relative: "src/a.ts", line: 3, column: 1, preview: "hello there", mtime: 200)
        folded.alsoOn = ["local"]
        folded.newer = true
        let rows = CrossHostSearch.rows([note("box", "n1", snippet: "hello note"), .file(folded)], query: "hello", hostNames: names, several: true, truncated: true)
        #expect(rows.map(\.id) == ["appnote:box:n1", "phead:box:p", "file:box:/work/app/src/a.ts:3:1", "more"])
        guard case .note(let noteRow) = rows[0], case .file(let fileRow) = rows[2] else {
            Issue.record("rows are not a note and a file")
            return
        }
        #expect(noteRow.host == "box")
        #expect(noteRow.matches == [0..<5])
        #expect(fileRow.alsoOn == ["Mac"])
        #expect(fileRow.newer)
        #expect(rows.filter { $0.id == "more" }.count == 1)
    }

    @Test func `heads carry the host only with several targets, and every id is unique`() {
        let hits = [message("local", "s", seq: 1, title: "One"), message("local", "s", seq: 2, title: "One"), projectHit("local", "p", name: "app", path: "/x")]
        let alone = CrossHostSearch.rows(hits, query: "hello", hostNames: names, several: false, truncated: false)
        guard case .threadHead(let head) = alone[0], case .project(let project) = alone[3] else {
            Issue.record("rows are not a head and a project")
            return
        }
        #expect(head.host == nil)
        #expect(project.host == nil)
        #expect(Set(alone.map(\.id)).count == alone.count)
    }

    @Test func `a file group is cut at filesPerProject and says so`() {
        let many = (1...(SearchRows.filesPerProject + 1)).map { file("box", "/work/app/f\($0).ts", relative: "f\($0).ts", line: $0, mtime: 1) }
        let rows = CrossHostSearch.rows(many, query: "hello", hostNames: names, several: false, truncated: false)
        #expect(rows.count == SearchRows.filesPerProject + 2)
        #expect(rows.last?.id == "more")
    }
}

// MARK: feet

@Suite struct FeetTests {
    @Test func `searching, answered, offline and failed in the order given`() {
        let feet = CrossHostSearch.feet([
            HostProgress(environmentId: "a", name: "A", state: .searching, elapsedMs: 300),
            HostProgress(environmentId: "b", name: "B", state: .done, elapsedMs: 1200),
            HostProgress(environmentId: "c", name: "C", state: .skipped, detail: "offline"),
            HostProgress(environmentId: "d", name: "D", state: .failed, detail: "boom")
        ])
        #expect(feet.map(\.state) == [.searching(ms: 300), .answered(ms: 1200), .offline, .failed])
        #expect(SearchRows.footLine(feet) == "A … · B 1.2 s · C offline · D failed")
    }
}

// MARK: run

@Suite struct CrossHostSearchRunTests {
    private let threads = Gate<SessionSearchResult>()
    private let projectFiles = Gate<ProjectSearchResult>()
    private let notes = Gate<NoteSearchResult>()

    func ask(_ host: String) -> SearchAsk {
        SearchAsk(
            threads: { _ in try await threads.wait(host) },
            files: { _, _ in try await projectFiles.wait(host) },
            notes: { _ in try await notes.wait(host) }
        )
    }

    @Test func `rows stream per host and source, each host timed, an offline one skipped`() async throws {
        let clock = ManualClock(now: 0)
        let mac = target("mac", name: "Mac", isMac: true, sessions: [session("m1", title: "Mac thread")], ask: ask("mac"))
        let box = target("box", sessions: [session("b1", title: "Box thread")], projects: [project("p", name: "app", cwd: "/work/app")], ask: ask("box"))
        let laptop = target("laptop", open: false)
        let stream = CrossHostSearch.run(raw: "hello type:thread,file", scope: .threads, targets: [mac, box, laptop], pairs: pairs, clock: clock, now: { now })
        var answers = stream.makeAsyncIterator()

        await clock.advance(ms: 300)
        await threads.resume("box", .success(SessionSearchResult(hits: [SessionSearchHit(sessionId: "b1", seq: 4, role: .assistant, snippet: "hello box", ts: 1, rank: -3)], truncated: false)))
        let first = try #require(await answers.next())
        #expect(first.query == "hello type:thread,file")
        #expect(first.rows.map(\.id) == ["thread:box:b1", "hit:box:b1:4"])
        #expect(feet(first) == ["mac": .searching(ms: 0), "box": .searching(ms: 300), "laptop": .offline])
        #expect(first.hosts.map(\.environmentId) == ["mac", "box", "laptop"])

        await clock.advance(ms: 900)
        await projectFiles.resume("box", .success(ProjectSearchResult(matches: [ProjectSearchMatch(path: "/work/app/src/a.ts", relative: "src/a.ts", line: 3, column: 1, preview: "  hello there", mtime: 200)], truncated: false)))
        let second = try #require(await answers.next())
        #expect(second.rows.map(\.id) == ["thread:box:b1", "hit:box:b1:4", "phead:box:p", "file:box:/work/app/src/a.ts:3:1"])
        #expect(feet(second)["box"] == .answered(ms: 1200))
        guard case .file(let fileRow) = second.rows[3] else {
            Issue.record("no file row")
            return
        }
        #expect(fileRow.preview == "hello there")

        await clock.advance(ms: 100)
        await threads.resume("mac", .success(SessionSearchResult(hits: [SessionSearchHit(sessionId: "m1", seq: 2, role: .user, snippet: "hello mac", ts: 1, rank: -9)], truncated: true)))
        let last = try #require(await answers.next())
        #expect(last.rows.map(\.id) == ["thread:mac:m1", "hit:mac:m1:2", "thread:box:b1", "hit:box:b1:4", "phead:box:p", "file:box:/work/app/src/a.ts:3:1", "more"])
        #expect(feet(last) == ["mac": .answered(ms: 1300), "box": .answered(ms: 1200), "laptop": .offline])
        #expect(await answers.next() == nil)
    }

    @Test func `a type token wins over the scope, and a title match needs no call`() async throws {
        let box = target("box", sessions: [session("b1", title: "Hello world"), session("b2", title: "Nothing here")], ask: ask("box"))
        let stream = CrossHostSearch.run(raw: "hello type:thread", scope: .files, targets: [box], pairs: pairs, clock: ManualClock(), now: { now })
        var answers = stream.makeAsyncIterator()
        await threads.resume("box", .success(SessionSearchResult(hits: [], truncated: false)))
        let only = try #require(await answers.next())
        #expect(only.rows.map(\.id) == ["thread:box:b1"])
        #expect(only.scope == .files)
        #expect(await answers.next() == nil)
    }

    @Test func `one failed source among two is tolerated`() async throws {
        let box = target("box", sessions: [session("b1", title: "Box thread")], ask: ask("box"))
        let stream = CrossHostSearch.run(raw: "hello", scope: .threads, targets: [box], pairs: pairs, clock: ManualClock(), now: { now })
        var answers = stream.makeAsyncIterator()
        await threads.resume("box", .failure(Boom(text: "threads down")))
        await notes.resume("box", .success(NoteSearchResult(hits: [NoteSearchHit(id: "n1", title: "Gateway", snippet: "hello", updatedAt: now)], truncated: true)))
        let seen = await untilSettled(&answers)
        let last = try #require(seen.last)
        #expect(last.rows.map(\.id) == ["appnote:box:n1", "more"])
        #expect(feet(last)["box"] == .answered(ms: 1))
        // A failed source that landed first, with the notes still out, made no empty batch.
        #expect(seen.allSatisfy { !$0.rows.isEmpty })
        #expect(await answers.next() == nil)
    }

    @Test func `a host whose every source throws is failed`() async throws {
        let box = target("box", ask: ask("box"))
        let stream = CrossHostSearch.run(raw: "hello", scope: .threads, targets: [box], pairs: pairs, clock: ManualClock(), now: { now })
        var answers = stream.makeAsyncIterator()
        await threads.resume("box", .failure(Boom(text: "threads down")))
        await notes.resume("box", .failure(Boom(text: "notes down")))
        let seen = await untilSettled(&answers)
        #expect(seen.count == 1)
        let last = try #require(seen.last)
        #expect(feet(last)["box"] == .failed)
        #expect(last.rows.isEmpty)
        #expect(await answers.next() == nil)
    }

    @Test func `a cancelled task ends the stream with no further values and cancels the calls still out`() async throws {
        let box = target("box", sessions: [session("b1", title: "Box thread")], ask: ask("box"))
        let stream = CrossHostSearch.run(raw: "hello", scope: .threads, targets: [box], pairs: pairs, clock: ManualClock(), now: { now })
        let landed = Gate<Int>()
        let consumer = Task {
            var seen = 0
            for await _ in stream {
                seen += 1
                await landed.resume("first", .success(seen))
            }
            return seen
        }
        await threads.resume("box", .success(SessionSearchResult(hits: [SessionSearchHit(sessionId: "b1", seq: 1, role: .user, snippet: "hello", ts: 1)], truncated: false)))
        #expect(try await landed.wait("first") == 1)
        consumer.cancel()
        #expect(await consumer.value == 1)
        // The notes call was still out: the fan-out's cancellation reached it.
        #expect(await notes.cancelledKeys(after: 50) == ["box"])
    }

    @Test func `one failing project among several is tolerated and a cut answer says more`() async throws {
        let box = target("box", projects: [project("p1", name: "one", cwd: "/work/one"), project("p2", name: "two", cwd: "/work/two")], ask: ask("box"))
        let stream = CrossHostSearch.run(raw: "hello", scope: .files, targets: [box], pairs: pairs, clock: ManualClock(), now: { now })
        var answers = stream.makeAsyncIterator()
        await projectFiles.resume("box", .failure(Boom(text: "grep died")))
        await projectFiles.resume("box", .success(ProjectSearchResult(matches: [ProjectSearchMatch(path: "/work/two/a.ts", relative: "a.ts", line: 1, column: 1, preview: "hello")], truncated: true)))
        let only = try #require(await answers.next())
        #expect(only.rows.map(\.id) == ["phead:box:p2", "file:box:/work/two/a.ts:1:1", "more"])
        #expect(feet(only)["box"] == .answered(ms: 1))
        #expect(await answers.next() == nil)
    }

    @Test func `a host token nobody matches yields one empty answer`() async {
        let box = target("box", ask: ask("box"))
        let stream = CrossHostSearch.run(raw: "hello host:zzz", scope: .threads, targets: [box], pairs: pairs, clock: ManualClock(), now: { now })
        var answers = stream.makeAsyncIterator()
        let only = await answers.next()
        #expect(only?.rows.isEmpty == true)
        #expect(only?.hosts.isEmpty == true)
        #expect(await answers.next() == nil)
    }

    @Test func `a target with nothing to ask is answered at once`() async throws {
        let box = target("box", projects: [], ask: ask("box"))
        let laptop = target("laptop", open: false)
        let stream = CrossHostSearch.run(raw: "hello", scope: .files, targets: [box, laptop], pairs: pairs, clock: ManualClock(), now: { now })
        var answers = stream.makeAsyncIterator()
        let only = try #require(await answers.next())
        #expect(feet(only) == ["box": .answered(ms: 1), "laptop": .offline])
        #expect(only.rows.isEmpty)
        #expect(await answers.next() == nil)
    }

    @Test func `projects and workspaces match by name locally, with the files of the asked projects`() async throws {
        let box = target("box", projects: [project("p", name: "Billing", cwd: "/work/billing")], workspaces: [workspace("w", name: "cosmic", path: "/work/bill-ws")], ask: ask("box"))
        let stream = CrossHostSearch.run(raw: "bill", scope: .files, targets: [box], pairs: pairs, clock: ManualClock(), now: { now })
        var answers = stream.makeAsyncIterator()
        await projectFiles.resume("box", .success(ProjectSearchResult(matches: [], truncated: false)))
        let only = try #require(await answers.next())
        #expect(only.rows.map(\.id) == ["project:box:p", "project:box:ws:w"])
        #expect(await answers.next() == nil)
    }
}
