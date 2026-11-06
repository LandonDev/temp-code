import Foundation
import TempCodeContract

/// How an agent row names its agent, the desktop's lib/agentTitle.ts: the
/// store's title (a cross-host id read by its bare session id), else the
/// spawn call's own title, else the title its report stamped, else its
/// task's first line, else "a subagent"; cut at a word past 48.
public struct AgentTitle: Sendable, Hashable {
    public static let max = 48

    /// As drawn.
    public var title: String
    /// Whole, for the accessibility value.
    public var full: String
    /// The agent's own name rather than its task or the fallback.
    public var named: Bool

    public static func of(_ id: String?, titleOf: (String) -> String?, inputTitle: String? = nil, stamped: String? = nil, task: String? = nil) -> AgentTitle {
        func clean(_ text: String?) -> String {
            (text ?? "").split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init)?
                .split(whereSeparator: \.isWhitespace).joined(separator: " ") ?? ""
        }
        let stored = id.map { clean(titleOf(WatchWords.bareAgentId($0)) ?? titleOf($0)) } ?? ""
        let name = [stored, clean(inputTitle), clean(stamped)].first { !$0.isEmpty } ?? ""
        let full = name.isEmpty ? (clean(task).isEmpty ? "a subagent" : clean(task)) : name
        return AgentTitle(title: WatchWords.cutAtWord(full, max: max), full: full, named: !name.isEmpty)
    }
}

/// A wait_for_agent call is a state of the turn, never a row, the desktop's
/// surfaces/agentSteps.ts: while it is open the working line says "Waiting
/// on <title>"; once it returns each agent that settled folds into the run
/// as one step; a wait that returned on nobody leaves nothing.
public enum WaitSteps {
    /// One agent a wait returned on and the status it settled in.
    public struct Outcome: Sendable, Hashable {
        public var id: String
        public var status: String
    }

    static let settled: Set<String> = ["done", "idle", "watching", "waiting", "failed", "error", "stopped", "paused"]

    public static func isWait(_ tool: ToolItem) -> Bool {
        ToolPhrase.shortName(tool.name) == "wait_for_agent"
    }

    public static func isOpen(_ tool: ToolItem) -> Bool {
        isWait(tool) && tool.status == .running
    }

    /// A wait is no step while it is open, nor once it returned on nobody.
    public static func isHidden(_ tool: ToolItem) -> Bool {
        isWait(tool) && (isOpen(tool) || outcomes(tool).isEmpty)
    }

    /// The agents a wait names, in its own order, once each.
    public static func ids(_ tool: ToolItem) -> [String] {
        guard case .object(let input)? = tool.input else { return [] }
        var out: [String] = []
        if case .array(let many)? = input["agentIds"] {
            for case .string(let id) in many where !id.isEmpty && !out.contains(id) { out.append(id) }
        }
        if case .string(let one)? = input["agentId"], !one.isEmpty, !out.contains(one) { out.append(one) }
        return out
    }

