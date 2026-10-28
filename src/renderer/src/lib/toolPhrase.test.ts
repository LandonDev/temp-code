import { describe, expect, it } from "vitest";
import type { Block, ToolPreview } from "./session";
import { commandPhrases, humanName, kindOf, runClauses, toolPhrase, toolPhraseParts } from "./toolPhrase";

const CWD = "/Users/me/monocode";

function call(
  name: string,
  input: unknown,
  extra: Partial<NonNullable<Block["tool"]>> & { id?: string; streaming?: boolean } = {},
): Block {
  const { id, streaming, ...tool } = extra;
  return {
    id: id ?? name,
    role: "tool",
    text: name,
    streaming: streaming ?? false,
    tool: { callId: id ?? name, title: name, status: "completed", name, input, ...tool },
  };
}

describe("kindOf", () => {
  it("maps provider tool names", () => {
    expect(kindOf(call("Bash", {}))).toBe("run");
    expect(kindOf(call("shell", {}))).toBe("run");
    expect(kindOf(call("Read", {}))).toBe("read");
    expect(kindOf(call("Write", {}))).toBe("write");
    expect(kindOf(call("MultiEdit", {}))).toBe("edit");
    expect(kindOf(call("apply_patch", ""))).toBe("patch");
    expect(kindOf(call("Grep", {}))).toBe("search");
    expect(kindOf(call("Glob", {}))).toBe("glob");
    expect(kindOf(call("WebFetch", {}))).toBe("fetch");
    expect(kindOf(call("web_search", {}))).toBe("web");
    expect(kindOf(call("update_plan", {}))).toBe("todo");
    expect(kindOf(call("mcp__app__app_start_thread", {}))).toBe("mcp");
    expect(kindOf(call("linear.save_document", {}))).toBe("mcp");
    expect(kindOf(call("Whatever", {}))).toBe("tool");
  });

  it("falls back to the block's kind and preview when no name is kept", () => {
    const bare = (kind: string, title: string, preview?: ToolPreview): Block => ({
      id: title,
      role: "tool",
      text: title,
      tool: { kind, title, status: "completed", ...(preview ? { preview } : {}) },
    });
    expect(kindOf(bare("execute", "git status"))).toBe("run");
    expect(kindOf(bare("read", "Read a.ts"))).toBe("read");
    expect(kindOf(bare("search", "Find x"))).toBe("search");
    expect(kindOf(bare("edit", "Edited a.ts", { kind: "write", path: "a.ts" }))).toBe("edit");
    expect(kindOf(bare("other", "Read a.ts"))).toBe("read");
    expect(kindOf(bare("question", "Ask"))).toBe("question");
  });
});

describe("humanName", () => {
  it("names the app tools in plain words and title-cases the rest", () => {
    expect(humanName("mcp__app__app_start_thread")).toBe("Create Thread");
    expect(humanName("mcp__orchestrator__spawn_agent")).toBe("Spawn Agent");
    expect(humanName("AskUserQuestion")).toBe("Ask User");
    expect(humanName("mcp__linear__save_document")).toBe("Save Document");
    expect(humanName("ExitPlanMode")).toBe("Exit Plan Mode");
    expect(humanName("someCamelTool")).toBe("Some Camel Tool");
  });
});

