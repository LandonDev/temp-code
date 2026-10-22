import Foundation
import TempCodeContract

/// Fleet selectors: which children a thread has, how they rank, and the one
/// line and stats a row shows for each (the desktop's agents.ts).
public enum Fleet {
    /// Rows sort by what needs the user first: waiting, then failed and
    /// stopped (a gone harness needs the person like a failure does), then
    /// working, then the rest (queued among them).
    public static func rank(_ status: SessionStatus?) -> Int {
        switch status {
        case .waiting?: 0
        case .error?, .stopped?: 1
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
        /// Created, not booted: waiting for a sibling to finish.
        public var queued = 0
        /// The harness behind the turn is gone.
        public var stopped = 0

        public init(working: Int = 0, waiting: Int = 0, failed: Int = 0, done: Int = 0, queued: Int = 0, stopped: Int = 0) {
            self.working = working
            self.waiting = waiting
            self.failed = failed
            self.done = done
            self.queued = queued
            self.stopped = stopped
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
            else if status == .queued { out.queued += 1 }
            else if status == .stopped { out.stopped += 1 }
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
    /// what is queued behind a sibling, what has settled (done, idle, paused,
    /// stopped and failed alike; a failed or stopped agent keeps its mark and
    /// its rank puts it first in the group).
    public enum Group: Int, CaseIterable, Sendable, Hashable {
        case running, waiting, queued, done

        public var title: String {
            switch self {
            case .running: "Running"
            case .waiting: "Waiting"
            case .queued: "Queued"
            case .done: "Done"
            }
        }
    }

    public static func group(_ status: SessionStatus?) -> Group {
        if isLive(status) || status == .watching { return .running }
        if status == .waiting { return .waiting }
        if status == .queued { return .queued }
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

    /// The fleet in its groups, in group order, empty groups left out;
    /// inside a group the rank order holds (a failed agent before a settled one).
    public static func sections(_ agents: [SessionMeta]) -> [Section] {
        var byGroup: [Group: [SessionMeta]] = [:]
        for agent in sort(agents) { byGroup[group(agent.status), default: []].append(agent) }
        return Group.allCases.compactMap { group in
            guard let list = byGroup[group], !list.isEmpty else { return nil }
            return Section(group: group, agents: list)
        }
    }

    // MARK: - agents across hosts

    /// One paired host as the fleet reads it: its id, its name and every
    /// session it lists.
    public struct Host: Sendable, Hashable {
        public let id: String
        public let name: String
        public let sessions: [SessionMeta]

        public init(id: String, name: String, sessions: [SessionMeta]) {
            self.id = id
            self.name = name
            self.sessions = sessions
        }
    }

    /// A subagent with the host it lives on. A box thread's `spawn_agent`
    /// with `environmentId: 'mac'` lands an ordinary session on the Mac whose
    /// `parentId` is the box thread, so a phone paired with both sees it in
    /// the Mac client's list under the box root's id.
    public struct Agent: Sendable, Hashable, Identifiable {
        public let meta: SessionMeta
        public let environmentId: String
        /// The agent lives on a host other than its root's.
        public let remote: Bool

        public init(meta: SessionMeta, environmentId: String, remote: Bool) {
            self.meta = meta
            self.environmentId = environmentId
            self.remote = remote
        }

        public var id: String { "\(environmentId):\(meta.id)" }
    }

    public struct AgentSection: Sendable, Hashable, Identifiable {
        public let group: Group
        public let agents: [Agent]

        public init(group: Group, agents: [Agent]) {
            self.group = group
            self.agents = agents
        }

        public var id: Group { group }
    }

    /// Every unarchived child of `rootId` on every paired host: the root's
    /// host first, then the rest in the order given; de-duplicated by
    /// (host, id); rank order then age across hosts.
    public static func gather(rootId: String, rootHost: String, hosts: [Host]) -> [Agent] {
        let ordered = hosts.filter { $0.id == rootHost } + hosts.filter { $0.id != rootHost }
        var seen = Set<String>()
        var out: [(agent: Agent, host: Int)] = []
        for (index, host) in ordered.enumerated() {
            for meta in children(of: rootId, in: host.sessions) {
                let agent = Agent(meta: meta, environmentId: host.id, remote: host.id != rootHost)
                guard seen.insert(agent.id).inserted else { continue }
                out.append((agent, index))
            }
        }
        // Rank, then age, then the host order, so two hosts' rows never trade places between renders.
        return out
            .sorted { (rank($0.agent.meta.status), $0.agent.meta.createdAt, $0.host) < (rank($1.agent.meta.status), $1.agent.meta.createdAt, $1.host) }
            .map(\.agent)
    }

    /// `sections(_:)` over agents with hosts: the same groups, the same order.
    public static func sections(_ agents: [Agent]) -> [AgentSection] {
        var byGroup: [Group: [Agent]] = [:]
        let ranked = agents.sorted { (rank($0.meta.status), $0.meta.createdAt) < (rank($1.meta.status), $1.meta.createdAt) }
        for agent in ranked { byGroup[group(agent.meta.status), default: []].append(agent) }
        return Group.allCases.compactMap { group in
            guard let list = byGroup[group], !list.isEmpty else { return nil }
            return AgentSection(group: group, agents: list)
        }
    }

    /// How many agent-spawned events of the root name a host this phone is
    /// not paired with: the fold keeps only the child id, so this reads the
    /// raw rows. An event with no host is local and never counts.
    public static func unpaired(rows: [EventRow], paired: Set<String>) -> Int {
        rows.reduce(0) { count, row in
            guard case .agentSpawned(let spawned) = row.event, let host = spawned.environmentId, !paired.contains(host) else { return count }
            return count + 1
        }
    }

    // MARK: - the orchestrator

    /// The one line under the goal: what the orchestrator itself is up to,
    /// else what it waits on. The group headers carry the counts, so this
    /// line never repeats them.
    public static func orchestratorLine(status: SessionStatus?, counts: Counts) -> String {
        switch status {
        case .running?, .starting?: return "Orchestrating"
        case .waiting?: return "Waiting on you"
        case .error?: return "Failed"
        case .paused?: return "Paused"
        case .stopped?: return "Stopped"
        case .queued?: return "Queued"
        case .watching?: return "Waiting on background work"
        default: break
        }
        if counts.working > 0 { return "Waiting on its subagents" }
        if counts.waiting > 0 { return counts.waiting == 1 ? "A subagent needs you" : "Subagents need you" }
        // A queued child is coming: nothing to do but wait for it.
        if counts.queued > 0 { return "Waiting on its subagents" }
        if counts.failed > 0 { return counts.failed == 1 ? "Done, one agent failed" : "Done, \(counts.failed) agents failed" }
        if counts.stopped > 0 { return counts.stopped == 1 ? "Done, one agent stopped" : "Done, \(counts.stopped) agents stopped" }
        return counts.done > 0 ? "Done" : ""
    }

    /// The last path component of an agent's directory when it works
    /// somewhere other than its parent (a worktree), else nil.
    public static func branch(cwd: String, parentCwd: String?) -> String? {
        let own = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !own.isEmpty, own != parentCwd else { return nil }
        return own.split(separator: "/").last.map(String.init)
    }

    /// How long the agent has run: since its start while live; nothing while
    /// queued (it has not started); the host's frozen working time once
    /// paused or stopped; else its whole span once settled, nil when that
    /// span is too short to mean anything.
    public static func elapsedMs(_ agent: SessionMeta, now: Int) -> Int? {
        if isLive(agent.status) { return max(0, now - agent.createdAt) }
        let span = agent.updatedAt - agent.createdAt
        let settled: Int? = span > 2_000 ? span : nil
        switch agent.status {
        case .queued: return nil
        case .paused, .stopped: return agent.frozenActiveElapsed ?? settled
        default: return settled
        }
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
    /// `activity` is the host's own line for the row (`SessionMeta.activity`,
    /// "Queued · waiting for <sibling>"), read for a queued agent.
    public static func line(status: SessionStatus?, items: [ThreadEntry], compacting: Bool = false, activity: String? = nil) -> Line {
        if isLive(status), compacting { return Line("compacting the context…", tone: .muted) }
        switch status {
        case .queued?:
            let own = activity?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return Line(own.isEmpty ? "Queued" : own, tone: .muted)
        case .stopped?: return Line("stopped · the harness is gone", tone: .muted)
        case .paused?: return Line("paused", tone: .muted)
        default: break
        }
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
