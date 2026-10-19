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

    /// Answers the shell listing a fresh session asks for, as the three
    /// requests appear: workspaces, projects, one session page.
    func answerShell(_ fake: FakeWebSocket, sessions: [SessionMeta]) async {
        var answered: Set<String> = []
        for _ in 0..<2000 {
            for sent in fake.sentRequests where !answered.contains(sent.id) {
                switch sent.method {
                case "workspace.list": fake.answer(id: sent.id, result: json([sampleWorkspace("w1")]))
                case "project.list": fake.answer(id: sent.id, result: json([sampleProject("p1")]))
                case "session.list": fake.answer(id: sent.id, result: json(SessionPage(sessions: sessions, cursor: nil)))
                default: continue
                }
                answered.insert(sent.id)
            }
            if answered.count >= 3 { return }
            await Task.yield()
        }
        Issue.record("the shell was never listed")
    }

    /// Waits until `predicate` holds on the main actor.
    func wait(_ predicate: () -> Bool) async -> Bool {
        for _ in 0..<2000 {
            if predicate() { return true }
            await Task.yield()
        }
        return false
    }

    /// Waits until the async `predicate` holds.
    func waitAsync(_ predicate: () async -> Bool) async -> Bool {
        for _ in 0..<2000 {
            if await predicate() { return true }
            await Task.yield()
        }
        return false
    }

    /// The requests of `method` sent on `fake` so far.
    func sent(_ fake: FakeWebSocket, _ method: String) -> [(id: String, method: String, params: JSONValue)] {
        fake.sentRequests.filter { $0.method == method }
    }

    func waitForRequest(_ fake: FakeWebSocket, _ method: String, count: Int = 1) async -> (id: String, method: String, params: JSONValue)? {
        for _ in 0..<2000 {
            let matching = sent(fake, method)
            if matching.count >= count { return matching[count - 1] }
            await Task.yield()
        }
        return nil
    }
}

private func seqs(_ rows: [EventRow]) -> [Int] { rows.map(\.seq) }

@MainActor
@Suite struct EnvironmentClientTests {
    @Test func `a cold launch paints the cached shell and tail before the socket is up`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.replaceProjects("env_test", [sampleProject("p1")])
        try await cache.upsertSessions("env_test", [sampleSession("s1", updatedAt: 3), sampleSession("s2", updatedAt: 1)])
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
        await rig.answerShell(fake, sessions: [sampleSession("s1"), sampleSession("s3")])
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

    @Test func `a cold thread opens with a tail and pushes append without duplicates`() async throws {
        let rig = try ClientRig()
        await rig.client.start()
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [sampleSession("s1")])
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
        await rig.answerShell(first, sessions: [sampleSession("s1")])
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
        await rig.answerShell(second, sessions: [sampleSession("s1")])
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

    @Test func `a reset page throws the fold away`() async throws {
        let cache = try SessionCache.inMemory()
        try await cache.store("env_test", sessionId: "s1", rows: (1...20).map { textRow("s1", seq: $0) }, moreBefore: false)
        let rig = try ClientRig(cache: cache)
        await rig.client.start()
        await rig.client.openThread("s1")
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [sampleSession("s1")])
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
        await rig.answerShell(fake, sessions: [sampleSession("s1")])
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

    @Test func `sessions pushes merge newest first and removals drop the thread`() async throws {
        let rig = try ClientRig()
        await rig.client.start()
        let fake = await rig.sockets.socket(0)
        fake.hello()
        await rig.answerShell(fake, sessions: [sampleSession("s1", updatedAt: 1), sampleSession("s2", updatedAt: 2)])
        #expect(await rig.wait { rig.client.sessions.count == 2 })
        #expect(rig.client.sessions.map(\.id) == ["s2", "s1"])
        fake.deliver(#"{"push":"sessions","sessions":\#(json([sampleSession("s1", title: "Renamed", updatedAt: 9)]))}"#)
        #expect(await rig.wait { rig.client.sessions.first?.title == "Renamed" })
        await rig.client.openThread("s2")
        fake.deliver(#"{"push":"session-removed","sessionIds":["s2"]}"#)
        #expect(await rig.wait { rig.client.sessions.count == 1 })
        #expect(rig.client.threads["s2"] == nil)
        #expect(!rig.client.subscriptions.has("s2"))
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
}
