import Foundation
import TempCodeContract

/// Plain words for a tool call, the desktop's `lib/toolPhrase.ts`: "Read
/// src/lib/paths.ts", "Searched for toolCallLabel", "Ran the tests", "Used
/// Spawn Agent". A raw tool name, JSON or a provider name never makes it
/// into the line; the chip's body keeps the detail. The line splits into
/// the verb (dim) and its target (the file, the pattern) where the desktop's
/// `ToolCallSummary` does, so a file reads as the loud half of the chip.
public struct ToolPhrase: Hashable, Sendable {
    /// "Read", "Searched for", "Counted to one hundred".
    public var verb: String
    /// "src/lib/paths.ts", "toolCallLabel"; nil when the verb says it all.
    public var target: String?
    /// The target is a path: mono, truncated in the middle.
    public var isFile: Bool

    public init(verb: String, target: String? = nil, isFile: Bool = false) {
        self.verb = verb
        self.target = target
        self.isFile = isFile
    }

    public var line: String { target.map { "\(verb) \($0)" } ?? verb }

    public enum Kind: Sendable { case run, read, write, edit, patch, search, glob, fetch, web, todo, question, skill, mcp, tool }

    public static func of(_ tool: ToolItem) -> ToolPhrase {
        let live = tool.status == .running
        switch kind(of: tool) {
        case .run:
            return runPhrase(tool, live: live)
        case .read:
            return ToolPhrase(verb: live ? "Reading" : "Read", target: fileWord(tool), isFile: true)
        case .write:
            return ToolPhrase(verb: live ? "Writing" : "Wrote", target: fileWord(tool), isFile: true)
        case .edit:
            return ToolPhrase(verb: live ? "Editing" : "Edited", target: fileWord(tool), isFile: true)
        case .patch:
            let paths = patchPaths(tool)
            let what = paths.count == 0 ? "files" : paths.count == 1 ? displayPath(paths[0]) : "\(paths.count) files"
            return ToolPhrase(verb: live ? "Patching" : "Patched", target: what, isFile: paths.count == 1)
        case .search, .glob:
            let q = queryOf(tool)
            if q.isEmpty { return ToolPhrase(verb: live ? "Searching the project" : "Searched the project", target: nil, isFile: false) }
            return ToolPhrase(verb: live ? "Searching for" : "Searched for", target: trim(q, 32), isFile: false)
        case .fetch:
            let url = input(tool)["url"]?.stringValue ?? ""
            let host = URL(string: url)?.host
            return ToolPhrase(verb: live ? "Fetching" : "Fetched", target: host ?? "a page", isFile: false)
        case .web:
            let q = input(tool)["query"]?.stringValue ?? tool.preview?.query ?? ""
            return ToolPhrase(verb: live ? "Searching the web" : "Searched the web", target: q.isEmpty ? nil : "for \(trim(q, 32))", isFile: false)
        case .todo:
            return ToolPhrase(verb: live ? "Updating todos" : "Updated todos", target: nil, isFile: false)
        case .question:
            return ToolPhrase(verb: live ? "Asking a question" : "Asked a question", target: nil, isFile: false)
        case .skill:
            let i = input(tool)
            let skill = i["skill"]?.stringValue ?? i["name"]?.stringValue ?? ""
            return ToolPhrase(verb: live ? "Using" : "Used", target: skill.isEmpty ? "Skill" : "Skill \(skill)", isFile: false)
        case .mcp, .tool:
            if let app = tool.display?.app, !app.isEmpty {
                return ToolPhrase(verb: app, target: tool.display?.action, isFile: false)
            }
            return ToolPhrase(verb: live ? "Using" : "Used", target: humanName(tool.name), isFile: false)
        }
    }

    // MARK: - kinds

    private static let nameKind: [String: Kind] = [
        "Bash": .run, "shell": .run, "Shell": .run,
        "Read": .read, "Write": .write, "Edit": .edit, "MultiEdit": .edit, "NotebookEdit": .edit,
        "apply_patch": .patch, "Grep": .search, "Glob": .glob, "LS": .read,
        "WebFetch": .fetch, "WebSearch": .web, "web_search": .web,
        "TodoWrite": .todo, "update_plan": .todo, "AskUserQuestion": .question, "Skill": .skill,
    ]