    /// What a settled wait returned on: each agent that settled, in order.
    public static func outcomes(_ tool: ToolItem) -> [Outcome] {
        guard isWait(tool), tool.status != .running, case .whole(let detail) = tool.output,
              let data = detail.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) else { return [] }
        let rows = (parsed as? [Any]) ?? [parsed]
        return rows.compactMap { row in
            guard let object = row as? [String: Any], let id = object["agentId"] as? String, !id.isEmpty,
                  let status = object["status"] as? String, settled.contains(status) else { return nil }
            return Outcome(id: id, status: status)
        }
    }

    /// The wait the turn is in now (the desktop's `openWaitOf`): its last
    /// open wait, when nothing after it speaks (prose, a thought) or still
    /// runs beside it (a running call, an undecided approval). With another
    /// call running the turn reads as that work, which is true.
    public static func openWait(_ turn: [ThreadEntry]) -> ToolItem? {
        for entry in turn.reversed() {
            switch entry.item {
            case .tool(let tool):
                if isOpen(tool) { return tool }
                if tool.status == .running { return nil }
            case .assistant(let block), .thinking(let block):
                if !block.text.isEmpty { return nil }
            case .approval(let approval):
                if approval.allowed == nil { return nil }
            default:
                continue
            }
        }
        return nil
    }

    /// What the open wait waits on, as the working line says it after
    /// "Waiting on": one agent by its title, several counted; nil with no
    /// open wait. The turn's own call decides, never the meta.
    public static func waitOn(_ turn: [ThreadEntry], titleOf: (String) -> String? = { _ in nil }) -> String? {
        guard let wait = openWait(turn) else { return nil }
        return WatchWords.waitSubject(ids(wait), titleOf: titleOf)
    }

    /// The step's word for an agent's settled status: Finished, Failed, Needs you, Stopped, Paused.
    public static func word(_ status: String) -> String {
        switch status {
        case "failed", "error", "blocked": "Failed"
        case "waiting": "Needs you"
        case "stopped": "Stopped"
        case "paused": "Paused"
        default: "Finished"
        }
    }
}

/// The agents cue, the desktop's `agentsCue` (lib/threads/agents.ts): the
/// loudest live state of the thread's subagents at any depth (waiting's
/// amber, else working, else queued) and their count. A master's batch
/// threads carry `masterId`, not `parentId`, and are left to its board; an
/// archived agent is not counted, but its own children are. Working is
/// drawn still while the thread's own turn runs (one moving mark).
public struct AgentsCue: Sendable, Hashable {
    public enum State: String, Sendable, Hashable { case waiting, working, queued }

    public var state: State
    public var still: Bool
    public var waiting: Int
    public var working: Int
    public var queued: Int

    public var total: Int { waiting + working + queued }
    /// "3 agents", or while one needs you "1 needs you".
    public var label: String {
        if waiting > 0 { return "\(waiting) \(waiting == 1 ? "needs" : "need") you" }
        return "\(total) \(total == 1 ? "agent" : "agents")"
    }
    /// "Agents: 1 needs you, 2 working": the accessibility label.
    public var line: String {
        let parts = [(waiting, "needs you"), (working, "working"), (queued, "queued")].filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }
        return "Agents: \(parts.joined(separator: ", "))"
    }

    /// The cue for `rootId` over `metas`, nil when nothing is live.
    public static func of(rootId: String, metas: [SessionMeta], rootRunning: Bool) -> AgentsCue? {
        var children: [String: [SessionMeta]] = [:]
        for meta in metas { if let parent = meta.parentId { children[parent, default: []].append(meta) } }
        var counts = (waiting: 0, working: 0, queued: 0)
        var seen: Set<String> = [rootId]
        var stack = [rootId]
        while let id = stack.popLast() {
            for child in children[id] ?? [] where seen.insert(child.id).inserted {
                if !child.archived {
                    switch child.status {
                    case .running, .starting, .watching: counts.working += 1
                    case .waiting: counts.waiting += 1
                    case .queued: counts.queued += 1
                    default: break
                    }
                }
                stack.append(child.id)
            }
        }
        guard counts.waiting + counts.working + counts.queued > 0 else { return nil }
        let state: State = counts.waiting > 0 ? .waiting : counts.working > 0 ? .working : .queued
        return AgentsCue(state: state, still: state == .working && rootRunning, waiting: counts.waiting, working: counts.working, queued: counts.queued)
    }
}

/// What a spawn call says about each child it stamped, the desktop's
/// `spawnedNames`: the title it gave, else its task. A step about an agent
/// the store has not listed still says the name its spawn gave it.
public struct SpawnedName: Sendable, Hashable {
    public var title: String?
    public var task: String?
}

