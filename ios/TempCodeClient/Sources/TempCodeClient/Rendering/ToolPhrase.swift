import Foundation
import TempCodeContract

/// Plain words for a call, split into its verb and object.
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

    public var line: String { [verb, target ?? ""].filter { !$0.isEmpty }.joined(separator: " ") }

    public enum Kind: Hashable, Sendable { case run, read, write, edit, patch, search, glob, fetch, web, todo, list, question, skill, mcp, tool }

    /// `live` overrides the call's own status (a live phase's title is in the
    /// present tense throughout); `cwd` shortens paths under the project.
    public static func of(_ tool: ToolItem, live: Bool? = nil, cwd: String? = nil) -> ToolPhrase {
        let live = live ?? tool.isLive
        var parts = settledParts(tool, cwd: cwd, live: live)
        if !live, tool.isRefused, kind(of: tool) != .run {
            let plain = ["ran": "run", "read": "read", "wrote": "write", "created": "create", "edited": "edit", "deleted": "delete", "searched": "search", "listed": "list", "fetched": "fetch", "updated": "update", "asked": "ask", "used": "use"]
            var words = parts.verb.components(separatedBy: " ")
            if let first = words.first, let word = plain[first.lowercased()] {
                words[0] = String(first.prefix(1)) == first.prefix(1).uppercased() ? cap(word) : word
                parts.verb = words.joined(separator: " ")
            }
        }
        return parts
    }

    private static func settledParts(_ tool: ToolItem, cwd: String?, live: Bool) -> ToolPhrase {
        switch kind(of: tool) {
        case .run: return runPhrase(tool, cwd: cwd, live: live)
        case .read: return fileParts(live ? "Reading" : "Read", path: pathOf(tool))
        case .write:
            let edited = outputText(tool).firstMatch(of: /has been (updated|overwritten)/.ignoresCase()) != nil
            return fileParts(edited ? (live ? "Editing" : "Edited") : (live ? "Creating" : "Created"), path: pathOf(tool))
        case .edit: return fileParts(live ? "Editing" : "Edited", path: pathOf(tool))
        case .patch:
            let files = patchFiles(tool)
            if files.count == 1 {
                let word = files[0].op == "add" ? (live ? "Creating" : "Created") : files[0].op == "delete" ? (live ? "Deleting" : "Deleted") : (live ? "Editing" : "Edited")
                return fileParts(word, path: files[0].path)
            }
            return ToolPhrase(verb: live ? "Editing" : "Edited", target: files.isEmpty ? "files" : "\(files.count) files")
        case .search, .glob:
            let q = queryOf(tool)
            return ToolPhrase(verb: q.isEmpty ? (live ? "Searching" : "Searched") : (live ? "Searching for" : "Searched for"), target: q.isEmpty ? "the project" : trim(q, 32))
        case .list:
            let path = pathOf(tool)
            return ToolPhrase(verb: live ? "Listing" : "Listed", target: path.isEmpty ? "files" : displayPath(path, cwd: cwd), isFile: !path.isEmpty)
        case .fetch:
            let url = input(tool)["url"]?.stringValue ?? ""
            return ToolPhrase(verb: live ? "Fetching" : "Fetched", target: URL(string: url)?.host ?? "a page")
        case .web:
            let q = firstText(input(tool)["query"]?.stringValue, tool.preview?.query)
            return ToolPhrase(verb: q.isEmpty ? (live ? "Searching" : "Searched") : (live ? "Searching the web for" : "Searched the web for"), target: q.isEmpty ? "the web" : trim(q, 32))
        case .todo: return ToolPhrase(verb: live ? "Updating todos" : "Updated todos")
        case .question: return ToolPhrase(verb: live ? "Asking" : "Asked", target: "a question")
        case .skill:
            let title = (tool.preview?.title ?? "").replacing(/^skill\b\s*/.ignoresCase(), with: "").trimmingCharacters(in: .whitespacesAndNewlines)
            let skill = firstText(input(tool)["skill"]?.stringValue, input(tool)["name"]?.stringValue, title)
            return ToolPhrase(verb: live ? "Using skill" : "Used skill", target: skill.isEmpty ? nil : skill)
        case .mcp, .tool:
            let verb = live ? "Using" : "Used"
            if tool.name.isEmpty {
                let title = (tool.preview?.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if title.isEmpty || title.firstMatch(of: /^(working|tool|running)$/.ignoresCase()) != nil { return ToolPhrase(verb: "") }
                return ToolPhrase(verb: verb, target: humanName(title.split(whereSeparator: { $0.isWhitespace || $0 == ":" }).first.map(String.init) ?? title))
            }
            return ToolPhrase(verb: verb, target: humanName(tool.name))
        }
    }

    private static func fileParts(_ verb: String, path: String) -> ToolPhrase {
        ToolPhrase(verb: verb, target: path.isEmpty ? "a file" : base(path), isFile: !path.isEmpty)
    }

    // MARK: - kinds

    private static let nameKind: [String: Kind] = [
        "Bash": .run, "shell": .run, "Shell": .run,
        "Read": .read, "Write": .write, "Edit": .edit, "MultiEdit": .edit, "NotebookEdit": .edit,
        "apply_patch": .patch, "Grep": .search, "Glob": .glob, "LS": .list,
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
        let title = (tool.preview?.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if tool.preview?.kind == .search { return .search }
        if tool.preview?.kind == .read { return .read }
        if title.firstMatch(of: /^(wrote|writ(e|ing)|creat(e|ed|ing))\b/) != nil { return .write }
        if tool.preview?.kind == .write { return .edit }
        if tool.preview?.kind == .shell { return .run }
        if title.hasPrefix("edit") || title.hasPrefix("updat") { return .edit }
        if title.firstMatch(of: /^read\b/) != nil { return .read }
        if title.hasPrefix("find") || title.hasPrefix("search") || title.hasPrefix("grep") || title.hasPrefix("glob") { return .search }
        if title.hasPrefix("bash") || title.hasPrefix("shell") || title.hasPrefix("run") { return .run }
        return .tool
    }

    /// "mcp__orchestrator__spawn_agent" → "spawn_agent"; "linear.save" → "save".
    public static func shortName(_ name: String) -> String {
        if name.hasPrefix("mcp__") { return firstText(name.components(separatedBy: "__").last, name) }
        if name.contains(".") { return firstText(name.components(separatedBy: ".").last, name) }
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

    /// A connector tool's name as a sentence; app tools keep their names.
    public static func sentenceName(_ name: String) -> String {
        let short = shortName(name)
        if let known = appTool[short] { return known }
        return cap(humanName(name).lowercased())
    }

    // MARK: - inputs

    static func input(_ tool: ToolItem) -> [String: JSONValue] {
        tool.input?.objectValue ?? [:]
    }

    static func pathOf(_ tool: ToolItem) -> String {
        let i = input(tool)
        return firstText(i["file_path"]?.stringValue, i["path"]?.stringValue, i["notebook_path"]?.stringValue, tool.preview?.path, tool.preview?.fileName)
    }

    private static func queryOf(_ tool: ToolItem) -> String {
        let i = input(tool)
        return firstText(i["pattern"]?.stringValue, i["query"]?.stringValue, tool.preview?.query)
    }

    private static func commandOf(_ tool: ToolItem) -> String {
        let i = input(tool)
        if let parts = i["command"]?.arrayValue { return parts.map(commandWord).joined(separator: " ") }
        if let command = i["command"]?.stringValue { return command }
        let title = (tool.preview?.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return title.replacing(/^(bash|shell|run(?:ning)?(?:\s+command)?)\b[:\s]*/.ignoresCase(), with: "")
    }

    private static func commandWord(_ value: JSONValue) -> String {
        switch value {
        case .string(let text): return text
        case .object: return "[object Object]"
        case .array(let items): return items.map { $0 == .null ? "" : commandWord($0) }.joined(separator: ",")
        default: return value.canonicalJSON()
        }
    }

    static func firstText(_ values: String?...) -> String {
        values.compactMap { $0 }.first { !$0.isEmpty } ?? ""
    }

    static func outputText(_ tool: ToolItem) -> String {
        switch tool.output {
        case .whole(let text): return text
        case .omitted(let body, _): return body.head
        case .none: return ""
        }
    }

    struct PatchFile { var path: String; var op: String }

    static func patchFiles(_ tool: ToolItem) -> [PatchFile] {
        if let changes = tool.input?.arrayValue {
            return changes.compactMap { change in
                guard let path = change["path"]?.stringValue, !path.isEmpty else { return nil }
                let type = change["kind"]?["type"]?.stringValue ?? ""
                return PatchFile(path: path, op: type == "add" || type == "delete" ? type : "update")
            }
        }
        let raw = firstText(tool.input?.stringValue, input(tool)["input"]?.stringValue, input(tool)["patch"]?.stringValue)
        let found = raw.matches(of: /^\*\*\* (Add|Update|Delete) File: (.+)$/.anchorsMatchLineEndings()).map {
            PatchFile(path: String($0.2).trimmingCharacters(in: .whitespacesAndNewlines), op: $0.1.lowercased())
        }
        if !found.isEmpty { return found }
        let path = pathOf(tool)
        return path.isEmpty ? [] : [PatchFile(path: path, op: "update")]
    }

    /// Paths inside the project read relative to it; other paths keep their full form.
    public static func displayPath(_ path: String, cwd: String? = nil) -> String {
        let normalized = path.replacingOccurrences(of: "\\", with: "/").trimmingSuffix("/")
        if let cwd {
            let base = cwd.replacingOccurrences(of: "\\", with: "/").trimmingSuffix("/")
            if !base.isEmpty, base != "~" {
                if normalized == base { return normalized.split(separator: "/").last.map(String.init) ?? normalized }
                if normalized.hasPrefix(base + "/") { return String(normalized.dropFirst(base.count + 1)) }
            }
        }
        return normalized
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

    private static func foldedTitle(_ tool: ToolItem) -> (verb: String, object: String)? {
        let i = input(tool)
        if !(i["description"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || i["command"] != nil { return nil }
        let title = (tool.preview?.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let m = title.firstMatch(of: /^(Read|Find|List|Edit|Write|Delete|Move|Fetch|Create)\s+(.+)$/) else { return nil }
        return (m.1 == "Find" ? "search for" : m.1.lowercased(), String(m.2))
    }

    /// One clause per distinct command segment; descriptions and folded titles stay whole.
    public static func runClauses(_ tool: ToolItem, cwd: String? = nil, live: Bool? = nil) -> [String] {
        let live = live ?? tool.isLive
        func form(_ phrase: String) -> String { !live && tool.isRefused ? phrase : tense(phrase, live: live) }
        let desc = (input(tool)["description"]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !desc.isEmpty { return [cap(form(trim(desc.prefix(1).lowercased() + desc.dropFirst(), 60)))] }
        if let title = foldedTitle(tool) { return ["\(cap(form(title.verb))) \(title.object)"] }
        return commandPhrases(commandOf(tool), cwd: cwd).enumerated().map { index, phrase in
            index == 0 ? cap(form(phrase)) : form(phrase)
        }
    }

    private static func runPhrase(_ tool: ToolItem, cwd: String?, live: Bool) -> ToolPhrase {
        if let title = foldedTitle(tool) {
            return ToolPhrase(verb: cap(!live && tool.isRefused ? title.verb : tense(title.verb, live: live)), target: title.object)
        }
        let clauses = runClauses(tool, cwd: cwd, live: live)
        if clauses.isEmpty { return ToolPhrase(verb: live ? "Running" : tool.isRefused ? "Run" : "Ran", target: "a command") }
        let phrase = clauses.prefix(2).joined(separator: ", ") + (clauses.count > 2 ? " and \(clauses.count - 2) more" : "")
        guard let space = phrase.firstIndex(of: " ") else { return ToolPhrase(verb: phrase) }
        return ToolPhrase(verb: String(phrase[..<space]), target: String(phrase[phrase.index(after: space)...]))
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
        let chars = Array(cmd)
        var i = 0
        while i < chars.count {
            let c = chars[i]
            let previous: Character? = i > 0 ? chars[i - 1] : nil
            let next: Character? = i + 1 < chars.count ? chars[i + 1] : nil
            if let open = quote {
                current.append(c)
                if c == open, previous != "\\" { quote = nil }
            } else if c == "'" || c == "\"" || c == "`" {
                quote = c
                current.append(c)
            } else if c == "&", previous == ">" || previous == "<" || next == ">" {
                current.append(c)
            } else if c == "\n" || c == ";" || c == "|" || c == "&" {
                if (c == "|" || c == "&"), next == c { i += 1 }
                out.append(current)
                current = ""
            } else { current.append(c) }
            i += 1
        }
        out.append(current)
        return out.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
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
    private static func segmentPhrase(_ seg: String, cwd: String?) -> String? {
        var words = seg.split(whereSeparator: \.isWhitespace).map(String.init)
        while let first = words.first, first == "env" || first.firstMatch(of: /^[A-Za-z_][A-Za-z0-9_]*=/) != nil { words.removeFirst() }
        if let first = words.first, first == "sudo" || first == "xargs" { words.removeFirst() }
        guard let head = words.first else { return nil }
        let cmd = base(head)
        let args = Array(words.dropFirst())
        let plain = args.filter { !$0.hasPrefix("-") && $0.firstMatch(of: /^\d*[<>]/) == nil && !$0.contains(">") }
        let file = plain.first
        let sub = plain.first ?? ""
        let rel = { (p: String) in displayPath(unquote(p), cwd: cwd) }
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
            return sub.isEmpty ? "run \(cmd)" : segmentPhrase(words.dropFirst().filter { !$0.hasPrefix("-") }.joined(separator: " "), cwd: cwd)
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
            if let path = redirectPath(seg) { return "write \(rel(path))" }
            return nil
        case "open": return file.map { "open \(base($0))" } ?? "open something"
        case "sleep": return "wait"
        case "kill", "pkill", "killall": return "stop a process"
        case "ps", "pgrep", "lsof": return "check running processes"
        case "diff": return "compare files"
        case "which", "command", "type": return "check for \(base(plain.last ?? "a tool"))"
        case "gh", "docker": return sub.isEmpty ? "run \(cmd)" : "run \(cmd) \(sub)"
        default:
            if let path = redirectPath(seg) { return "write \(rel(path))" }
            if cmd.isEmpty { return nil }
            let subWord = sub.firstMatch(of: /^[a-z][\w:-]*$/.ignoresCase()) != nil ? " \(sub)" : ""
            return "run \(cmd)\(subWord)"
        }
    }

    /// One present-tense phrase per distinct command segment.
    public static func commandPhrases(_ raw: String) -> [String] {
        commandPhrases(raw, cwd: nil)
    }

    /// Command phrases with paths shown relative to the project.
    public static func commandPhrases(_ raw: String, cwd: String?) -> [String] {
        var out: [String] = []
        for seg in segments(unwrap(raw)) {
            var phrase = segmentPhrase(seg, cwd: cwd)
            if let p = phrase, p.hasPrefix("run "), echoesCommand(String(p.dropFirst(4)), segment: seg) { phrase = "run a command" }
            if let phrase, !out.contains(phrase) { out.append(phrase) }
        }
        return out
    }

    private static let fileRedirect = try? NSRegularExpression(pattern: #"(?<![\d&])>>?\s*([^&\s]\S*)"#)

    private static func redirectPath(_ segment: String) -> String? {
        guard let match = fileRedirect?.firstMatch(in: segment, range: NSRange(segment.startIndex..., in: segment)),
              let range = Range(match.range(at: 1), in: segment) else { return nil }
        return String(segment[range])
    }

    private static func echoesCommand(_ words: String, segment: String) -> Bool {
        let tokens = segment.split(whereSeparator: \.isWhitespace).map(String.init)
        let typed = tokens.filter { token in
            let assignment = token.firstMatch(of: /^[A-Za-z_][A-Za-z0-9_]*=/) != nil
            return !assignment && token != "env" && token != "sudo"
        }
        let said = words.components(separatedBy: " ")
        guard said.count <= typed.count else { return false }
        for (index, word) in said.enumerated() {
            let token = index == 0 ? base(typed[0]) : unquote(typed[index])
            if word != token { return false }
        }
        return true
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
        return s.replacing(/\/Users\/[^\/\s'"]+/, with: "~")
    }
}

extension ToolItem {
    /// Streaming input or a call still running.
    public var isLive: Bool { partial || status == .running }

    /// Approval decisions live on separate ApprovalItem rows, outside this value.
    public var isRefused: Bool { false }

    /// The call in plain words.
    public var phrase: ToolPhrase { ToolPhrase.of(self) }
}

extension String {
    /// The string without trailing copies of `suffix`.
    func trimmingSuffix(_ suffix: Character) -> String {
        var s = Substring(self)
        while s.last == suffix { s = s.dropLast() }
        return String(s)
    }
}