    /// Human names for the app's own tools; anything else title-cases its short name.
    private static let appTool: [String: String] = [
        "app_start_thread": "Create Thread", "app_list_threads": "List Threads", "app_read_thread": "Read Thread",
        "spawn_agent": "Spawn Agent", "send_to_agent": "Message Agent", "wait_for_agent": "Wait For Agent",
        "check_agent": "Check Agent", "answer_agent": "Answer Agent", "interrupt_agent": "Interrupt Agent",
        "list_agents": "List Agents", "AskUserQuestion": "Ask User", "Task": "Agent", "Agent": "Agent",
        "EnterPlanMode": "Plan Mode", "ExitPlanMode": "Exit Plan Mode",
    ]

    public static func kind(of tool: ToolItem) -> Kind {
        if let known = nameKind[tool.name] { return known }
        if tool.name.hasPrefix("mcp__") || tool.name.contains(".") { return .mcp }
        let title = (tool.preview?.title ?? "").lowercased()
        switch tool.preview?.kind {
        case .search?: return .search
        case .read?: return .read
        case .write?: return .edit
        case .shell?: return .run
        default: break
        }
        if title.hasPrefix("edit") || title.hasPrefix("updat") { return .edit }
        if title.hasPrefix("read") { return .read }
        if title.hasPrefix("find") || title.hasPrefix("search") || title.hasPrefix("grep") || title.hasPrefix("glob") { return .search }
        if title.hasPrefix("bash") || title.hasPrefix("shell") || title.hasPrefix("run") { return .run }
        return .tool
    }

    /// "mcp__orchestrator__spawn_agent" → "spawn_agent"; "linear.save" → "save".
    public static func shortName(_ name: String) -> String {
        if name.hasPrefix("mcp__") { return name.components(separatedBy: "__").last ?? name }
        if name.contains(".") { return name.components(separatedBy: ".").last ?? name }
        return name
    }

