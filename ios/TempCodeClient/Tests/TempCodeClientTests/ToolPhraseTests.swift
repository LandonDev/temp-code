import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct ToolPhraseTests {
    private func tool(_ name: String, _ input: [String: JSONValue] = [:], live: Bool = false, display: ToolCallEvent.Display? = nil, preview: ToolPreview? = nil) -> ToolItem {
        ToolItem(seq: 1, ts: 0, callId: "c", name: name, display: display, input: input.isEmpty ? nil : .object(input), partial: false, preview: preview, parentCallId: nil, inputOmitted: false, output: .none, status: live ? .running : .done, reauth: nil, doneTs: live ? nil : 10)
    }

    @Test func `a file tool reads verb and file, in the live tense while it runs`() {
        let read = ToolPhrase.of(tool("Read", ["file_path": .string("/Users/landon/src/a.ts")]))
        #expect(read.verb == "Read")
        #expect(read.target == "~/src/a.ts")
        #expect(read.isFile)
        #expect(read.line == "Read ~/src/a.ts")
        #expect(ToolPhrase.of(tool("Read", ["file_path": .string("/repo/a.ts")], live: true)).verb == "Reading")
        #expect(ToolPhrase.of(tool("Write", ["file_path": .string("/repo/b.ts")])).verb == "Wrote")
        let edit = ToolPhrase.of(tool("Edit", ["file_path": .string("/repo/c.ts")], live: true))
        #expect(edit.verb == "Editing" && edit.target == "/repo/c.ts")
        #expect(ToolPhrase.of(tool("Read")).target == "a file")
    }

    @Test func `a shell command reads as what it did`() {
        let tests = ToolPhrase.of(tool("Bash", ["command": .string("bun test")]))
        #expect(tests.verb == "Ran the tests")
        #expect(tests.target == nil)
        #expect(ToolPhrase.of(tool("Bash", ["command": .string("bun test")], live: true)).verb == "Running the tests")
        let described = ToolPhrase.of(tool("Bash", ["command": .string("ls"), "description": .string("Check the deploy")]))
        #expect(described.verb == "Checked the deploy")
        let two = ToolPhrase.of(tool("Bash", ["command": .string("git status && bun run typecheck && ls && pwd")]))
        #expect(two.verb == "Checked git status · ran bun run typecheck +1 more")
        #expect(ToolPhrase.of(tool("Bash", ["command": .string("")])).verb == "Ran a command")
    }

    @Test func `bareCommand peels the shell wrapper and the env prefix and hides home dirs`() {
        #expect(ToolPhrase.bareCommand(#"/bin/zsh -lc "FOO=1 env -u X ls /Users/landon/src""#) == "ls ~/src")
        #expect(ToolPhrase.bareCommand("bash -lc 'git status'") == "git status")
        #expect(ToolPhrase.bareCommand("git status") == "git status")
    }

    @Test func `commandPhrases keeps the gist of a chain and drops the noise`() {
        #expect(ToolPhrase.commandPhrases("cd /repo && git status && bun run typecheck") == ["check git status", "run bun run typecheck"])
        #expect(ToolPhrase.commandPhrases("cat a.ts | grep foo | sort") == ["read a.ts", "search for foo"])
        #expect(ToolPhrase.commandPhrases("sh -c 'npm test'") == ["run the tests"])
        #expect(ToolPhrase.commandPhrases("cd x") == [])
    }

    @Test func `displayPath shortens a home directory`() {
        #expect(ToolPhrase.displayPath("/Users/landon/src/a.ts") == "~/src/a.ts")
        #expect(ToolPhrase.displayPath("/srv/agents/work/a.ts") == "/srv/agents/work/a.ts")
    }

    @Test func `a search names its pattern`() {
        let grep = ToolPhrase.of(tool("Grep", ["pattern": .string("toolCallLabel")]))
        #expect(grep.verb == "Searched for" && grep.target == "toolCallLabel" && !grep.isFile)
        #expect(ToolPhrase.of(tool("Grep")).verb == "Searched the project")
        #expect(ToolPhrase.of(tool("Glob", ["pattern": .string("**/*.swift")], live: true)).verb == "Searching for")
        let web = ToolPhrase.of(tool("WebSearch", ["query": .string("swift testing")]))
        #expect(web.verb == "Searched the web" && web.target == "for swift testing")
    }

    @Test func `an MCP call and a spawn read by their human names`() {
        let spawn = ToolPhrase.of(tool("mcp__orchestrator__spawn_agent"))
        #expect(spawn.verb == "Used" && spawn.target == "Spawn Agent")
        let linear = ToolPhrase.of(tool("linear.save_issue", live: true))
        #expect(linear.verb == "Using" && linear.target == "Save Issue")
        let app = ToolPhrase.of(tool("mcp__slack__post", display: ToolCallEvent.Display(app: "Slack", action: "Post a message")))
        #expect(app.verb == "Slack" && app.target == "Post a message")
    }

    @Test func `an unknown tool falls back to its human name`() {
        let odd = ToolPhrase.of(tool("fooBarBaz"))
        #expect(odd.verb == "Used" && odd.target == "Foo Bar Baz")
        #expect(ToolPhrase.humanName("AskUserQuestion") == "Ask User")
        #expect(ToolPhrase.humanName("list_agents") == "List Agents")
        #expect(ToolPhrase.shortName("mcp__a__b") == "b")
        let skill = ToolPhrase.of(tool("Skill", ["skill": .string("impeccable")]))
        #expect(skill.target == "Skill impeccable")
    }
}
