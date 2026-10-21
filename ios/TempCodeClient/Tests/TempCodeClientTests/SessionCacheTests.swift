import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

func sampleSession(_ id: String, projectId: String = "p1", title: String = "A thread", updatedAt: Int = 1, threadType: ThreadType? = .implementation) -> SessionMeta {
    SessionMeta(id: id, parentId: nil, projectId: projectId, workspaceId: nil, threadType: threadType, planPath: nil, provider: .claude, model: "claude-sonnet-5-5", reasoning: .low, agentType: .implementer, title: title, cwd: "/tmp/repo", status: .idle, pinned: false, archived: false, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, account: nil, activity: nil, activityKind: nil, tasks: nil, goal: nil, context: nil, canContinue: nil, treeCanContinue: nil, treeHasLiveWork: nil, treeHasPaused: nil, treeFrozenActiveElapsed: nil, threadRules: nil, createdAt: 1, updatedAt: updatedAt)
}

func sampleProject(_ id: String, workspaceId: String = "w1", name: String = "A project") -> ProjectMeta {
    ProjectMeta(id: id, workspaceId: workspaceId, name: name, mode: .local, branch: "master", cwd: "/tmp/repo", archived: false, accountPins: nil, createdAt: 1)
}

func sampleWorkspace(_ id: String, name: String = "repo") -> WorkspaceMeta {
    WorkspaceMeta(id: id, name: name, path: "/tmp/repo", git: true, accountPins: nil, githubRepo: nil, githubRepoCheckedAt: nil, createdAt: 1)
}

func textRow(_ sessionId: String, seq: Int, text: String? = nil, ephemeral: Bool? = nil) -> EventRow {
    EventRow(sessionId: sessionId, seq: seq, ts: 1_700_000_000_000 + seq, event: .assistantText(AssistantTextEvent(text: text ?? "row \(seq)", delta: false, msgId: "m\(seq)", blockIndex: 0)), ephemeral: ephemeral)
}

@Suite struct SessionCacheTests {
    let path = FileManager.default.temporaryDirectory.appending(path: "tc-cache-\(UUID().uuidString)/cache.sqlite")

