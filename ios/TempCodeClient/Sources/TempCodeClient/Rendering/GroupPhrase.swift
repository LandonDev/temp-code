import Foundation
import TempCodeContract

/// One step of a run, for its phrase: a tool call, or a host step (A8 words those).
public enum GroupStep: Hashable, Sendable {
    case tool(ToolItem)
    case system(SystemLine)
}

public enum GroupPhrase {
    private enum Stretch: Equatable { case read, edit, run, search, report, app(String), other }

    private static let counted: [String: (past: String, live: String)] = [
        "spawn_agent": ("spawned # agents", "spawning # agents"),
        "app_start_thread": ("started # threads", "starting # threads"),
        "send_to_agent": ("messaged # agents", "messaging # agents"),
        "check_agent": ("checked # agents", "checking # agents"),
        "answer_agent": ("answered # agents", "answering # agents"),
        "interrupt_agent": ("stopped # agents", "stopping # agents"),
        "merge_branch": ("merged # branches", "merging # branches"),
        "TaskCreate": ("added # tasks", "adding # tasks"),
        "TaskUpdate": ("updated # tasks", "updating # tasks"),
    ]

    /// The group line's words. `live` nil = live while any call still runs. `titleOf` names threads by id.
    public static func of(_ steps: [GroupStep], cwd: String? = nil, live: Bool? = nil, titleOf: (String) -> String? = { _ in nil }) -> String {
        guard !steps.isEmpty else { return "" }
        let tools = steps.compactMap { step -> ToolItem? in
            if case .tool(let tool) = step { return tool }
            return nil
        }
        let running = live ?? tools.contains(where: \.isLive)
        var phrases: [String] = []
        func push(_ phrase: String) {
            if !phrase.isEmpty, !phrases.contains(phrase) { phrases.append(phrase) }
        }
        let accepted = steps.filter {
            if case .tool(let tool) = $0 { return !tool.isRefused }
            return true
        }
        if accepted.isEmpty { tools.forEach { push(ToolPhrase.of($0, live: false, cwd: cwd).line) } }
        var stretch: Stretch?
        var run: [GroupStep] = []
        func flush() {
            if let stretch { stretchPhrases(stretch, steps: run, cwd: cwd, live: running, titleOf: titleOf).forEach(push) }
            run = []
        }
        for step in accepted {
            let next = stretchOf(step)
            if next != stretch || next == .other {
                flush()
                stretch = next
            }
            run.append(step)
        }
        flush()
        if phrases.isEmpty { return running ? "Working" : "Ran \(tools.count) \(tools.count == 1 ? "tool" : "tools")" }
        let shown = phrases.prefix(3).enumerated().map { index, phrase in
            ToolPhrase.trim(index == 0 ? cap(phrase) : lower(phrase), 48)
        }
        return shown.joined(separator: ", ") + (phrases.count > 3 ? " and \(phrases.count - 3) more" : "")
    }

    /// The shared folder of cwd-relative paths, or "" at the project root.
    public static func commonDir(_ paths: [String]) -> String {
        let dirs = paths.map { Array($0.components(separatedBy: "/").dropLast()) }
        var shared = dirs.first ?? []
        for dir in dirs.dropFirst() {
            var n = 0
            while n < shared.count, n < dir.count, shared[n] == dir[n] { n += 1 }
            shared = Array(shared.prefix(n))
        }
        return shared.joined(separator: "/")
    }