    /// "AskUserQuestion" → "Ask User", "list_agents" → "List Agents".
    public static func humanName(_ name: String) -> String {
        let short = shortName(name)
        if let known = appTool[short] { return known }
        var spaced = ""
        var previous: Character?
        for character in short {
            if character == "_" || character == "-" {
                spaced.append(" ")
            } else {
                if let previous, previous.isLowercase || previous.isNumber, character.isUppercase { spaced.append(" ") }
                spaced.append(character)
            }
            previous = character
        }
        return spaced.split(separator: " ").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    // MARK: - inputs

    private static func input(_ tool: ToolItem) -> [String: JSONValue] {
        tool.input?.objectValue ?? [:]
    }

    private static func pathOf(_ tool: ToolItem) -> String {
        let i = input(tool)
        return i["file_path"]?.stringValue ?? i["path"]?.stringValue ?? i["notebook_path"]?.stringValue ?? tool.preview?.path ?? tool.preview?.fileName ?? ""
    }

    private static func queryOf(_ tool: ToolItem) -> String {
        let i = input(tool)
        return i["pattern"]?.stringValue ?? i["query"]?.stringValue ?? tool.preview?.query ?? ""
    }

    private static func commandOf(_ tool: ToolItem) -> String {
        let i = input(tool)
        if let parts = i["command"]?.arrayValue { return parts.compactMap(\.stringValue).joined(separator: " ") }
        if let command = i["command"]?.stringValue { return command }
        let title = tool.preview?.title ?? ""
        return title.replacing(/^(bash|shell|run(?:ning)?(?:\s+command)?)\b[:\s]*/.ignoresCase(), with: "")
    }

    private static func fileWord(_ tool: ToolItem) -> String {
        let p = pathOf(tool)
        return p.isEmpty ? "a file" : displayPath(p)
    }

    private static func patchPaths(_ tool: ToolItem) -> [String] {
        let raw = tool.input?.stringValue ?? input(tool)["patch"]?.stringValue ?? ""
        var found: [String] = []
        for match in raw.matches(of: /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.anchorsMatchLineEndings()) {
            found.append(String(match.1).trimmingCharacters(in: .whitespaces))
        }
        if !found.isEmpty { return found }
        let p = pathOf(tool)
        return p.isEmpty ? [] : [p]
    }

    /// Home directories read as `~`; the phone has no cwd to strip.
    public static func displayPath(_ path: String) -> String {
        path.replacing(/\/Users\/[^\/\s'"]+/, with: "~")
    }

    public static func trim(_ s: String, _ n: Int = 40) -> String {
        s.count > n ? String(s.prefix(n - 1)) + "…" : s
    }

    private static func cap(_ s: String) -> String {
        s.prefix(1).uppercased() + s.dropFirst()
    }

    // MARK: - commands

    private static let past: [String: String] = [
        "check": "checked", "read": "read", "view": "viewed", "list": "listed", "find": "found", "search": "searched",
        "count": "counted", "run": "ran", "build": "built", "typecheck": "typechecked", "install": "installed",
        "fetch": "fetched", "create": "created", "delete": "deleted", "copy": "copied", "move": "moved", "write": "wrote",
        "stage": "staged", "commit": "committed", "push": "pushed", "sync": "synced", "switch": "switched",
        "stash": "stashed", "show": "showed", "update": "updated", "start": "started", "stop": "stopped", "kill": "killed",
        "test": "tested", "open": "opened", "wait": "waited", "compare": "compared", "print": "printed",
        "change": "changed", "add": "added", "remove": "removed", "make": "made", "format": "formatted", "lint": "linted",
        "query": "queried", "manage": "managed",
    ]

    private static let ing: [String: String] = [
        "run": "running", "write": "writing", "stop": "stopping", "commit": "committing", "stash": "stashing",
        "make": "making", "create": "creating", "delete": "deleting", "update": "updating", "remove": "removing",
        "change": "changing", "compare": "comparing", "move": "moving", "stage": "staging", "query": "querying",
        "format": "formatting", "manage": "managing",
    ]

    /// "check git status" → "checked git status" / "checking git status".
    private static func tense(_ phrase: String, live: Bool) -> String {
        var words = phrase.split(separator: " ").map(String.init)
        guard let first = words.first else { return phrase }
        let w = first.lowercased()
        let verb: String
        if live {
            verb = ing[w] ?? (past[w] != nil ? (w.hasSuffix("e") ? String(w.dropLast()) : w) + "ing" : w)
        } else {
            verb = past[w] ?? w
        }
        words[0] = verb
        return words.joined(separator: " ")
    }

    private static func runPhrase(_ tool: ToolItem, live: Bool) -> ToolPhrase {
        let i = input(tool)
        if let desc = i["description"]?.stringValue?.trimmingCharacters(in: .whitespaces), !desc.isEmpty {
            let lowered = desc.prefix(1).lowercased() + desc.dropFirst()
            return ToolPhrase(verb: cap(tense(trim(lowered, 60), live: live)), target: nil, isFile: false)
        }
        if i["command"] == nil, let title = tool.preview?.title?.trimmingCharacters(in: .whitespaces),
           let match = title.firstMatch(of: /^(Read|Find|List|Edit|Write|Delete|Move|Fetch|Create)\s+(.+)$/) {
            let verb = match.1 == "Find" ? "search for" : match.1.lowercased()
            return ToolPhrase(verb: cap(tense(verb, live: live)), target: String(match.2), isFile: match.1 != "Find")
        }
        let phrases = commandPhrases(commandOf(tool)).map { tense($0, live: live) }
        if phrases.isEmpty { return ToolPhrase(verb: live ? "Running a command" : "Ran a command", target: nil, isFile: false) }
        return ToolPhrase(verb: cap(sentence(phrases)), target: nil, isFile: false)
    }

    /// A command's phrases as one clause of prose: "check git status",
    /// "check git status and run the tests", "check git status, run the
    /// tests and 2 more".
    public static func sentence(_ phrases: [String]) -> String {
        switch phrases.count {
        case 0: return ""
        case 1: return phrases[0]
        case 2: return "\(phrases[0]) and \(phrases[1])"
        default: return "\(phrases[0]), \(phrases[1]) and \(phrases.count - 2) more"
        }
    }

    /// Drop a `sh -lc '…'` wrapper.
    private static func unwrap(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let m = s.firstMatch(of: /^(?:\S*\/)?(?:ba|z|da)?sh\s+-[a-z]*c\s+([\s\S]+)$/) {
            var rest = String(m.1).trimmingCharacters(in: .whitespaces)
            if let q = rest.firstMatch(of: /^(['"])([\s\S]*)\1$/) { rest = String(q.2) }
            s = rest.trimmingCharacters(in: .whitespaces)
        }
        return s
    }

    /// Split on top-level `&&`, `||`, `|`, `;` and newlines, quote-aware.
    private static func segments(_ cmd: String) -> [String] {
        var out: [String] = []
        var current = ""
        var quote: Character?
        var previous: Character?
        for character in cmd {
            if let open = quote {
                current.append(character)
                if character == open, previous != "\\" { quote = nil }
            } else if character == "'" || character == "\"" || character == "`" {
                quote = character
                current.append(character)
            } else if character == "\n" || character == ";" || character == "|" || character == "&" {
                out.append(current)
                current = ""
            } else {
                current.append(character)
            }
            previous = character
        }
        out.append(current)
        return out.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private static func unquote(_ s: String) -> String {
        var out = Substring(s)
        if let first = out.first, "'\"`".contains(first) { out = out.dropFirst() }
        if let last = out.last, "'\"`".contains(last) { out = out.dropLast() }
        return String(out)
    }

    private static func base(_ p: String) -> String {
        let bare = unquote(p).replacing(/\/+$/, with: "")
        return bare.split(separator: "/").last.map(String.init) ?? p
    }

    /// One shell segment → a present-tense phrase, or nil for pipe noise.
    private static func segmentPhrase(_ seg: String) -> String? {
        var words = seg.split(separator: " ").map(String.init)
        while let first = words.first, first == "env" || first.firstMatch(of: /^[A-Za-z_][A-Za-z0-9_]*=/) != nil { words.removeFirst() }
        if let first = words.first, first == "sudo" || first == "xargs" { words.removeFirst() }
        guard let head = words.first else { return nil }
        let cmd = base(head)
        let args = Array(words.dropFirst())
        let plain = args.filter { !$0.hasPrefix("-") && $0.firstMatch(of: /^\d*[<>]/) == nil && !$0.contains(">") }
        let file = plain.first
        let sub = plain.first ?? ""
        let rel = { (p: String) in displayPath(unquote(p)) }
        switch cmd {
        case "cd", "pwd", "true", "exit", "export", "setopt", "awk", "sort", "uniq", "cut", "tr", "jq", "tee", "xargs":
            return nil
        case "grep", "rg", "ag":
            return plain.first.map { "search for \(trim(unquote($0), 24))" }
        case "head", "tail", "cat", "less", "bat", "more":
            return file.map { "read \(rel($0))" }
        case "sed":
            let f = plain.filter { $0.firstMatch(of: /^['"]?[\d,$]+p['"]?$/) == nil }.last
            guard seg.contains("-n"), let f, !f.contains("s/") else { return nil }
            return "read \(rel(f))"
        case "wc":
            return file.map { "count lines in \(rel($0))" }
        case "ls", "tree":
            return file.map { "list \(rel($0))" } ?? "list files"
        case "find", "fd":
            return "find files"
        case "git":
            switch sub {
            case "status": return "check git status"
            case "log": return "read git history"
            case "diff": return "view the diff"
            case "add": return "stage changes"
            case "commit": return "commit"
            case "push": return "push"
            case "pull", "fetch": return "sync with the remote"
            case "checkout", "switch": return "switch branches"
            case "branch": return "list branches"
            case "stash": return "stash changes"
            case "show": return "show a commit"
            case "worktree": return "manage worktrees"
            default: return sub.isEmpty ? "run git" : "run git \(sub)"
            }
        case "npm", "pnpm", "bun", "yarn":
            if sub == "test" || sub == "t" { return "run the tests" }
            if ["install", "i", "ci", "add"].contains(sub) { return "install dependencies" }
            if sub == "run" { return "run \(cmd) run \(plain.count > 1 ? plain[1] : "")".trimmingCharacters(in: .whitespaces) }
            return sub.isEmpty ? "run \(cmd)" : "run \(cmd) \(sub)"
        case "npx", "bunx":
            return sub.isEmpty ? "run \(cmd)" : "run \(base(sub))"
        case "cargo", "go", "mvn", "gradle", "gradlew":
            if sub == "test" || sub.contains("test") { return "run the tests" }
            if ["build", "compile", "package", "install"].contains(sub) { return "build the project" }
            return sub.isEmpty ? "run \(cmd)" : "run \(cmd) \(sub)"
        case "vitest", "jest", "pytest":
            return "run the tests"
        case "tsc": return "typecheck"
        case "eslint": return "lint"
        case "prettier": return "format code"
        case "make": return sub.isEmpty ? "run make" : "make \(sub)"
        case "python", "python3", "node", "ruby", "perl":
            if args.contains("-c") || args.contains("-e") { return "run a \(cmd.hasPrefix("python") ? "Python" : cmd == "node" ? "JS" : cmd) snippet" }
            return file.map { "run \(base($0))" } ?? "run \(cmd)"
        case "curl", "wget":
            let url = args.map(unquote).first { $0.hasPrefix("http://") || $0.hasPrefix("https://") }
            if let url, let host = URL(string: url)?.host { return "fetch \(host)" }
            return "fetch a URL"
        case "mkdir": return "create a folder"
        case "touch": return file.map { "create \(rel($0))" } ?? "create a file"
        case "rm": return file.map { "delete \(rel($0))" } ?? "delete files"
        case "cp", "rsync": return file.map { "copy \(base($0))" } ?? "copy files"
        case "mv": return file.map { "move \(base($0))" } ?? "move files"
        case "chmod", "chown": return "change permissions"
        case "echo", "printf":
            if let m = seg.firstMatch(of: />>?\s*(\S+)/) { return "write \(rel(String(m.1)))" }
            return nil
        case "open": return file.map { "open \(base($0))" } ?? "open something"
        case "sleep": return "wait"
        case "kill", "pkill", "killall": return "stop a process"
        case "ps", "pgrep", "lsof": return "check running processes"
        case "diff": return "compare files"
        case "which", "command", "type": return "check for \(base(plain.last ?? "a tool"))"
        case "gh", "docker": return sub.isEmpty ? "run \(cmd)" : "run \(cmd) \(sub)"
        default:
            if let m = seg.firstMatch(of: />>?\s*(\S+)/) { return "write \(rel(String(m.1)))" }
            if cmd.isEmpty { return nil }
            let subWord = sub.firstMatch(of: /^[a-z][\w:-]*$/.ignoresCase()) != nil ? " \(sub)" : ""
            return "run \(cmd)\(subWord)"
        }
    }

    /// The command's gist: up to two distinct phrases, present tense.
    public static func commandPhrases(_ raw: String) -> [String] {
        var out: [String] = []
        for seg in segments(unwrap(raw)) {
            if let p = segmentPhrase(seg), !out.contains(p) { out.append(p) }
        }
        return out
    }

    /// Home dirs read as `~`; a `sh -lc '…'` wrapper and env prefix fall away (the desktop's `bareCommand`).
    public static func bareCommand(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        for _ in 0..<4 {
            let before = s
            s = s.replacing(/^env\s+(?:-u\s+\w+\s+)*/, with: "")
            while s.firstMatch(of: /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+/) != nil {
                s = s.replacing(/^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+/, with: "")
            }
            s = unwrap(s)
            if s == before { break }
        }
        return displayPath(s)
    }
}

extension ToolItem {
    /// The call in plain words.
    public var phrase: ToolPhrase { ToolPhrase.of(self) }
}
