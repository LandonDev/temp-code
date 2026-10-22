import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct MatchRangesTests {
    @Test func `terms are the query's words, longest first`() {
        #expect(MatchRanges.terms(of: "hello world") == ["hello", "world"])
        #expect(MatchRanges.terms(of: "a ab") == ["ab", "a"])
    }

    @Test func `duplicate terms collapse and whitespace gives none`() {
        #expect(MatchRanges.terms(of: "go go  go") == ["go"])
        #expect(MatchRanges.terms(of: "").isEmpty)
        #expect(MatchRanges.terms(of: "   \n ").isEmpty)
    }

    @Test func `ranges are case insensitive`() {
        #expect(MatchRanges.ranges(in: "say hello", query: "Hello") == [4..<9])
    }

    @Test func `ranges are diacritic insensitive`() {
        #expect(MatchRanges.ranges(in: "un café noir", query: "cafe") == [3..<7])
    }

    @Test func `every occurrence is a range`() {
        #expect(MatchRanges.ranges(in: "ab ab ab", query: "ab") == [0..<2, 3..<5, 6..<8])
    }

    @Test func `a shorter term claims nothing inside a longer term's run`() {
        #expect(MatchRanges.ranges(in: "abab", query: "ab a") == [0..<2, 2..<4])
    }

    @Test func `offsets count characters, not bytes`() {
        #expect(MatchRanges.ranges(in: "🙂 hello", query: "hello") == [2..<7])
    }

    @Test func `an empty query matches nothing`() {
        #expect(MatchRanges.ranges(in: "anything", query: "").isEmpty)
        #expect(MatchRanges.ranges(in: "", query: "x").isEmpty)
    }
}

@Suite struct SearchDebounceTests {
    @Test func `a new text waits for the typing to pause`() {
        #expect(SearchDebounce.delay(previousQuery: "hel", nextQuery: "hello") == SearchDebounce.typing)
        #expect(SearchDebounce.typing == .milliseconds(250))
    }

    @Test func `the same text runs at once`() {
        #expect(SearchDebounce.delay(previousQuery: "hello", nextQuery: "hello") == .zero)
    }

    @Test func `under two characters nothing is asked`() {
        #expect(SearchDebounce.minimumLength == 2)
    }
}

@Suite struct SearchRowsBuildTests {
    let mac = SearchHost(id: "mac", name: "Mac", open: true)
    let box = SearchHost(id: "box", name: "box", open: true)

    @Test func `two hosts with hits on a shared session id give two heads with distinct ids`() {
        let hit = SessionSearchHit(sessionId: "shared", seq: 7, role: .assistant, snippet: "say hello", ts: 1)
        let answer = SearchRows.build(query: "hello", scope: .threads, hosts: [mac, box], answers: [
            threads("mac", [hit], sessions: [session("shared", title: "Mac thread", type: .planning)]),
            threads("box", [hit], sessions: [session("shared", title: "Box thread", type: .chat)])
        ])
        let heads = answer.rows.compactMap { row -> SearchRow.ThreadHead? in
            if case .threadHead(let head) = row { head } else { nil }
        }
        #expect(heads.count == 2)
        #expect(Set(answer.rows.map(\.id)).count == answer.rows.count)
        #expect(heads.map(\.title) == ["Mac thread", "Box thread"])
        #expect(heads.map(\.type) == [.planning, .chat])
        #expect(heads.map(\.host) == ["Mac", "box"])
        #expect(answer.rows.map(\.id) == ["thread:mac:shared", "hit:mac:shared:7", "thread:box:shared", "hit:box:shared:7"])
    }

    @Test func `hits keep the host's ranked order and carry their match ranges`() {
        let hits = [
            SessionSearchHit(sessionId: "s", seq: 9, role: .assistant, snippet: "second Hello", ts: 2, rank: -3),
            SessionSearchHit(sessionId: "s", seq: 3, role: .user, snippet: "hello first", ts: 1, rank: -1)
        ]
        let answer = SearchRows.build(query: "hello", scope: .threads, hosts: [mac], answers: [threads("mac", hits, sessions: [session("s", title: "T")])])
        let rows = answer.rows.compactMap { row -> SearchRow.Hit? in if case .hit(let hit) = row { hit } else { nil } }
        #expect(rows.map(\.seq) == [9, 3])
        #expect(rows.map(\.matches) == [[7..<12], [0..<5]])
        #expect(rows.map(\.ts) == [2, 1])
    }

    @Test func `an unknown session falls back to Thread with no type`() {
        let hit = SessionSearchHit(sessionId: "gone", seq: 1, role: .assistant, snippet: "x", ts: 1)
        let answer = SearchRows.build(query: "x", scope: .threads, hosts: [mac], answers: [threads("mac", [hit], sessions: [])])
        guard case .threadHead(let head) = answer.rows[0] else { Issue.record("no head"); return }
        #expect(head.title == "Thread")
        #expect(head.type == nil)
    }

