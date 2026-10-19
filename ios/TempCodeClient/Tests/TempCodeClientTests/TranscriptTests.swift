import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func row(_ seq: Int, _ event: AgentEvent) -> EventRow {
    EventRow(sessionId: "s", seq: seq, ts: 1_000 + seq, event: event)
}

@Suite struct TranscriptTests {
    @Test func `deltas merge into one block until the final row replaces them`() {
        let items = Transcript.fold([
            row(1, .userText(UserTextEvent(text: "Hi"))),
            row(2, .thinking(ThinkingEvent(text: "The ", delta: true, msgId: "m", blockIndex: 0))),
            row(3, .thinking(ThinkingEvent(text: "user", delta: true, msgId: "m", blockIndex: 0))),
            row(4, .assistantText(AssistantTextEvent(text: "Hel", delta: true, msgId: "m", blockIndex: 1))),
            row(5, .assistantText(AssistantTextEvent(text: "Hello there.", delta: false, msgId: "m", blockIndex: 1))),
            row(6, .thinking(ThinkingEvent(text: "The user greets.", delta: false, msgId: "m", blockIndex: 0))),
            row(7, .turnComplete(TurnCompleteEvent(costUsd: 0.5)))
        ])
        #expect(items.count == 3)
        guard case .user(let turn) = items[0], case .thinking(let thinking) = items[1], case .assistant(let answer) = items[2] else {
            Issue.record("shape \(items)")
            return
        }
        #expect(turn.completedTs == 1_007)
        #expect(turn.costUsd == 0.5)
        #expect(thinking.text == "The user greets.")
        #expect(!thinking.streaming)
        #expect(answer.text == "Hello there.")
        #expect(answer.seq == 4)
    }

    @Test func `a streaming block shows what has arrived so far`() {
        let items = Transcript.fold([
            row(1, .assistantText(AssistantTextEvent(text: "Wor", delta: true, msgId: "m", blockIndex: 0))),
            row(2, .assistantText(AssistantTextEvent(text: "king", delta: true, msgId: "m", blockIndex: 0)))
        ])
        guard case .assistant(let block)? = items.first else {
            Issue.record("no block")
            return
        }
        #expect(block.text == "Working")
        #expect(block.streaming)
    }

    @Test func `a tool call pairs with its result and keeps an omitted body's promise`() {
        let omitted = OmittedBody(omitted: true, bytes: 6_000, lines: 100, head: "line 000")
        let items = Transcript.fold([
            row(1, .toolCall(ToolCallEvent(callId: "c1", name: "Bash", input: .object(["command": .string("seq 1 100")]), partial: true))),
            row(2, .toolCall(ToolCallEvent(callId: "c1", name: "Bash", input: .object(["command": .string("seq 1 100"), "description": .string("Count")])))),
            row(3, .toolResult(ToolResultEvent(callId: "c1", output: .omittedBody(omitted), isError: false))),
            row(4, .toolCall(ToolCallEvent(callId: "c2", name: "Edit", input: .object(["file_path": .string("/src/a.ts"), "old_string": .object(["omitted": .bool(true), "bytes": .number(3_000), "lines": .number(80), "head": .string("x")])])))),
            row(5, .toolResult(ToolResultEvent(callId: "c2", output: .string("ok"), isError: true)))
        ])
        #expect(items.count == 2)
        guard case .tool(let bash) = items[0], case .tool(let edit) = items[1] else {
            Issue.record("shape")
            return
        }
        #expect(bash.status == .done)
        #expect(bash.detail == "seq 1 100")
        #expect(!bash.partial)
        #expect(bash.output == .omitted(omitted, seq: 3))
        #expect(edit.status == .failed)
        #expect(edit.inputOmitted)
        #expect(edit.detail == "/src/a.ts")
        #expect(edit.output == .whole("ok"))
    }

    @Test func `questions and approvals resolve in place and errors clear`() {
        let question = QuestionRequestEvent(requestId: "q1", questions: [.init(question: "Which?", options: [.init(label: "A"), .init(label: "B")])])
        let items = Transcript.fold([
            row(1, .questionRequest(question)),
            row(2, .approvalRequest(ApprovalRequestEvent(requestId: "p1", toolName: "Bash"))),
            row(3, .error(ErrorEvent(message: "boom"))),
            row(4, .questionResolved(QuestionResolvedEvent(requestId: "q1", answers: [["B"]]))),
            row(5, .approvalResolved(ApprovalResolvedEvent(requestId: "p1", allow: false, auto: true))),
            row(6, .errorsCleared(ErrorsClearedEvent())),
            row(7, .compaction(CompactionEvent(phase: .start, trigger: .auto, preTokens: 100_000))),
            row(8, .compaction(CompactionEvent(phase: .done, postTokens: 20_000, durationMs: 1_500))),
            row(9, .unknown(.object(["type": .string("new-thing")])))
        ])
        #expect(items.map(\.seq) == [1, 2, 7, 9])
        guard case .question(let q) = items[0], case .approval(let a) = items[1], case .compaction(let c) = items[2], case .system(let u) = items[3] else {
            Issue.record("shape")
            return
        }
        #expect(q.resolved && q.answers == [["B"]])
        #expect(a.allowed == false && a.auto)
        #expect(c.phase == .done && c.postTokens == 20_000 && c.preTokens == 100_000)
        #expect(u.kind == .unknown)
    }
}