describe("toolPhrase", () => {
  it("reads, writes, edits and patches name the file by its basename", () => {
    expect(toolPhrase(call("Read", { file_path: `${CWD}/src/lib/paths.ts` }), CWD)).toBe(
      "Read paths.ts",
    );
    expect(toolPhrase(call("Write", { file_path: `${CWD}/a.ts` }), CWD)).toBe("Created a.ts");
    expect(toolPhrase(call("Edit", { file_path: `${CWD}/a.ts` }), CWD, true)).toBe(
      "Editing a.ts",
    );
    expect(
      toolPhrase(
        call("apply_patch", "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** End Patch"),
        CWD,
      ),
    ).toBe("Edited 2 files");
    expect(toolPhrase(call("apply_patch", { patch: "*** Update File: src/a.ts\n" }), CWD)).toBe(
      "Edited a.ts",
    );
  });

  it("searches show the query, globs too", () => {
    expect(toolPhrase(call("Grep", { pattern: "toolCallLabel", path: CWD }), CWD)).toBe(
      "Searched for toolCallLabel",
    );
    expect(toolPhrase(call("Glob", { pattern: "**/*.test.ts" }), CWD, true)).toBe(
      "Searching for **/*.test.ts",
    );
    expect(toolPhrase(call("Grep", {}), CWD)).toBe("Searched the project");
    expect(toolPhrase(call("Grep", { pattern: "x".repeat(50) }), CWD)).toBe(
      `Searched for ${"x".repeat(31)}…`,
    );
  });

  it("commands read as their gist, the harness description first", () => {
    expect(toolPhrase(call("Bash", { command: "npm test", description: "Run the tests" }))).toBe(
      "Ran the tests",
    );
    expect(toolPhrase(call("Bash", { command: "npm test" }))).toBe("Ran the tests");
    expect(toolPhrase(call("Bash", { command: "git status -s" }))).toBe("Checked git status");
    expect(toolPhrase(call("Bash", { command: "git status" }), undefined, true)).toBe(
      "Checking git status",
    );
    expect(toolPhrase(call("Bash", { command: `cat ${CWD}/src/a.ts` }), CWD)).toBe(
      "Read src/a.ts",
    );
    expect(toolPhrase(call("Bash", { command: "cd /x && rg -n foo src | head" }))).toBe(
      "Searched for foo",
    );
    expect(toolPhrase(call("Bash", { command: "ls src && wc -l a.ts && git log" }))).toBe(
      "Listed src, counted lines in a.ts and 1 more",
    );
    expect(toolPhrase(call("shell", { command: ["/bin/zsh", "-lc", "bun run build"] }))).toBe(
      "Ran a command",
    );
    expect(toolPhrase(call("Bash", { command: "osascript -e 'tell app'" }))).toBe(
      "Ran a command",
    );
    expect(toolPhrase(call("Bash", { command: "" }))).toBe("Ran a command");
  });

  it("a shell title the fold already rewrote keeps its sense", () => {
    const b: Block = {
      id: "a",
      role: "tool",
      text: "Read src/lib/appearance.ts",
      tool: { kind: "execute", title: "Read src/lib/appearance.ts", status: "completed" },
    };
    expect(toolPhrase(b)).toBe("Read src/lib/appearance.ts");
    expect(toolPhrase({ ...b, text: "Find tokens", tool: { ...b.tool, title: "Find tokens" } })).toBe(
      "Searched for tokens",
    );
  });

  it("fetch, web, todo, list, question and skill", () => {
    expect(toolPhrase(call("WebFetch", { url: "https://docs.rs/x/y" }))).toBe("Fetched docs.rs");
    expect(toolPhrase(call("WebFetch", { url: "nope" }))).toBe("Fetched a page");
    expect(toolPhrase(call("WebSearch", { query: "tauri updater" }))).toBe(
      "Searched the web for tauri updater",
    );
    expect(toolPhrase(call("TodoWrite", { todos: [] }), undefined, true)).toBe("Updating todos");
    expect(toolPhrase(call("LS", { path: `${CWD}/src` }), CWD)).toBe("Listed src");
    expect(toolPhrase(call("AskUserQuestion", { questions: [] }))).toBe("Asked a question");
    expect(toolPhrase(call("Skill", { skill: "code-review" }))).toBe("Used skill code-review");
  });

  it("app, agent and MCP tools read as Used <Name>, nothing else", () => {
    expect(
      toolPhrase(call("mcp__app__app_start_thread", { threadType: "planning", provider: "claude", model: "claude-opus-5" })),
    ).toBe("Used Create Thread");
    expect(toolPhrase(call("mcp__orchestrator__spawn_agent", { task: "x", model: "gpt" }), undefined, true)).toBe(
      "Using Spawn Agent",
    );
    expect(toolPhrase(call("mcp__orchestrator__wait_for_agent", {}))).toBe("Used Wait For Agent");
    expect(toolPhrase(call("mcp__linear__save_document", {}))).toBe("Used Save Document");
    expect(toolPhrase(call("Task", { prompt: "explore" }))).toBe("Used Agent");
  });

  it("says nothing for a call it knows nothing about", () => {
    expect(
      toolPhrase({ id: "x", role: "tool", text: "Working", tool: { kind: "other", title: "Working" } }),
    ).toBe("");
  });

  it("takes the tense from the block when not told", () => {
    expect(toolPhrase(call("Read", { file_path: "a.ts" }, { streaming: true }))).toBe("Reading a.ts");
    expect(toolPhrase(call("Read", { file_path: "a.ts" }, { status: "running" }))).toBe("Reading a.ts");
    expect(
      toolPhrase({ ...call("Bash", { command: "npm test" }), approval: { requestId: 1 } }),
    ).toBe("Running the tests");
  });

  it("a refused call never ran, so it keeps the plain verb", () => {
    const deny = { requestId: 1, decided: "deny" as const };
    expect(
      toolPhrase({ ...call("Bash", { command: "touch x.txt", description: "Create empty file x.txt" }, { status: "failed" }), approval: deny }),
    ).toBe("Create empty file x.txt");
    expect(toolPhrase({ ...call("Bash", { command: "npm test" }, { status: "failed" }), approval: deny })).toBe("Run the tests");
    expect(toolPhrase({ ...call("Write", { file_path: "notes.txt", content: "hi" }, { status: "failed" }), approval: deny })).toBe("Create notes.txt");
    expect(toolPhrase({ ...call("Edit", { file_path: "a.ts" }, { status: "failed" }), approval: deny })).toBe("Edit a.ts");
    // Allowed, it ran: the settled verb.
    expect(
      toolPhrase({ ...call("Bash", { command: "touch x.txt", description: "Create empty file x.txt" }), approval: { requestId: 1, decided: "allow" } }),
    ).toBe("Created empty file x.txt");
  });
});