    @Test func `a notes hit opens the thread at its end`() {
        let note = SessionSearchHit(sessionId: "s", seq: 0, role: .assistant, snippet: "kept in notes", ts: 5, source: .notes)
        let answer = SearchRows.build(query: "notes", scope: .threads, hosts: [mac], answers: [threads("mac", [note], sessions: [session("s", title: "T")])])
        guard case .hit(let hit) = answer.rows[1] else { Issue.record("no hit"); return }
        #expect(hit.isNote)
        #expect(hit.seq == nil)
        #expect(answer.rows[1].id == "note:mac:s")
    }

    @Test func `truncated on any host adds one more row at the end`() {
        let hit = SessionSearchHit(sessionId: "s", seq: 1, role: .assistant, snippet: "x", ts: 1)
        let answer = SearchRows.build(query: "x", scope: .threads, hosts: [mac, box], answers: [
            threads("mac", [hit], sessions: [], truncated: true),
            threads("box", [hit], sessions: [], truncated: true)
        ])
        #expect(answer.rows.filter { $0 == .more }.count == 1)
        #expect(answer.rows.last == .more)
    }

    @Test func `the host word is nil with one paired host`() {
        let hit = SessionSearchHit(sessionId: "s", seq: 1, role: .assistant, snippet: "x", ts: 1)
        let answer = SearchRows.build(query: "x", scope: .threads, hosts: [mac], answers: [threads("mac", [hit], sessions: [])])
        guard case .threadHead(let head) = answer.rows[0] else { Issue.record("no head"); return }
        #expect(head.host == nil)
    }

