import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct BoardTests {
    @Test func `activeMs counts tool runs and skips the gap before a user message`() {
        let list = [
            item(userItem(1, ts: 0)),
            item(toolItem(2, ts: 100, doneTs: 400)),
            item(textItem(3, ts: 500, "ok")),
            item(userItem(4, ts: 10_000, "more")),
            item(textItem(5, ts: 10_200, "done"))
        ]
        #expect(Board.activeMs(list) == 100 + 100 + 200)
        #expect(Board.activeMs(list, liveNow: 10_500) == 700)
    }

    @Test func `groups by todo with clamping`() {
        let list = [
            item(toolItem(1), todo: -1),
            item(toolItem(2), todo: 0),
            item(toolItem(3), todo: 5),
            item(toolItem(4))
        ]
        let groups = Board.groupByTodo(list, todoCount: 2)
        #expect(groups.keys.sorted() == [-1, 0, 1])
        #expect(groups[1]?.map(\.seq) == [3])
        #expect(groups[-1]?.map(\.seq) == [1, 4])
        #expect(Board.groupByTodo(list, todoCount: 0).keys.sorted() == [-1])
    }

    @Test func `classifies activity by tool kind and name`() {
        func kind(_ name: String, preview: ToolPreview? = nil, input: [String: JSONValue] = [:]) -> ActivityKind {
            guard case .tool(let tool) = toolItem(1, name: name, input: input, preview: preview) else { fatalError() }
            return Board.actKind(tool)
        }
        #expect(kind("Edit", preview: editPreview("/repo/a.ts", adds: 1)) == .edit)
        #expect(kind("Edit", input: ["file_path": .string("/repo/a.ts")]) == .edit)
        #expect(kind("Read") == .read)
        #expect(kind("Grep") == .search)
        #expect(kind("Bash") == .command)
        #expect(kind("mcp__orchestrator__spawn_agent") == .subagent)
        #expect(kind("WebFetch") == .web)
        #expect(kind("TaskCreate") == .tool)
        #expect(kind("fs.readPreview", preview: ToolPreview(kind: .read, path: "/x")) == .read)
    }

    @Test func `fuses several edits to one file into one card`() {
        guard case .tool(let a) = toolItem(1, ts: 100, doneTs: 110, name: "Edit", preview: editPreview("/repo/a.ts", adds: 1, lines: ["x"])),
              case .tool(let b) = toolItem(2, ts: 200, doneTs: 210, name: "Edit", preview: editPreview("/repo/a.ts", adds: 2, lines: ["y", "z"]))
        else { fatalError() }
        let single = Board.wholeChange(path: "/repo/a.ts", edits: [a])
        #expect(single.editCount == 1)
        #expect(single.adds == 1)
        let merged = Board.wholeChange(path: "/repo/a.ts", edits: [a, b])
        #expect(merged.path == "/repo/a.ts")
        #expect(merged.fileName == "a.ts")
        #expect(merged.adds == 3)
        #expect(merged.dels == 0)
        #expect(merged.lines?.map(\.text) == ["x", "y", "z"])
        #expect(merged.ts == 100)
        #expect(merged.doneTs == 210)
        let stat = Board.changeStat([item(.tool(a)), item(.tool(b)), item(toolItem(3, name: "Read"))])
        #expect(stat.adds == 3 && stat.dels == 0)
        let cards = Board.changes(in: [item(.tool(a)), item(toolItem(3, name: "Edit", preview: editPreview("/repo/.temp-code/x.md", adds: 9))), item(.tool(b))])
        #expect(cards.map(\.path) == ["/repo/a.ts"])
        #expect(cards[0].editCount == 2)
    }

    @Test func `an edit without a preview counts the lines its input replaces`() {
        guard case .tool(let edit) = toolItem(1, name: "Edit", input: ["file_path": .string("/repo/a.ts"), "old_string": .string("a\nb"), "new_string": .string("a\nb\nc")]) else { fatalError() }
        let stat = Board.stat(edit)
        #expect(stat.adds == 3 && stat.dels == 2)
        guard case .tool(let write) = toolItem(2, name: "Write", input: ["file_path": .string("/repo/b.ts"), "content": .string("one\ntwo")]) else { fatalError() }
        #expect(Board.stat(write).adds == 2)
    }

    @Test func `parses unified diff text into preview lines`() {
        let lines = Board.diffLines("--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n")
        #expect(lines.map { [$0.number.map { Int($0) } ?? -1, $0.kind == .add ? 1 : $0.kind == .del ? 2 : 3] } == [[1, 2], [1, 1], [2, 3]])
        #expect(lines.map(\.text) == ["old", "new", "same"])
        #expect(Board.diffLines("").isEmpty)
    }

    @Test func `the implementation board numbers passes, keeps the goal and closes on the final report`() {
        let first = rows([
            user("Build the thing"),
            todoWrite("t1", [("A", "in_progress")]),
            call("e1", "Edit", ["file_path": .string("/repo/a.ts")], preview: editPreview("/repo/a.ts", adds: 4, dels: 1)),
            result("e1"),
            todoWrite("t2", [("A", "completed")]),
            answer("All done.", msgId: "m1"),
            .turnComplete(TurnCompleteEvent(costUsd: 0.3)),
            user("Thanks, what did you change?"),
            answer("Just a.ts.", msgId: "m2"),
            .turnComplete(TurnCompleteEvent(costUsd: 0.35)),
            user("Now B", newPass: true),
            todoWrite("t3", [("B", "in_progress")]),
            call("r1", "Read", ["file_path": .string("/repo/b.ts")])
        ])
        let board = ImplementationBoard.build(ThreadFold.fold(first), running: true)
        #expect(board.rounds.count == 3)
        #expect(board.rounds.map(\.passNumber) == [1, 0, 2])
        #expect(!board.rounds[1].hasRow)
        #expect(board.currentRound == 2)
        #expect(board.passNumber == 2)
        #expect(board.goal == "Build the thing")
        #expect(board.rounds[0].headerText == "Build the thing")
        #expect(board.rounds[0].work.map(\.seq) == [3])
        #expect(board.rounds[0].done == 1)
        #expect(!board.allDone)
        #expect(board.closing == nil)
        #expect(board.hasTodos)
        #expect(ImplementationBoard.passColor(1) == "#10b981")
        #expect(ImplementationBoard.passColor(9) == "#10b981")
        #expect(ImplementationBoard.passColor(2) == "#0ea5e9")

        let finished = first + rows([
            todoWrite("t4", [("B", "completed")]),
            answer("B is in.", msgId: "m3"),
            .turnComplete(TurnCompleteEvent(costUsd: 0.5))
        ]).map { EventRow(sessionId: "s", seq: $0.seq + first.count, ts: $0.ts + 10_000, event: $0.event) }
        let done = ImplementationBoard.build(ThreadFold.fold(finished), running: false)
        #expect(done.allDone)
        #expect(done.closing?.text == "B is in.")
        // A follow-up with no task list shows its answer as the closing note too.
        let qa = ImplementationBoard.build(ThreadFold.fold(rows([user("hi"), answer("hello"), .turnComplete(TurnCompleteEvent())])), running: false)
        #expect(qa.closing?.text == "hello")
        #expect(!qa.hasTodos)
    }
}