    @Test func `a cold launch reads the shell and the newest rows written by the last run`() async throws {
        do {
            let cache = try SessionCache(path: path)
            try await cache.replaceWorkspaces("env_a", [sampleWorkspace("w1"), sampleWorkspace("w2", name: "other")])
            try await cache.replaceProjects("env_a", [sampleProject("p1"), sampleProject("p2", name: "B")])
            try await cache.upsertSessions("env_a", [sampleSession("s1", updatedAt: 5), sampleSession("s2", title: "Older", updatedAt: 2)])
            try await cache.upsertSessions("env_a", [sampleSession("s2", title: "Older, renamed", updatedAt: 9)])
            let page = (1...400).map { textRow("s1", seq: $0) }
            try await cache.store("env_a", sessionId: "s1", rows: Array(page[0..<200]), moreBefore: true)
            try await cache.store("env_a", sessionId: "s1", rows: Array(page[200...]))
            try await cache.storeBody("env_a", sessionId: "s1", seq: 7, row: textRow("s1", seq: 7, text: String(repeating: "x", count: 5_000)))
            // Another environment's data stays apart.
            try await cache.upsertSessions("env_b", [sampleSession("s9")])
        }

        let reopened = try SessionCache(path: path)
        let shell = try await reopened.shell("env_a")
        #expect(shell.workspaces.map(\.name) == ["repo", "other"])
        #expect(shell.projects.map(\.id) == ["p1", "p2"])
        #expect(shell.sessions.map(\.title) == ["Older, renamed", "A thread"])   // newest first, one row per id

        let tail = try await reopened.tail("env_a", sessionId: "s1", limit: 300)
        #expect(tail.rows.map(\.seq) == Array(101...400))
        #expect(tail.moreBefore)
        #expect(tail.cursor == 400)
        let older = try await reopened.rows("env_a", sessionId: "s1", before: 101, limit: 50)
        #expect(older.map(\.seq) == Array(51...100))
        #expect(try await reopened.cursor("env_a", sessionId: "s1") == 400)
        #expect(try await reopened.oldestSeq("env_a", sessionId: "s1") == 1)
        let body = try await reopened.body("env_a", sessionId: "s1", seq: 7)
        if case .assistantText(let text)? = body?.event { #expect(text.text.count == 5_000) } else { Issue.record("no body") }
        #expect(try await reopened.body("env_a", sessionId: "s1", seq: 8) == nil)
        #expect(try await reopened.shell("env_b").sessions.map(\.id) == ["s9"])
    }

    @Test func `writing a row twice keeps one, ephemeral rows are skipped, and reset starts over`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.store("e", sessionId: "s", rows: [textRow("s", seq: 1), textRow("s", seq: 2), textRow("s", seq: 3, ephemeral: true)], moreBefore: false)
        try await cache.store("e", sessionId: "s", rows: [textRow("s", seq: 2, text: "replaced"), textRow("s", seq: 4)])
        var tail = try await cache.tail("e", sessionId: "s")
        #expect(tail.rows.map(\.seq) == [1, 2, 4])
        if case .assistantText(let text) = tail.rows[1].event { #expect(text.text == "replaced") }
        #expect(!tail.moreBefore)

        try await cache.store("e", sessionId: "s", rows: [textRow("s", seq: 40), textRow("s", seq: 41)], moreBefore: true, reset: true)
        tail = try await cache.tail("e", sessionId: "s")
        #expect(tail.rows.map(\.seq) == [40, 41])
        #expect(tail.moreBefore)
        #expect(tail.cursor == 41)
    }

    @Test func `a running thread's host clock survives the cache for the elapsed timer`() async throws {
        let cache = try SessionCache.inMemory()
        let running = SessionMeta(id: "s1", parentId: nil, projectId: "p1", workspaceId: nil, threadType: .chat, planPath: nil, provider: .claude, model: "claude-sonnet-5-5", reasoning: .low, agentType: .implementer, title: "Running", cwd: "/tmp/repo", status: .running, pinned: false, archived: false, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: 1_699_999_990_000, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, account: nil, activity: nil, activityKind: nil, tasks: nil, goal: nil, context: nil, canContinue: nil, treeCanContinue: nil, treeHasLiveWork: nil, treeHasPaused: nil, treeFrozenActiveElapsed: nil, threadRules: nil, createdAt: 1, updatedAt: 1_700_000_000_000)
        try await cache.upsertSessions("env_test", [running])
        let shell = try await cache.shell("env_test")
        #expect(shell.sessions.first?.busySince == 1_699_999_990_000)
        #expect(shell.sessions.first?.status == .running)
    }

    @Test func `a thread is pruned to its bound once it runs past it`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.store("e", sessionId: "s", rows: (1...1_301).map { textRow("s", seq: $0) }, moreBefore: false)
        #expect(try await cache.oldestSeq("e", sessionId: "s") == 302)
        #expect(try await cache.cursor("e", sessionId: "s") == 1_301)
        #expect(try await cache.moreBefore("e", sessionId: "s"))   // what was dropped is still on the host
        let tail = try await cache.tail("e", sessionId: "s", limit: 10)
        #expect(tail.rows.map(\.seq) == Array(1_292...1_301))
    }

    @Test func `removing sessions and clearing an environment drop their rows and bodies`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.upsertSessions("e", [sampleSession("s1"), sampleSession("s2")])
        try await cache.store("e", sessionId: "s1", rows: [textRow("s1", seq: 1)])
        try await cache.storeBody("e", sessionId: "s1", seq: 1, row: textRow("s1", seq: 1))
        try await cache.store("e", sessionId: "s2", rows: [textRow("s2", seq: 1)])
        try await cache.removeSessions("e", ["s1"])
        #expect(try await cache.shell("e").sessions.map(\.id) == ["s2"])
        #expect(try await cache.tail("e", sessionId: "s1").rows.isEmpty)
        #expect(try await cache.body("e", sessionId: "s1", seq: 1) == nil)
        try await cache.clear("e")
        #expect(try await cache.shell("e") == .empty)
        #expect(try await cache.tail("e", sessionId: "s2").rows.isEmpty)
    }
}
