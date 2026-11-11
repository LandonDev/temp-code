import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

// One write per window: the pushes that change threads and the session
// list wait in `PushIngress` and are applied a window at a time, in the
// order they arrived, with the same result as applying each on its own.

/// A clock the test moves, and sleeps it lets go by hand.
@MainActor
private final class Gate {
    var now = 1_000.0
    private var sleepers: [CheckedContinuation<Void, Never>] = []

    func sleep() async {
        await withCheckedContinuation { sleepers.append($0) }
    }

    /// Every sleeper wakes; the tasks behind them run before this returns.
    /// A task started just before the call reaches its sleep first.
    func wake() async {
        for _ in 0..<20 { await Task.yield() }
        let woken = sleepers
        sleepers = []
        for sleeper in woken { sleeper.resume() }
        for _ in 0..<20 { await Task.yield() }
    }

    var sleeping: Int { sleepers.count }
}

private func rows(_ sessionId: String, _ seqs: ClosedRange<Int>) -> [EventRow] {
    seqs.map { textRow(sessionId, seq: $0) }
}

private func edit(_ path: String, adds: Int, sessions: [String]) -> LiveEdit {
    LiveEdit(cwd: "/repo", sessionIds: sessions, edit: LiveEdit.Edit(path: path, kind: .changed, adds: adds, dels: 0, diff: nil, ts: adds))
}

@MainActor
@Suite struct PushIngressTests {
    @Test func `the first push after a quiet window lands at once; the rest of the window lands together when it closes`() async {
        let gate = Gate()
        let ingress = PushIngress(now: { gate.now }, sleep: { _ in await gate.sleep() })
        var blocks: [[PushIngress.Item]] = []
        ingress.land = { blocks.append($0) }
        ingress.take(.events(sessionId: "a", rows: rows("a", 1...1)))
        #expect(blocks.count == 1, "a lone row waits for nothing")
        // Inside the window: they wait, behind one timer.
        gate.now += 3
        ingress.take(.events(sessionId: "a", rows: rows("a", 2...2)))
        gate.now += 3
        ingress.take(.events(sessionId: "a", rows: rows("a", 3...4)))
        for _ in 0..<20 { await Task.yield() }
        #expect(blocks.count == 1)
        #expect(ingress.waiting == 2)
        #expect(gate.sleeping == 1)
        gate.now += 10
        await gate.wake()
        #expect(blocks.count == 2)
        #expect(blocks[1] == [.events(sessionId: "a", rows: rows("a", 2...4))], "one write for the thread")
        // The window that closed on waiting pushes opened the next: a push right behind it waits too.
        gate.now += 2
        ingress.take(.events(sessionId: "a", rows: rows("a", 5...5)))
        #expect(blocks.count == 2)
        gate.now += 14
        await gate.wake()
        #expect(blocks.count == 3)
        // Quiet for a window: at once again.
        gate.now += 40
        ingress.take(.events(sessionId: "a", rows: rows("a", 6...6)))
        #expect(blocks.count == 4)
        #expect(ingress.waiting == 0)
    }

    @Test func `a block keeps the order it arrived in and merges only neighbours`() {
        let idle = sampleSession("s", updatedAt: 1)
        let merged = PushIngress.merged([
            .events(sessionId: "a", rows: rows("a", 1...2)),
            .events(sessionId: "a", rows: rows("a", 3...3)),
            .events(sessionId: "b", rows: rows("b", 1...1)),
            .events(sessionId: "a", rows: rows("a", 4...4)),
            .sessions([idle]),
            .events(sessionId: "a", rows: rows("a", 5...5)),
            .liveEdits([edit("src/a.ts", adds: 1, sessions: ["a"])]),
            .liveEdits([edit("src/a.ts", adds: 2, sessions: ["a"])]),
        ])
        #expect(merged == [
            .events(sessionId: "a", rows: rows("a", 1...3)),
            .events(sessionId: "b", rows: rows("b", 1...1)),
            .events(sessionId: "a", rows: rows("a", 4...4)),
            .sessions([idle]),
            .events(sessionId: "a", rows: rows("a", 5...5)),
            .liveEdits([edit("src/a.ts", adds: 1, sessions: ["a"]), edit("src/a.ts", adds: 2, sessions: ["a"])]),
        ])
    }

    @Test func `metas collapse to the newest per session, but a status that changed is kept beside the one before it`() {
        let a1 = sampleSession("a", updatedAt: 1, status: .running)
        let a2 = sampleSession("a", updatedAt: 2, status: .running)
        let a3 = sampleSession("a", updatedAt: 3, status: .idle)
        let a4 = sampleSession("a", updatedAt: 4, status: .idle)
        let b1 = sampleSession("b", updatedAt: 1, status: .idle)
        let b2 = sampleSession("b", updatedAt: 5, status: .idle)
        #expect(PushIngress.collapsed([a1, b1, a2, a3, b2, a4]) == [a2, b2, a4])
        let merged = PushIngress.merged([.sessions([a1]), .sessions([a2, b1]), .sessions([a3])])
        #expect(merged == [.sessions([a2, b1, a3])])
    }

    @Test func `a flush applies what waits now, and a drop forgets it`() async {
        let gate = Gate()
        let ingress = PushIngress(now: { gate.now }, sleep: { _ in await gate.sleep() })
        var blocks: [[PushIngress.Item]] = []
        ingress.land = { blocks.append($0) }
        ingress.take(.events(sessionId: "a", rows: rows("a", 1...1)))
        ingress.take(.events(sessionId: "a", rows: rows("a", 2...2)))
        ingress.flush()
        #expect(blocks.count == 2)
        ingress.take(.events(sessionId: "a", rows: rows("a", 3...3)))
        ingress.drop()
        ingress.flush()
        await gate.wake()
        #expect(blocks.count == 2, "rows of a socket that closed land nowhere")
        #expect(ingress.waiting == 0)
    }
}