describe("toolPhraseParts", () => {
  const parts = (b: Block, live = false) => toolPhraseParts(b, CWD, live);
  const file = `${CWD}/src/lib/a.ts`;

  it("splits every kind into verb and object, settled and live", () => {
    const cases: [Block, string, string, string][] = [
      [call("Bash", { command: "npm test" }), "Ran", "Running", "the tests"],
      [call("Read", { file_path: file }), "Read", "Reading", "a.ts"],
      [call("Write", { file_path: file }), "Created", "Creating", "a.ts"],
      [call("Edit", { file_path: file }), "Edited", "Editing", "a.ts"],
      [call("apply_patch", "*** Update File: src/a.ts\n"), "Edited", "Editing", "a.ts"],
      [call("apply_patch", "*** Update File: a.ts\n*** Add File: b.ts\n"), "Edited", "Editing", "2 files"],
      [call("Grep", { pattern: "needle" }), "Searched for", "Searching for", "needle"],
      [call("Glob", { pattern: "*.ts" }), "Searched for", "Searching for", "*.ts"],
      [call("LS", { path: `${CWD}/src` }), "Listed", "Listing", "src"],
      [call("WebFetch", { url: "https://docs.rs/x" }), "Fetched", "Fetching", "docs.rs"],
      [call("WebSearch", { query: "tauri" }), "Searched the web for", "Searching the web for", "tauri"],
      [call("TodoWrite", { todos: [] }), "Updated todos", "Updating todos", ""],
      [call("AskUserQuestion", {}), "Asked", "Asking", "a question"],
      [call("Skill", { skill: "code-review" }), "Used skill", "Using skill", "code-review"],
      [call("mcp__linear__save_document", {}), "Used", "Using", "Save Document"],
      [call("Whatever", {}), "Used", "Using", "Whatever"],
    ];
    for (const [block, settled, live, object] of cases) {
      expect(parts(block)).toMatchObject({ verb: settled, object });
      expect(parts(block, true)).toMatchObject({ verb: live, object });
    }
  });

  it("a delete says Deleted", () => {
    const b: Block = {
      id: "d",
      role: "tool",
      text: "Deleted gone.ts",
      tool: { kind: "delete", title: "Deleted gone.ts", status: "completed", preview: { kind: "write", path: `${CWD}/gone.ts` } },
    };
    expect(parts(b)).toMatchObject({ verb: "Deleted", object: "gone.ts" });
    expect(parts(b, true).verb).toBe("Deleting");
  });

  it("a Write over a file that was there is an edit", () => {
    const b = call("Write", { file_path: file }, { detail: "The file /repo/src/lib/a.ts has been updated." });
    expect(parts(b)).toMatchObject({ verb: "Edited", object: "a.ts" });
  });

  it("codex's change array names the file and what happened to it", () => {
    const change = (path: string, type: string) => ({ path, kind: { type }, diff: "" });
    expect(parts(call("apply_patch", [change(`${CWD}/src/a.ts`, "update")]))).toMatchObject({ verb: "Edited", object: "a.ts" });
    expect(parts(call("apply_patch", [change(`${CWD}/new.ts`, "add")]))).toMatchObject({ verb: "Created", object: "new.ts" });
    expect(parts(call("apply_patch", [change(`${CWD}/old.ts`, "delete")]), true)).toMatchObject({ verb: "Deleting", object: "old.ts" });
    expect(parts(call("apply_patch", [change("a.ts", "update"), change("b.ts", "add")]))).toMatchObject({ verb: "Edited", object: "2 files" });
    expect(parts(call("apply_patch", { input: "*** Add File: src/n.ts\n+x\n" }))).toMatchObject({ verb: "Created", object: "n.ts" });
  });

  it("a file's title is its shown path", () => {
    expect(parts(call("Read", { file_path: file })).title).toBe("src/lib/a.ts");
  });

  it("splits a run phrase on its first word", () => {
    expect(parts(call("Bash", { command: "npx convex dev --once" }))).toEqual({ verb: "Ran", object: "convex dev" });
    expect(parts(call("Bash", { command: "npx vitest run src" }))).toEqual({ verb: "Ran", object: "the tests" });
    expect(parts(call("Bash", { command: "npm i" }))).toEqual({ verb: "Installed", object: "dependencies" });
    expect(parts(call("Bash", { command: "" }))).toEqual({ verb: "Ran", object: "a command" });
    expect(parts(call("Bash", { command: "git status && git diff" }))).toEqual({
      verb: "Checked",
      object: "git status, viewed the diff",
    });
  });

  it("a run whose words would only repeat the command says a command", () => {
    expect(parts(call("Bash", { command: "bun run typecheck" }))).toEqual({ verb: "Ran", object: "a command" });
    expect(parts(call("Bash", { command: "osascript -e 'x'" }))).toEqual({ verb: "Ran", object: "a command" });
    expect(parts(call("Bash", { command: "npm test" }))).toEqual({ verb: "Ran", object: "the tests" });
    expect(parts(call("Bash", { command: "git status" }))).toEqual({ verb: "Checked", object: "git status" });
  });

  it("more clauses than two read as and N more, never a plus", () => {
    expect(toolPhrase(call("Bash", { command: "ls src && wc -l a.ts && git log && git diff" }), CWD, false)).toBe(
      "Listed src, counted lines in a.ts and 2 more",
    );
  });

  it("toolPhrase is the parts joined, and never carries a middle dot", () => {
    const blocks = [
      call("Bash", { command: "ls src && wc -l a.ts && git log && git diff" }),
      call("Read", { file_path: file }),
      call("TodoWrite", {}),
      call("mcp__app__app_start_thread", {}),
    ];
    for (const b of blocks) {
      const { verb, object } = parts(b);
      expect(toolPhrase(b, CWD, false)).toBe([verb, object].filter(Boolean).join(" "));
      expect(toolPhrase(b, CWD, false)).not.toContain(" · ");
    }
  });
});

