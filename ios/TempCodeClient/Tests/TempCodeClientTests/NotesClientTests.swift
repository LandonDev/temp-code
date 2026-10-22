import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func notesEnvironment(caps: [Capability]) -> PairedEnvironment {
    PairedEnvironment(id: "env_test", name: "box", origin: URL(string: "https://box.example")!, caps: caps, keyId: "K1", keyName: "iphone", addedAt: 0)
}

/// A client on a fake socket, the shell listed and `s1` open (ActionsTests' rig, for the notes).
@MainActor
private final class NotesRig {
    let clock = ManualClock(random: [0])
    let sockets = FakeSocketFactory()
    let keys = InMemoryKeyStore()
    let environment: PairedEnvironment
    let client: EnvironmentClient

    init(caps: [Capability] = [.read, .operate]) throws {
        environment = notesEnvironment(caps: caps)
        try keys.set("tc_K1.secret", for: "env_test")
        let api = RemoteAPI { request in
            (Data(#"{"ticket":"t","expiresIn":30}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        client = EnvironmentClient(environment: environment, keys: keys, cache: try SessionCache.inMemory(), api: api, connect: sockets.factory, clock: clock)
    }

    func open() async throws -> FakeWebSocket {
        await client.start()
        await client.openThread("s1")
        let fake = await sockets.socket(0)
        fake.hello(caps: environment.caps.map(\.rawValue))
        var answered: Set<String> = []
        for _ in 0..<4000 {
            for sent in fake.sentRequests where !answered.contains(sent.id) {
                switch sent.method {
                case "workspace.list": fake.answer(id: sent.id, result: json([sampleWorkspace("w1")]))
                case "project.list": fake.answer(id: sent.id, result: json([sampleProject("p1")]))
                // The client asks for the change log at open; reset makes it list whole.
                case "session.changes": fake.answer(id: sent.id, result: json(SessionChanges(reset: true, seq: 1, generation: "g")))
                case "session.list": fake.answer(id: sent.id, result: json(SessionPage(sessions: [sampleSession("s1"), sampleSession("s2")], cursor: nil)))
                case "session.subscribe": fake.answer(id: sent.id, result: "null")
                case "session.events": fake.answer(id: sent.id, result: json(EventsPage(rows: [textRow("s1", seq: 1)], moreBefore: false, moreAfter: false, reset: false)))
                default: continue
                }
                answered.insert(sent.id)
            }
            if client.threads["s1"]?.isLive == true, client.status.transport == .open { return fake }
            await Task.yield()
        }
        throw TransportError.notConnected
    }

    /// The `count`th request of `method` sent so far, once it has gone out.
    func request(_ fake: FakeWebSocket, _ method: String, count: Int = 1) async -> (id: String, method: String, params: JSONValue)? {
        for _ in 0..<4000 {
            let matching = fake.sentRequests.filter { $0.method == method }
            if matching.count >= count { return matching[count - 1] }
            await Task.yield()
        }
        return nil
    }

    func wait(_ predicate: () -> Bool) async -> Bool {
        for _ in 0..<4000 {
            if predicate() { return true }
            await Task.yield()
        }
        return false
    }

    func sent(_ fake: FakeWebSocket, _ method: String) -> Int {
        fake.sentRequests.filter { $0.method == method }.count
    }
}

private let goal = ThreadNotesDoc(text: "## Goal\n\nShip.\n", updatedAt: 5, path: nil)

@MainActor
@Suite struct NotesClientTests {
    @Test func `loadNotes asks once, holds the answer and answers from memory after; refresh asks again`() async throws {
        let rig = try NotesRig()
        let fake = try await rig.open()
        let loading = Task { await rig.client.loadNotes("s1") }
        let request = try #require(await rig.request(fake, "session.notes.get"))
        #expect(request.params == .object(["sessionId": .string("s1")]))
        #expect(rig.client.notes["s1"]?.isLoading == true)
        fake.answer(id: request.id, result: json(goal))
        #expect(await loading.value == goal)
        #expect(rig.client.notes["s1"] == NotesState(doc: goal))
        #expect(await rig.client.loadNotes("s1") == goal)
        #expect(rig.sent(fake, "session.notes.get") == 1, "the second call came from memory")
        let refreshing = Task { await rig.client.loadNotes("s1", refresh: true) }
        let again = try #require(await rig.request(fake, "session.notes.get", count: 2))
        let newer = ThreadNotesDoc(text: "## Goal\n\nShip it.\n", updatedAt: 6, path: "/tmp/notes.md")
        fake.answer(id: again.id, result: json(newer))
        #expect(await refreshing.value == newer)
        #expect(rig.client.notes["s1"]?.doc == newer)
        await rig.client.stop()
    }

    @Test func `a notes push replaces the held doc for its thread alone, and the same doc twice changes nothing`() async throws {
        let rig = try NotesRig()
        let fake = try await rig.open()
        let loading = Task { await rig.client.loadNotes("s2") }
        let request = try #require(await rig.request(fake, "session.notes.get"))
        fake.answer(id: request.id, result: json(ThreadNotesDoc(text: "## Goal\n\nOther.\n", updatedAt: 1, path: nil)))
        _ = await loading.value
        fake.deliver(###"{"push":"notes","sessionId":"s1","doc":{"text":"## Goal\n\nShip.\n","updatedAt":5,"path":null}}"###)
        #expect(await rig.wait { rig.client.notes["s1"]?.doc == goal })
        #expect(rig.client.notes["s2"]?.doc?.text == "## Goal\n\nOther.\n")
        let before = rig.client.notes["s1"]
        fake.deliver(###"{"push":"notes","sessionId":"s1","doc":{"text":"## Goal\n\nShip.\n","updatedAt":5,"path":null}}"###)
        fake.deliver(###"{"push":"notes","sessionId":"s2","doc":{"text":"## Goal\n\nOther, more.\n","updatedAt":2,"path":null}}"###)
        #expect(await rig.wait { rig.client.notes["s2"]?.doc?.updatedAt == 2 })
        #expect(rig.client.notes["s1"] == before)
        await rig.client.stop()
    }

    @Test func `saveNotes sends the text and holds the answer; a read key is refused before the wire`() async throws {
        let rig = try NotesRig()
        let fake = try await rig.open()
        let saving = Task { try await rig.client.saveNotes("s1", text: "## Goal\n\nShip.\n") }
        let request = try #require(await rig.request(fake, "session.notes.set"))
        #expect(request.params == .object(["sessionId": .string("s1"), "text": .string("## Goal\n\nShip.\n")]))
        fake.answer(id: request.id, result: json(goal))
        #expect(try await saving.value == goal)
        #expect(rig.client.notes["s1"]?.doc == goal)
        await rig.client.stop()

        let reader = try NotesRig(caps: [.read])
        let readerFake = try await reader.open()
        await #expect(throws: ActionError.blocked(.readOnly)) { try await reader.client.saveNotes("s1", text: "x") }
        #expect(reader.sent(readerFake, "session.notes.set") == 0)
        await reader.client.stop()
    }

    @Test func `a removed thread drops its notes`() async throws {
        let rig = try NotesRig()
        let fake = try await rig.open()
        fake.deliver(###"{"push":"notes","sessionId":"s1","doc":{"text":"## Goal\n\nShip.\n","updatedAt":5,"path":null}}"###)
        #expect(await rig.wait { rig.client.notes["s1"]?.doc == goal })
        fake.deliver(json(ServerPush.sessionRemoved(SessionRemovedPush(sessionIds: ["s1"]))))
        #expect(await rig.wait { rig.client.notes["s1"] == nil })
        #expect(rig.client.sessions.map(\.id) == ["s2"])
        await rig.client.stop()
    }

    @Test func `a cancelled fetch holds no error, and a thread removed mid-fetch stays gone`() async throws {
        let rig = try NotesRig()
        let fake = try await rig.open()
        let loading = Task { await rig.client.loadNotes("s1") }
        _ = try #require(await rig.request(fake, "session.notes.get"))
        loading.cancel()
        _ = await loading.value
        #expect(rig.client.notes["s1"]?.error == nil)
        #expect(rig.client.notes["s1"]?.isLoading == false)
        let again = Task { await rig.client.loadNotes("s2") }
        let request = try #require(await rig.request(fake, "session.notes.get", count: 2))
        fake.deliver(json(ServerPush.sessionRemoved(SessionRemovedPush(sessionIds: ["s2"]))))
        #expect(await rig.wait { !rig.client.sessions.contains { $0.id == "s2" } })
        fake.answer(id: request.id, result: json(goal))
        _ = await again.value
        #expect(rig.client.notes["s2"] == nil)
        await rig.client.stop()
    }

    @Test func `a failed fetch leaves no doc, loading off and the error held`() async throws {
        let rig = try NotesRig()
        let fake = try await rig.open()
        let loading = Task { await rig.client.loadNotes("s1") }
        let request = try #require(await rig.request(fake, "session.notes.get"))
        fake.refuse(id: request.id, error: "unknown session: s1")
        #expect(await loading.value == nil)
        #expect(rig.client.notes["s1"]?.doc == nil)
        #expect(rig.client.notes["s1"]?.isLoading == false)
        #expect(rig.client.notes["s1"]?.error == .refused(message: "unknown session: s1", forbidden: false))
        await rig.client.stop()
    }
}
