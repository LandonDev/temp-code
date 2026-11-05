import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct ActionRowTests {
    @Test func `filler folds into the verb`() {
        for (name, verb) in [("Bash", "Ran a command"), ("Read", "Read a file"), ("Grep", "Searched the project"), ("WebFetch", "Fetched a page"), ("WebSearch", "Searched the web"), ("AskUserQuestion", "Asked a question")] {
            let row = ActionRow.of(PhraseFixture.call(name))
            #expect(row.verb == verb && row.object.isEmpty && !row.isFile)
        }
        let tests = ActionRow.of(PhraseFixture.bash("npm test"))
        #expect(tests.verb == "Ran" && tests.object == "the tests" && tests.opens == .command)
    }

    @Test func `a connector reads by its product and sentence case tool name`() {
        let row = ActionRow.of(PhraseFixture.call("mcp__cosmic-admin__build_get"))
        #expect(row.connector == "cosmic-admin" && row.verb == "Cosmic Admin" && row.object == "Build get")
        #expect(row.opens == .details && !row.agent)
        let underscored = ActionRow.of(PhraseFixture.call("mcp__claude_ai_Gmail__list_messages"))
        #expect(underscored.connector == "claude_ai_Gmail")
        #expect(ActionRow.of(PhraseFixture.call("mcp__github__listIssues")).verb == "GitHub")
        #expect(ActionRow.of(PhraseFixture.call("mcp__app__update_notes")).connector == nil)
    }

    @Test func `display app names the product and supplies the action`() {
        let row = ActionRow.of(PhraseFixture.call("mcp__slack__post", display: ToolCallEvent.Display(app: "google-drive", action: "Find files")))
        #expect(row.verb == "Google Drive" && row.object == "Find files" && row.connector == "google-drive")
    }

    @Test func `todo tally counts completed items including items with no text`() {
        for (name, key) in [("TodoWrite", "todos"), ("update_plan", "plan")] {
            let row = ActionRow.of(PhraseFixture.call(name, .object([key: .array([.object(["status": .string("completed")]), .object(["step": .string("build"), "status": .string("in_progress")]), .object(["content": .string("test"), "status": .string("pending")])])])))
            #expect(row.verb == "Updated todos" && row.object.isEmpty && row.tally == "1/3" && row.opens == .details)
        }
        #expect(ActionRow.of(PhraseFixture.call("TodoWrite")).tally == nil)
    }

    @Test func `an edit shows its counts and opens the diff`() {
        let row = ActionRow.of(PhraseFixture.call("Edit", .object(["file_path": .string("/repo/a.ts"), "old_string": .string("a\nb"), "new_string": .string("c\nd\ne")])))
        #expect(row.verb == "Edited" && row.object == "a.ts" && row.isFile)
        #expect(row.path == "/repo/a.ts" && row.adds == 3 && row.dels == 2 && row.opens == .diff && row.glyph == .kind(.edit))
        let preview = ToolPreview(kind: .write, path: "/repo/a.ts", additions: 7, deletions: 3)
        let remote = ActionRow.of(PhraseFixture.call("Edit", preview: preview))
        #expect(remote.adds == 7 && remote.dels == 3 && remote.opens == .diff)
        let deleted = ActionRow.of(PhraseFixture.call("apply_patch", .array([PhraseFixture.change("old.ts", "delete")])))
        #expect(deleted.glyph == .delete && deleted.opens == .diff && deleted.path == "old.ts")
    }

    @Test func `reads and lists open the file they name`() {
        let row = ActionRow.of(PhraseFixture.read("src/a.ts"), cwd: PhraseFixture.cwd)
        #expect(row.verb == "Read" && row.object == "a.ts" && row.path == "\(PhraseFixture.cwd)/src/a.ts" && row.opens == .file && row.isFile)
        #expect(ActionRow.of(PhraseFixture.call("LS", .object(["path": .string("/repo/src")]))).opens == .file)
        #expect(ActionRow.of(PhraseFixture.call("Read")).opens == .details)
    }

    @Test func `failed calls keep their failure and a failed read opens details`() {
        let row = ActionRow.of(PhraseFixture.call("Read", .object(["file_path": .string("/repo/a.ts")]), failed: true))
        #expect(row.failed && !row.running && !row.pending && row.opens == .details && row.path == "/repo/a.ts")
    }

    @Test func `running comes from state and tense may be overridden`() {
        let tool = PhraseFixture.call("Bash", .object(["command": .string("npm test")]), live: true)
        let row = ActionRow.of(tool)
        #expect(row.running && !row.failed && !row.pending && row.verb == "Running" && row.opens == .command)
        #expect(ActionRow.of(tool, live: false).running && ActionRow.of(tool, live: false).verb == "Ran")
        #expect(ActionRow.of(PhraseFixture.call("Read", live: true, partial: true)).running)
        #expect(!ActionRow.of(PhraseFixture.call("Read", partial: true)).running)
    }

    @Test func `agent calls keep their mark and avoid connector words`() {
        let row = ActionRow.of(PhraseFixture.call("mcp__orchestrator__spawn_agent"))
        #expect(row.agent && row.verb == "Used" && row.object == "Spawn Agent" && row.connector == "orchestrator")
        #expect(ActionRow.of(PhraseFixture.call("Task")).agent)
    }
}
