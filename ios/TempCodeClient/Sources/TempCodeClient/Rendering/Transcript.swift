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
    /// Set by the `turn-complete` (or the idle status) that closed it.
    public var completedTs: Int?
    public var costUsd: Double?
    /// How long the turn lay down between the host's `stopped` close and a
    /// Resume that reopened it: the closing line leaves it out, as the host's
    /// strip does (`resumeStopped`), so the two agree.
    public var downMs: Int = 0
    /// The project rules this first message opened with (the desktop's PreambleRow).
    public var preamble: PreambleStamp? = nil
    /// A person's steer into a running turn: the id its `steer` rows name.
    public var steerId: String? = nil
    /// Where that steer stands, from its last `steer` row.
    public var steer: SteerStamp? = nil
}

/// Where a steer stands under its bubble: the desktop's steerWords.ts.
public struct SteerStamp: Sendable, Hashable {
    public var state: SteerEvent.State
    public var how: SteerEvent.How?
    public var reason: String?
    /// When (ms): the row's ts.
    public var ts: Int

    public init(state: SteerEvent.State, how: SteerEvent.How? = nil, reason: String? = nil, ts: Int) {
        self.state = state
        self.how = how
        self.reason = reason
        self.ts = ts
    }

    /// The one word under the bubble; nil for a state this build does not know.
    public var word: String? {
        switch state {
        case .sent: "Sent"
        case .received: "Received"
        case .queued: "Queued for the next turn"
        case .failed: "Not delivered"
        case .unknown: nil
        }
    }

    /// What the desktop's tooltip says: when (the locale's clock time), and how it went in.
    public func detail(timeZone: TimeZone = .current, locale: Locale = .current) -> String? {
        guard let word else { return nil }
        if state == .failed, let reason { return "Not delivered: \(reason)" }
        let clock = TimeFormat.clock(ts, locale: locale, timeZone: timeZone)
        let lead = state == .queued ? "Queued" : word
        return "\(lead) at \(clock)\(state == .received && how == .nextTurn ? ", as its own turn" : "")"
    }
}

public struct TextBlock: Sendable, Hashable {
    public var seq: Int
    public var ts: Int
    public var text: String
    /// Only deltas so far; the final row has not come.
    public var streaming: Bool
    public var parentCallId: String?
    /// When the final row landed; nil while streaming.
    public var doneTs: Int? = nil

    /// How long the block streamed, when it did.
    public var durationMs: Int? {
        guard let doneTs, doneTs > ts else { return nil }
        return doneTs - ts
    }
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
    /// When the result landed.
    public var doneTs: Int? = nil
    /// The host's live diff of the file this edit is changing, while it runs.
    public var live: LiveEditState? = nil
    /// A spawn_agent call: the children the host said it spawned
    /// (`agent-spawned`), in order; a child on another host as `<env>:<id>`.
    public var spawned: [String] = []
    /// A wait whose result the host left behind (over 2 KiB, which most
    /// replies pass): the agents it returned on, read from the body's head
    /// and the agents' own sessions (`WaitSteps.resolved`). Nil otherwise.
    public var waitOutcomes: [WaitSteps.Outcome]? = nil

    /// What the row shows after the name: a command, a path, a query.
    public var detail: String? {
        if let preview, let path = preview.path, preview.kind != .shell { return preview.fileName ?? path }
        guard case .object(let fields)? = input else { return nil }
        for key in ["command", "file_path", "path", "pattern", "query", "url", "description"] {
            if case .string(let value)? = fields[key], !value.isEmpty { return value }
        }
        return nil
    }

    /// The tool's run so far, or whole.
    public func elapsedMs(now: Int? = nil) -> Int? {
        if let doneTs { return max(0, doneTs - ts) }
        guard let now else { return nil }
        return max(0, now - ts)
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
    /// Its turn ended or paused with the compaction still open: it stopped
    /// there, at this time ("Compaction stopped" and its span).
    public var stoppedTs: Int? = nil
}

public struct SystemLine: Sendable, Hashable {
    public enum Kind: Sendable, Hashable { case plan, turnPass, agentSpawned, agentReport, planHandoff, backgroundTask, goal, error, status, unknown }

    public var seq: Int
    public var ts: Int
    public var kind: Kind
    public var text: String
    public var detail: String?
    /// `error` rows: the turn stopped here.
    public var stopped: Bool
    /// `agentSpawned`, `agentReport` and `planHandoff` rows: the child session the row is about.
    public var agentId: String? = nil
    /// `error` rows: the host's verdict on what went wrong, when it gave one.
    public var failure: Failure? = nil
    /// A host notice's whole payload (a gate run, a review verdict, an account
    /// that left), so the board and the host rows can draw it as more than a
    /// line. Last and defaulted: every `SystemLine(seq:ts:kind:text:detail:stopped:)`
    /// call stays as it is.
    public var notice: NoticeEvent? = nil
    /// A held review whose merge was later forced through (a merged-anyway notice with the same runId).
    public var reviewResolved: Bool = false
    /// `agentReport` rows: the report names this thread itself, a master's
    /// batch reporting in: it reads "the batch" and opens nothing.
    public var batch: Bool = false
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
        case .approval(let v): v.seq
        case .compaction(let v): v.seq
        case .system(let v): v.seq
        }
    }

    /// When the row was born.
    public var ts: Int {
        switch self {
        case .user(let v): v.ts
        case .assistant(let v), .thinking(let v): v.ts
        case .tool(let v): v.ts
        case .question(let v): v.ts
        case .approval(let v): v.ts
        case .compaction(let v): v.ts
        case .system(let v): v.ts
        }
    }

    public var id: Int { seq }

    /// An approval not yet decided or a question not yet answered.
    public var needsUser: Bool {
        switch self {
        case .approval(let approval): approval.allowed == nil
        case .question(let question): !question.resolved
        default: false
        }
    }

    public var isError: Bool {
        if case .system(let line) = self, line.kind == .error { return true }
        return false
    }
}

/// Rows → items, without the round and todo stamps. The fold itself lives
/// in `ThreadFold`; this is its transcript view, kept for callers that
/// need the items alone.
public enum Transcript {
    public static func fold(_ rows: [EventRow]) -> [TranscriptItem] {
        ThreadFold.fold(rows).items.map(\.item)
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