describe("commandPhrases", () => {
  it("unwraps the shell and skips pipe noise", () => {
    expect(commandPhrases(`/bin/zsh -lc 'cd /x && git diff | cat'`)).toEqual(["view the diff"]);
    expect(commandPhrases("FOO=1 env npm run check:web")).toEqual(["run a command"]);
    expect(commandPhrases("echo hi > out.txt")).toEqual(["write out.txt"]);
    expect(commandPhrases("npx convex dev --once 2>&1 | tail -20 && git commit -m x")).toEqual(["run convex dev", "commit"]);
    expect(commandPhrases("npm test &> log.txt")).toEqual(["run the tests"]);
  });
});

describe("runClauses", () => {
  it("is one clause per command segment, the first capitalized; the row joins two", () => {
    const run = call("Bash", { command: "git status && npm test" });
    expect(runClauses(run)).toEqual(["Checked git status", "ran the tests"]);
    expect(toolPhrase(run)).toBe("Checked git status, ran the tests");
  });

  it("is one clause for a description or a folded title, and none for nothing", () => {
    expect(runClauses(call("Bash", { command: "make", description: "Run the build, then sign" }))).toEqual(["Ran the build, then sign"]);
    expect(runClauses({ id: "f", role: "tool", text: "Find tokens", tool: { kind: "execute", title: "Find tokens" } })).toEqual([
      "Searched for tokens",
    ]);
    expect(runClauses(call("Bash", { command: "" }))).toEqual([]);
  });
});
