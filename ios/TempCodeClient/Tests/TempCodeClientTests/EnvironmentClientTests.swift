import Foundation
import Synchronization
import Testing
import TempCodeContract
@testable import TempCodeClient

func json(_ value: some Encodable) -> String {
    String(decoding: try! JSONEncoder().encode(value), as: UTF8.self)
}

/// A client on fake sockets with an in-memory cache and a manual clock.
@MainActor
private final class ClientRig {
    let clock = ManualClock(random: [0])
    let sockets = FakeSocketFactory()
    let keys = InMemoryKeyStore()
    let cache: SessionCache
    let environment = PairedEnvironment(id: "env_test", name: "box", origin: URL(string: "https://box.example")!, caps: [.read], keyId: "K1", keyName: "iphone", addedAt: 0)
    let client: EnvironmentClient

    init(cache: SessionCache? = nil) throws {
        self.cache = try cache ?? SessionCache.inMemory()
        try keys.set("tc_K1.secret", for: "env_test")
        let api = RemoteAPI { request in
            let body = #"{"ticket":"t","expiresIn":30}"#
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        client = EnvironmentClient(environment: environment, keys: keys, cache: self.cache, api: api, connect: sockets.factory, clock: clock)
    }

    /// Answers the shell listing a fresh session asks for, as the requests
    /// appear: workspaces, projects, `session.changes` (the head, `reset` by
    /// default, so the client lists whole; nil when the test answers it by
    /// hand) and one session page.
    func answerShell(_ fake: FakeWebSocket, sessions: [SessionMeta], changes: SessionChanges? = SessionChanges(reset: true, seq: 1, generation: "g0")) async {
        var answered: Set<String> = []
        // A non-reset reconcile never asks for a session page.
        let wanted = changes?.reset == false ? 3 : 4
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            for sent in fake.sentRequests where !answered.contains(sent.id) {
                switch sent.method {
                case "workspace.list": fake.answer(id: sent.id, result: json([sampleWorkspace("w1")]))
                case "project.list": fake.answer(id: sent.id, result: json([sampleProject("p1")]))
                case "session.changes":
                    guard let changes else { continue }
                    fake.answer(id: sent.id, result: json(changes))
                case "session.list": fake.answer(id: sent.id, result: json(SessionPage(sessions: sessions, cursor: nil)))
                default: continue
                }
                answered.insert(sent.id)
            }
            if answered.count >= wanted { return }
            try? await Task.sleep(for: .milliseconds(1))
        }
        Issue.record("the shell was never listed")
    }

    /// Waits until `predicate` holds on the main actor.
    func wait(_ predicate: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if predicate() { return true }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return false
    }

    /// Waits until the async `predicate` holds.
    func waitAsync(_ predicate: () async -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if await predicate() { return true }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return false
    }

    /// The requests of `method` sent on `fake` so far.
    func sent(_ fake: FakeWebSocket, _ method: String) -> [(id: String, method: String, params: JSONValue)] {
        fake.sentRequests.filter { $0.method == method }
    }

    func waitForRequest(_ fake: FakeWebSocket, _ method: String, count: Int = 1) async -> (id: String, method: String, params: JSONValue)? {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            let matching = sent(fake, method)
            if matching.count >= count { return matching[count - 1] }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return nil
    }
}

private func clientSession(_ id: String, title: String = "A thread", updatedAt: Int = 1) -> SessionMeta {
    sampleSession(id, title: title, updatedAt: updatedAt, threadType: .chat)
}

private func seqs(_ rows: [EventRow]) -> [Int] { rows.map(\.seq) }

