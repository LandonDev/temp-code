import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

enum PhraseFixture {
    static let cwd = "/Users/me/monocode"
    static func call(_ name: String, _ input: JSONValue = .object([:]), id: String? = nil, live: Bool = false, partial: Bool = false, preview: ToolPreview? = nil, output: String? = nil, failed: Bool = false, display: ToolCallEvent.Display? = nil) -> ToolItem {
        ToolItem(seq: 1, ts: 0, callId: id ?? name, name: name, display: display, input: input, partial: partial, preview: preview, parentCallId: nil, inputOmitted: false, output: output.map(BodyState.whole) ?? .none, status: failed ? .failed : live ? .running : .done, reauth: nil, doneTs: live ? nil : 10)
    }
    static func read(_ path: String, id: String? = nil) -> ToolItem { call("Read", .object(["file_path": .string("\(cwd)/\(path)")]), id: id ?? path) }
    static func edit(_ path: String) -> ToolItem { call("Edit", .object(["file_path": .string("\(cwd)/\(path)"), "old_string": .string("a"), "new_string": .string("b")]), id: "e:\(path)") }
    static func write(_ path: String, output: String? = nil) -> ToolItem { call("Write", .object(["file_path": .string("\(cwd)/\(path)"), "content": .string("x")]), id: "w:\(path)", output: output) }
    static func bash(_ command: String, id: String? = nil) -> ToolItem { call("Bash", .object(["command": .string(command)]), id: id ?? command) }
    static func grep(_ pattern: String) -> ToolItem { call("Grep", .object(["pattern": .string(pattern)]), id: "g:\(pattern)") }
    static func change(_ path: String, _ op: String) -> JSONValue { .object(["path": .string(path), "kind": .object(["type": .string(op)]), "diff": .string("")]) }
}

@Suite struct ToolPhraseTests {
    private let cwd = PhraseFixture.cwd
    private func say(_ tool: ToolItem, live: Bool? = nil) -> String { ToolPhrase.of(tool, live: live, cwd: cwd).line }

