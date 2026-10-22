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

    // MARK: landing outcomes

    @Test func `outcomes land on their round and never in work`() {
        let gate = GateNotice(step: .typecheck, branch: "feature", ok: true, log: "", at: 1_500)
        let review = ReviewNotice(runId: "r1", provider: "codex", model: "gpt-6.1-sol", outcome: .pass, branch: "feature", target: "master", blocking: [], minor: [], merged: true, pushed: true)
        let fold = ThreadFold.fold(rows([
            user("go", newPass: true),
            todoWrite("t1", [("a", "completed")]),
            .notice(NoticeEvent(kind: .gate, message: "Typecheck passed on feature", gate: gate)),
            .notice(NoticeEvent(kind: .accountGone, message: "Account a is gone")),
            answer("done", msgId: "m1"),
            .turnComplete(TurnCompleteEvent()),
            user("more", newPass: true),
            todoWrite("t2", [("b", "completed")]),
            .notice(NoticeEvent(kind: .review, message: "Reviewed", review: review))
        ]))
        let board = ImplementationBoard.build(fold, running: false)
        #expect(board.rounds.count == 2)
        #expect(board.rounds[0].outcomes.map(\.seq) == [3])
        #expect(board.rounds[1].outcomes.map(\.seq) == [9])
        #expect(board.rounds.allSatisfy { $0.work.isEmpty })
        #expect(!Board.isOutcome(fold.items[3].item))
        #expect(Board.isOutcome(fold.items[2].item))
    }

    static let gateSteps: [(GateStep, String)] = [(.typecheck, "Typecheck"), (.gate, "Gate"), (.release, "Release"), (.unknown("smoke"), "Smoke")]

    @Test(arguments: gateSteps) func `a passed gate names its step and branch`(step: GateStep, label: String) {
        let gate = GateNotice(step: step, branch: "ios/board", ok: true, log: "anything", at: 0)
        #expect(GateLine.text(gate) == "\(label) passed on ios/board")
    }

    @Test func `a failed gate names what failed`() {
        let typecheck = GateNotice(step: .typecheck, branch: "f", ok: false, log: "src/a.ts(1,2): error TS2322: x\nFound 3 errors in 2 files.", at: 0)
        #expect(GateLine.text(typecheck) == "Typecheck failed on f with 3 errors")
        let one = GateNotice(step: .typecheck, branch: "f", ok: false, log: "Found 1 error.", at: 0)
        #expect(GateLine.text(one) == "Typecheck failed on f · 1 error")
        let silent = GateNotice(step: .typecheck, branch: "f", ok: false, log: "tsc crashed", at: 0)
        #expect(GateLine.text(silent) == "Typecheck failed on f")
        let gate = GateNotice(step: .gate, branch: "master", ok: false, log: "✓ typecheck 12s\n✗ vitest 40s failed", at: 0)
        #expect(GateLine.text(gate) == "Gate failed on master at vitest")
        let gateNoStep = GateNotice(step: .gate, branch: "master", ok: false, log: "boom", at: 0)
        #expect(GateLine.text(gateNoStep) == "Gate failed on master")
        let release = GateNotice(step: .release, branch: "master", ok: false, log: "✗ vitest", at: 0)
        #expect(GateLine.text(release) == "Release failed on master")
    }

    @Test func `the error count reads Found N first, else the error TS lines`() {
        #expect(GateLine.errorCount("Found 3 errors") == 3)
        #expect(GateLine.errorCount("Found 1 error in a.ts") == 1)
        #expect(GateLine.errorCount("a.ts: error TS2322: x\nb.ts: error TS7006: y\n") == 2)
        #expect(GateLine.errorCount("all good") == 0)
    }

    @Test func `the failed step is the last marked line, and the tail drops blank lines`() {
        #expect(GateLine.failedStep("✓ typecheck 12s\n✗ vitest 40s failed") == "vitest")
        #expect(GateLine.failedStep("✗ typecheck 1s\n✗ build 2s\n✓ done") == "build")
        #expect(GateLine.failedStep("✓ typecheck") == nil)
        #expect(GateLine.tail("a\n\n  \nb\nc\n", lines: 2) == "b\nc")
        #expect(GateLine.tail("a\nb", lines: 20) == "a\nb")
        #expect(GateLine.tail("", lines: 20) == "")
    }

    static func review(_ outcome: ReviewOutcome, blocking: Int = 0, minor: Int = 0, merged: Bool = false, reason: String? = nil, minutes: Double? = nil) -> ReviewNotice {
        let finding = { (i: Int) in ReviewFinding(file: "src/a\(i).ts", line: i, summary: "s", failure_scenario: "f") }
        let note = { (i: Int) in ReviewFinding(file: "src/m\(i).ts", line: i, summary: "s", failure_scenario: "f") }
        return ReviewNotice(runId: "r", reviewerId: "rev", provider: "codex", model: "gpt-6.1-sol", outcome: outcome, branch: "f", target: "master", blocking: (0..<blocking).map(finding), minor: (0..<minor).map(note), merged: merged, pushed: merged, reason: reason, minutes: minutes)
    }

    static let leads: [(ReviewOutcome, String)] = [
        (.pass, "Reviewed by GPT-6.1 Sol"), (.held, "Reviewed by GPT-6.1 Sol"), (.timeout, "Review by GPT-6.1 Sol timed out"),
        (.failed, "Review by GPT-6.1 Sol did not run"), (.mergedAnyway, "Merged anyway"), (.skipped, "Merged"), (.unknown("odd"), "Review")
    ]

    @Test(arguments: leads) func `the review lead follows the outcome`(outcome: ReviewOutcome, expected: String) {
        #expect(ReviewLine.lead(Self.review(outcome)) == expected)
    }

    @Test func `the review summary counts findings and says what happened to the merge`() {
        #expect(ReviewLine.summary(Self.review(.pass)) == "no blocking findings")
        #expect(ReviewLine.summary(Self.review(.pass, minor: 2)) == "no blocking findings, 2 minor")
        #expect(ReviewLine.summary(Self.review(.held, blocking: 2, minor: 1)) == "2 blocking findings, 1 minor, merge held")
        #expect(ReviewLine.summary(Self.review(.held, blocking: 1, merged: true)) == "1 blocking finding, merged anyway")
        #expect(ReviewLine.summary(Self.review(.timeout, minutes: 2.4)) == "after 2.4 min, merged without it")
        #expect(ReviewLine.summary(Self.review(.timeout, minutes: 15)) == "after 15 min, merged without it")
        #expect(ReviewLine.summary(Self.review(.timeout)) == "after ? min, merged without it")
        #expect(ReviewLine.summary(Self.review(.failed, reason: "the reviewer never reported")) == "the reviewer never reported, merged without it")
        #expect(ReviewLine.summary(Self.review(.failed)) == "merged without it")
        #expect(ReviewLine.summary(Self.review(.mergedAnyway, blocking: 1)) == "1 blocking finding overridden")
        #expect(ReviewLine.summary(Self.review(.skipped, reason: "review off")) == "review off")
        #expect(ReviewLine.summary(Self.review(.skipped)) == "")
        #expect(ReviewLine.summary(Self.review(.unknown("odd"))) == "odd")
    }

    @Test func `a review holds the merge only while blocking findings stand`() {
        #expect(ReviewLine.isHeld(Self.review(.held, blocking: 1)))
        #expect(!ReviewLine.isHeld(Self.review(.held, blocking: 1, merged: true)))
        #expect(!ReviewLine.isHeld(Self.review(.pass)))
        #expect(!ReviewLine.isHeld(Self.review(.mergedAnyway, blocking: 1, merged: true)))
    }
}
