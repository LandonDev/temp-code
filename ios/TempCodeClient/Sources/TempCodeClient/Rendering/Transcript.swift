import Foundation
import TempCodeContract

/// A body a row carries, or the promise of one: the remote profile leaves
/// bodies over 2 KiB on the host and sends `head`, `lines` and `bytes`.
public enum BodyState: Sendable, Hashable {
    case whole(String)
    /// `seq` is the row `session.rowBody` fetches to make it whole.
    case omitted(OmittedBody, seq: Int)
    case none

    public var isOmitted: Bool {
        if case .omitted = self { return true }
        return false
    }
}

public struct UserTurn: Sendable, Hashable {
    public var seq: Int
    public var ts: Int
    public var text: String
    public var attachments: [Attachment]
    public var model: String?
    public var reasoning: String?
    /// Set by the `turn-complete` that answered it.
    public var completedTs: Int?
    public var costUsd: Double?
}

public struct TextBlock: Sendable, Hashable {
    public var seq: Int
    public var ts: Int
    public var text: String
    /// Only deltas so far; the final row has not come.
    public var streaming: Bool
    public var parentCallId: String?
}

public struct ToolItem: Sendable, Hashable {
    public enum Status: Sendable, Hashable { case running, done, failed }

    public var seq: Int
    public var ts: Int
    public var callId: String
    public var name: String
    public var display: ToolCallEvent.Display?
    public var input: JSONValue?
    /// The call's input still streams in.
    public var partial: Bool
    public var preview: ToolPreview?
    public var parentCallId: String?
    /// Omitted strings inside the input (an Edit's old and new text): the call row holds them whole.
    public var inputOmitted: Bool
    public var output: BodyState
    public var status: Status
    public var reauth: ToolResultEvent.Reauth?

    /// What the row shows after the name: a command, a path, a query.
    public var detail: String? {
        if let preview, let path = preview.path, preview.kind != .shell { return preview.fileName ?? path }
        guard case .object(let fields)? = input else { return nil }
        for key in ["command", "file_path", "path", "pattern", "query", "url", "description"] {
            if case .string(let value)? = fields[key], !value.isEmpty { return value }
        }
        return nil
    }
}

public struct QuestionItem: Sendable, Hashable {
    public var seq: Int
    public var ts: Int
    public var request: QuestionRequestEvent
    public var answers: [[String]]?
    public var resolved: Bool
}

public struct ApprovalItem: Sendable, Hashable {
    public var seq: Int
    public var ts: Int
    public var request: ApprovalRequestEvent
    public var allowed: Bool?
    public var auto: Bool
}

public struct CompactionItem: Sendable, Hashable {
    public var seq: Int
    public var ts: Int
    public var phase: CompactionEvent.Phase
    public var trigger: CompactionEvent.Trigger?
    public var preTokens: Double?
    public var postTokens: Double?
    public var durationMs: Double?
    public var error: String?
}

public struct SystemLine: Sendable, Hashable {
    public enum Kind: Sendable, Hashable { case plan, turnPass, agentSpawned, agentReport, backgroundTask, goal, error, status, unknown }

    public var seq: Int
    public var ts: Int
    public var kind: Kind
    public var text: String
    public var detail: String?
    /// `error` rows: the turn stopped here.
    public var stopped: Bool
}

/// One thing the transcript shows, in order. Rows that are bookkeeping
/// (usage, context, status, errors-cleared) fold into their neighbours.
public enum TranscriptItem: Sendable, Hashable, Identifiable {
    case user(UserTurn)
    case assistant(TextBlock)
    case thinking(TextBlock)
    case tool(ToolItem)
    case question(QuestionItem)
    case approval(ApprovalItem)
    case compaction(CompactionItem)
    case system(SystemLine)

    public var seq: Int {
        switch self {
        case .user(let v): v.seq
        case .assistant(let v), .thinking(let v): v.seq
        case .tool(let v): v.seq
        case .question(let v): v.seq
        case .approval(let v): v.approval.seq
        case .compaction(let v): v.seq
        case .system(let v): v.seq
        }
    }

    public var id: Int { seq }
}

extension ApprovalItem {
    fileprivate var approval: ApprovalItem { self }
}

