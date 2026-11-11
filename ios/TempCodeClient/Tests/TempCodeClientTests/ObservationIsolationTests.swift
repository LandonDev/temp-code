import Foundation
import Observation
import Synchronization
import Testing
import TempCodeContract
@testable import TempCodeClient

// What a push may re-run (docs/IOS-DESIGN.md "Performance"): a reader of one
// thread hears that thread's writes and no other's, a reader of one session
// its own meta, and each projection only its own answer changing. Each case
// reads under `withObservationTracking`, makes a change, and says whether
// the reader was told.

/// A client that is never started: threads are held and metas adopted by hand.
@MainActor
private func idleClient() throws -> EnvironmentClient {
    let keys = InMemoryKeyStore()
    try keys.set("tc_K1.secret", for: "env_test")
    let environment = PairedEnvironment(id: "env_test", name: "box", origin: URL(string: "https://box.example")!, caps: [.read], keyId: "K1", keyName: "iphone", addedAt: 0)
    let api = RemoteAPI { request in
        (Data(#"{"ticket":"t","expiresIn":30}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
    return EnvironmentClient(environment: environment, keys: keys, cache: try SessionCache.inMemory(), api: api, connect: FakeSocketFactory().factory, clock: ManualClock(random: [0]))
}

/// True when a reader that ran `read` was told of a change `change` made.
@MainActor
private func hears(_ read: () -> Void, when change: () -> Void) -> Bool {
    let told = Mutex(false)
    withObservationTracking(read) { told.withLock { $0 = true } }
    change()
    return told.withLock { $0 }
}

@MainActor
@Suite struct ObservationIsolationTests {
    @Test func `a reader of one thread hears that thread's rows and no other's`() throws {
        let client = try idleClient()
        client.threads["a"] = ThreadState()
        client.threads["b"] = ThreadState()
        #expect(!hears({ _ = client.threads["a"] }, when: { client.write("b") { $0.append([textRow("b", seq: 1)], trim: false) } }))
        #expect(!hears({ _ = client.thread("a")?.content }, when: { client.adopt(sampleSession("b", updatedAt: 5)) }))
        #expect(!hears({ _ = client.threads["a"] }, when: { client.adopt(sampleSession("a", updatedAt: 6)) }), "its own meta is the session's, not the thread's")
        #expect(hears({ _ = client.threads["a"] }, when: { client.write("a") { $0.append([textRow("a", seq: 1)], trim: false) } }))
        #expect(client.threads["a"]?.rows.count == 1)
        #expect(client.threads["b"]?.rows.count == 1)
    }

    @Test func `each of a thread's projections moves only when its own answer does`() throws {
        let client = try idleClient()
        client.threads["a"] = ThreadState()
        let model = try #require(client.thread("a"))
        // Rows: the content, not the dock.
        #expect(hears({ _ = model.content }, when: { client.write("a") { $0.append([textRow("a", seq: 1)], trim: false) } }))
        #expect(!hears({ _ = model.dock }, when: { client.write("a") { $0.append([textRow("a", seq: 2)], trim: false) } }))
        #expect(!hears({ _ = model.overlays }, when: { client.write("a") { $0.append([textRow("a", seq: 3)], trim: false) } }))
        // A flag: the flags, not the content.
        #expect(!hears({ _ = model.content }, when: { client.write("a") { $0.isLoadingOlder = true } }))
        #expect(hears({ _ = model.flags }, when: { client.write("a") { $0.isLoadingOlder = false } }))
        // A click: the dock, not the content.
        #expect(!hears({ _ = model.content }, when: { client.write("a") { $0.beginSend(status: .idle, at: 10) } }))
        #expect(hears({ _ = model.dock }, when: { client.write("a") { $0.observe(sampleSession("a", status: .running, busySince: 12)) } }))
        // A decision: the overlays alone.
        #expect(!hears({ _ = model.flags }, when: { client.write("a") { $0.decisions["r1"] = true } }))
        #expect(hears({ _ = model.overlays }, when: { client.write("a") { $0.decisions["r1"] = nil } }))
        // A pending send is content: its row is drawn.
        #expect(hears({ _ = model.content }, when: { client.write("a") { _ = $0.addPending(text: "hello", sentAt: 20) } }))
        // A write that changes nothing still wakes the whole state's reader, and none of the four.
        #expect(!hears({ _ = model.content; _ = model.dock; _ = model.flags; _ = model.overlays }, when: { client.write("a") { $0.isLive = $0.isLive } }))
        #expect(hears({ _ = model.state }, when: { client.write("a") { $0.isLive = $0.isLive } }))
    }

    @Test func `a reader that asked for a thread before it was held hears it arrive, and leave`() throws {
        let client = try idleClient()
        #expect(client.thread("c") == nil)
        #expect(hears({ _ = client.thread("c") }, when: { client.threads["c"] = ThreadState() }))
        #expect(client.thread("c") != nil)
        #expect(hears({ _ = client.threads["c"] }, when: { client.threads["c"] = nil }))
        #expect(client.threads["c"] == nil)
        // A thread already held, written whole, is the same model.
        client.threads["d"] = ThreadState()
        let model = client.thread("d")
        var loading = ThreadState()
        loading.isLoading = true
        #expect(!hears({ _ = client.thread("e") }, when: { client.threads["d"] = loading }))
        #expect(client.thread("d") === model)
        #expect(client.thread("d")?.flags.isLoading == true)
    }

    @Test func `a reader of one session hears its own meta and no other's, listed or not yet`() throws {
        let client = try idleClient()
        client.adopt(sampleSession("s1", updatedAt: 1))
        #expect(!hears({ _ = client.session("s1") }, when: { client.adopt(sampleSession("s2", updatedAt: 2)) }))
        #expect(hears({ _ = client.session("s1") }, when: { client.adopt(sampleSession("s1", title: "Renamed", updatedAt: 3)) }))
        #expect(client.session("s1")?.title == "Renamed")
        // An equal meta is no news to anyone.
        #expect(!hears({ _ = client.session("s1") }, when: { client.adopt(sampleSession("s1", title: "Renamed", updatedAt: 3)) }))
        // Asked before the host listed it: the arrival is heard.
        #expect(client.session("s9") == nil)
        #expect(hears({ _ = client.session("s9") }, when: { client.adopt(sampleSession("s9", updatedAt: 4)) }))
        #expect(client.session("s9") != nil)
    }

    @Test func `a reader of a thread's children hears a change in its own children alone`() throws {
        let client = try idleClient()
        client.adopt(meta("root"))
        client.adopt(meta("other"))
        client.adopt(meta("kid", parentId: "root", status: .running, updatedAt: 2))
        #expect(client.children(of: "root").map(\.id) == ["kid"])
        #expect(!hears({ _ = client.children(of: "root") }, when: { client.adopt(meta("stranger", parentId: "other", updatedAt: 3)) }))
        #expect(!hears({ _ = client.children(of: "root") }, when: { client.adopt(meta("other", updatedAt: 4, title: "Renamed")) }))
        #expect(hears({ _ = client.children(of: "root") }, when: { client.adopt(meta("kid", parentId: "root", status: .idle, updatedAt: 5)) }))
        #expect(hears({ _ = client.children(of: "root") }, when: { client.adopt(meta("kid2", parentId: "root", updatedAt: 6)) }))
        #expect(Set(client.children(of: "root").map(\.id)) == ["kid", "kid2"])
        // The cue of a root moves with its agents, not with a stranger's.
        #expect(!hears({ _ = client.agentsCue(of: "root") }, when: { client.adopt(meta("stranger", parentId: "other", status: .running, updatedAt: 7)) }))
        #expect(hears({ _ = client.agentsCue(of: "root") }, when: { client.adopt(meta("kid2", parentId: "root", status: .waiting, updatedAt: 8)) }))
    }

    @Test func `the client acts on the meta as it is while the list screens' copy trails`() async throws {
        let client = try idleClient()
        // The first meta reaches the lists at once; the next, inside a quarter second, waits.
        client.adopt(sampleSession("s1", updatedAt: 1))
        #expect(client.listedSessions.map(\.id) == ["s1"])
        client.adopt(sampleSession("s2", updatedAt: 2, status: .waiting))
        client.adopt(sampleSession("s1", updatedAt: 3, status: .waiting))
        #expect(client.listedSessions.map(\.id) == ["s1"], "no list is on screen: the copy is at most four a second")
        #expect(client.listedSessions.first?.status == .idle)
        // Everything that acts reads the store: the order, the meta, the badge's count.
        #expect(client.currentSessions.map(\.id) == ["s1", "s2"])
        #expect(client.currentSession("s1")?.status == .waiting)
        #expect(client.session("s2")?.status == .waiting)
        #expect(HomeModel.needsYouCount(client.currentSessions) == 2)
        // The mark a thread on screen gets is stamped from the fresh meta.
        client.threads["s1"] = ThreadState()
        client.markSeen("s1")
        #expect(client.currentSeen["s1"]?.at == 3)
        // A list that shows is current at once.
        client.listVisible = true
        #expect(client.listedSessions.map(\.id) == ["s1", "s2"])
        #expect(client.seen["s1"]?.at == 3)
        // And without one, the copy catches up on its own inside the quarter second.
        client.listVisible = false
        client.adopt(sampleSession("s3", updatedAt: 9))
        let deadline = ContinuousClock.now.advanced(by: waitDeadline)
        while client.listedSessions.count < 3, ContinuousClock.now < deadline { try? await Task.sleep(for: .milliseconds(5)) }
        #expect(client.listedSessions.map(\.id) == ["s3", "s1", "s2"])
    }

    @Test func `a thread that leaves its host leaves every list at once`() throws {
        let client = try idleClient()
        client.adopt(sampleSession("s1", updatedAt: 1))
        client.adopt(sampleSession("s2", updatedAt: 2))
        client.listVisible = true
        client.listVisible = false
        client.threads["s2"] = ThreadState()
        #expect(hears({ _ = client.session("s2") }, when: { client.forget(["s2"]) }))
        #expect(client.listedSessions.map(\.id) == ["s1"])
        #expect(client.currentSession("s2") == nil)
        #expect(client.thread("s2") == nil)
    }
}

@MainActor
@Suite struct SessionStoreTests {
    @Test func `a meta takes its place by the order, newest first, ids breaking ties`() {
        let store = SessionStore()
        for (id, at) in [("a", 5), ("c", 9), ("b", 9), ("d", 1)] { store.put(sampleSession(id, updatedAt: at)) }
        #expect(store.sorted.map(\.id) == ["c", "b", "a", "d"])
        // A changed meta moves; one whose time did not move stays where it is.
        #expect(store.put(sampleSession("d", updatedAt: 10))?.updatedAt == 1)
        #expect(store.sorted.map(\.id) == ["d", "c", "b", "a"])
        store.put(sampleSession("b", title: "Renamed", updatedAt: 9))
        #expect(store.sorted.map(\.id) == ["d", "c", "b", "a"])
        #expect(store.byId["b"]?.title == "Renamed")
        #expect(store.sorted.count == store.byId.count)
        store.remove(["c", "a"])
        #expect(store.sorted.map(\.id) == ["d", "b"])
        #expect(store.byId["c"] == nil)
    }

    @Test func `the store is the order a sort of every meta would give`() {
        let store = SessionStore()
        var metas: [String: SessionMeta] = [:]
        var seed: UInt64 = 7
        func next(_ bound: Int) -> Int {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Int((seed >> 33) % UInt64(bound))
        }
        for _ in 0..<400 {
            let meta = sampleSession("s\(next(40))", updatedAt: next(60))
            metas[meta.id] = meta
            store.put(meta)
        }
        #expect(store.sorted == metas.values.sorted { ($0.updatedAt, $0.id) > ($1.updatedAt, $1.id) })
    }

    @Test func `a slot made before its session is listed is told when it is, and when it goes`() {
        let store = SessionStore()
        let slot = store.slot("s1")
        #expect(slot.meta == nil)
        store.put(sampleSession("s1", updatedAt: 1))
        #expect(slot.meta?.id == "s1")
        #expect(store.slot("s1") === slot)
        store.remove(["s1"])
        #expect(slot.meta == nil)
        store.replace([sampleSession("s1", updatedAt: 4), sampleSession("s2", updatedAt: 2)])
        #expect(slot.meta?.updatedAt == 4)
        #expect(store.sorted.map(\.id) == ["s1", "s2"])
    }
}
