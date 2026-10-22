import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

// The streaming path through the client: a batch is one change set applied
// in place, partial calls fold without a whole refold wherever they sit,
// and the live-edits push lands on the open thread's running edit row.

private func partialRow(_ callId: String, _ name: String = "Edit", path: String = "src/a.ts", ts: Int = 50) -> EventRow {
    EventRow(sessionId: "s1", seq: -1, ts: ts, event: .toolCall(ToolCallEvent(callId: callId, name: name, input: .object(["file_path": .string(path)]), partial: true)), ephemeral: true)
}

private func callRow(_ seq: Int, _ callId: String, _ name: String = "Edit", path: String = "src/a.ts") -> EventRow {
    EventRow(sessionId: "s1", seq: seq, ts: seq, event: .toolCall(ToolCallEvent(callId: callId, name: name, input: .object(["file_path": .string(path)]))))
}

private func runningEdit(_ state: ThreadState) -> ToolItem? {
    for entry in state.fold.items.reversed() {
        if case .tool(let tool) = entry.item, tool.status == .running { return tool }
    }
    return nil
}

@Suite struct ThreadStateStreamingTests {
    @Test func `a batch of twelve rows bumps the revision once and folds each row`() {
        var state = ThreadState()
        state.rows = (1...5).map { textRow("s1", seq: $0) }
        state.fold = ThreadFold.fold(state.rows)
        let revision = state.revision
        state.append((6...17).map { textRow("s1", seq: $0) }, trim: true)
        #expect(state.revision == revision + 1)
        #expect(state.fold.items.count == 17)
        #expect(state.refolds == 0)
        #expect(state.cursor == 17)
    }

    @Test func `a partial replaced behind a later text row folds in place, no whole refold`() {
        var state = ThreadState()
        state.append([textRow("s1", seq: 1), partialRow("c1", path: "src/a")], trim: true)
        #expect(state.refolds == 0)
        #expect(runningEdit(state)?.seq == -1_000)
        // A text row lands after the preview, then the preview grows: the
        // preview's row is no longer at the tail.
        state.append([textRow("s1", seq: 2)], trim: true)
        state.append([partialRow("c1", path: "src/a.ts")], trim: true)
        #expect(state.refolds == 0)
        #expect(state.rows.map(\.seq) == [1, -1, 2])
        #expect(runningEdit(state)?.input?["file_path"]?.stringValue == "src/a.ts")
        #expect(runningEdit(state)?.seq == -1_000, "the same item, updated by callId")
        #expect(state.fold.items.count == 3)
    }

    @Test func `a final call retires its preview and stamps the item without a refold`() {
        var state = ThreadState()
        state.append([textRow("s1", seq: 1), partialRow("c1"), textRow("s1", seq: 2)], trim: true)
        state.append([callRow(3, "c1")], trim: true)
        #expect(state.refolds == 0)
        #expect(state.rows.map(\.seq) == [1, 2, 3], "the preview row is gone")
        #expect(state.fold.items.count == 3)
        #expect(state.fold.items.map(\.id) == [1, 3, 2], "the item keeps its place and takes the real seq")
        #expect(runningEdit(state)?.seq == 3)
        #expect(runningEdit(state)?.partial == false)
        #expect(state.cursor == 3)
    }

    @Test func `a partial behind its own final row is never held`() {
        var state = ThreadState()
        state.append([callRow(1, "c1")], trim: true)
        state.append([partialRow("c1", path: "stale")], trim: true)
        #expect(state.rows.map(\.seq) == [1])
        #expect(state.fold.items.count == 1)
        #expect(runningEdit(state)?.input?["file_path"]?.stringValue == "src/a.ts")
        #expect(state.refolds == 0)
    }

    @Test func `an out-of-order row still folds whole, and a replayed row too`() {
        var state = ThreadState()
        state.append([textRow("s1", seq: 1), textRow("s1", seq: 3)], trim: true)
        #expect(state.refolds == 0)
        state.append([textRow("s1", seq: 2)], trim: true)
        #expect(state.refolds == 1)
        #expect(state.rows.map(\.seq) == [1, 2, 3])
        state.append([textRow("s1", seq: 3, text: "replayed")], trim: true)
        #expect(state.refolds == 2)
        #expect(state.fold.items.count == 3)
    }

