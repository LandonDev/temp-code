import { describe, expect, it } from "vitest";
import type { Block, ToolPreview } from "./session";
import { commandPhrases, groupPhrase, humanName, kindOf, toolPhrase } from "./toolPhrase";

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
  it("reads, writes, edits and patches name the file relative to the cwd", () => {
    expect(toolPhrase(call("Read", { file_path: `${CWD}/src/lib/paths.ts` }), CWD)).toBe(
      "Read src/lib/paths.ts",
    );
    expect(toolPhrase(call("Write", { file_path: `${CWD}/a.ts` }), CWD)).toBe("Wrote a.ts");
    expect(toolPhrase(call("Edit", { file_path: `${CWD}/a.ts` }), CWD, true)).toBe(
      "Editing a.ts",
    );
    expect(
      toolPhrase(
        call("apply_patch", "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** End Patch"),
        CWD,
      ),
    ).toBe("Patched 2 files");
    expect(toolPhrase(call("apply_patch", { patch: "*** Update File: src/a.ts\n" }), CWD)).toBe(
      "Patched src/a.ts",
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
      "Listed src · counted lines in a.ts +1 more",
    );
    expect(toolPhrase(call("shell", { command: ["/bin/zsh", "-lc", "bun run build"] }))).toBe(
      "Ran bun run build",
    );
    expect(toolPhrase(call("Bash", { command: "osascript -e 'tell app'" }))).toBe(
      "Ran osascript",
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
    expect(toolPhrase(call("Skill", { skill: "code-review" }))).toBe("Used Skill code-review");
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
});

describe("commandPhrases", () => {
  it("unwraps the shell and skips pipe noise", () => {
    expect(commandPhrases(`/bin/zsh -lc 'cd /x && git diff | cat'`)).toEqual(["view the diff"]);
    expect(commandPhrases("FOO=1 env npm run check:web")).toEqual(["run npm run check:web"]);
    expect(commandPhrases("echo hi > out.txt")).toEqual(["write out.txt"]);
  });
});

describe("groupPhrase", () => {
  const read = (p: string, id = p) => call("Read", { file_path: `${CWD}/${p}` }, { id });

  it("folds consecutive reads into one line by folder or project", () => {
    expect(groupPhrase([read("src/lib/a.ts"), read("src/lib/b.ts"), read("src/lib/c.ts")], CWD)).toBe(
      "Read 3 files in src/lib",
    );
    expect(groupPhrase([read("src/lib/a.ts"), read("README.md")], CWD)).toBe("Read monocode files");
    expect(groupPhrase([read("src/a.ts")], CWD)).toBe("Read src/a.ts");
    expect(groupPhrase([read("src/a.ts"), read("src/a.ts", "again")], CWD)).toBe("Read src/a.ts");
    expect(groupPhrase([read("a.ts"), call("Read", { file_path: "/etc/hosts" })], CWD)).toBe(
      "Read 2 files",
    );
  });

  it("keeps the first two distinct things and counts the rest", () => {
    const blocks = [
      read("src/lib/a.ts"),
      read("src/lib/b.ts"),
      call("Grep", { pattern: "toolCallLabel" }),
      call("Bash", { command: "npm test" }),
      call("mcp__app__app_start_thread", {}),
    ];
    expect(groupPhrase(blocks, CWD)).toBe(
      "Read 2 files in src/lib · Searched for toolCallLabel +2 more",
    );
  });

  it("collapses edits, splits runs of reads around them, and marks failures", () => {
    const edit = (p: string) => call("Edit", { file_path: `${CWD}/${p}` }, { id: `e:${p}` });
    expect(groupPhrase([edit("a.ts"), edit("b.ts")], CWD)).toBe("Edited 2 files");
    expect(groupPhrase([read("a.ts"), edit("a.ts"), read("b.ts")], CWD)).toBe(
      "Read a.ts · Edited a.ts +1 more",
    );
    expect(
      groupPhrase([call("Bash", { command: "npm test" }, { status: "failed" })], CWD),
    ).toBe("Ran the tests · 1 failed");
  });

  it("speaks in the present while any call is still running", () => {
    expect(groupPhrase([read("a.ts"), read("b.ts", "b")], CWD, true)).toBe("Reading monocode files");
    expect(groupPhrase([call("Grep", { pattern: "x" }, { streaming: true })], CWD)).toBe(
      "Searching for x",
    );
  });

  it("ignores non-tool blocks and says Working for nothing", () => {
    expect(groupPhrase([{ id: "p", role: "assistant", text: "hi" }])).toBe("");
    expect(
      groupPhrase([{ id: "x", role: "tool", text: "Working", tool: { kind: "other", title: "Working" } }]),
    ).toBe("Ran 1 tool");
  });
});
