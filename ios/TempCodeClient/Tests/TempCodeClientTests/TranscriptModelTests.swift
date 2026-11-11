import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

// The view's row model against the whole build: a thread is played a step
// at a time, and after every step the model's rows, their turns and the
// agents its waits still need must be what `TranscriptRows.rows` makes of
// the same thread from nothing but its own memory.

private func row(_ seq: Int, _ event: AgentEvent) -> EventRow {
    EventRow(sessionId: "s", seq: seq, ts: 1_000 + 100 * seq, event: event)
}

private func delta(_ text: String, _ msgId: String) -> AgentEvent {
    .assistantText(AssistantTextEvent(text: text, delta: true, msgId: msgId, blockIndex: 0))
}

private func thought(_ text: String, _ msgId: String, delta: Bool = false) -> AgentEvent {
    .thinking(ThinkingEvent(text: text, delta: delta, msgId: msgId, blockIndex: 0))
}

private func status(_ status: SessionStatus) -> AgentEvent {
    .status(StatusEvent(status: status))
}

private let closed = AgentEvent.turnComplete(TurnCompleteEvent())

/// A thread and the model that reads it, checked against a whole build at every step.
private final class Play {
    var state = ThreadState()
    let model = TranscriptModel()
    let whole = RowKeyMemory()
    var statuses: [String: String] = [:]
    var waits = WaitStatuses()
    private var seq: Int

    /// `after`: the seq before the first row pushed, so a test can join history under it.
    init(after seq: Int = 0) {
        self.seq = seq
    }

    /// The next rows, numbered on from the last.
    func push(_ label: String, _ events: AgentEvent..., sourceLocation: SourceLocation = #_sourceLocation) {
        let rows = events.map { event -> EventRow in
            seq += 1
            return row(seq, event)
        }
        state.append(rows, trim: false)
        state.settle(rows)
        check(label, sourceLocation: sourceLocation)
    }

    func change(_ label: String, sourceLocation: SourceLocation = #_sourceLocation, _ body: (inout ThreadState) -> Void) {
        body(&state)
        check(label, sourceLocation: sourceLocation)
    }

    func check(_ label: String, sourceLocation: SourceLocation = #_sourceLocation) {
        let statuses = statuses
        model.update(state, waits: waits, statusOf: { statuses[$0] })
        let full = TranscriptRows.rows(state.entries, turnOpen: state.fold.board.turnOpen, memory: whole, waits: state.fold.waitOutcomes, statusOf: { statuses[$0] })
        #expect(model.rows == full, "\(label): the rows", sourceLocation: sourceLocation)
        let keys = TranscriptRows.turnKeys(full)
        for (at, row) in full.enumerated() {
            #expect(model.turnKey(of: row.id) == keys[row.id], "\(label): the turn of row \(at)", sourceLocation: sourceLocation)
            #expect(model.index(of: row.id) == at, "\(label): the place of row \(at)", sourceLocation: sourceLocation)
        }
        #expect(model.waitIds == WaitSteps.unsettledAgents(state.entries, memory: state.fold.waitOutcomes), "\(label): the agents still read", sourceLocation: sourceLocation)
    }
}

@Suite struct TranscriptModelTests {
    @Test func `a streaming turn builds its rows where they changed, and the same rows as a whole build`() {
        let play = Play()
        play.push("the message", user("Add dark mode", newPass: true), status(.running))
        play.push("a thought streams", thought("The theme", "t1", delta: true))
        play.push("the thought lands", thought("The theme file holds the tokens.", "t1"))
        play.push("a call", call("c1", "Read", ["file_path": .string("src/a.ts")]))
        play.push("its result", result("c1"))
        play.push("two calls at once", call("c2", "Bash", ["command": .string("bun test")]), call("c3", "Edit", ["file_path": .string("src/a.ts"), "old_string": .string("a"), "new_string": .string("b\nc")]))
        play.push("the later one settles first", result("c3"))
        play.push("the earlier one settles late", result("c2", "1 failed", isError: true))
        play.push("prose streams", delta("The palette ", "m1"))
        play.push("more prose", delta("is in. ", "m1"), delta("Now the toggle.", "m1"))
        play.push("the prose lands", answer("The palette is in. Now the toggle.", msgId: "m1"))
        play.push("a second run of calls", call("c4", "Read", ["file_path": .string("src/b.ts")]), result("c4"), call("c5", "Grep", ["pattern": .string("theme")]), result("c5"))
        play.push("the turn closes", answer("Done.", msgId: "m2"), closed, status(.idle))
        // One whole build, at the first rows; everything after built on from the turn that changed.
        #expect(play.model.wholeBuilds == 1)
        #expect(play.model.builds > 5)
    }