    @Test func `a refold keeps the live edits on the running edit`() {
        var state = ThreadState()
        state.append([callRow(1, "e1")], trim: true)
        state.fold.applyLiveEdit(LiveEdit.Edit(path: "src/a.ts", kind: .changed, adds: 5, dels: 1, diff: nil, ts: 1))
        #expect(runningEdit(state)?.live?.adds == 5)
        state.append([textRow("s1", seq: 3), textRow("s1", seq: 2)], trim: true)
        #expect(state.refolds == 1)
        #expect(runningEdit(state)?.live?.adds == 5)
        #expect(state.fold.liveEdits.count == 1)
    }

    @Test func `the trim past the memory cap refolds once and marks more before`() {
        var state = ThreadState()
        state.append((1...threadRowsInMemory).map { textRow("s1", seq: $0) }, trim: true)
        #expect(state.refolds == 0)
        state.append([textRow("s1", seq: threadRowsInMemory + 1)], trim: true)
        #expect(state.refolds == 1)
        #expect(state.rows.count == threadRowsInMemory)
        #expect(state.moreBefore)
        var board = ThreadState()
        board.append((1...(threadRowsInMemory + 1)).map { textRow("s1", seq: $0) }, trim: false)
        #expect(board.rows.count == threadRowsInMemory + 1)
        #expect(board.refolds == 0)
    }
}

/// A client on fake sockets with an in-memory cache, enough to open a thread
/// and deliver a push.
@MainActor
private final class StreamRig {
    let sockets = FakeSocketFactory()
    let cache: SessionCache
    let client: EnvironmentClient

    init() throws {
        cache = try SessionCache.inMemory()
        let keys = InMemoryKeyStore()
        try keys.set("tc_K1.secret", for: "env_test")
        let environment = PairedEnvironment(id: "env_test", name: "box", origin: URL(string: "https://box.example")!, caps: [.read], keyId: "K1", keyName: "iphone", addedAt: 0)
        let api = RemoteAPI { request in
            (Data(#"{"ticket":"t","expiresIn":30}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        client = EnvironmentClient(environment: environment, keys: keys, cache: cache, api: api, connect: sockets.factory, clock: ManualClock(random: [0]))
    }

    func wait(_ predicate: () -> Bool) async -> Bool {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while ContinuousClock.now < deadline {
            if predicate() { return true }
            try? await Task.sleep(for: .milliseconds(1))
        }
        return false
    }
}

@MainActor
@Suite struct EnvironmentClientStreamingTests {
    @Test func `a live-edits push lands on the open thread's running edit and is ignored for a thread not open`() async throws {
        let rig = try StreamRig()
        try await rig.cache.store("env_test", sessionId: "s1", rows: [EventRow(sessionId: "s1", seq: 1, ts: 1, event: user("go")), callRow(2, "e1", path: "/repo/src/a.ts")], moreBefore: false)
        await rig.client.start()
        await rig.client.openThread("s1")
        #expect(runningEdit(rig.client.threads["s1"]!)?.live == nil)
        let fake = await rig.sockets.socket(0)
        fake.hello()
        let edit = LiveEdit(cwd: "/repo", sessionIds: ["s9", "s1"], edit: LiveEdit.Edit(path: "src/a.ts", kind: .changed, adds: 9, dels: 2, diff: "@@ -1 +1,2 @@\n-a\n+b\n+c\n", ts: 77))
        fake.deliver(json(ServerPush.liveEdits(LiveEditsPush(items: [edit]))))
        #expect(await rig.wait { rig.client.threads["s1"]?.fold.liveEdits["src/a.ts"] != nil })
        let live = runningEdit(rig.client.threads["s1"]!)?.live
        #expect(live?.adds == 9)
        #expect(live?.dels == 2)
        #expect(live?.diff?.hasPrefix("@@") == true)
        #expect(rig.client.threads["s9"] == nil)
        // A second push for the same file merges; a later ts alone moves ts.
        fake.deliver(json(ServerPush.liveEdits(LiveEditsPush(items: [LiveEdit(cwd: "/repo", sessionIds: ["s1"], edit: LiveEdit.Edit(path: "src/a.ts", kind: .changed, diff: nil, settled: true, ts: 78))]))))
        #expect(await rig.wait { rig.client.threads["s1"]?.fold.liveEdits["src/a.ts"]?.settled == true })
        #expect(runningEdit(rig.client.threads["s1"]!)?.live?.adds == 9)
        #expect(rig.client.threads["s1"]?.fold.liveEdits["src/a.ts"]?.startedTs == 77)
        await rig.client.stop()
    }
}
