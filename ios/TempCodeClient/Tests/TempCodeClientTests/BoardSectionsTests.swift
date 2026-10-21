import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct BoardSectionsTests {
    @Test func `progress reads done, the task under way, and completion`() {
        let todos = [TodoItem(content: "a", status: .completed), TodoItem(content: "b", status: .inProgress), TodoItem(content: "c", status: .pending)]
        let round = RoundData(todos: todos, items: [], work: [], header: nil, passNumber: 1, isCurrent: true)
        let progress = round.progress
        #expect(progress.done == 1)
        #expect(progress.total == 3)
        #expect(progress.running)
        #expect(progress.fraction == 1.0 / 3.0)
        #expect(progress.workingFraction == 2.0 / 3.0)
        #expect(!progress.complete)
        #expect(progress.label == "1 of 3")

        let done = BoardProgress(done: 3, total: 3, running: false)
        #expect(done.complete)
        #expect(done.workingFraction == 1)
        #expect(BoardProgress(done: 0, total: 0, running: false).fraction == 0)
    }

    @Test func `the board's progress is the newest pass with tasks`() {
        let fold = ThreadFold.fold(rows([
            user("go", newPass: true),
            todoWrite("t1", [("a", "completed"), ("b", "completed")]),
            answer("done", msgId: "m1"),
            .turnComplete(TurnCompleteEvent()),
            user("and one question", newPass: true),
            answer("an answer", msgId: "m2")
        ]))
        let board = ImplementationBoard.build(fold, running: false)
        #expect(board.progress?.label == "2 of 2")
        #expect(board.progress?.complete == true)
        // The Q&A round earns no pass row, so headers stay off.
        #expect(!board.showsPasses)
    }

    @Test func `pass headers show once two passes have rows`() {
        let fold = ThreadFold.fold(rows([
            user("go", newPass: true),
            todoWrite("t1", [("a", "completed")]),
            .turnComplete(TurnCompleteEvent()),
            user("more", newPass: true),
            todoWrite("t2", [("b", "in_progress")])
        ]))
        #expect(ImplementationBoard.build(fold, running: true).showsPasses)
    }

    @Test func `the trace keeps tools, notes and errors and drops edits and plan tools`() {
        let list = [
            item(toolItem(1, name: "Read")),
            item(toolItem(2, name: "Edit", preview: editPreview("/repo/a.ts", adds: 1))),
            item(toolItem(3, name: "TodoWrite")),
            item(textItem(4, "  ")),
            item(textItem(5, "a note")),
            item(errorItem(6, "boom")),
            item(textItem(7, "thinking", thinking: true))
        ]
        #expect(Board.traceItems(list).map(\.seq) == [1, 5, 6])
    }

    @Test func `changes group by todo with setup first and empty todos skipped`() {
        let todos = [TodoItem(content: "first", status: .completed), TodoItem(content: "second", status: .completed)]
        let work = [
            item(toolItem(1, name: "Edit", preview: editPreview("/repo/setup.ts", adds: 1)), todo: -1),
            item(toolItem(2, name: "Edit", preview: editPreview("/repo/b.ts", adds: 2)), todo: 1),
            item(toolItem(3, name: "Edit", preview: editPreview("/repo/b.ts", adds: 3)), todo: 1)
        ]
        let groups = Board.changeGroups(work: work, todos: todos)
        #expect(groups.map(\.todo) == [-1, 1])
        #expect(groups[0].title == "Setup")
        #expect(groups[1].title == "second")
        #expect(groups[1].cards.count == 1)
        #expect(groups[1].cards[0].adds == 5)
        #expect(groups[1].cards[0].editCount == 2)
    }
}
