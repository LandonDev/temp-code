import Foundation
import TempCodeContract

/// Fleet selectors: which children a thread has, how they rank, and the one
/// line and stats a row shows for each (the desktop's agents.ts).
public enum Fleet {
    /// Rows sort by what needs the user first: waiting, failed, working, done.
    public static func rank(_ status: SessionStatus?) -> Int {
        switch status {
        case .waiting?: 0
        case .error?: 1
        case .starting?, .running?: 2
        default: 3
        }
    }

    /// A queued thread (created, not booted) is not live, whatever its rank.
    public static func isLive(_ status: SessionStatus?) -> Bool {
        status == .running || status == .starting
    }

    public static func sort(_ list: [SessionMeta]) -> [SessionMeta] {
        list.sorted { (rank($0.status), $0.createdAt) < (rank($1.status), $1.createdAt) }
    }

    /// Unarchived children of `parentId`, ranked.
    public static func children(of parentId: String, in metas: [SessionMeta]) -> [SessionMeta] {
        sort(metas.filter { $0.parentId == parentId && !$0.archived })
    }

    public struct Counts: Sendable, Hashable {
        public var working = 0
        public var waiting = 0
        public var failed = 0
        public var done = 0

        public init(working: Int = 0, waiting: Int = 0, failed: Int = 0, done: Int = 0) {
            self.working = working
            self.waiting = waiting
            self.failed = failed
            self.done = done
        }

        /// A child works or waits.
        public var active: Bool { working > 0 || waiting > 0 }
    }

    public static func counts(_ statuses: [SessionStatus]) -> Counts {
        var out = Counts()
        for status in statuses {
            if isLive(status) || status == .watching { out.working += 1 }
            else if status == .waiting { out.waiting += 1 }
            else if status == .error { out.failed += 1 }
            else { out.done += 1 }
        }
        return out
    }

    /// Fleets at or under this size load every row's transcript for its
    /// line and stats; above it only rows still working, waiting or failed
    /// do, and a settled row loads when opened.
    public static let eagerLoad = 24

    public static func loadsTranscript(status: SessionStatus, fleetSize: Int) -> Bool {
        if fleetSize <= eagerLoad { return true }
        return isLive(status) || status == .waiting || status == .error
    }

    // MARK: - groups

    /// How the phone's list groups a fleet: what runs, what needs the user,
    /// what has settled (done, idle, paused and failed alike; a failed
    /// agent keeps its red mark and its rank puts it first in the group).
    public enum Group: Int, CaseIterable, Sendable, Hashable {
        case running, waiting, done

        public var title: String {
            switch self {
            case .running: "Running"
            case .waiting: "Waiting"
            case .done: "Done"
            }
        }
    }

    public static func group(_ status: SessionStatus?) -> Group {
        if isLive(status) || status == .watching { return .running }
        if status == .waiting { return .waiting }
        return .done
    }

    public struct Section: Sendable, Hashable, Identifiable {
        public let group: Group
        public let agents: [SessionMeta]

        public init(group: Group, agents: [SessionMeta]) {
            self.group = group
            self.agents = agents
        }

        public var id: Group { group }
    }

    /// The fleet in its three groups, in group order, empty groups left out;
    /// inside a group the rank order holds (a failed agent before a settled one).
    public static func sections(_ agents: [SessionMeta]) -> [Section] {
        var byGroup: [Group: [SessionMeta]] = [:]
        for agent in sort(agents) { byGroup[group(agent.status), default: []].append(agent) }
        return Group.allCases.compactMap { group in
            guard let list = byGroup[group], !list.isEmpty else { return nil }
            return Section(group: group, agents: list)
        }
    }

    // MARK: - the orchestrator

    /// The one line under the goal: what the orchestrator itself is up to,
    /// else what its fleet is (the desktop's FleetPulseLine).
    public static func orchestratorLine(status: SessionStatus?, counts: Counts) -> String {
        switch status {
        case .running?, .starting?: return "Orchestrating"
        case .waiting?: return "Waiting on you"
        case .error?: return "Failed"
        case .paused?: return "Paused"
        case .watching?: return "Waiting on background work"
        default: break
        }
        if counts.working > 0 { return "\(counts.working) subagent\(counts.working == 1 ? "" : "s") working" }
        if counts.waiting > 0 { return "\(counts.waiting) subagent\(counts.waiting == 1 ? "" : "s") waiting on approval" }
        if counts.failed > 0 { return "Done, \(counts.failed) failed" }
        return counts.done > 0 ? "Done" : ""
    }

    /// The last path component of an agent's directory when it works
    /// somewhere other than its parent (a worktree), else nil.
    public static func branch(cwd: String, parentCwd: String?) -> String? {
        let own = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !own.isEmpty, own != parentCwd else { return nil }
        return own.split(separator: "/").last.map(String.init)
    }