/// Rows → items. The desktop's fold rules (src/renderer/src/lib/session.ts):
/// assistant text and thinking merge by (msgId, blockIndex) with deltas
/// appended until the final row replaces them; a tool call and its result
/// pair by callId; questions and approvals pair by requestId; a compaction's
/// done row updates its start; `turn-complete` closes the user turn before
/// it; `errors-cleared` drops the error lines so far.
public enum Transcript {
    public static func fold(_ rows: [EventRow]) -> [TranscriptItem] {
        var items: [TranscriptItem] = []
        var textIndex: [String: Int] = [:]        // "msgId/blockIndex/kind" → items index
        var toolIndex: [String: Int] = [:]        // callId → items index
        var questionIndex: [String: Int] = [:]    // requestId → items index
        var approvalIndex: [String: Int] = [:]
        var lastUser: Int?
        var openCompaction: Int?

        for row in rows {
            switch row.event {
            case .userText(let event):
                items.append(.user(UserTurn(seq: row.seq, ts: row.ts, text: event.text, attachments: event.attachments ?? [], model: event.model, reasoning: event.reasoning, completedTs: nil, costUsd: nil)))
                lastUser = items.count - 1
            case .assistantText(let event):
                mergeText(&items, &textIndex, row: row, kind: "a", text: event.text, delta: event.delta, msgId: event.msgId, blockIndex: event.blockIndex, parentCallId: event.parentCallId) { .assistant($0) }
            case .thinking(let event):
                mergeText(&items, &textIndex, row: row, kind: "t", text: event.text, delta: event.delta, msgId: event.msgId, blockIndex: event.blockIndex, parentCallId: event.parentCallId) { .thinking($0) }
            case .toolCall(let event):
                if let index = toolIndex[event.callId], case .tool(var tool) = items[index] {
                    tool.input = event.input ?? tool.input
                    tool.partial = event.partial ?? false
                    tool.preview = event.preview ?? tool.preview
                    tool.display = event.display ?? tool.display
                    tool.inputOmitted = tool.inputOmitted || containsOmitted(event.input)
                    items[index] = .tool(tool)
                } else {
                    items.append(.tool(ToolItem(seq: row.seq, ts: row.ts, callId: event.callId, name: event.name, display: event.display, input: event.input, partial: event.partial ?? false, preview: event.preview, parentCallId: event.parentCallId, inputOmitted: containsOmitted(event.input), output: .none, status: .running, reauth: nil)))
                    toolIndex[event.callId] = items.count - 1
                }
            case .toolResult(let event):
                let output: BodyState
                switch event.output {
                case .string(let text): output = .whole(text)
                case .omittedBody(let omitted): output = .omitted(omitted, seq: row.seq)
                case .unknown: output = .none
                }
                if let index = toolIndex[event.callId], case .tool(var tool) = items[index] {
                    tool.output = output
                    tool.status = event.isError ? .failed : .done
                    tool.reauth = event.reauth
                    tool.partial = false
                    items[index] = .tool(tool)
                } else {
                    items.append(.tool(ToolItem(seq: row.seq, ts: row.ts, callId: event.callId, name: "result", display: nil, input: nil, partial: false, preview: nil, parentCallId: event.parentCallId, inputOmitted: false, output: output, status: event.isError ? .failed : .done, reauth: event.reauth)))
                    toolIndex[event.callId] = items.count - 1
                }
            case .turnComplete(let event):
                if let index = lastUser, case .user(var turn) = items[index] {
                    turn.completedTs = row.ts
                    turn.costUsd = event.costUsd ?? turn.costUsd
                    items[index] = .user(turn)
                }
            case .questionRequest(let event):
                items.append(.question(QuestionItem(seq: row.seq, ts: row.ts, request: event, answers: nil, resolved: false)))
                questionIndex[event.requestId] = items.count - 1
            case .questionResolved(let event):
                if let index = questionIndex[event.requestId], case .question(var question) = items[index] {
                    question.answers = event.answers
                    question.resolved = true
                    items[index] = .question(question)
                }
            case .approvalRequest(let event):
                items.append(.approval(ApprovalItem(seq: row.seq, ts: row.ts, request: event, allowed: nil, auto: false)))
                approvalIndex[event.requestId] = items.count - 1
            case .approvalResolved(let event):
                if let index = approvalIndex[event.requestId], case .approval(var approval) = items[index] {
                    approval.allowed = event.allow
                    approval.auto = event.auto ?? false
                    items[index] = .approval(approval)
                }
            case .compaction(let event):
                if event.phase == .start || openCompaction == nil {
                    items.append(.compaction(CompactionItem(seq: row.seq, ts: row.ts, phase: event.phase, trigger: event.trigger, preTokens: event.preTokens, postTokens: event.postTokens, durationMs: event.durationMs, error: event.error)))
                    openCompaction = event.phase == .start ? items.count - 1 : nil
                } else if let index = openCompaction, case .compaction(var compaction) = items[index] {
                    compaction.phase = event.phase
                    compaction.postTokens = event.postTokens ?? compaction.postTokens
                    compaction.preTokens = event.preTokens ?? compaction.preTokens
                    compaction.durationMs = event.durationMs ?? compaction.durationMs
                    compaction.error = event.error
                    items[index] = .compaction(compaction)
                    openCompaction = nil
                }
            case .plan(let event):
                items.append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .plan, text: event.text, detail: nil, stopped: false)))
            case .turnPass(let event):
                items.append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .turnPass, text: event.actions.joined(separator: ", "), detail: nil, stopped: false)))
            case .agentSpawned(let event):
                items.append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .agentSpawned, text: "Spawned an agent", detail: event.childSessionId, stopped: false)))
            case .agentReport(let event):
                items.append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .agentReport, text: event.title, detail: event.status, stopped: false)))
            case .backgroundTask(let event):
                items.append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .backgroundTask, text: event.description, detail: event.status.rawValue, stopped: false)))
            case .backgroundTasks(let event):
                guard !event.tasks.isEmpty else { break }
                items.append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .backgroundTask, text: event.tasks.joined(separator: "\n"), detail: nil, stopped: false)))
            case .goal(let event):
                items.append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .goal, text: event.condition, detail: event.phase.rawValue, stopped: false)))
            case .error(let event):
                items.append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .error, text: event.message, detail: nil, stopped: event.stopped ?? false)))
            case .errorsCleared:
                items.removeAll { if case .system(let line) = $0, line.kind == .error { return true } else { return false } }
                rebuildIndexes(items, &textIndex, &toolIndex, &questionIndex, &approvalIndex, &lastUser, &openCompaction)
            case .status(let event):
                // The session meta carries status; a detail is worth a line.
                if let detail = event.detail, !detail.isEmpty, event.status == .error {
                    items.append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .status, text: detail, detail: nil, stopped: false)))
                }
            case .researchSource, .usage, .context:
                break
            case .unknown:
                items.append(.system(SystemLine(seq: row.seq, ts: row.ts, kind: .unknown, text: "Something this version of the app does not show", detail: nil, stopped: false)))
            }
        }
        return items
    }

    private static func mergeText(_ items: inout [TranscriptItem], _ index: inout [String: Int], row: EventRow, kind: String, text: String, delta: Bool, msgId: String?, blockIndex: Double?, parentCallId: String?, wrap: (TextBlock) -> TranscriptItem) {
        let key = msgId.map { "\($0)/\(blockIndex ?? 0)/\(kind)" }
        if let key, let at = index[key] {
            var block: TextBlock
            switch items[at] {
            case .assistant(let b), .thinking(let b): block = b
            default: return
            }
            if delta {
                if block.streaming { block.text += text }
            } else {
                block.text = text
                block.streaming = false
            }
            items[at] = wrap(block)
            return
        }
        let block = TextBlock(seq: row.seq, ts: row.ts, text: text, streaming: delta, parentCallId: parentCallId)
        items.append(wrap(block))
        if let key { index[key] = items.count - 1 }
    }

    private static func rebuildIndexes(_ items: [TranscriptItem], _ text: inout [String: Int], _ tools: inout [String: Int], _ questions: inout [String: Int], _ approvals: inout [String: Int], _ lastUser: inout Int?, _ openCompaction: inout Int?) {
        text = [:]
        tools = [:]
        questions = [:]
        approvals = [:]
        lastUser = nil
        openCompaction = nil
        for (offset, item) in items.enumerated() {
            switch item {
            case .user: lastUser = offset
            case .tool(let tool): tools[tool.callId] = offset
            case .question(let q): questions[q.request.requestId] = offset
            case .approval(let a): approvals[a.request.requestId] = offset
            case .compaction(let c) where c.phase == .start: openCompaction = offset
            default: break
            }
        }
    }

    /// True when a JSON value holds an omitted body anywhere inside.
    public static func containsOmitted(_ value: JSONValue?) -> Bool {
        guard let value else { return false }
        switch value {
        case .object(let fields):
            if case .bool(true)? = fields["omitted"], fields["bytes"] != nil { return true }
            return fields.values.contains { containsOmitted($0) }
        case .array(let values):
            return values.contains { containsOmitted($0) }
        default:
            return false
        }
    }
}
