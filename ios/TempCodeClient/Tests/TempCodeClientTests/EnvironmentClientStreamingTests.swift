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

    @Test func `a trimmed thread grows by the slack before it is cut back, one refold a cut`() {
        var state = ThreadState()
        state.append((1...(threadRowsInMemory + threadRowsSlack)).map { textRow("s1", seq: $0) }, trim: true)
        #expect(state.refolds == 0)
        #expect(!state.moreBefore)
        state.append([textRow("s1", seq: threadRowsInMemory + threadRowsSlack + 1)], trim: true)
        #expect(state.refolds == 1)
        #expect(state.rows.count == threadRowsInMemory)
        #expect(state.rows.first?.seq == threadRowsSlack + 2)
        #expect(state.moreBefore)
        var board = ThreadState()
        board.append((1...(threadRowsInMemory + threadRowsSlack + 1)).map { textRow("s1", seq: $0) }, trim: false)
        #expect(board.rows.count == threadRowsInMemory + threadRowsSlack + 1)
        #expect(board.refolds == 0)
    }

    @Test func `a thousand rows past the cap refold at most three times`() {
        var state = ThreadState()
        // Paged in whole: older pages join without a trim.
        state.append((1...2_600).map { textRow("s1", seq: $0) }, trim: false)
        let before = state.refolds
        for seq in 2_601...3_600 { state.append([textRow("s1", seq: seq)], trim: true) }
        #expect(state.refolds - before <= 3)
        #expect(state.rows.count <= threadRowsInMemory + threadRowsSlack)
        #expect(state.cursor == 3_600)
        #expect(state.fold.items.count == state.rows.count)
    }

    @Test func `the cut waits while it would take a row the reader's window shows`() {
        var state = ThreadState()
        state.append((1...(threadRowsInMemory + threadRowsSlack)).map { textRow("s1", seq: $0) }, trim: true)
        // The reader paged back to seq 100: the cut (rows 1 to 401) would take it.
        state.append([textRow("s1", seq: 2_401)], trim: true, keeping: 100)
        #expect(state.refolds == 0)
        #expect(state.rows.count == 2_401)
        #expect(!state.moreBefore)
        // The window is back below the cut: the next push trims.
        state.append([textRow("s1", seq: 2_402)], trim: true, keeping: 1_000)
        #expect(state.refolds == 1)
        #expect(state.rows.count == threadRowsInMemory)
        #expect(state.rows.first?.seq == 403)
    }

    @Test func `a row past the newest held and a call with no preview search nothing and fold in place`() {
        var state = ThreadState()
        state.append((1...50).map { textRow("s1", seq: $0) }, trim: true)
        state.append([callRow(51, "c1"), EventRow(sessionId: "s1", seq: 52, ts: 52, event: result("c1"))], trim: true)
        #expect(state.refolds == 0)
        #expect(state.rows.map(\.seq) == Array(1...52))
        #expect(state.fold.held("c1") == .final)
        #expect(state.fold.held("never") == nil)
        // A preview of a call the fold has not seen is held as one; behind its final row it is stale.
        state.append([partialRow("c2")], trim: true)
        #expect(state.fold.held("c2") == .preview)
        state.append([callRow(53, "c2")], trim: true)
        #expect(state.fold.held("c2") == .final)
        state.append([partialRow("c2", path: "stale")], trim: true)
        #expect(state.rows.map(\.seq) == Array(1...53))
        #expect(state.refolds == 0)
    }

    @Test func `a live edit lands on the newest running edit of its path, found without a walk of the history`() {
        var state = ThreadState()
        state.append([callRow(1, "e1", path: "/repo/src/a.ts"), callRow(2, "e2", path: "/repo/src/b.ts"), callRow(3, "e3", path: "/repo/src/a.ts")], trim: false)
        state.append((4...400).map { textRow("s1", seq: $0) }, trim: false)
        func live(_ callId: String) -> Int? {
            for entry in state.fold.items { if case .tool(let tool) = entry.item, tool.callId == callId { return tool.live?.adds } }
            return nil
        }
        let took1 = state.fold.applyLiveEdit(LiveEdit.Edit(path: "src/a.ts", kind: .changed, adds: 4, dels: 0, diff: nil, ts: 1))
        #expect(took1)
        #expect(live("e3") == 4)
        #expect(live("e1") == nil)
        // The newest settled: the next lands on the older call still running.
        state.append([EventRow(sessionId: "s1", seq: 401, ts: 401, event: result("e3"))], trim: false)
        let took2 = state.fold.applyLiveEdit(LiveEdit.Edit(path: "src/a.ts", kind: .changed, adds: 6, dels: 0, diff: nil, ts: 2))
        #expect(took2)
        #expect(live("e1") == 6)
        #expect(live("e3") == 4)
        state.append([EventRow(sessionId: "s1", seq: 402, ts: 402, event: result("e1"))], trim: false)
        let took3 = state.fold.applyLiveEdit(LiveEdit.Edit(path: "src/a.ts", kind: .changed, adds: 7, dels: 0, diff: nil, ts: 3))
        #expect(!took3)
        #expect(live("e2") == nil)
    }

    @Test func `a preview whose path streams in late is found by its live edit, and a refold finds it again`() {
        var state = ThreadState()
        state.append([EventRow(sessionId: "s1", seq: -1, ts: 1, event: .toolCall(ToolCallEvent(callId: "c1", name: "Edit", input: .object([:]), partial: true)), ephemeral: true)], trim: false)
        let took4 = state.fold.applyLiveEdit(LiveEdit.Edit(path: "src/a.ts", kind: .changed, adds: 1, dels: 0, diff: nil, ts: 1))
        #expect(!took4)
        state.append([partialRow("c1", path: "src/a.ts")], trim: false)
        let took5 = state.fold.applyLiveEdit(LiveEdit.Edit(path: "src/a.ts", kind: .changed, adds: 2, dels: 0, diff: nil, ts: 2))
        #expect(took5)
        #expect(runningEdit(state)?.live?.adds == 2)
        state.refold()
        let took6 = state.fold.applyLiveEdit(LiveEdit.Edit(path: "src/a.ts", kind: .changed, adds: 3, dels: 0, diff: nil, ts: 3))
        #expect(took6)
        #expect(runningEdit(state)?.live?.adds == 3)
    }

    @Test func `a meta that moves neither the click's busy nor its clock is not observed`() {
        var state = ThreadState()
        #expect(!state.observes(meta("s1", status: .idle)))
        state.beginSend(status: .idle, at: 100)
        let running = meta("s1", status: .running, busySince: 120)
        #expect(state.observes(running))
        state.observe(running)
        #expect(!state.sending && state.sentTurn == 120 && state.sentAt == 100)
        // A second meta of the same open turn moves nothing.
        #expect(!state.observes(running))
        // A paused thread keeps its status when a send is held: the meta still ends Sending.
        var paused = ThreadState()
        paused.beginSend(status: .paused, at: 5)
        #expect(paused.sending)
        #expect(paused.observes(meta("s1", status: .paused)))
        paused.observe(meta("s1", status: .paused))
        #expect(!paused.sending && paused.sentAt == nil)
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
        let deadline = ContinuousClock.now.advanced(by: waitDeadline)
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