    @Test func `a new turn rebuilds the turn that was last, and nothing before it`() {
        let play = Play()
        play.push("turn one", user("One", newPass: true), status(.running), call("a1", "Read"), result("a1"), answer("First.", msgId: "m1"), closed, status(.idle))
        play.push("turn two", user("Two"), status(.running), call("b1", "Read"), result("b1"), answer("Second.", msgId: "m2"), closed, status(.idle))
        let settled = play.model.rows
        play.push("turn three opens", user("Three"), status(.running))
        // Turn two's end row was the thread's last and is no longer; turn one is as it was.
        #expect(play.model.built < play.model.rows.count)
        let one = settled.prefix { if case .turnEnd = $0 { false } else { true } }
        #expect(Array(play.model.rows.prefix(one.count)) == Array(one))
        play.push("it works", call("c1", "Read"), result("c1"), delta("Third", "m3"))
        #expect(play.model.built == play.model.lastTurnRows)
        #expect(play.model.wholeBuilds == 1)
    }

    @Test func `a result that lands in an earlier turn rebuilds from that turn`() {
        let play = Play()
        play.push("turn one leaves a call running", user("One", newPass: true), status(.running), call("bg", "Bash", ["command": .string("sleep 600"), "run_in_background": .bool(true)]), answer("Started.", msgId: "m1"), closed, status(.idle))
        play.push("turn two", user("Two"), status(.running), call("b1", "Read"), result("b1"))
        play.push("the old call settles", result("bg", "done"))
        #expect(play.model.built == play.model.rows.count, "the write sat in the first turn")
        play.push("and the turn goes on", delta("Second", "m2"))
        #expect(play.model.built == play.model.lastTurnRows)
    }

    @Test func `a pending send, its refusal and its echo are rows without a write to the fold`() {
        let play = Play()
        play.push("a settled turn", user("One", newPass: true), status(.running), answer("First.", msgId: "m1"), closed, status(.idle))
        let generation = play.state.fold.changes.generation
        play.change("the person sends") { _ = $0.addPending(text: "Two", sentAt: 9_000) }
        #expect(play.state.fold.changes.generation == generation, "a pending turn is no item")
        #expect(play.model.rows.contains { $0.id == TranscriptRowID(key: -100_000) })
        play.change("the host refuses it") { $0.pending.removeAll() }
        #expect(!play.model.rows.contains { $0.id == TranscriptRowID(key: -100_000) })
        play.change("the person sends again") { _ = $0.addPending(text: "Two", sentAt: 9_500) }
        play.push("the echo takes the pending row's key", user("Two"))
        #expect(play.state.pending.isEmpty)
        #expect(play.model.rows.contains { $0.id == TranscriptRowID(key: -100_001) })
        play.push("and the turn runs", status(.running), delta("Second", "m2"))
    }

    @Test func `a live edit moves its running row and no other`() {
        let play = Play()
        play.push("an edit runs", user("Edit it", newPass: true), status(.running), call("e1", "Edit", ["file_path": .string("/repo/src/a.ts"), "old_string": .string("a"), "new_string": .string("b")]))
        let before = play.model.rows
        play.change("the file grows on disk") { $0.fold.applyLiveEdit(LiveEdit.Edit(path: "src/a.ts", kind: .changed, adds: 12, dels: 3, diff: "@@ -1 +1 @@", ts: 5)) }
        #expect(play.model.rows != before)
        // The edit's own row and the open turn's end row, which reads the turn's entries; never the message above them.
        let changed = play.model.changedIDs()
        #expect(!changed.isEmpty)
        #expect(changed.isSubset(of: [TranscriptRowID(key: 3), TranscriptRowID(key: 1, end: true)]))
        play.change("a file no call names") { $0.fold.applyLiveEdit(LiveEdit.Edit(path: "src/other.ts", kind: .changed, adds: 1, dels: 0, diff: nil, ts: 6)) }
        #expect(play.model.built == 0, "nothing was written, so nothing was built")
    }

