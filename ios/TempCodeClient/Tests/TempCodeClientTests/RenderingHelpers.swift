import Foundation
import TempCodeContract
@testable import TempCodeClient

/// Rows the way the desktop's fold tests make them: seq i+1, ts 1_000 + 100·i.
func rows(_ events: [AgentEvent]) -> [EventRow] {
    events.enumerated().map { EventRow(sessionId: "s", seq: $0.offset + 1, ts: 1_000 + 100 * $0.offset, event: $0.element) }
}

func todoWrite(_ callId: String, _ todos: [(String, String)]) -> AgentEvent {
    .toolCall(ToolCallEvent(callId: callId, name: "TodoWrite", input: .object(["todos": .array(todos.map { .object(["content": .string($0.0), "status": .string($0.1)]) })])))
}

func call(_ callId: String, _ name: String, _ input: [String: JSONValue] = [:], preview: ToolPreview? = nil) -> AgentEvent {
    .toolCall(ToolCallEvent(callId: callId, name: name, input: .object(input), preview: preview))
}

func result(_ callId: String, _ output: String = "ok", isError: Bool = false) -> AgentEvent {
    .toolResult(ToolResultEvent(callId: callId, output: .string(output), isError: isError))
}

func user(_ text: String, newPass: Bool? = nil) -> AgentEvent {
    .userText(UserTextEvent(text: text, newPass: newPass))
}

func answer(_ text: String, msgId: String = "m", blockIndex: Double = 0) -> AgentEvent {
    .assistantText(AssistantTextEvent(text: text, delta: false, msgId: msgId, blockIndex: blockIndex))
}

func editPreview(_ path: String, adds: Int, dels: Int = 0, lines: [String] = []) -> ToolPreview {
    ToolPreview(kind: .write, path: path, fileName: path.split(separator: "/").last.map(String.init), additions: Double(adds), deletions: Double(dels), lines: lines.isEmpty ? nil : .array(lines.map { ToolPreview.Line(number: nil, kind: .add, text: $0) }))
}

/// A thread item made directly, for the selectors that only read stamps and times.
func item(_ item: TranscriptItem, round: Int = 0, todo: Int = -1, pass: Bool = false) -> ThreadEntry {
    ThreadEntry(item: item, round: round, todo: todo, pass: pass)
}

func userItem(_ seq: Int, ts: Int, _ text: String = "go") -> TranscriptItem {
    .user(UserTurn(seq: seq, ts: ts, text: text, attachments: [], model: nil, reasoning: nil, completedTs: nil, costUsd: nil))
}

func toolItem(_ seq: Int, ts: Int = 0, doneTs: Int? = nil, name: String = "Read", callId: String? = nil, input: [String: JSONValue] = [:], preview: ToolPreview? = nil) -> TranscriptItem {
    .tool(ToolItem(seq: seq, ts: ts, callId: callId ?? "c\(seq)", name: name, display: nil, input: input.isEmpty ? nil : .object(input), partial: false, preview: preview, parentCallId: nil, inputOmitted: false, output: .none, status: doneTs == nil ? .running : .done, reauth: nil, doneTs: doneTs))
}

func textItem(_ seq: Int, ts: Int = 0, _ text: String, thinking: Bool = false, streaming: Bool = false) -> TranscriptItem {
    let block = TextBlock(seq: seq, ts: ts, text: text, streaming: streaming, parentCallId: nil, doneTs: streaming ? nil : ts)
    return thinking ? .thinking(block) : .assistant(block)
}

func errorItem(_ seq: Int, ts: Int = 0, _ text: String) -> TranscriptItem {
    .system(SystemLine(seq: seq, ts: ts, kind: .error, text: text, detail: nil, stopped: false))
}

func meta(_ id: String, parentId: String? = nil, status: SessionStatus = .idle, archived: Bool = false, createdAt: Int = 1, updatedAt: Int = 1, title: String = "", tasks: SessionMeta.Tasks? = nil, context: SessionMeta.Context? = nil, frozenActiveElapsed: Int? = nil, activity: String? = nil, provider: ProviderId = .claude, agentType: AgentType = .implementer, model: String = "claude-sonnet-5-5", threadType: ThreadType? = nil, isMaster: Bool? = nil, busySince: Int? = nil, treeHasLiveWork: Bool? = nil) -> SessionMeta {
    SessionMeta(id: id, parentId: parentId, projectId: nil, workspaceId: nil, threadType: threadType, planPath: nil, provider: provider, model: model, reasoning: .low, agentType: agentType, title: title, cwd: "/repo", status: status, pinned: false, archived: archived, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: busySince, pausedAt: nil, frozenActiveElapsed: frozenActiveElapsed, nativeId: nil, activity: activity, tasks: tasks, context: context, treeHasLiveWork: treeHasLiveWork, isMaster: isMaster, createdAt: createdAt, updatedAt: updatedAt)
}