/// A row the host wrote that is a step of the agent's work, the desktop's
/// `isFoldedStep` (transcriptActivity.ts): it folds into the run it sits in.
/// A subagent spawned or settled, a background task that finished, a gate
/// or release outcome, a review that merged, the turn pass, the plan's
/// build hand-off, a merge the batch made, what the host decided while the
/// person was away. What asks the person something or ends a stretch of
/// work (a held review, a failure, Stopped, a compaction, Batch done, an
/// account gone, a plain host line) stays a row of its own.
public enum FoldedStep {
    public static func isFolded(_ line: SystemLine) -> Bool {
        switch line.kind {
        case .agentReport, .agentSpawned, .planHandoff, .turnPass, .backgroundTask: return true
        case .status:
            guard let notice = line.notice else { return false }
            switch notice.kind {
            case .gate: return notice.gate != nil
            case .review: return notice.review.map { $0.outcome != .held } ?? false
            case .away: return true
            case .batch: return notice.message.hasPrefix("Merged by the batch")
            default: return false
            }
        default: return false
        }
    }

    /// A spawn_agent call that asked for several agents.
    public static func isBatchSpawn(_ tool: ToolItem) -> Bool {
        ToolPhrase.shortName(tool.name) == "spawn_agent" && (ToolPhrase.input(tool)["agents"]?.arrayValue?.count ?? 0) > 1
    }

    /// The rows a step draws, `stepRows`: one per agent a wait returned on,
    /// one per child a batch spawn stamped, else one.
    public static func rows(_ entry: ThreadEntry) -> Int {
        guard case .tool(let tool) = entry.item else { return 1 }
        if WaitSteps.isWait(tool) { return WaitSteps.outcomes(tool).count }
        return isBatchSpawn(tool) && tool.spawned.count > 1 ? tool.spawned.count : 1
    }

    /// How many of a step's parts went wrong, `stepFailures`: a failed call,
    /// each agent a wait found failed, a red gate, a review that failed to
    /// run, a report of a failure, a failed task.
    public static func failures(_ entry: ThreadEntry) -> Int {
        switch entry.item {
        case .tool(let tool):
            if WaitSteps.isWait(tool) { return WaitSteps.outcomes(tool).count { ["failed", "error", "blocked"].contains($0.status) } }
            return tool.status == .failed ? 1 : 0
        case .system(let line):
            return failed(line) ? 1 : 0
        default:
            return 0
        }
    }

    /// A folded host step that went wrong.
    public static func failed(_ line: SystemLine) -> Bool {
        if let gate = line.notice?.gate { return !gate.ok }
        if let review = line.notice?.review { return review.outcome == .failed }
        switch line.kind {
        case .backgroundTask: return line.detail == "failed"
        case .agentReport: return ["failed", "error", "blocked"].contains(line.detail ?? "")
        default: return false
        }
    }

    /// The child each of a spawn's stamped ids is, by the call's own entry:
    /// its title, else its task (a batch's entry, else the call's).
    public static func spawnedNames(_ tool: ToolItem) -> [(id: String, name: SpawnedName)] {
        let input = ToolPhrase.input(tool)
        let entries = input["agents"]?.arrayValue
        func text(_ value: JSONValue?) -> String? {
            guard let string = value?.stringValue, string.contains(where: { !$0.isWhitespace }) else { return nil }
            return string
        }
        return tool.spawned.enumerated().map { index, id in
            let entry = entries.flatMap { $0.indices.contains(index) ? $0[index] : nil }
            let title = entries == nil ? text(input["title"]) : text(entry?["title"])
            let task = (entries == nil ? nil : text(entry?["task"])) ?? text(input["task"])
            return (id, SpawnedName(title: title, task: task))
        }
    }

    /// The names a run's spawn calls gave, by child id.
    public static func spawnedNames(_ entries: [ThreadEntry]) -> [String: SpawnedName] {
        var names: [String: SpawnedName] = [:]
        for entry in entries {
            guard case .tool(let tool) = entry.item, ToolPhrase.shortName(tool.name) == "spawn_agent" else { continue }
            for (id, name) in spawnedNames(tool) { names[id] = name }
        }
        return names
    }
}