    /// How long the agent has run: since its start while live, else its
    /// whole span once settled; nil when that span is too short to mean anything.
    public static func elapsedMs(_ agent: SessionMeta, now: Int) -> Int? {
        if isLive(agent.status) { return max(0, now - agent.createdAt) }
        let span = agent.updatedAt - agent.createdAt
        return span > 2_000 ? span : nil
    }

    // MARK: - transcript lines

    static func firstLine(_ text: String) -> String { Board.firstLine(text) }

    /// What the agent is doing right now: its latest tool call, else its
    /// latest words, else its latest error.
    public static func activityLine(_ items: [ThreadEntry]) -> String {
        for entry in items.reversed() {
            switch entry.item {
            case .tool(let tool):
                let name = tool.display?.app ?? tool.name
                let detail = tool.detail.map(firstLine) ?? ""
                return detail.isEmpty ? name : "\(name) · \(detail)"
            case .assistant(let block) where !block.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                return firstLine(block.text)
            case .system(let line) where line.kind == .error && !line.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                return firstLine(line.text)
            default:
                continue
            }
        }
        return ""
    }

    public static func lastAssistantLine(_ items: [ThreadEntry]) -> String {
        for entry in items.reversed() {
            if case .assistant(let block) = entry.item, !block.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return firstLine(block.text) }
        }
        return ""
    }

    /// The task the agent was handed: its first user message.
    public static func taskTitle(_ items: [ThreadEntry]) -> String {
        for entry in items {
            if case .user(let turn) = entry.item, !turn.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return firstLine(turn.text) }
        }
        return ""
    }

    public static func lastErrorLine(_ items: [ThreadEntry]) -> String {
        for entry in items.reversed() {
            if case .system(let line) = entry.item, line.kind == .error, !line.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return firstLine(line.text) }
        }
        return ""
    }

    public enum Tone: Sendable, Hashable { case warning, danger, muted }

    public struct Line: Sendable, Hashable {
        public var text: String
        public var tone: Tone

        public init(_ text: String, tone: Tone) {
            self.text = text
            self.tone = tone
        }
    }

    /// The row's one-line status and its colour; compaction shows while live.
    public static func line(status: SessionStatus?, items: [ThreadEntry], compacting: Bool = false) -> Line {
        if isLive(status), compacting { return Line("compacting the context…", tone: .muted) }
        if status == .waiting {
            for entry in items.reversed() {
                switch entry.item {
                case .question(let question) where !question.resolved:
                    let q = question.request.questions.first?.question ?? ""
                    return Line(q.isEmpty ? "has a question" : "has a question — \(firstLine(q))", tone: .warning)
                case .approval(let approval) where approval.allowed == nil:
                    let title = approval.request.title ?? approval.request.toolName
                    return Line(title.isEmpty ? "waiting for approval" : "waiting for approval — \(title)", tone: .warning)
                default:
                    continue
                }
            }
            return Line("waiting for approval", tone: .warning)
        }
        if status == .error {
            let last = lastErrorLine(items)
            return Line(last.isEmpty ? "failed" : last, tone: .danger)
        }
        if status == .watching { return Line("waiting on background work", tone: .muted) }
        if isLive(status) { return Line(activityLine(items), tone: .muted) }
        return Line(lastAssistantLine(items), tone: .muted)
    }

    // MARK: - stats

    public struct Stats: Sendable, Hashable {
        public var adds = 0
        public var dels = 0
        public var tasksDone = 0
        public var tasksTotal = 0
        /// Whole percent of the context window in use; nil when unknown.
        public var contextPercent: Int?
        public var cost: Double?

        public init(adds: Int = 0, dels: Int = 0, tasksDone: Int = 0, tasksTotal: Int = 0, contextPercent: Int? = nil, cost: Double? = nil) {
            self.adds = adds
            self.dels = dels
            self.tasksDone = tasksDone
            self.tasksTotal = tasksTotal
            self.contextPercent = contextPercent
            self.cost = cost
        }

        public var isEmpty: Bool { adds == 0 && dels == 0 && tasksTotal == 0 && contextPercent == nil }
    }

    /// Edit totals over the items, the task tally from the host (else the
    /// folded list), the context reading and the cost.
    public static func stats(items: [ThreadEntry], tasks: SessionMeta.Tasks?, board: BoardState?, context: SessionMeta.Context?) -> Stats {
        var out = Stats()
        for entry in items {
            guard case .tool(let tool) = entry.item, let preview = tool.preview, preview.kind == .write else { continue }
            out.adds += Int(preview.additions ?? 0)
            out.dels += Int(preview.deletions ?? 0)
        }
        if let tasks {
            out.tasksDone = tasks.done
            out.tasksTotal = tasks.total
        } else if let board {
            let tally = board.tally
            out.tasksDone = tally.done
            out.tasksTotal = tally.total
        }
        if let context, let window = context.window, window > 0 {
            out.contextPercent = Int((Double(context.tokens) / Double(window) * 100).rounded())
        }
        out.cost = board?.cost
        return out
    }
}