    /// One file by basename, several by folder or project when they share it.
    public static func readsPhrase(_ paths: [String], cwd: String?, live: Bool) -> String {
        let verb = live ? "Reading" : "Read"
        let rel = paths.map { ToolPhrase.displayPath($0, cwd: cwd) }
        if rel.count == 1 { return "\(verb) \(basename(rel[0]))" }
        guard let cwd, !cwd.isEmpty, rel.allSatisfy({ !$0.hasPrefix("/") && !$0.hasPrefix("~") }) else { return "\(verb) \(rel.count) files" }
        let dir = commonDir(rel)
        let project = cwd.firstMatch(of: /^\/(Users|home)\/[^\/]+\/*$/) != nil ? "~" : basename(cwd)
        return dir.isEmpty ? "\(verb) \(project) files" : "\(verb) \(rel.count) files in \(dir)"
    }

    private static func stretchOf(_ step: GroupStep) -> Stretch {
        guard case .tool(let tool) = step else { return .other }
        let short = ToolPhrase.shortName(tool.name)
        if short == "wait_for_agent" { return .report }
        if counted[short] != nil { return .app(short) }
        let kind = ToolPhrase.kind(of: tool)
        if kind == .read, !ToolPhrase.pathOf(tool).isEmpty { return .read }
        if isEdit(tool) { return .edit }
        if kind == .run { return .run }
        if kind == .search || kind == .glob { return .search }
        return .other
    }

    static func isEdit(_ tool: ToolItem) -> Bool {
        ["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch"].contains(tool.name) || tool.preview?.kind == .write || ([ToolPhrase.Kind.edit, .write, .patch].contains(ToolPhrase.kind(of: tool)) && !ToolPhrase.pathOf(tool).isEmpty)
    }

    static func editFiles(_ tool: ToolItem) -> [(verb: String, path: String)] {
        if tool.name == "apply_patch" {
            let files = ToolPhrase.patchFiles(tool)
            if !files.isEmpty { return files.map { ($0.op == "add" ? "create" : $0.op == "delete" ? "delete" : "edit", $0.path) } }
        }
        let created = tool.name == "Write" || ToolPhrase.kind(of: tool) == .write
        let updated = ToolPhrase.outputText(tool).firstMatch(of: /has been (updated|overwritten)/.ignoresCase()) != nil
        return [(created && !updated ? "create" : "edit", ToolPhrase.pathOf(tool))]
    }

    private static func editsPhrases(_ tools: [ToolItem], live: Bool) -> [String] {
        var order: [String] = []
        var byVerb: [String: [String]] = [:]
        for file in tools.flatMap(editFiles) {
            if byVerb[file.verb] == nil { order.append(file.verb) }
            if !(byVerb[file.verb] ?? []).contains(file.path) { byVerb[file.verb, default: []].append(file.path) }
        }
        return order.map { verb in
            let paths = byVerb[verb] ?? []
            let word = verb == "create" ? (live ? "Creating" : "Created") : verb == "delete" ? (live ? "Deleting" : "Deleted") : (live ? "Editing" : "Edited")
            return paths.count == 1 ? "\(word) \(basename(paths[0]))" : "\(word) \(paths.count) files"
        }
    }

    private static func targetsOf(_ tool: ToolItem) -> [String] {
        let short = ToolPhrase.shortName(tool.name)
        if short == "spawn_agent" {
            return (0..<max(1, ToolPhrase.input(tool)["agents"]?.arrayValue?.count ?? 1)).map { "\(tool.callId):\($0)" }
        }
        if short == "merge_branch" { return [ToolPhrase.input(tool)["branch"]?.stringValue ?? tool.callId] }
        if short == "TaskCreate" || short == "TaskUpdate" { return [tool.callId] }
        return [agentId(tool) ?? tool.callId]
    }

    static func agentId(_ tool: ToolItem) -> String? {
        if let id = ToolPhrase.input(tool)["agentId"]?.stringValue, !id.isEmpty { return id }
        return ToolPhrase.outputText(tool).firstMatch(of: /"agentId"\s*:\s*"([\w:-]+)"/).map { String($0.1) }
    }

    private static func waitIds(_ tool: ToolItem) -> [String] {
        guard tool.status != .running, let data = ToolPhrase.outputText(tool).data(using: .utf8), let parsed = try? JSONDecoder().decode(JSONValue.self, from: data) else { return [] }
        let settled = ["done", "idle", "watching", "waiting", "failed", "error", "stopped", "paused"]
        return (parsed.arrayValue ?? [parsed]).compactMap {
            guard let id = $0["agentId"]?.stringValue, !id.isEmpty, let status = $0["status"]?.stringValue, settled.contains(status) else { return nil }
            return id
        }
    }

    private static func heardPhrase(_ id: String, titleOf: (String) -> String?) -> String {
        let title = ToolPhrase.firstText(titleOf(WatchWords.bareAgentId(id)), titleOf(id))
        return "heard from \(title.isEmpty ? "a subagent" : quoted(title))"
    }

    private static func stepPhrase(_ step: GroupStep, cwd: String?, live: Bool, titleOf: (String) -> String?) -> String {
        switch step {
        case .system:
            // A8: Host reports, tasks, gates, reviews, passes, hand-offs and away steps get their words here.
            return ""
        case .tool(let tool):
            return appPhrase(tool, live: live, titleOf: titleOf) ?? ToolPhrase.of(tool, live: live, cwd: cwd).line
        }
    }

    private static func stretchPhrases(_ stretch: Stretch, steps: [GroupStep], cwd: String?, live: Bool, titleOf: (String) -> String?) -> [String] {
        let tools = steps.compactMap { step -> ToolItem? in
            if case .tool(let tool) = step { return tool }
            return nil
        }
        switch stretch {
        case .read: return [readsPhrase(unique(tools.map(ToolPhrase.pathOf)), cwd: cwd, live: live)]
        case .edit: return editsPhrases(tools, live: live)
        case .run:
            if tools.count == 1 { return [ToolPhrase.runClauses(tools[0], cwd: cwd, live: live).first ?? "\(live ? "Running" : "Ran") a command"] }
            return ["\(live ? "Running" : "Ran") \(tools.count) commands"]
        case .search:
            if tools.count == 1 { return [ToolPhrase.of(tools[0], live: live, cwd: cwd).line] }
            return ["\(live ? "Running" : "Ran") \(tools.count) searches"]
        case .report:
            let ids = unique(tools.flatMap(waitIds))
            return ids.count > 1 ? ["heard from \(ids.count) agents"] : ids.map { heardPhrase($0, titleOf: titleOf) }
        case .other: return steps.map { stepPhrase($0, cwd: cwd, live: live, titleOf: titleOf) }
        case .app(let name):
            let targets = unique(tools.flatMap(targetsOf))
            if targets.count > 1, let words = counted[name] { return [(live ? words.live : words.past).replacingOccurrences(of: "#", with: String(targets.count))] }
            return steps.map { stepPhrase($0, cwd: cwd, live: live, titleOf: titleOf) }
        }
    }

    private static func appPhrase(_ tool: ToolItem, live: Bool, titleOf: (String) -> String?) -> String? {
        let short = ToolPhrase.shortName(tool.name)
        let input = ToolPhrase.input(tool)
        func tense(_ past: String, _ now: String) -> String { live ? now : past }
        let verbs = ["spawn_agent": ("spawned", "spawning"), "send_to_agent": ("messaged", "messaging"), "check_agent": ("checked", "checking"), "wait_for_agent": ("waited on", "waiting on"), "answer_agent": ("answered", "answering"), "interrupt_agent": ("stopped", "stopping")]
        if verbs[short] != nil || short == "Agent" || short == "Task" {
            let builtin = short == "Agent" || short == "Task"
            let spawn = short == "spawn_agent" || builtin
            let id = agentId(tool)
            let stored = id.map { ToolPhrase.firstText(titleOf(WatchWords.bareAgentId($0)), titleOf($0)) } ?? ""
            func clean(_ text: String) -> String { (text.components(separatedBy: "\n").first ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ") }
            let title = ToolPhrase.firstText(clean(stored), spawn ? clean(ToolPhrase.firstText(input["title"]?.stringValue, builtin ? input["description"]?.stringValue : nil)) : nil)
            let verb = verbs[short].map { tense($0.0, $0.1) } ?? tense("ran", "running")
            return "\(verb) \(title.isEmpty ? "a subagent" : quoted(WatchWords.cutAtWord(title, max: 48)))"
        }
        switch short {
        case "update_notes": return "\(tense("updated", "updating")) the notes"
        case "batch_rules": return "\(tense("set", "setting")) the batch steps"
        case "merge_branch":
            let branch = input["branch"]?.stringValue ?? ""
            return "\(tense("merged", "merging")) \(branch.isEmpty ? "the branch" : ToolPhrase.trim(branch, 24))"
        case "plan_complete": return "\(tense("marked", "marking")) the plan complete"
        case "TaskCreate": return tense("added a task", "adding a task")
        case "TaskUpdate": return tense("updated a task", "updating a task")
        case "list_agents": return "listed the subagents"
        case "app_list_threads": return "listed the threads"
        case "app_read_thread":
            let title = titleOf(input["threadId"]?.stringValue ?? "")
            return title.map { "read thread \(quoted($0))" } ?? "read a thread"
        case "app_start_thread":
            let data = ToolPhrase.outputText(tool).data(using: .utf8)
            let result = data.flatMap { try? JSONDecoder().decode(JSONValue.self, from: $0) }
            let title = ToolPhrase.firstText(input["title"]?.stringValue, result?["title"]?.stringValue)
            return "\(tense("started", "starting")) \(title.isEmpty ? "a thread" : "thread \(quoted(title))")"
        case "cite_source":
            let url = input["url"]?.stringValue ?? ""
            return "cited \(URL(string: url)?.host ?? url.split(separator: "/").last.map(String.init) ?? "a source")"
        case "html_preview": return "previewed a page"
        case "html_render":
            let title = input["title"]?.stringValue ?? ""
            return title.isEmpty ? "showed a page" : "showed page \(quoted(title))"
        default: return nil
        }
    }

    private static func unique(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { seen.insert($0).inserted }
    }
    private static func cap(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }
    private static func lower(_ s: String) -> String { s.prefix(1).lowercased() + s.dropFirst() }
    private static func basename(_ s: String) -> String { s.trimmingSuffix("/").components(separatedBy: "/").last.flatMap { $0.isEmpty ? nil : $0 } ?? s }
    private static func quoted(_ s: String) -> String { "“\(ToolPhrase.trim(s, 24))”" }
}