@MainActor
@Suite struct EnvironmentClientTests {
    @Test func `a cold launch paints the cached shell and tail before the socket is up`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.replaceProjects("env_test", [sampleProject("p1")])
        try await cache.upsertSessions("env_test", [clientSession("s1", updatedAt: 3), clientSession("s2", updatedAt: 1)])
        try await cache.store("env_test", sessionId: "s1", rows: (1...50).map { textRow("s1", seq: $0) }, moreBefore: true)
        let rig = try ClientRig(cache: cache)
        await rig.client.start()
        #expect(rig.client.sessions.map(\.id) == ["s1", "s2"])
        #expect(rig.client.projects.map(\.id) == ["p1"])
        #expect(await rig.wait { rig.client.status.transport == .connecting })
        await rig.client.openThread("s1")
        #expect(seqs(rig.client.threads["s1"]?.rows ?? []) == Array(1...50))
        #expect(rig.client.threads["s1"]?.moreBefore == true)
        #expect(rig.client.threads["s1"]?.isLive == false)
    }

    @Test func `the first session lists the shell, resumes the open thread from its cursor and marks fresh`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.store("env_test", sessionId: "s1", rows: (1...50).map { textRow("s1", seq: $0) }, moreBefore: true)
        let rig = try ClientRig(cache: cache)
        await rig.client.start()
        await rig.client.openThread("s1")
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [clientSession("s1"), clientSession("s3")])
        let subscribe = try #require(await rig.waitForRequest(fake, "session.subscribe"))
        fake.answer(id: subscribe.id, result: "null")
        let events = try #require(await rig.waitForRequest(fake, "session.events"))
        #expect(events.params == .object(["sessionId": .string("s1"), "afterSeq": .number(50)]))
        // The host replays what followed seq 50, with one row the cache already had.
        fake.answer(id: events.id, result: json(EventsPage(rows: (50...60).map { textRow("s1", seq: $0) }, moreBefore: false, moreAfter: false, reset: false)))
        #expect(await rig.wait { rig.client.threads["s1"]?.rows.count == 60 })
        #expect(seqs(rig.client.threads["s1"]!.rows) == Array(1...60))
        #expect(rig.client.threads["s1"]?.isLive == true)
        #expect(rig.client.threads["s1"]?.isLoading == false)
        #expect(await rig.wait { rig.client.status.fresh })
        #expect(rig.client.sessions.map(\.id).sorted() == ["s1", "s3"])
        #expect(rig.client.workspaces.map(\.id) == ["w1"])
        #expect(try await cache.cursor("env_test", sessionId: "s1") == 60)
    }

    @Test func `a resync reconciles the list and open thread on the same socket`() async throws {
        let rig = try ClientRig()
        await rig.client.start()
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [clientSession("s1")])
        #expect(await rig.wait { rig.client.status.fresh })
        await rig.client.openThread("s1")
        let subscribe = try #require(await rig.waitForRequest(fake, "session.subscribe"))
        fake.answer(id: subscribe.id, result: "null")
        let events = try #require(await rig.waitForRequest(fake, "session.events"))
        fake.answer(id: events.id, result: json(EventsPage(rows: [textRow("s1", seq: 1)], moreBefore: false, moreAfter: false, reset: false)))
        #expect(await rig.wait { rig.client.threads["s1"]?.rows.count == 1 })

        fake.deliver(#"{"push":"resync"}"#)
        let changes = try #require(await rig.waitForRequest(fake, "session.changes", count: 2))
        #expect(changes.params == .object(["afterSeq": .number(1), "generation": .string("g0")]))
        let workspaces = try #require(await rig.waitForRequest(fake, "workspace.list", count: 2))
        fake.answer(id: workspaces.id, result: json([sampleWorkspace("w1")]))
        let projects = try #require(await rig.waitForRequest(fake, "project.list", count: 2))
        fake.answer(id: projects.id, result: json([sampleProject("p1")]))
        fake.answer(id: changes.id, result: json(SessionChanges(reset: false, seq: 2, generation: "g0", sessions: [clientSession("s1", title: "Renamed")], removed: [])))
        let replay = try #require(await rig.waitForRequest(fake, "session.events", count: 2))
        #expect(replay.params == .object(["sessionId": .string("s1"), "afterSeq": .number(1)]))
        fake.answer(id: replay.id, result: json(EventsPage(rows: [textRow("s1", seq: 2)], moreBefore: false, moreAfter: false, reset: false)))
        #expect(await rig.wait { rig.client.session("s1")?.title == "Renamed" && rig.client.threads["s1"]?.rows.count == 2 })
        #expect(rig.client.listCursor == ListCursor(seq: 2, generation: "g0"))
        #expect(rig.sent(fake, "session.subscribe").count == 1)
        #expect(rig.client.status.fresh)
    }

    @Test func `a cold thread opens with a tail and pushes append without duplicates`() async throws {
        let rig = try ClientRig()
        await rig.client.start()
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [clientSession("s1")])
        #expect(await rig.wait { rig.client.hasShell })
        await rig.client.openThread("s1")
        let subscribe = try #require(await rig.waitForRequest(fake, "session.subscribe"))
        fake.answer(id: subscribe.id, result: "null")
        let events = try #require(await rig.waitForRequest(fake, "session.events"))
        #expect(events.params == .object(["sessionId": .string("s1"), "tail": .number(300)]))
        fake.answer(id: events.id, result: json(EventsPage(rows: (101...110).map { textRow("s1", seq: $0) }, moreBefore: true, moreAfter: false, reset: false)))
        #expect(await rig.wait { rig.client.threads["s1"]?.rows.count == 10 })
        #expect(rig.client.threads["s1"]?.moreBefore == true)

        fake.deliver(json(["push": "events"]).dropLast() + #","sessionId":"s1","rows":\#(json([textRow("s1", seq: 110, text: "final"), textRow("s1", seq: 111), textRow("s1", seq: 112, ephemeral: true)]))}"#)
        #expect(await rig.wait { rig.client.threads["s1"]?.rows.count == 12 })
        let rows = rig.client.threads["s1"]!.rows
        #expect(seqs(rows) == Array(101...112))
        if case .assistantText(let text) = rows[9].event { #expect(text.text == "final") }
        // The ephemeral row stayed out of the cache; the rest landed.
        #expect(await rig.waitAsync { (try? await rig.cache.cursor("env_test", sessionId: "s1")) == 111 })
        let cached = try await rig.cache.tail("env_test", sessionId: "s1")
        #expect(seqs(cached.rows) == Array(101...111))
        #expect(cached.moreBefore)
    }

    @Test func `a drop and a new session resume from the last seq without duplicates`() async throws {
        let rig = try ClientRig()
        await rig.client.start()
        let first = await rig.sockets.socket(0)
        first.hello()
        await rig.answerShell(first, sessions: [clientSession("s1")])
        await rig.client.openThread("s1")
        let subscribe = try #require(await rig.waitForRequest(first, "session.subscribe"))
        first.answer(id: subscribe.id, result: "null")
        let events = try #require(await rig.waitForRequest(first, "session.events"))
        first.answer(id: events.id, result: json(EventsPage(rows: (1...5).map { textRow("s1", seq: $0) }, moreBefore: false, moreAfter: false, reset: false)))
        #expect(await rig.wait { rig.client.threads["s1"]?.rows.count == 5 })

        first.serverClose(code: 1006)
        #expect(await rig.wait { rig.client.threads["s1"]?.isLive == false })
        #expect(await rig.wait { rig.client.status.transport == .reconnecting })
        await rig.clock.advance(ms: 750)
        let second = await rig.sockets.socket(1)
        second.hello()
        await rig.answerShell(second, sessions: [clientSession("s1")])
        let resubscribe = try #require(await rig.waitForRequest(second, "session.subscribe"))
        second.answer(id: resubscribe.id, result: "null")
        let resume = try #require(await rig.waitForRequest(second, "session.events"))
        #expect(resume.params == .object(["sessionId": .string("s1"), "afterSeq": .number(5)]))
        second.answer(id: resume.id, result: json(EventsPage(rows: (4...9).map { textRow("s1", seq: $0) }, moreBefore: false, moreAfter: false, reset: false)))
        #expect(await rig.wait { rig.client.threads["s1"]?.rows.count == 9 })
        #expect(seqs(rig.client.threads["s1"]!.rows) == Array(1...9))
        #expect(rig.client.threads["s1"]?.isLive == true)
        // Sessions still open on the old socket are not replayed: one subscribe per socket.
        #expect(rig.sent(second, "session.subscribe").count == 1)
    }

    @Test func `pushes during subscribe and gap fetch stay behind the fixed resume cursor`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.store("env_test", sessionId: "s1", rows: (1...50).map { textRow("s1", seq: $0) }, moreBefore: false)
        let rig = try ClientRig(cache: cache)
        await rig.client.start()
        await rig.client.openThread("s1")
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [clientSession("s1")])
        // The list answer lands before the pushes below, or it would overwrite their title.
        #expect(await rig.wait { rig.client.hasShell })
        let subscribe = try #require(await rig.waitForRequest(fake, "session.subscribe"))
        fake.deliver(#"{"push":"events","sessionId":"s1","rows":\#(json([textRow("s1", seq: 100)]))}"#)
        // A shell push after the events push proves the push loop consumed it.
        fake.deliver(#"{"push":"sessions","sessions":\#(json([clientSession("s1", title: "push consumed")]))}"#)
        #expect(await rig.wait { rig.client.session("s1")?.title == "push consumed" })
        #expect(rig.client.threads["s1"]?.cursor == 50)
        fake.answer(id: subscribe.id, result: "null")
        let events = try #require(await rig.waitForRequest(fake, "session.events"))
        #expect(events.params["afterSeq"] == .number(50))
        let preview = EventRow(sessionId: "s1", seq: -1, ts: 102, event: .toolCall(ToolCallEvent(callId: "partial", name: "Read", partial: true)), ephemeral: true)
        let final = EventRow(sessionId: "s1", seq: 103, ts: 103, event: .toolCall(ToolCallEvent(callId: "partial", name: "Read", partial: false)))
        fake.deliver(#"{"push":"events","sessionId":"s1","rows":\#(json([textRow("s1", seq: 102), textRow("s1", seq: 101), textRow("s1", seq: 100), preview, final]))}"#)
        fake.deliver(#"{"push":"sessions","sessions":\#(json([clientSession("s1", title: "second push consumed")]))}"#)
        #expect(await rig.wait { rig.client.session("s1")?.title == "second push consumed" })
        #expect(rig.client.threads["s1"]?.cursor == 50)
        fake.answer(id: events.id, result: json(EventsPage(rows: (51...100).map { textRow("s1", seq: $0) }, moreBefore: false, moreAfter: false, reset: false)))
        #expect(await rig.wait { rig.client.threads["s1"]?.cursor == 103 })
        #expect(seqs(rig.client.threads["s1"]!.rows) == Array(1...103))
        #expect(await rig.waitAsync { (try? await cache.cursor("env_test", sessionId: "s1")) == 103 })
        await rig.client.stop()
    }

    @Test func `a failed replay discards held pushes so retry still fetches the gap`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.store("env_test", sessionId: "s1", rows: (1...50).map { textRow("s1", seq: $0) }, moreBefore: false)
        let rig = try ClientRig(cache: cache)
        await rig.client.start()
        await rig.client.openThread("s1")
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [clientSession("s1")])
        let subscribe = try #require(await rig.waitForRequest(fake, "session.subscribe"))
        fake.answer(id: subscribe.id, result: "null")
        let events = try #require(await rig.waitForRequest(fake, "session.events"))
        fake.deliver(#"{"push":"events","sessionId":"s1","rows":\#(json([textRow("s1", seq: 100)]))}"#)
        fake.refuse(id: events.id, error: "replay failed")
        #expect(await rig.wait { rig.client.status.fresh })
        #expect(rig.client.threads["s1"]?.cursor == 50)
        let retry = rig.client.subscriptions.resume("s1")
        let replay = try #require(await rig.waitForRequest(fake, "session.events", count: 2))
        #expect(replay.params["afterSeq"] == .number(50))
        fake.answer(id: replay.id, result: json(EventsPage(rows: (51...100).map { textRow("s1", seq: $0) }, moreBefore: false, moreAfter: false, reset: false)))
        _ = try await retry.value
        #expect(seqs(rig.client.threads["s1"]!.rows) == Array(1...100))
        await rig.client.stop()
    }

    @Test func `a reset page throws the fold away`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.store("env_test", sessionId: "s1", rows: (1...20).map { textRow("s1", seq: $0) }, moreBefore: false)
        let rig = try ClientRig(cache: cache)
        await rig.client.start()
        await rig.client.openThread("s1")
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [clientSession("s1")])
        let subscribe = try #require(await rig.waitForRequest(fake, "session.subscribe"))
        fake.answer(id: subscribe.id, result: "null")
        let events = try #require(await rig.waitForRequest(fake, "session.events"))
        fake.answer(id: events.id, result: json(EventsPage(rows: (900...905).map { textRow("s1", seq: $0) }, moreBefore: true, moreAfter: false, reset: true)))
        #expect(await rig.wait { rig.client.threads["s1"]?.rows.first?.seq == 900 })
        #expect(seqs(rig.client.threads["s1"]!.rows) == Array(900...905))
        #expect(rig.client.threads["s1"]?.moreBefore == true)
        #expect(await rig.waitAsync { (try? await cache.oldestSeq("env_test", sessionId: "s1")) == 900 })
    }

    @Test func `older rows come from the cache first and then from the host`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.store("env_test", sessionId: "s1", rows: (1...400).map { textRow("s1", seq: $0) }, moreBefore: true)
        let rig = try ClientRig(cache: cache)
        await rig.client.start()
        await rig.client.openThread("s1")
        #expect(seqs(rig.client.threads["s1"]!.rows) == Array(101...400))
        await rig.client.loadOlder("s1")
        #expect(rig.client.threads["s1"]!.rows.first?.seq == 1)
        #expect(rig.client.threads["s1"]!.rows.count == 400)
        #expect(rig.client.threads["s1"]?.moreBefore == true)

        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [clientSession("s1")])
        let subscribe = try #require(await rig.waitForRequest(fake, "session.subscribe"))
        fake.answer(id: subscribe.id, result: "null")
        let events = try #require(await rig.waitForRequest(fake, "session.events"))
        fake.answer(id: events.id, result: json(EventsPage(rows: [], moreBefore: false, moreAfter: false, reset: false)))
        #expect(await rig.wait { rig.client.threads["s1"]?.isLive == true })

        let loading = Task { await rig.client.loadOlder("s1") }
        let older = try #require(await rig.waitForRequest(fake, "session.events", count: 2))
        #expect(older.params == .object(["sessionId": .string("s1"), "beforeSeq": .number(1), "tail": .number(200)]))
        fake.answer(id: older.id, result: json(EventsPage(rows: [], moreBefore: false, moreAfter: false, reset: false)))
        await loading.value
        #expect(rig.client.threads["s1"]?.moreBefore == false)
    }

    @Test func `an old search hit pages backwards and resolves its merged text item`() async throws {
        let cache = try SessionCache.inMemory()
        var history = (1...800).map { textRow("s1", seq: $0) }
        history[49] = EventRow(sessionId: "s1", seq: 50, ts: 50, event: .assistantText(AssistantTextEvent(text: "first", delta: true, msgId: "merged", blockIndex: 0)))
        history[50] = EventRow(sessionId: "s1", seq: 51, ts: 51, event: .assistantText(AssistantTextEvent(text: "whole", delta: false, msgId: "merged", blockIndex: 0)))
        try await cache.store("env_test", sessionId: "s1", rows: history, moreBefore: false)
        let rig = try ClientRig(cache: cache)
        await rig.client.start()
        await rig.client.openThread("s1")
        rig.client.threads["s1"]?.isLoading = false
        #expect(rig.client.threads["s1"]?.rows.first?.seq == 501)
        let preview = EventRow(sessionId: "s1", seq: -1, ts: 801, event: .toolCall(ToolCallEvent(callId: "live", name: "Read", partial: true)), ephemeral: true)
        rig.client.threads["s1"]?.rows.append(preview)
        rig.client.threads["s1"]?.fold.apply(preview)
        #expect(await rig.client.reveal("s1", seq: 51) == 50)
        #expect(rig.client.threads["s1"]?.rows.first?.seq == 1)
        #expect(rig.client.threads["s1"]?.rows.last?.ephemeral == true)
        #expect(await rig.client.reveal("s1", seq: 0) == nil)
        await rig.client.stop()
    }

    @Test func `search paging stops at its bound and never substitutes a newer row`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.store("env_test", sessionId: "s1", rows: (1...800).map { textRow("s1", seq: $0) }, moreBefore: false)
        let rig = try ClientRig(cache: cache)
        await rig.client.openThread("s1")
        rig.client.threads["s1"]?.isLoading = false
        #expect(await rig.client.reveal("s1", seq: 51, maxPages: 1) == nil)
        #expect(rig.client.threads["s1"]?.rows.first?.seq == 301)
        #expect(await rig.client.reveal("s1", seq: 900) == nil)
    }

    @Test(arguments: [ThreadType.implementation, .research, .orchestration, .planning])
    func `a board paints its tail then folds history beyond the transcript memory cap`(_ type: ThreadType) async throws {
        let rig = try ClientRig()
        var history = (1...2_500).map { textRow("s1", seq: $0) }
        history[0] = EventRow(sessionId: "s1", seq: 1, ts: 1, event: user("first round"))
        history[1] = EventRow(sessionId: "s1", seq: 2, ts: 2, event: todoWrite("old-todo", [("Keep the early task", "completed")]))
        history[2] = EventRow(sessionId: "s1", seq: 3, ts: 3, event: .researchSource(ResearchSourceEvent(callId: "source", url: "https://example.com", agentId: "s1", agentLabel: "main", title: "Early source")))
        history[1_199] = EventRow(sessionId: "s1", seq: 1200, ts: 1200, event: .turnComplete(TurnCompleteEvent()))
        history[1_200] = EventRow(sessionId: "s1", seq: 1201, ts: 1201, event: user("second round", newPass: true))
        history[1_201] = EventRow(sessionId: "s1", seq: 1202, ts: 1202, event: todoWrite("new-todo", [("Keep the current task", "in_progress")]))
        await rig.client.start()
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [sampleSession("s1", threadType: type)])
        #expect(await rig.wait { rig.client.hasShell })
        await rig.client.openThread("s1")
        let subscribe = try #require(await rig.waitForRequest(fake, "session.subscribe"))
        fake.answer(id: subscribe.id, result: "null")
        let tail = try #require(await rig.waitForRequest(fake, "session.events"))
        fake.answer(id: tail.id, result: json(EventsPage(rows: Array(history.suffix(300)), moreBefore: true, moreAfter: false, reset: false)))
        let firstPage = try #require(await rig.waitForRequest(fake, "session.events", count: 2))
        #expect(rig.client.threads["s1"]?.isLoading == false)
        #expect(rig.client.threads["s1"]?.isLoadingHistory == true)
        #expect(rig.client.threads["s1"]?.rows.count == 300)
        #expect(firstPage.params["beforeSeq"] == .number(2201))
        fake.deliver(#"{"push":"events","sessionId":"s1","rows":\#(json([textRow("s1", seq: 2501)]))}"#)
        var count = 2
        while true {
            let request = try #require(await rig.waitForRequest(fake, "session.events", count: count))
            guard case .number(let raw)? = request.params["beforeSeq"] else { Issue.record("not an older page"); break }
            let before = Int(raw)
            let page = Array(history.filter { $0.seq < before }.suffix(200))
            fake.answer(id: request.id, result: json(EventsPage(rows: page, moreBefore: page.first?.seq != 1, moreAfter: false, reset: false)))
            if page.first?.seq == 1 { break }
            count += 1
        }
        #expect(await rig.wait { rig.client.threads["s1"]?.isLoadingHistory == false })
        let state = try #require(rig.client.threads["s1"])
        #expect(state.rows.count == 2501)
        #expect(state.moreBefore == false)
        #expect(state.fold.board.rounds.first?.first?.content == "Keep the early task")
        #expect(state.fold.board.todos.first?.content == "Keep the current task")
        #expect(state.fold.board.sources.first?.title == "Early source")
        fake.deliver(#"{"push":"events","sessionId":"s1","rows":\#(json([textRow("s1", seq: 2502)]))}"#)
        #expect(await rig.wait { rig.client.threads["s1"]?.cursor == 2502 })
        #expect(rig.client.threads["s1"]?.fold.board.rounds.count == 1)
        await rig.client.stop()
    }

    @Test func `a stalled history page leaves the board marked incomplete and keeps the tail`() async throws {
        let rig = try ClientRig()
        await rig.client.start()
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [sampleSession("s1")])
        #expect(await rig.wait { rig.client.hasShell })
        await rig.client.openThread("s1")
        let subscribe = try #require(await rig.waitForRequest(fake, "session.subscribe"))
        fake.answer(id: subscribe.id, result: "null")
        let tail = try #require(await rig.waitForRequest(fake, "session.events"))
        fake.answer(id: tail.id, result: json(EventsPage(rows: (701...1000).map { textRow("s1", seq: $0) }, moreBefore: true, moreAfter: false, reset: false)))
        let older = try #require(await rig.waitForRequest(fake, "session.events", count: 2))
        fake.answer(id: older.id, result: json(EventsPage(rows: [], moreBefore: true, moreAfter: false, reset: false)))
        #expect(await rig.wait { rig.client.threads["s1"]?.historyError != nil })
        #expect(rig.client.threads["s1"]?.moreBefore == true)
        #expect(rig.client.threads["s1"]?.rows.count == 300)
        #expect(rig.client.threads["s1"]?.isLoadingHistory == false)
        await rig.client.stop()
    }

    @Test func `sessions pushes merge newest first and removals drop the thread`() async throws {
        let rig = try ClientRig()
        await rig.client.start()
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [clientSession("s1", updatedAt: 1), clientSession("s2", updatedAt: 2)])
        #expect(await rig.wait { rig.client.sessions.count == 2 })
        #expect(rig.client.sessions.map(\.id) == ["s2", "s1"])
        fake.deliver(#"{"push":"sessions","sessions":\#(json([clientSession("s1", title: "Renamed", updatedAt: 9)]))}"#)
        #expect(await rig.wait { rig.client.sessions.first?.title == "Renamed" })
        await rig.client.openThread("s2")
        fake.deliver(#"{"push":"session-removed","sessionIds":["s2"]}"#)
        #expect(await rig.wait { rig.client.sessions.count == 1 })
        #expect(rig.client.threads["s2"] == nil)
        #expect(!rig.client.subscriptions.has("s2"))
    }

    @Test func `a moved push records the destination for the root and each subagent, then the sessions are gone`() async throws {
        let rig = try ClientRig()
        await rig.client.start()
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [clientSession("root", updatedAt: 2), clientSession("child", updatedAt: 1), clientSession("other", updatedAt: 3)])
        #expect(await rig.wait { rig.client.sessions.count == 3 })
        await rig.client.openThread("root")
        let before = Int(Date().timeIntervalSince1970 * 1000)
        fake.deliver(#"{"push":"session-moved","id":"root","sessionIds":["root","child"],"to":"env_mac"}"#)
        #expect(await rig.wait { rig.client.sessions.count == 1 })
        #expect(rig.client.sessions.map(\.id) == ["other"])
        #expect(rig.client.threads["root"] == nil)
        let record = try #require(rig.client.moved["root"])
        #expect(record.to == "env_mac")
        #expect(record.sessionId == "root")
        #expect(record.subagents == ["child"])
        #expect(record.at >= before)
        #expect(rig.client.moved["child"] == record)
        #expect(rig.client.moved["other"] == nil)
        // Moved back: listed here again, the record goes.
        fake.deliver(#"{"push":"sessions","sessions":\#(json([clientSession("root", updatedAt: 9)]))}"#)
        #expect(await rig.wait { rig.client.sessions.count == 2 })
        #expect(rig.client.moved["root"] == nil)
        #expect(rig.client.moved["child"] == record)
    }

    @Test func `a body comes from the host once and from the cache after`() async throws {
        let rig = try ClientRig()
        await rig.client.start()
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [])
        #expect(await rig.wait { rig.client.hasShell })
        let fetching = Task { await rig.client.body(sessionId: "s1", seq: 8) }
        let request = try #require(await rig.waitForRequest(fake, "session.rowBody"))
        #expect(request.params == .object(["sessionId": .string("s1"), "seq": .number(8)]))
        fake.answer(id: request.id, result: json(["row": textRow("s1", seq: 8, text: "the whole body")]))
        let row = await fetching.value
        if case .assistantText(let text)? = row?.event { #expect(text.text == "the whole body") } else { Issue.record("no body") }
        let again = await rig.client.body(sessionId: "s1", seq: 8)
        #expect(again == row)
        #expect(rig.sent(fake, "session.rowBody").count == 1)
    }

    // MARK: - the return flow

    @Test func `a painted tail is not loading; only an empty thread is`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.store("env_test", sessionId: "s1", rows: (1...10).map { textRow("s1", seq: $0) }, moreBefore: false)
        let rig = try ClientRig(cache: cache)
        await rig.client.start()
        await rig.client.openThread("s1")
        #expect(rig.client.threads["s1"]?.isLoading == false)
        #expect(rig.client.threads["s1"]?.rows.count == 10)
        await rig.client.openThread("s9")
        #expect(rig.client.threads["s9"]?.isLoading == true)
    }

    @Test func `on a new session the open thread catches up before the shell has listed`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.store("env_test", sessionId: "s1", rows: (1...50).map { textRow("s1", seq: $0) }, moreBefore: true)
        let rig = try ClientRig(cache: cache)
        await rig.client.start()
        await rig.client.openThread("s1")
        let fake = await rig.sockets.socket(0)
        fake.hello()
        // The shell's three requests stay unanswered while the thread resumes.
        let subscribe = try #require(await rig.waitForRequest(fake, "session.subscribe"))
        fake.answer(id: subscribe.id, result: "null")
        let events = try #require(await rig.waitForRequest(fake, "session.events"))
        #expect(events.params == .object(["sessionId": .string("s1"), "afterSeq": .number(50)]))
        fake.answer(id: events.id, result: json(EventsPage(rows: (51...55).map { textRow("s1", seq: $0) }, moreBefore: false, moreAfter: false, reset: false)))
        #expect(await rig.wait { rig.client.threads["s1"]?.rows.count == 55 })
        #expect(rig.client.threads["s1"]?.isLive == true)
        #expect(rig.client.status.fresh == false)
        #expect(rig.client.hasShell == false)
        await rig.answerShell(fake, sessions: [clientSession("s1")])
        #expect(await rig.wait { rig.client.status.fresh })
    }

    @Test func `the thread on screen resumes ahead of the other open ones`() async throws {
        let cache = try SessionCache.inMemory()
        for id in ["s1", "s2", "s3"] {
            try await cache.store("env_test", sessionId: id, rows: (1...5).map { textRow(id, seq: $0) }, moreBefore: false)
        }
        let rig = try ClientRig(cache: cache)
        await rig.client.start()
        for id in ["s1", "s2", "s3"] { await rig.client.openThread(id) }
        rig.client.visibleThread = "s3"
        let fake = await rig.sockets.socket(0)
        fake.hello()
        let first = try #require(await rig.waitForRequest(fake, "session.subscribe"))
        #expect(first.params == .object(["sessionId": .string("s3")]))
    }

    @Test func `rows land with motion only on the thread on screen; elsewhere quietly`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.store("env_test", sessionId: "s1", rows: (1...5).map { textRow("s1", seq: $0) }, moreBefore: false)
        try await cache.store("env_test", sessionId: "s2", rows: (1...5).map { textRow("s2", seq: $0) }, moreBefore: false)
        let rig = try ClientRig(cache: cache)
        var quiet = 0
        rig.client.quietly = { body in
            quiet += 1
            body()
        }
        await rig.client.start()
        await rig.client.openThread("s1")
        await rig.client.openThread("s2")
        #expect(quiet == 2, "the first paint of each thread lands quietly")
        rig.client.visibleThread = "s1"
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [clientSession("s1"), clientSession("s2")])
        // Both threads resume in one batch: two subscribes, then two gap pages.
        for n in 1...2 {
            let subscribe = try #require(await rig.waitForRequest(fake, "session.subscribe", count: n))
            fake.answer(id: subscribe.id, result: "null")
        }
        for n in 1...2 {
            let events = try #require(await rig.waitForRequest(fake, "session.events", count: n))
            let id = events.params.objectValue?["sessionId"]?.stringValue ?? ""
            fake.answer(id: events.id, result: json(EventsPage(rows: [textRow(id, seq: 6)], moreBefore: false, moreAfter: false, reset: false)))
        }
        #expect(await rig.wait { rig.client.threads["s1"]?.rows.count == 6 && rig.client.threads["s2"]?.rows.count == 6 })
        #expect(await rig.wait { rig.client.status.fresh })
        let afterCatchUp = quiet
        fake.deliver(#"{"push":"events","sessionId":"s1","rows":\#(json([textRow("s1", seq: 7)]))}"#)
        #expect(await rig.wait { rig.client.threads["s1"]?.rows.count == 7 })
        #expect(quiet == afterCatchUp, "the thread on screen publishes with the view's own motion")
        fake.deliver(#"{"push":"events","sessionId":"s2","rows":\#(json([textRow("s2", seq: 7)]))}"#)
        #expect(await rig.wait { rig.client.threads["s2"]?.rows.count == 7 })
        #expect(quiet == afterCatchUp + 1, "a thread nobody is looking at publishes quietly")
    }

    @Test func `a catch-up that confirms the list republishes nothing`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.replaceWorkspaces("env_test", [sampleWorkspace("w1")])
        try await cache.replaceProjects("env_test", [sampleProject("p1")])
        try await cache.upsertSessions("env_test", [clientSession("s3", updatedAt: 5), clientSession("s1", updatedAt: 2)])
        let rig = try ClientRig(cache: cache)
        var quiet = 0
        rig.client.quietly = { body in
            quiet += 1
            body()
        }
        await rig.client.start()
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [clientSession("s3", updatedAt: 5), clientSession("s1", updatedAt: 2)])
        #expect(await rig.wait { rig.client.status.fresh })
        #expect(quiet == 0, "nothing changed, nothing moved")
        fake.deliver(#"{"push":"sessions","sessions":\#(json([clientSession("s1", updatedAt: 9)]))}"#)
        #expect(await rig.wait { rig.client.sessions.first?.id == "s1" })
        #expect(quiet == 1, "a list nobody is looking at changes quietly")
        rig.client.listVisible = true
        fake.deliver(#"{"push":"sessions","sessions":\#(json([clientSession("s3", updatedAt: 12)]))}"#)
        #expect(await rig.wait { rig.client.sessions.first?.id == "s3" })
        #expect(quiet == 1, "Home on screen animates its own rows")
    }

    // MARK: - the list reconciles from its cursor

    @Test func `a saved cursor reconciles the list with one session.changes and no session.list`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.upsertSessions("env_test", [clientSession("s1", updatedAt: 5), clientSession("s2", updatedAt: 2)])
        try await cache.store("env_test", sessionId: "s2", rows: (1...5).map { textRow("s2", seq: $0) }, moreBefore: false)
        try await cache.setCursor("env_test", ListCursor(seq: 10, generation: "g1"))
        let rig = try ClientRig(cache: cache)
        await rig.client.start()
        #expect(rig.client.shellSource == .cache)
        #expect(rig.client.listCursor == ListCursor(seq: 10, generation: "g1"))
        await rig.client.openThread("s2")
        let fake = await rig.sockets.socket(0)
        fake.hello()
        let changes = try #require(await rig.waitForRequest(fake, "session.changes"))
        #expect(changes.params == .object(["afterSeq": .number(10), "generation": .string("g1")]))
        let subscribe = try #require(await rig.waitForRequest(fake, "session.subscribe"))
        fake.answer(id: subscribe.id, result: "null")
        let events = try #require(await rig.waitForRequest(fake, "session.events"))
        fake.answer(id: events.id, result: json(EventsPage(rows: [], moreBefore: false, moreAfter: false, reset: false)))
        await rig.answerShell(fake, sessions: [], changes: SessionChanges(reset: false, seq: 12, generation: "g1", sessions: [clientSession("s1", title: "Renamed", updatedAt: 5)], removed: ["s2"]))
        #expect(await rig.wait { rig.client.status.fresh })
        #expect(rig.sent(fake, "session.list").isEmpty, "a cursor never lists whole")
        #expect(rig.client.shellSource == .changes)
        #expect(rig.client.hasShell)
        // The changed meta updated in place; the removed one took its thread and subscription with it.
        #expect(rig.client.sessions.map(\.id) == ["s1"])
        #expect(rig.client.session("s1")?.title == "Renamed")
        #expect(rig.client.threads["s2"] == nil)
        #expect(!rig.client.subscriptions.has("s2"))
        #expect(rig.client.listCursor == ListCursor(seq: 12, generation: "g1"))
        #expect(await rig.waitAsync { (try? await cache.cursor("env_test")) == ListCursor(seq: 12, generation: "g1") })
        #expect(await rig.waitAsync { (try? await cache.shell("env_test"))?.sessions.map(\.id) == ["s1"] })
    }

    @Test func `a reconcile that confirms the list republishes nothing`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.upsertSessions("env_test", [clientSession("s1", updatedAt: 5), clientSession("s2", updatedAt: 2)])
        // The workspaces and projects the rig answers, so they confirm the cache too.
        try await cache.replaceWorkspaces("env_test", [sampleWorkspace("w1")])
        try await cache.replaceProjects("env_test", [sampleProject("p1")])
        try await cache.setCursor("env_test", ListCursor(seq: 10, generation: "g1"))
        let rig = try ClientRig(cache: cache)
        var quiet = 0
        rig.client.quietly = { body in
            quiet += 1
            body()
        }
        await rig.client.start()
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [], changes: SessionChanges(reset: false, seq: 10, generation: "g1", sessions: [], removed: []))
        #expect(await rig.wait { rig.client.status.fresh })
        #expect(rig.client.shellSource == .changes)
        #expect(rig.client.sessions.map(\.id) == ["s1", "s2"])
        #expect(quiet == 0, "nothing changed, nothing moved")
    }

    @Test func `a reset answer lists whole and keeps the head as the cursor`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.upsertSessions("env_test", [clientSession("s1", updatedAt: 5), clientSession("s9", updatedAt: 1)])
        try await cache.setCursor("env_test", ListCursor(seq: 10, generation: "g1"))
        let rig = try ClientRig(cache: cache)
        await rig.client.start()
        let fake = await rig.sockets.socket(0)
        fake.hello()
        let changes = try #require(await rig.waitForRequest(fake, "session.changes"))
        #expect(changes.params["generation"] == .string("g1"))
        #expect(rig.sent(fake, "session.list").isEmpty, "with a cursor the whole list is asked only after a reset")
        await rig.answerShell(fake, sessions: [clientSession("s1", updatedAt: 5), clientSession("s2", updatedAt: 7)], changes: SessionChanges(reset: true, seq: 30, generation: "g2"))
        #expect(await rig.wait { rig.client.status.fresh })
        #expect(rig.client.shellSource == .list)
        #expect(rig.client.sessions.map(\.id) == ["s2", "s1"], "the whole walk replaced the list; s9 was not listed and is gone")
        #expect(rig.client.listCursor == ListCursor(seq: 30, generation: "g2"))
        #expect(await rig.waitAsync { (try? await cache.cursor("env_test")) == ListCursor(seq: 30, generation: "g2") })
    }

    @Test func `no cursor asks for the head beside the whole list and stores it`() async throws {
        let rig = try ClientRig()
        await rig.client.start()
        #expect(rig.client.shellSource == .none)
        #expect(rig.client.listCursor == nil)
        let fake = await rig.sockets.socket(0)
        fake.hello()
        let changes = try #require(await rig.waitForRequest(fake, "session.changes"))
        #expect(changes.params == .object(["afterSeq": .number(0)]))
        #expect(await rig.waitForRequest(fake, "session.list") != nil, "the first page goes out alongside: no extra round trip")
        await rig.answerShell(fake, sessions: [clientSession("s1")], changes: SessionChanges(reset: true, seq: 5, generation: "g1"))
        #expect(await rig.wait { rig.client.status.fresh })
        #expect(rig.client.shellSource == .list)
        #expect(rig.client.sessions.map(\.id) == ["s1"])
        #expect(rig.client.listCursor == ListCursor(seq: 5, generation: "g1"))
        #expect(await rig.waitAsync { (try? await rig.cache.cursor("env_test")) == ListCursor(seq: 5, generation: "g1") })
    }

    @Test func `a host without session.changes lists whole and leaves no cursor`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.setCursor("env_test", ListCursor(seq: 10, generation: "g1"))
        let rig = try ClientRig(cache: cache)
        await rig.client.start()
        let fake = await rig.sockets.socket(0)
        fake.hello()
        let changes = try #require(await rig.waitForRequest(fake, "session.changes"))
        fake.refuse(id: changes.id, error: "unknown method session.changes")
        await rig.answerShell(fake, sessions: [clientSession("s1")], changes: nil)
        #expect(await rig.wait { rig.client.status.fresh })
        #expect(rig.client.shellSource == .list)
        #expect(rig.client.sessions.map(\.id) == ["s1"])
        #expect(rig.client.listCursor == nil)
        #expect(await rig.waitAsync { (try? await cache.cursor("env_test")) == nil })
    }

    @Test func `the thread on screen stays seen when its rows land before its meta`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.upsertSessions("env_test", [clientSession("s1", updatedAt: 5)])
        try await cache.store("env_test", sessionId: "s1", rows: (1...5).map { textRow("s1", seq: $0) }, moreBefore: false)
        try await cache.markSeen("env_test", sessionId: "s1", at: 5, seq: 5)
        let rig = try ClientRig(cache: cache)
        await rig.client.start()
        rig.client.visibleThread = "s1"
        await rig.client.openThread("s1")
        let fake = await rig.sockets.socket(0)
        fake.hello()
        let subscribe = try #require(await rig.waitForRequest(fake, "session.subscribe"))
        fake.answer(id: subscribe.id, result: "null")
        let events = try #require(await rig.waitForRequest(fake, "session.events"))
        fake.answer(id: events.id, result: json(EventsPage(rows: (6...8).map { textRow("s1", seq: $0) }, moreBefore: false, moreAfter: false, reset: false)))
        #expect(await rig.wait { rig.client.threads["s1"]?.rows.count == 8 })
        // The rows are on screen; the mark follows them, still against the old meta.
        #expect(rig.client.seen["s1"] == SeenMark(at: 5, seq: 8))
        await rig.answerShell(fake, sessions: [clientSession("s1", updatedAt: 9)])
        #expect(await rig.wait { rig.client.status.fresh })
        // The fresh meta re-marks the thread the person is looking at.
        #expect(rig.client.seen["s1"] == SeenMark(at: 9, seq: 8))
        #expect(await rig.waitAsync { (try? await cache.seen("env_test"))?["s1"] == SeenMark(at: 9, seq: 8) })
        // A thread nobody is looking at is left as it was.
        fake.deliver(#"{"push":"sessions","sessions":\#(json([clientSession("s2", updatedAt: 11)]))}"#)
        #expect(await rig.wait { rig.client.session("s2") != nil })
        #expect(rig.client.seen["s2"] == nil)
    }

    @Test func `a reset page lands quietly even on the thread on screen`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.store("env_test", sessionId: "s1", rows: (1...20).map { textRow("s1", seq: $0) }, moreBefore: false)
        let rig = try ClientRig(cache: cache)
        var quiet = 0
        rig.client.quietly = { body in
            quiet += 1
            body()
        }
        await rig.client.start()
        rig.client.visibleThread = "s1"
        await rig.client.openThread("s1")
        #expect(quiet == 1, "the first paint from the cache")
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [clientSession("s1")])
        #expect(await rig.wait { rig.client.hasShell })
        let listed = quiet   // the list, which nobody is looking at, landed quietly
        let subscribe = try #require(await rig.waitForRequest(fake, "session.subscribe"))
        fake.answer(id: subscribe.id, result: "null")
        let events = try #require(await rig.waitForRequest(fake, "session.events"))
        fake.answer(id: events.id, result: json(EventsPage(rows: (900...905).map { textRow("s1", seq: $0) }, moreBefore: true, moreAfter: false, reset: true)))
        #expect(await rig.wait { rig.client.threads["s1"]?.rows.first?.seq == 900 })
        #expect(quiet == listed + 1, "a replaced tail is a fresh paint, not rows arriving")
        fake.deliver(#"{"push":"events","sessionId":"s1","rows":\#(json([textRow("s1", seq: 906)]))}"#)
        #expect(await rig.wait { rig.client.threads["s1"]?.rows.count == 7 })
        #expect(quiet == listed + 1, "rows arriving on the thread on screen keep the view's motion")
    }

    @Test func `the boot-resume push surfaces once per boot, across launches`() async throws {
        let cache = try SessionCache.inMemory()
        let rig = try ClientRig(cache: cache)
        await rig.client.start()
        let fake = await rig.sockets.socket(0)
        fake.hello()
        #expect(rig.client.bootResume == nil)
        fake.deliver(#"{"push":"boot-resume","count":3,"at":1700}"#)
        #expect(await rig.wait { rig.client.bootResume == BootResumeNotice(count: 3, at: 1700) })
        rig.client.dismissBootResume()
        #expect(rig.client.bootResume == nil)
        // The host repeats it after every hello; the same boot shows nothing.
        fake.deliver(#"{"push":"boot-resume","count":3,"at":1700}"#)
        fake.deliver(#"{"push":"sessions","sessions":\#(json([clientSession("s1", title: "after the repeat")]))}"#)
        #expect(await rig.wait { rig.client.session("s1")?.title == "after the repeat" })
        #expect(rig.client.bootResume == nil)
        // Another boot surfaces again.
        fake.deliver(#"{"push":"boot-resume","count":1,"at":1800}"#)
        #expect(await rig.wait { rig.client.bootResume == BootResumeNotice(count: 1, at: 1800) })
        await rig.client.stop()
        // The next launch on the same cache still knows that boot.
        let next = try ClientRig(cache: cache)
        await next.client.start()
        let socket = await next.sockets.socket(0)
        socket.hello()
        socket.deliver(#"{"push":"boot-resume","count":1,"at":1800}"#)
        socket.deliver(#"{"push":"sessions","sessions":\#(json([clientSession("s1", title: "next launch")]))}"#)
        #expect(await next.wait { next.client.session("s1")?.title == "next launch" })
        #expect(next.client.bootResume == nil)
        await next.client.stop()
    }

    @Test func `a peeked tail refreshes once the thread's meta moves past it`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.upsertSessions("env_test", [clientSession("s1", updatedAt: 5)])
        try await cache.store("env_test", sessionId: "s1", rows: (1...3).map { textRow("s1", seq: $0) }, moreBefore: false)
        let rig = try ClientRig(cache: cache)
        await rig.client.start()
        // No socket yet: the cache is the answer.
        #expect(seqs(await rig.client.peekTail("s1")) == [1, 2, 3])
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [clientSession("s1", updatedAt: 5)])
        #expect(await rig.wait { rig.client.status.fresh })
        // The socket is up and the tail was never fetched for this meta: one page from the host.
        let peeking = Task { await rig.client.peekTail("s1") }
        let first = try #require(await rig.waitForRequest(fake, "session.events"))
        #expect(first.params == .object(["sessionId": .string("s1"), "tail": .number(24)]))
        fake.answer(id: first.id, result: json(EventsPage(rows: (1...4).map { textRow("s1", seq: $0) }, moreBefore: false, moreAfter: false, reset: false)))
        #expect(seqs(await peeking.value) == [1, 2, 3, 4])
        // The same meta again: the cache, no request.
        #expect(seqs(await rig.client.peekTail("s1")) == [1, 2, 3, 4])
        #expect(rig.sent(fake, "session.events").count == 1)
        // The thread moved on (a second approval): the tail is fetched again.
        fake.deliver(#"{"push":"sessions","sessions":\#(json([clientSession("s1", updatedAt: 9)]))}"#)
        #expect(await rig.wait { rig.client.session("s1")?.updatedAt == 9 })
        let again = Task { await rig.client.peekTail("s1") }
        let second = try #require(await rig.waitForRequest(fake, "session.events", count: 2))
        fake.answer(id: second.id, result: json(EventsPage(rows: (1...5).map { textRow("s1", seq: $0) }, moreBefore: false, moreAfter: false, reset: false)))
        #expect(seqs(await again.value) == [1, 2, 3, 4, 5])
        #expect(await rig.waitAsync { (try? await cache.cursor("env_test", sessionId: "s1")) == 5 })
    }
}