    @Test func `cleared errors, a refold and history joining above each build the same rows`() {
        let play = Play(after: 100)
        play.push("a turn fails", user("One", newPass: true), status(.running), call("a1", "Read"), result("a1"), .error(ErrorEvent(message: "The turn failed")), status(.error))
        play.push("a second turn fails", user("Two"), status(.running), .error(ErrorEvent(message: "Again")), status(.error))
        play.push("the errors are cleared", .errorsCleared(ErrorsClearedEvent()))
        #expect(!play.model.rows.contains { if case .item(let entry) = $0 { entry.item.isError } else { false } })
        play.push("a third turn", user("Three"), status(.running), call("c1", "Read"), result("c1"), delta("Third", "m3"))
        let whole = play.model.wholeBuilds
        play.change("the rows are replayed whole") { $0.refold() }
        #expect(play.model.wholeBuilds == whole + 1)
        // A page joins above: every turn it does not touch keeps its rows.
        play.change("history joins above") { state in
            let older = [EventRow(sessionId: "s", seq: 1, ts: 100, event: user("Before")), EventRow(sessionId: "s", seq: 2, ts: 110, event: answer("Earlier.", msgId: "m0")), EventRow(sessionId: "s", seq: 3, ts: 120, event: closed)]
            state.rows = older + state.rows
            state.refold()
        }
        play.push("and the stream goes on", delta(" turn.", "m3"))
        #expect(play.model.built == play.model.lastTurnRows)
    }

