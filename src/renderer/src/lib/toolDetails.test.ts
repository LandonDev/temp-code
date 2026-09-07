import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import {
  invocationBody,
  isSettled,
  kvDisplay,
  outputLines,
  parseJson,
  rawInput,
  stripAnsi,
  stripShell,
  todoItems,
  toolOutput,
} from "./toolDetails";

const tool = (name: string, input: unknown, extra: Partial<NonNullable<Block["tool"]>> = {}): Block => ({
  id: "b1",
  role: "tool",
  text: name,
  tool: { callId: "c1", name, input, ...extra },
});

describe("stripShell", () => {
  it("drops a sh -lc wrapper and its quotes", () => {
    expect(stripShell("/bin/zsh -lc 'git status'")).toBe("git status");
    expect(stripShell('bash -c "ls -la"')).toBe("ls -la");
  });
  it("leaves a bare command alone", () => {
    expect(stripShell("  bun test  ")).toBe("bun test");
  });
});

describe("invocationBody", () => {
  it("shows the unwrapped command for a shell call", () => {
    expect(invocationBody(tool("Bash", { command: "sh -lc 'git log'" }))).toBe("git log");
    expect(invocationBody(tool("shell", { command: ["git", "log"] }))).toBe("git log");
  });
  it("shows pattern and path for a search", () => {
    expect(invocationBody(tool("Grep", { pattern: "foo", path: "src" }))).toBe("foo in src");
  });
  it("shows the url, query or path for the rest", () => {
    expect(invocationBody(tool("WebFetch", { url: "https://x.y" }))).toBe("https://x.y");
    expect(invocationBody(tool("WebSearch", { query: "q" }))).toBe("q");
    expect(invocationBody(tool("Read", { file_path: "/a/b.ts" }))).toBe("/a/b.ts");
  });
});

describe("rawInput", () => {
  it("is the command for a shell call and JSON otherwise", () => {
    expect(rawInput(tool("Bash", { command: "ls" }))).toBe("ls");
    expect(rawInput(tool("Read", { file_path: "x" }))).toBe('{\n  "file_path": "x"\n}');
    expect(rawInput(tool("apply_patch", "*** Begin Patch"))).toBe("*** Begin Patch");
    expect(rawInput(tool("Read", undefined))).toBe("");
  });
});

describe("parseJson", () => {
  it("parses objects and arrays only", () => {
    expect(parseJson(' {"a":1} ')).toEqual({ a: 1 });
    expect(parseJson("[1]")).toEqual([1]);
    expect(parseJson("42")).toBeUndefined();
    expect(parseJson("{bad")).toBeUndefined();
  });
});

describe("kvDisplay", () => {
  const titleOf = (id: string) => (id === "t1" ? "Auth rewrite" : undefined);
  it("resolves thread and session ids to titles", () => {
    expect(kvDisplay("threadId", "t1", titleOf)).toBe("Auth rewrite");
    expect(kvDisplay("sessionId", "nope", titleOf)).toBe("nope");
    expect(kvDisplay("count", 3, titleOf)).toBe("3");
    expect(kvDisplay("x", null, titleOf)).toBe("—");
    expect(kvDisplay("o", { a: 1 }, titleOf)).toBe('{"a":1}');
  });
});

describe("toolOutput", () => {
  it("hides output until the call settles", () => {
    const running = tool("Bash", { command: "ls" }, { status: "running", detail: "partial" });
    expect(isSettled(running)).toBe(false);
    expect(toolOutput(running)).toBeUndefined();
    const streaming = tool("Bash", { command: "ls" }, { status: "completed", detail: "x" });
    streaming.streaming = true;
    expect(toolOutput(streaming)).toBeUndefined();
  });
  it("shows output once completed, flagged on failure", () => {
    expect(toolOutput(tool("Bash", {}, { status: "completed", detail: "ok" }))).toEqual({
      text: "ok",
      error: false,
    });
    expect(toolOutput(tool("Bash", {}, { status: "failed", detail: "boom" }))).toEqual({
      text: "boom",
      error: true,
    });
    expect(toolOutput(tool("Bash", {}, { status: "failed" }))).toEqual({ text: "", error: true });
  });
  it("gives nothing for an empty success", () => {
    expect(toolOutput(tool("Bash", {}, { status: "completed" }))).toBeUndefined();
  });
});

describe("outputLines", () => {
  it("strips ANSI, trims trailing newlines and caps at 24 lines", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
    const text = Array.from({ length: 30 }, (_, n) => `l${n}`).join("\n") + "\n\n";
    const { shown, more } = outputLines(text);
    expect(shown).toHaveLength(24);
    expect(shown[0]).toBe("l0");
    expect(more).toBe(6);
  });
});

describe("todoItems", () => {
  it("reads todos or plan steps", () => {
    expect(
      todoItems(tool("TodoWrite", { todos: [{ content: "a", status: "completed" }, { step: "b" }] })),
    ).toEqual([
      { text: "a", status: "completed" },
      { text: "b", status: "" },
    ]);
    expect(todoItems(tool("TodoWrite", {}))).toEqual([]);
  });
});