    @Test func `maps provider tool names`() {
        let cases: [(String, ToolPhrase.Kind)] = [("Bash", .run), ("shell", .run), ("Read", .read), ("Write", .write), ("MultiEdit", .edit), ("apply_patch", .patch), ("Grep", .search), ("Glob", .glob), ("WebFetch", .fetch), ("web_search", .web), ("update_plan", .todo), ("LS", .list), ("mcp__app__app_start_thread", .mcp), ("linear.save_document", .mcp), ("Whatever", .tool)]
        for (name, kind) in cases { #expect(ToolPhrase.kind(of: PhraseFixture.call(name)) == kind) }
    }

    @Test func `falls back to the preview when no name is kept`() {
        for (kind, title, expected) in [(ToolPreview.Kind.shell, "git status", ToolPhrase.Kind.run), (.read, "Read a.ts", .read), (.search, "Find x", .search), (.write, "Edited a.ts", .edit)] {
            #expect(ToolPhrase.kind(of: PhraseFixture.call("", preview: ToolPreview(kind: kind, title: title))) == expected)
        }
        #expect(ToolPhrase.kind(of: PhraseFixture.call("", preview: ToolPreview(kind: .unknown("other"), title: "Read a.ts"))) == .read)
    }

    @Test func `names app tools in plain words and title cases the rest`() {
        for (name, expected) in [("mcp__app__app_start_thread", "Create Thread"), ("mcp__orchestrator__spawn_agent", "Spawn Agent"), ("AskUserQuestion", "Ask User"), ("mcp__linear__save_document", "Save Document"), ("ExitPlanMode", "Exit Plan Mode"), ("someCamelTool", "Some Camel Tool")] {
            #expect(ToolPhrase.humanName(name) == expected)
        }
        #expect(ToolPhrase.shortName("mcp__claude_ai_Gmail__list_messages") == "list_messages")
        #expect(ToolPhrase.shortName("linear.save") == "save")
    }

    @Test func `connector names use sentence case and app names keep their case`() {
        for (name, expected) in [("mcp__cosmic-admin__build_get", "Build get"), ("mcp__notion__searchPages", "Search pages"), ("list-open-issues", "List open issues"), ("mcp__app__app_start_thread", "Create Thread")] {
            #expect(ToolPhrase.sentenceName(name) == expected)
        }
    }

    @Test func `reads writes edits and patches name the file by basename`() {
        #expect(say(PhraseFixture.read("src/lib/paths.ts")) == "Read paths.ts")
        #expect(say(PhraseFixture.write("a.ts")) == "Created a.ts")
        #expect(say(PhraseFixture.edit("a.ts"), live: true) == "Editing a.ts")
        #expect(say(PhraseFixture.call("apply_patch", .string("*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** End Patch"))) == "Edited 2 files")
        #expect(say(PhraseFixture.call("apply_patch", .object(["patch": .string("*** Update File: src/a.ts\n")]))) == "Edited a.ts")
    }

    @Test func `searches and globs show the query`() {
        #expect(say(PhraseFixture.grep("toolCallLabel")) == "Searched for toolCallLabel")
        #expect(say(PhraseFixture.call("Glob", .object(["pattern": .string("**/*.test.ts")])), live: true) == "Searching for **/*.test.ts")
        #expect(say(PhraseFixture.call("Grep")) == "Searched the project")
        #expect(say(PhraseFixture.grep(String(repeating: "x", count: 50))) == "Searched for \(String(repeating: "x", count: 31))…")
    }

    @Test func `commands read as their gist with the description first`() {
        #expect(say(PhraseFixture.call("Bash", .object(["command": .string("npm test"), "description": .string("Run the tests")]))) == "Ran the tests")
        for (command, expected) in [("npm test", "Ran the tests"), ("git status -s", "Checked git status"), ("cat \(cwd)/src/a.ts", "Read src/a.ts"), ("cd /x && rg -n foo src | head", "Searched for foo"), ("ls src && wc -l a.ts && git log", "Listed src, counted lines in a.ts and 1 more"), ("osascript -e 'tell app'", "Ran a command"), ("", "Ran a command")] {
            #expect(say(PhraseFixture.bash(command)) == expected)
        }
        #expect(say(PhraseFixture.bash("git status"), live: true) == "Checking git status")
        #expect(say(PhraseFixture.call("shell", .object(["command": .array([.string("/bin/zsh"), .string("-lc"), .string("bun run build")])]))) == "Ran a command")
    }

    @Test func `a shell title the fold rewrote keeps its sense`() {
        #expect(say(PhraseFixture.call("", preview: ToolPreview(kind: .shell, title: "Read src/lib/appearance.ts"))) == "Read src/lib/appearance.ts")
        #expect(say(PhraseFixture.call("", preview: ToolPreview(kind: .shell, title: "Find tokens"))) == "Searched for tokens")
    }

    @Test func `fetch web todo list question and skill`() {
        #expect(say(PhraseFixture.call("WebFetch", .object(["url": .string("https://docs.rs/x/y")]))) == "Fetched docs.rs")
        #expect(say(PhraseFixture.call("WebFetch", .object(["url": .string("nope")]))) == "Fetched a page")
        #expect(say(PhraseFixture.call("WebSearch", .object(["query": .string("tauri updater")]))) == "Searched the web for tauri updater")
        #expect(say(PhraseFixture.call("TodoWrite", .object(["todos": .array([])])), live: true) == "Updating todos")
        #expect(say(PhraseFixture.call("LS", .object(["path": .string("\(cwd)/src")]))) == "Listed src")
        #expect(say(PhraseFixture.call("AskUserQuestion")) == "Asked a question")
        #expect(say(PhraseFixture.call("Skill", .object(["skill": .string("code-review")]))) == "Used skill code-review")
    }

    @Test func `app agent and MCP tools read by their human names`() {
        #expect(say(PhraseFixture.call("mcp__app__app_start_thread", .object(["threadType": .string("planning"), "provider": .string("claude"), "model": .string("claude-opus-5")]))) == "Used Create Thread")
        #expect(say(PhraseFixture.call("mcp__orchestrator__spawn_agent", .object(["task": .string("x"), "model": .string("gpt")])), live: true) == "Using Spawn Agent")
        #expect(say(PhraseFixture.call("mcp__orchestrator__wait_for_agent")) == "Used Wait For Agent")
        #expect(say(PhraseFixture.call("mcp__linear__save_document")) == "Used Save Document")
        #expect(say(PhraseFixture.call("Task", .object(["prompt": .string("explore")]))) == "Used Agent")
    }

    @Test func `says nothing for a call it knows nothing about`() {
        #expect(say(PhraseFixture.call("", preview: ToolPreview(kind: .unknown("other"), title: "Working"))) == "")
    }

    @Test func `takes tense from the call when not told`() {
        #expect(say(PhraseFixture.call("Read", .object(["file_path": .string("a.ts")]), partial: true)) == "Reading a.ts")
        #expect(say(PhraseFixture.call("Read", .object(["file_path": .string("a.ts")]), live: true)) == "Reading a.ts")
    }

    @Test func `splits every kind into verb and object settled and live`() {
        let file = "\(cwd)/src/lib/a.ts"
        let cases: [(ToolItem, String, String, String)] = [
            (PhraseFixture.bash("npm test"), "Ran", "Running", "the tests"),
            (PhraseFixture.read("src/lib/a.ts"), "Read", "Reading", "a.ts"),
            (PhraseFixture.write("src/lib/a.ts"), "Created", "Creating", "a.ts"),
            (PhraseFixture.edit("src/lib/a.ts"), "Edited", "Editing", "a.ts"),
            (PhraseFixture.call("apply_patch", .string("*** Update File: src/a.ts\n")), "Edited", "Editing", "a.ts"),
            (PhraseFixture.call("apply_patch", .string("*** Update File: a.ts\n*** Add File: b.ts\n")), "Edited", "Editing", "2 files"),
            (PhraseFixture.grep("needle"), "Searched for", "Searching for", "needle"),
            (PhraseFixture.call("Glob", .object(["pattern": .string("*.ts")])), "Searched for", "Searching for", "*.ts"),
            (PhraseFixture.call("LS", .object(["path": .string("\(cwd)/src")])), "Listed", "Listing", "src"),
            (PhraseFixture.call("WebFetch", .object(["url": .string("https://docs.rs/x")])), "Fetched", "Fetching", "docs.rs"),
            (PhraseFixture.call("WebSearch", .object(["query": .string("tauri")])), "Searched the web for", "Searching the web for", "tauri"),
            (PhraseFixture.call("TodoWrite"), "Updated todos", "Updating todos", ""),
            (PhraseFixture.call("AskUserQuestion"), "Asked", "Asking", "a question"),
            (PhraseFixture.call("Skill", .object(["skill": .string("code-review")])), "Used skill", "Using skill", "code-review"),
            (PhraseFixture.call("mcp__linear__save_document"), "Used", "Using", "Save Document"),
            (PhraseFixture.call("Whatever"), "Used", "Using", "Whatever")
        ]
        for (tool, settled, live, object) in cases {
            let past = ToolPhrase.of(tool, live: false, cwd: cwd)
            let now = ToolPhrase.of(tool, live: true, cwd: cwd)
            #expect(past.verb == settled && (past.target ?? "") == object)
            #expect(now.verb == live && (now.target ?? "") == object)
        }
        #expect(ToolPhrase.of(PhraseFixture.call("Read", .object(["file_path": .string(file)]))).isFile)
    }

    @Test func `a Write over a file that was there is an edit`() {
        #expect(say(PhraseFixture.write("src/lib/a.ts", output: "The file /repo/src/lib/a.ts has been updated.")) == "Edited a.ts")
        #expect(say(PhraseFixture.write("a.ts", output: "has been overwritten"), live: true) == "Editing a.ts")
    }

    @Test func `codex change arrays name the file and what happened`() {
        for (path, op, live, expected) in [("src/a.ts", "update", false, "Edited a.ts"), ("new.ts", "add", false, "Created new.ts"), ("old.ts", "delete", true, "Deleting old.ts")] {
            #expect(say(PhraseFixture.call("apply_patch", .array([PhraseFixture.change("\(cwd)/\(path)", op)])), live: live) == expected)
        }
        #expect(say(PhraseFixture.call("apply_patch", .array([PhraseFixture.change("a.ts", "update"), PhraseFixture.change("b.ts", "add")]))) == "Edited 2 files")
        #expect(say(PhraseFixture.call("apply_patch", .object(["input": .string("*** Add File: src/n.ts\n+x\n")]))) == "Created n.ts")
    }

    @Test func `a file path reads relative to its project`() {
        #expect(ToolPhrase.displayPath("\(cwd)/src/lib/a.ts", cwd: cwd) == "src/lib/a.ts")
        #expect(ToolPhrase.displayPath(cwd, cwd: cwd) == "monocode")
        #expect(ToolPhrase.displayPath("/srv/agents/work/a.ts") == "/srv/agents/work/a.ts")
    }

    @Test func `splits a run on its first word and folds command echoes`() {
        for (command, verb, object) in [("npx convex dev --once", "Ran", "convex dev"), ("npx vitest run src", "Ran", "the tests"), ("npm i", "Installed", "dependencies"), ("", "Ran", "a command"), ("git status && git diff", "Checked", "git status, viewed the diff"), ("bun run typecheck", "Ran", "a command"), ("osascript -e 'x'", "Ran", "a command"), ("npm test", "Ran", "the tests"), ("git status", "Checked", "git status")] {
            let parts = ToolPhrase.of(PhraseFixture.bash(command))
            #expect(parts.verb == verb && parts.target == object)
        }
    }

    @Test func `more than two run clauses say and N more`() {
        #expect(say(PhraseFixture.bash("ls src && wc -l a.ts && git log && git diff")) == "Listed src, counted lines in a.ts and 2 more")
    }

    @Test func `the line joins its parts without a middle dot`() {
        for tool in [PhraseFixture.bash("ls src && wc -l a.ts && git log && git diff"), PhraseFixture.read("a.ts"), PhraseFixture.call("TodoWrite"), PhraseFixture.call("mcp__app__app_start_thread")] {
            let parts = ToolPhrase.of(tool, live: false, cwd: cwd)
            #expect(parts.line == [parts.verb, parts.target ?? ""].filter { !$0.isEmpty }.joined(separator: " "))
            #expect(!parts.line.contains(" · "))
        }
    }

    @Test func `command phrases unwrap shells and skip pipe noise`() {
        for (raw, expected) in [("/bin/zsh -lc 'cd /x && git diff | cat'", ["view the diff"]), ("FOO=1 env npm run check:web", ["run a command"]), ("echo hi > out.txt", ["write out.txt"]), ("npx convex dev --once 2>&1 | tail -20 && git commit -m x", ["run convex dev", "commit"]), ("npm test &> log.txt", ["run the tests"]), ("cat a.ts | grep foo | sort", ["read a.ts", "search for foo"]), ("cd x", [])] {
            #expect(ToolPhrase.commandPhrases(raw) == expected)
        }
    }

    @Test func `run clauses keep one clause per command segment and capitalize the first`() {
        let run = PhraseFixture.bash("git status && npm test")
        #expect(ToolPhrase.runClauses(run) == ["Checked git status", "ran the tests"])
        #expect(say(run) == "Checked git status, ran the tests")
    }

    @Test func `run clauses keep descriptions and folded titles whole and nothing empty`() {
        #expect(ToolPhrase.runClauses(PhraseFixture.call("Bash", .object(["command": .string("make"), "description": .string("Run the build, then sign")]))) == ["Ran the build, then sign"])
        #expect(ToolPhrase.runClauses(PhraseFixture.call("", preview: ToolPreview(kind: .shell, title: "Find tokens"))) == ["Searched for tokens"])
        #expect(ToolPhrase.runClauses(PhraseFixture.bash("")) == [])
    }

    @Test func `bareCommand peels shells and env prefixes and hides home directories`() {
        #expect(ToolPhrase.bareCommand(#"/bin/zsh -lc "FOO=1 env -u X ls /Users/landon/src""#) == "ls ~/src")
        #expect(ToolPhrase.bareCommand("bash -lc 'git status'") == "git status")
        #expect(ToolPhrase.bareCommand("git status") == "git status")
    }

    @Test func `sentence keeps its public joining rules`() {
        #expect(ToolPhrase.sentence([]) == "")
        #expect(ToolPhrase.sentence(["run the tests"]) == "run the tests")
        #expect(ToolPhrase.sentence(["check git status", "run the tests"]) == "check git status and run the tests")
        #expect(ToolPhrase.sentence(["a", "b", "c", "d"]) == "a, b and 2 more")
    }

    // ToolItem cannot express raw tool.kind, block.text independent of preview.title,
    // a phrase tooltip title, or approval decisions. Desktop's refused-call tests,
    // approval-live test and raw-kind delete case need those fields.
}
