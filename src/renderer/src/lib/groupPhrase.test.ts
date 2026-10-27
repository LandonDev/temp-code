import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { commonDir, editVerbOf, groupPhrase } from "./groupPhrase";

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

const read = (p: string, id = p) => call("Read", { file_path: `${CWD}/${p}` }, { id });
const edit = (p: string, id = `e:${p}`) =>
  call("Edit", { file_path: `${CWD}/${p}`, old_string: "a", new_string: "b" }, { id });
const write = (p: string, extra: Partial<NonNullable<Block["tool"]>> = {}) =>
  call("Write", { file_path: `${CWD}/${p}`, content: "x" }, { id: `w:${p}`, ...extra });
const bash = (command: string, id = command) => call("Bash", { command }, { id });
const grep = (pattern: string) => call("Grep", { pattern }, { id: `g:${pattern}` });

describe("groupPhrase", () => {
  it("joins phrases with commas, the first capitalized, the rest lowercase", () => {
    expect(groupPhrase([write("src/diag.ts"), bash("make")], CWD)).toBe("Created diag.ts, ran make");
    expect(
      groupPhrase([read("src/lib/a.ts"), read("src/lib/b.ts"), read("src/lib/c.ts"), edit("src/types.ts")], CWD),
    ).toBe("Read 3 files in src/lib, edited types.ts");
  });

  it("says three phrases, then how many more", () => {
    expect(
      groupPhrase([read("a.ts"), edit("b.ts"), grep("token"), call("mcp__app__app_start_thread", {})], CWD),
    ).toBe("Read a.ts, edited b.ts, searched for token and 1 more");
  });

  it("speaks in the present tense while live", () => {
    expect(groupPhrase([write("src/diag.ts"), bash("npm test")], CWD, true)).toBe(
      "Creating diag.ts, running the tests",
    );
  });

  it("says a repeated phrase once", () => {
    expect(groupPhrase([read("a.ts"), bash("npm test", "t1"), read("a.ts", "again"), bash("npm test", "t2")], CWD)).toBe(
      "Read a.ts, ran the tests",
    );
  });

  it("folds reads by folder or project, by basename for one", () => {
    expect(groupPhrase([read("src/lib/a.ts"), read("README.md")], CWD)).toBe("Read monocode files");
    expect(groupPhrase([read("src/a.ts"), read("src/a.ts", "again")], CWD)).toBe("Read a.ts");
    expect(groupPhrase([read("a.ts"), call("Read", { file_path: "/etc/hosts" })], CWD)).toBe("Read 2 files");
  });

  it("folds edits per verb: created, edited, deleted", () => {
    expect(groupPhrase([edit("a.ts"), edit("b.ts"), edit("c.ts")], CWD)).toBe("Edited 3 files");
    expect(groupPhrase([write("a.ts"), edit("b.ts")], CWD)).toBe("Created a.ts, edited b.ts");
    const remove = call("Delete", {}, { id: "d", kind: "delete", preview: { kind: "write", path: `${CWD}/old.ts` } });
    expect(groupPhrase([remove], CWD)).toBe("Deleted old.ts");
  });

  it("counts a stretch of commands or searches", () => {
    expect(groupPhrase([bash("ls"), bash("pwd"), bash("whoami")], CWD)).toBe("Ran 3 commands");
    expect(groupPhrase([grep("a"), grep("b")], CWD)).toBe("Ran 2 searches");
  });

  it("never prints a failure count or a separator dot", () => {
    const failed = call("Bash", { command: "npm test" }, { status: "failed" });
    expect(groupPhrase([failed], CWD)).toBe("Ran the tests");
    expect(groupPhrase([bash("git status && npm test && bun run build")], CWD)).not.toMatch(/·|\+\d/);
  });

  it("ignores non-tool blocks and falls back for a call it cannot name", () => {
    expect(groupPhrase([{ id: "p", role: "assistant", text: "hi" }])).toBe("");
    expect(
      groupPhrase([{ id: "x", role: "tool", text: "Working", tool: { kind: "other", title: "Working" } }]),
    ).toBe("Ran 1 tool");
  });
});

describe("editVerbOf", () => {
  it("is create only for a file that did not exist before", () => {
    expect(editVerbOf(write("a.ts"))).toBe("create");
    expect(editVerbOf(write("a.ts", { detail: "The file /x/a.ts has been updated successfully." }))).toBe("edit");
    expect(editVerbOf(edit("a.ts"))).toBe("edit");
  });
});

describe("commonDir", () => {
  it("is the shared folder, empty at the root", () => {
    expect(commonDir(["src/lib/a.ts", "src/lib/b/c.ts"])).toBe("src/lib");
    expect(commonDir(["a.ts", "src/b.ts"])).toBe("");
  });
});