    @Test func `a wait whose agent no host knows yet is decided at the pass that first reads it, in whichever turn it sits`() {
        let play = Play()
        let wait = ToolCallEvent(callId: "w1", name: "mcp__orchestrator__wait_for_agent", input: .object(["agentIds": .array([.string("a1"), .string("a2")]), "mode": .string("all")]))
        let body = OmittedBody(omitted: true, bytes: 4_000, lines: 80, head: #"[{"agentId":"a1","status":"done"},"#)
        play.push("a wait returns with its body left behind", user("Wait for them", newPass: true), status(.running), .toolCall(wait), .toolResult(ToolResultEvent(callId: "w1", output: .omittedBody(body), isError: false)), answer("Both are back.", msgId: "m1"), closed, status(.idle))
        #expect(play.model.waitIds == ["a2"])
        play.push("a later turn", user("Next"), status(.running), call("c1", "Read"), result("c1"))
        // The agent's meta lands: the wait sits in the settled first turn, which builds again.
        play.statuses["a2"] = "failed"
        play.waits = WaitStatuses.read(["a2"]) { play.statuses[$0] }
        play.check("the agent's status is read")
        #expect(play.model.waitIds.isEmpty)
        #expect(play.model.built == play.model.rows.count)
        // Decided for good: a later run of that agent changes nothing, and the first turn rests.
        play.statuses["a2"] = "running"
        play.waits = WaitStatuses.read(["a2"]) { play.statuses[$0] }
        play.check("the agent runs again")
        play.push("the turn goes on", delta("Now", "m2"))
        #expect(play.model.built == play.model.lastTurnRows)
    }

    @Test func `a pass that finds the thread as it was builds nothing`() {
        let play = Play()
        play.push("a turn", user("One", newPass: true), status(.running), call("a1", "Read"), result("a1"))
        let builds = play.model.builds
        #expect(!play.model.update(play.state))
        #expect(!play.model.update(play.state))
        #expect(play.model.builds == builds)
        #expect(play.model.built == 0)
        // A flag of the thread that is no row's (the first page loading) is no change either.
        play.state.isLoadingOlder = true
        #expect(!play.model.update(play.state))
    }

    @Test func `the window's start, its gaps and the top row read the model's own places`() {
        let play = Play()
        play.push("two turns", user("One", newPass: true), status(.running), call("a1", "Read"), result("a1"), answer("First.", msgId: "m1"), closed, status(.idle), user("Two"), status(.running), call("b1", "Read"), result("b1"))
        let rows = play.model.rows
        let ids = rows.map(\.id)
        #expect(play.model.windowStart(top: nil, count: 3) == rows.count - 3)
        #expect(play.model.windowStart(top: ids[1], count: 3) == 1)
        #expect(play.model.windowStart(top: TranscriptRowID(key: 999), count: 3) == TranscriptRows.windowStart(rows, top: TranscriptRowID(key: 999), count: 3))
        let gaps = play.model.gaps(from: 2)
        #expect(gaps.count == rows.count - 2)
        for at in 2..<rows.count { #expect(gaps[ids[at]] == RowGap.above(rows[at], after: rows[at - 1])) }
        #expect(play.model.topRow(onScreen: [ids[4], ids[2], ids[3]]) == TranscriptReflow.topRow(onScreen: [ids[4], ids[2], ids[3]], order: ids))
        #expect(play.model.topRow(onScreen: [ids[0], ids[3]], from: 2) == ids[3], "a row above the window is not on its screen")
        #expect(play.model.topRow(onScreen: []) == nil)
        #expect(play.model.rowID(containing: 3) == TranscriptRows.rowID(containing: 3, in: rows))
    }
}

@Suite struct FoldChangesTests {
    @Test func `a reader is told the lowest item written since it read`() {
        var fold = ThreadFold()
        let rows = TempCodeClientTests.rows([user("go"), call("c1", "Read"), answer("One.", msgId: "m1"), call("c2", "Read")])
        for row in rows { fold.apply(row) }
        let read = fold.changes.generation
        #expect(fold.changes.dirtyFrom(since: read) == nil)
        fold.apply(EventRow(sessionId: "s", seq: 5, ts: 5, event: result("c2")))
        #expect(fold.changes.dirtyFrom(since: read) == 3)
        fold.apply(EventRow(sessionId: "s", seq: 6, ts: 6, event: result("c1")))
        #expect(fold.changes.dirtyFrom(since: read) == 1)
        #expect(fold.changes.dirtyFrom(since: fold.changes.generation) == nil)
        // The turn closing stamps the person's row.
        let closing = fold.changes.generation
        fold.apply(EventRow(sessionId: "s", seq: 7, ts: 7, event: .turnComplete(TurnCompleteEvent())))
        #expect(fold.changes.dirtyFrom(since: closing) == 0)
    }

    @Test func `a reader far behind is told the lowest of everything it missed`() {
        var fold = ThreadFold()
        fold.apply(EventRow(sessionId: "s", seq: 1, ts: 1, event: user("go")))
        fold.apply(EventRow(sessionId: "s", seq: 2, ts: 2, event: call("c1", "Read")))
        let read = fold.changes.generation
        for seq in 3..<(3 + FoldChanges.kept * 2) { fold.apply(EventRow(sessionId: "s", seq: seq, ts: seq, event: answer("row \(seq)", msgId: "m\(seq)"))) }
        #expect(fold.changes.dirtyFrom(since: read)! <= 2)
        let late = fold.changes.generation
        fold.apply(EventRow(sessionId: "s", seq: 9_000, ts: 9_000, event: result("c1")))
        #expect(fold.changes.dirtyFrom(since: late) == 1)
        #expect(fold.changes.dirtyFrom(since: read)! <= 1)
    }

    @Test func `every fold is its own, and none of it is part of a fold's value`() {
        let rows = TempCodeClientTests.rows([user("go"), call("c1", "Read"), result("c1")])
        let one = ThreadFold.fold(rows)
        var two = ThreadFold()
        for row in rows { two.apply(row) }
        #expect(one.changes.epoch != two.changes.epoch)
        #expect(one == two)
        #expect(one.hashValue == two.hashValue)
        // A fold rebuilt from its rows is another fold: its reader builds whole.
        var state = ThreadState()
        state.append(rows, trim: false)
        let before = state.fold.changes.epoch
        state.refold()
        #expect(state.fold.changes.epoch != before)
    }
}

@Suite struct GroupTalliesTests {
    private func edit(_ seq: Int, new: String, old: String) -> ThreadEntry {
        item(toolItem(seq, ts: seq, doneTs: seq + 1, name: "Edit", input: ["file_path": .string("src/a.ts"), "new_string": .string(new), "old_string": .string(old)]))
    }

    @Test func `a group's counts are read off its steps once, and again after its steps change`() {
        var group = ActivityGroup(entries: [edit(1, new: "a\nb\nc", old: "a"), item(toolItem(2, ts: 2, doneTs: 3, name: "Bash")), edit(3, new: "x", old: "y\nz")])
        #expect(group.adds == 4)
        #expect(group.dels == 3)
        #expect(group.kind == .edit)
        #expect(group.stepRows == 3 && !group.lone)
        #expect(group.failed == 0)
        // A copy reads the same counts and compares equal, whoever asked first.
        let copy = group
        #expect(copy.adds == 4 && copy == group && copy.hashValue == group.hashValue)
        group.entries.removeLast()
        #expect(group.adds == 3 && group.dels == 1)
        #expect(copy.adds == 4, "the copy keeps its own steps' counts")
        #expect(copy != group)
    }

    @Test func `lines are counted as an editor counts them`() {
        #expect(Board.lineCount(nil) == 0)
        #expect(Board.lineCount("") == 0)
        #expect(Board.lineCount("one") == 1)
        #expect(Board.lineCount("one\ntwo") == 2)
        #expect(Board.lineCount("one\n") == 2)
        #expect(Board.lineCount("\n\n") == 3)
        for text in ["a\nb\nc", "é\n日本\n", "x"] {
            #expect(Board.lineCount(text) == text.split(separator: "\n", omittingEmptySubsequences: false).count)
        }
        // A Windows line end is a line end: the newline byte is counted, as the desktop counts it.
        #expect(Board.lineCount("a\r\nb") == 2)
    }
}