/// A client that is never started: threads are held by hand and pushes
/// handed to its ingress, whose clock stands still, so the first push lands
/// at once and every later one waits until the test empties the queue.
@MainActor
private func idleClient() throws -> EnvironmentClient {
    let keys = InMemoryKeyStore()
    try keys.set("tc_K1.secret", for: "env_test")
    let environment = PairedEnvironment(id: "env_test", name: "box", origin: URL(string: "https://box.example")!, caps: [.read], keyId: "K1", keyName: "iphone", addedAt: 0)
    let api = RemoteAPI { request in
        (Data(#"{"ticket":"t","expiresIn":30}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
    let client = EnvironmentClient(environment: environment, keys: keys, cache: try SessionCache.inMemory(), api: api, connect: FakeSocketFactory().factory, clock: ManualClock(random: [0]))
    client.install(PushIngress(now: { 0 }, sleep: { _ in try? await Task.sleep(for: .seconds(3_600)) }))
    return client
}

@MainActor
@Suite struct PushIngressClientTests {
    /// A turn as the host pushes it: rows a frame at a time, a preview that
    /// grows and settles, live edits, and the session's metas between them.
    private func turn() -> [PushIngress.Item] {
        func row(_ seq: Int, _ event: AgentEvent) -> EventRow { EventRow(sessionId: "s1", seq: seq, ts: 1_000 + seq, event: event) }
        func preview(_ path: String) -> EventRow {
            EventRow(sessionId: "s1", seq: -1, ts: 50, event: .toolCall(ToolCallEvent(callId: "e1", name: "Edit", input: .object(["file_path": .string(path)]), partial: true)), ephemeral: true)
        }
        func delta(_ seq: Int, _ text: String) -> EventRow {
            row(seq, .assistantText(AssistantTextEvent(text: text, delta: true, msgId: "m1", blockIndex: 0)))
        }
        return [
            .sessions([sampleSession("s1", updatedAt: 1, threadType: .chat, status: .idle)]),
            .events(sessionId: "s1", rows: [row(1, user("Go"))]),
            .sessions([sampleSession("s1", updatedAt: 2, threadType: .chat, status: .running, busySince: 100)]),
            .events(sessionId: "s1", rows: [row(2, .status(StatusEvent(status: .running)))]),
            .events(sessionId: "s1", rows: [delta(3, "The ")]),
            .events(sessionId: "s1", rows: [delta(4, "palette ")]),
            .events(sessionId: "s1", rows: [preview("src/a")]),
            .events(sessionId: "s1", rows: [delta(5, "is in.")]),
            .events(sessionId: "s1", rows: [preview("src/a.ts")]),
            .liveEdits([edit("src/a.ts", adds: 3, sessions: ["s1", "s9"])]),
            .liveEdits([edit("src/a.ts", adds: 7, sessions: ["s1"])]),
            .sessions([sampleSession("s2", updatedAt: 3, threadType: .chat)]),
            .sessions([sampleSession("s2", title: "Renamed", updatedAt: 4, threadType: .chat)]),
            .events(sessionId: "s1", rows: [row(6, .toolCall(ToolCallEvent(callId: "e1", name: "Edit", input: .object(["file_path": .string("src/a.ts")]))))]),
            .events(sessionId: "s1", rows: [row(7, .toolResult(ToolResultEvent(callId: "e1", output: .string("ok"), isError: false)))]),
            .events(sessionId: "s1", rows: [row(8, .assistantText(AssistantTextEvent(text: "The palette is in.", delta: false, msgId: "m1", blockIndex: 0)))]),
            .events(sessionId: "s1", rows: [row(9, .turnComplete(TurnCompleteEvent())), row(10, .status(StatusEvent(status: .idle)))]),
            .sessions([sampleSession("s1", updatedAt: 5, threadType: .chat, status: .idle)]),
        ]
    }

    @Test func `a turn applied a window at a time ends where the same pushes applied one by one do`() throws {
        let single = try idleClient()
        let windowed = try idleClient()
        for client in [single, windowed] { client.threads["s1"] = ThreadState() }
        var statuses: [[SessionStatus]] = []
        windowed.sessionObserver = { _, metas in statuses.append(metas.filter { $0.id == "s1" }.map(\.status)) }
        let appends = PerfCounters.value(.batches)
        for item in turn() {
            single.ingress.take(item)
            single.ingress.flush()
        }
        let oneByOne = PerfCounters.value(.batches) - appends
        // Handed over in one go: the first lands at once, the rest wait for the window, emptied here.
        for item in turn() { windowed.ingress.take(item) }
        windowed.ingress.flush()
        let together = PerfCounters.value(.batches) - appends - oneByOne
        let a = try #require(single.threads["s1"])
        let b = try #require(windowed.threads["s1"])
        #expect(a.rows == b.rows)
        #expect(a.fold == b.fold)
        #expect(a.fold.items.count == 3)
        #expect((a.sending, a.sentAt, a.sentTurn, a.isLive) == (b.sending, b.sentAt, b.sentTurn, b.isLive))
        #expect(single.currentSessions == windowed.currentSessions)
        #expect(windowed.currentSession("s2")?.title == "Renamed")
        #expect(together < oneByOne, "neighbouring rows of a thread are one write")
        // Running, then idle, inside one block: the observer saw both, in order.
        #expect(statuses.flatMap { $0 } == [.idle, .running, .idle])
    }

    @Test func `a meta adopted by this device is never undone by an older push still waiting`() throws {
        let client = try idleClient()
        client.ingress.take(.sessions([sampleSession("s0", updatedAt: 1)]))
        // Inside the window: it waits.
        client.ingress.take(.sessions([sampleSession("s1", title: "From the host", updatedAt: 2)]))
        client.adopt(sampleSession("s1", title: "Created here", updatedAt: 3))
        client.ingress.flush()
        #expect(client.currentSession("s1")?.title == "Created here")
    }

    @Test func `rows that waited when their socket closed mark no thread live`() throws {
        let client = try idleClient()
        client.threads["s1"] = ThreadState()
        client.ingress.take(.events(sessionId: "s1", rows: rows("s1", 1...1)))
        #expect(client.threads["s1"]?.isLive == true)
        client.ingress.take(.events(sessionId: "s1", rows: rows("s1", 2...2)))
        // The socket closes: its threads are no longer live, and what it left waiting goes.
        client.write("s1") { $0.isLive = false }
        client.ingress.drop()
        client.ingress.flush()
        #expect(client.threads["s1"]?.isLive == false)
        #expect(client.threads["s1"]?.rows.map(\.seq) == [1])
    }

    @Test func `a window's live edits for a thread are one write to its fold`() throws {
        let client = try idleClient()
        client.threads["s1"] = ThreadState()
        client.write("s1") { $0.append([EventRow(sessionId: "s1", seq: 1, ts: 1, event: .toolCall(ToolCallEvent(callId: "e1", name: "Edit", input: .object(["file_path": .string("/repo/src/a.ts")]))))], trim: false) }
        let model = try #require(client.thread("s1"))
        let generation = model.content.generation
        client.ingress.take(.liveEdits([edit("src/b.ts", adds: 1, sessions: ["s1"])]))
        client.ingress.take(.liveEdits([edit("src/a.ts", adds: 2, sessions: ["s1"])]))
        client.ingress.take(.liveEdits([edit("src/a.ts", adds: 5, sessions: ["s1", "s9"])]))
        client.ingress.flush()
        #expect(model.value.fold.liveEdits["src/a.ts"]?.adds == 5)
        #expect(model.value.fold.liveEdits["src/b.ts"]?.adds == 1)
        #expect(model.content.generation > generation)
        var live: Int?
        for entry in model.value.fold.items { if case .tool(let tool) = entry.item { live = tool.live?.adds } }
        #expect(live == 5)
        #expect(client.thread("s9") == nil)
    }
}