    @Test func `an offline paired host is in the foot and contributes no rows`() {
        let hit = SessionSearchHit(sessionId: "s", seq: 1, role: .assistant, snippet: "x", ts: 1)
        let offline = SearchHost(id: "box", name: "box", open: false)
        let answer = SearchRows.build(query: "x", scope: .threads, hosts: [mac, offline], answers: [threads("mac", [hit], sessions: [], elapsedMs: 320)])
        #expect(answer.rows.count == 2)
        #expect(answer.hosts == [
            SearchHostFoot(environmentId: "mac", name: "Mac", state: .answered(ms: 320)),
            SearchHostFoot(environmentId: "box", name: "box", state: .offline)
        ])
    }

    @Test func `a failed answer, or an open host with none, is failed in the foot`() {
        let failed = SearchHostAnswer(environmentId: "box", name: "box", sessions: [], threads: nil, elapsedMs: 50, failed: true)
        let answer = SearchRows.build(query: "x", scope: .threads, hosts: [mac, box], answers: [threads("mac", [], sessions: []), failed])
        #expect(answer.hosts.map(\.state) == [.answered(ms: 0), .failed])
        #expect(SearchRows.build(query: "x", scope: .threads, hosts: [mac], answers: []).hosts.map(\.state) == [.failed])
        #expect(answer.isEmpty)
        #expect(answer.query == "x")
        #expect(answer.scope == .threads)
    }

    @Test func `files: a project with no matches is omitted`() {
        let answer = SearchRows.build(query: "x", scope: .files, hosts: [mac], answers: [
            files("mac", [(project("empty"), []), (project("full"), [match("a.txt", 1, "x")])])
        ])
        #expect(answer.rows.map(\.id) == ["phead:mac:full", "file:mac:/repo/full/a.txt:1:1"])
    }

    @Test func `files: 41 matches give 40 rows and more`() {
        let matches = (1...41).map { match("a.txt", $0, "x") }
        let answer = SearchRows.build(query: "x", scope: .files, hosts: [mac], answers: [files("mac", [(project("p"), matches)])])
        #expect(answer.rows.filter { if case .file = $0 { true } else { false } }.count == 40)
        #expect(answer.rows.last == .more)
    }

    @Test func `files: truncated from the host gives more`() {
        let answer = SearchRows.build(query: "x", scope: .files, hosts: [mac], answers: [files("mac", [(project("p"), [match("a.txt", 1, "x")])], truncated: true)])
        #expect(answer.rows.last == .more)
        #expect(answer.rows.count == 3)
    }

    @Test func `files: the preview is trimmed and matched on the trimmed text`() {
        let answer = SearchRows.build(query: "hello", scope: .files, hosts: [mac], answers: [files("mac", [(project("p"), [match("a.txt", 3, "    say hello")])])])
        guard case .file(let file) = answer.rows[1] else { Issue.record("no file"); return }
        #expect(file.preview == "say hello")
        #expect(file.matches == [4..<9])
        #expect(file.line == 3)
        #expect(file.relative == "a.txt")
    }

    @Test func `files: heads carry branch, worktree and the host when several`() {
        let closed = SearchHost(id: "mac", name: "Mac", open: false)
        let answer = SearchRows.build(query: "x", scope: .files, hosts: [closed, box], answers: [
            files("box", [(project("p", branch: "feature", mode: .worktree), [match("a.txt", 1, "x")])])
        ])
        guard case .projectHead(let head) = answer.rows[0] else { Issue.record("no head"); return }
        #expect(head.name == "p")
        #expect(head.branch == "feature")
        #expect(head.worktree)
        #expect(head.host == "box")
        #expect(answer.hosts.map(\.state) == [.offline, .answered(ms: 0)])
    }

    @Test func `every row id is unique across hosts and kinds`() {
        let hits = [
            SessionSearchHit(sessionId: "s", seq: 1, role: .assistant, snippet: "x", ts: 1),
            SessionSearchHit(sessionId: "s", seq: 0, role: .assistant, snippet: "x", ts: 1, source: .notes),
            SessionSearchHit(sessionId: "t", seq: 1, role: .user, snippet: "x", ts: 1)
        ]
        let answer = SearchRows.build(query: "x", scope: .threads, hosts: [mac, box], answers: [
            threads("mac", hits, sessions: [], truncated: true),
            threads("box", hits, sessions: [])
        ])
        let ids = answer.rows.map(\.id)
        #expect(Set(ids).count == ids.count)
        #expect(ids.count == 11)
    }

    // MARK: helpers

    private func session(_ id: String, title: String, type: ThreadType? = nil) -> SessionMeta {
        SessionMeta(id: id, parentId: nil, projectId: nil, workspaceId: nil, threadType: type, planPath: nil, provider: .claude, model: "claude-sonnet-5-5", reasoning: .low, agentType: .implementer, title: title, cwd: "/repo", status: .idle, pinned: false, archived: false, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, tasks: nil, context: nil, createdAt: 1, updatedAt: 1)
    }

    private func threads(_ host: String, _ hits: [SessionSearchHit], sessions: [SessionMeta], truncated: Bool = false, elapsedMs: Int = 0) -> SearchHostAnswer {
        SearchHostAnswer(environmentId: host, name: host == "mac" ? "Mac" : host, sessions: sessions, threads: SessionSearchResult(hits: hits, truncated: truncated), elapsedMs: elapsedMs, failed: false)
    }

    private func files(_ host: String, _ projects: [(ProjectMeta, [ProjectSearchMatch])], truncated: Bool = false) -> SearchHostAnswer {
        SearchHostAnswer(
            environmentId: host,
            name: host == "mac" ? "Mac" : host,
            sessions: [],
            files: projects.map { .init(project: $0.0, result: ProjectSearchResult(matches: $0.1, truncated: truncated)) },
            elapsedMs: 0,
            failed: false
        )
    }

    private func project(_ name: String, branch: String? = nil, mode: ProjectMode = .local) -> ProjectMeta {
        ProjectMeta(id: name, workspaceId: "w", name: name, mode: mode, branch: branch, cwd: "/repo/\(name)", archived: false, createdAt: 1)
    }

    private func match(_ relative: String, _ line: Int, _ preview: String) -> ProjectSearchMatch {
        ProjectSearchMatch(path: "/repo/full/\(relative)", relative: relative, line: line, column: 1, preview: preview)
    }
}

@Suite struct SearchFootTests {
    @Test func `one host gives no foot line`() {
        #expect(SearchRows.footLine([SearchHostFoot(environmentId: "mac", name: "Mac", state: .answered(ms: 5))]) == nil)
    }

    @Test func `several hosts name each with its time or standing`() {
        let feet = [
            SearchHostFoot(environmentId: "mac", name: "Mac", state: .answered(ms: 320)),
            SearchHostFoot(environmentId: "box", name: "box", state: .answered(ms: 1234))
        ]
        #expect(SearchRows.footLine(feet) == "Mac 320 ms · box 1.2 s")
        #expect(SearchRows.footLine([feet[0], SearchHostFoot(environmentId: "box", name: "box", state: .offline)]) == "Mac 320 ms · box offline")
        #expect(SearchRows.footLine([feet[0], SearchHostFoot(environmentId: "box", name: "box", state: .failed)]) == "Mac 320 ms · box failed")
    }

    @Test(arguments: [(320, "320 ms"), (1234, "1.2 s"), (12000, "12.0 s"), (0, "0 ms"), (999, "999 ms"), (1050, "1.1 s")])
    func `duration reads in ms under a second and one decimal above`(ms: Int, text: String) {
        #expect(SearchRows.duration(ms: ms) == text)
    }
}
