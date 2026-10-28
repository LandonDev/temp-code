import { describe, expect, it } from "vitest";
import type { Block } from "../../lib/session";
import type { ToolKind } from "../../lib/toolPhrase";
import { actionOf } from "./actionModel";
import { GLYPH } from "./ToolGlyph";

const CWD = "/repo";

function call(
  name: string,
  input: unknown,
  extra: Partial<NonNullable<Block["tool"]>> & Partial<Pick<Block, "approval" | "streaming">> = {},
): Block {
  const { approval, streaming, ...tool } = extra;
  return {
    id: name,
    role: "tool",
    text: name,
    streaming: streaming ?? false,
    ...(approval ? { approval } : {}),
    tool: { callId: name, title: name, status: "completed", name, input, ...tool },
  };
}

describe("actionOf", () => {
  it("an edit counts its lines and opens onto its diff", () => {
    const a = actionOf(call("Edit", { file_path: "/repo/src/a.ts", old_string: "x", new_string: "y\nz" }), CWD);
    expect(a).toMatchObject({ glyph: "edit", verb: "Edited", object: "a.ts", title: "src/a.ts", adds: 2, dels: 1, opens: "diff" });
    expect(a.path).toBe("/repo/src/a.ts");
  });

  it("an edit opens at its preview's first line", () => {
    const a = actionOf(
      call("Edit", { file_path: "/repo/a.ts" }, { preview: { kind: "write", path: "/repo/a.ts", startLine: 41 } }),
      CWD,
    );
    expect(a.line).toBe(41);
  });

  it("a write is a create", () => {
    const a = actionOf(call("Write", { file_path: "/repo/diag.ts", content: "a\nb\nc" }), CWD);
    expect(a).toMatchObject({ glyph: "write", verb: "Created", object: "diag.ts", adds: 3, dels: 0, opens: "diff" });
  });

  it("a created file ending in a newline counts its three lines", () => {
    const a = actionOf(call("Write", { file_path: "/repo/diag.ts", content: "a\nb\nc\n" }), CWD);
    expect(a).toMatchObject({ verb: "Created", adds: 3, dels: 0 });
  });

  it("a delete leads with the trash glyph", () => {
    const b: Block = {
      id: "d",
      role: "tool",
      text: "Deleted gone.ts",
      tool: { kind: "delete", title: "Deleted gone.ts", status: "completed", preview: { kind: "write", path: "/repo/gone.ts" } },
    };
    expect(actionOf(b, CWD)).toMatchObject({ glyph: "delete", verb: "Deleted", object: "gone.ts", opens: "diff" });
  });

  it("a read opens the file at the line it started from, with no body", () => {
    const a = actionOf(call("Read", { file_path: "/repo/src/types.ts", offset: 120, limit: 40 }), CWD);
    expect(a).toMatchObject({ glyph: "read", verb: "Read", object: "types.ts", opens: "file", path: "/repo/src/types.ts", line: 120 });
    expect(actionOf(call("Read", { file_path: "/repo/a.ts" }), CWD).line).toBeUndefined();
  });

  it("a failed or waiting read opens its details, so the error or the ask is there", () => {
    expect(actionOf(call("Read", { file_path: "/repo/a.ts" }, { status: "failed", detail: "ENOENT" }), CWD).opens).toBe("details");
    expect(
      actionOf(call("Read", { file_path: "/repo/a.ts" }, { status: "pending", approval: { requestId: 1 } }), CWD).opens,
    ).toBe("details");
  });

  it("a read with no path has nothing to open but its details", () => {
    expect(actionOf(call("Read", {}), CWD).opens).toBe("details");
  });

  it("a run opens onto its command card", () => {
    expect(actionOf(call("Bash", { command: "npm test" }), CWD)).toMatchObject({
      glyph: "run",
      verb: "Ran",
      object: "the tests",
      opens: "command",
      failed: false,
      running: false,
    });
  });

  it("a search opens onto its details", () => {
    expect(actionOf(call("Grep", { pattern: "needle" }), CWD)).toMatchObject({
      glyph: "search",
      verb: "Searched for",
      object: "needle",
      opens: "details",
    });
  });

  it("a connector call says the product and the action, with its mark", () => {
    const a = actionOf(
      call("mcp__linear__save_issue", {}, { display: { app: "linear", action: "Saved issue ENG-12" } }),
      CWD,
    );
    expect(a).toMatchObject({ connector: "linear", verb: "Linear", object: "Saved issue ENG-12", opens: "details" });
    expect(actionOf(call("mcp__notion__search", {}), CWD).connector).toBe("notion");
    expect(actionOf(call("mcp__app__app_list_threads", {}), CWD).connector).toBeUndefined();
  });

  it("an app call naming a thread links to it", () => {
    const view = { label: "Read thread", detail: "Auth rewrite", phrase: "read thread", threadId: "t1" };
    const a = actionOf(call("mcp__app__app_read_thread", { threadId: "t1" }), CWD, view);
    expect(a).toMatchObject({ glyph: "app", verb: "Read thread", object: "Auth rewrite", threadId: "t1", opens: "details" });
  });

  it("a subagent call is marked so its provider leads", () => {
    expect(actionOf(call("mcp__orchestrator__spawn_agent", { task: "x" }), CWD).agent).toBe(true);
    expect(actionOf(call("Bash", { command: "ls" }), CWD).agent).toBe(false);
  });

  it("a running call says its verb in the live tense", () => {
    const a = actionOf(call("Bash", { command: "npm test" }, { status: "running" }), CWD);
    expect(a).toMatchObject({ running: true, failed: false, verb: "Running" });
  });

  it("a failed or denied call is failed", () => {
    expect(actionOf(call("Bash", { command: "npm test" }, { status: "failed" }), CWD).failed).toBe(true);
    expect(
      actionOf(call("Bash", { command: "npm test" }, { approval: { requestId: 1, decided: "deny" } }), CWD).failed,
    ).toBe(true);
  });

  it("a call waiting on approval keeps the body it opens onto", () => {
    const a = actionOf(call("Bash", { command: "npm test" }, { status: "pending", approval: { requestId: 1 } }), CWD);
    expect(a).toMatchObject({ pending: true, running: false, opens: "command", verb: "Running" });
    const edit = actionOf(
      call("Edit", { file_path: "/repo/a.ts", old_string: "a", new_string: "b" }, { approval: { requestId: 2 } }),
      CWD,
    );
    expect(edit).toMatchObject({ pending: true, opens: "diff", verb: "Editing" });
  });
});

describe("GLYPH", () => {
  it("has an icon for every kind", () => {
    const kinds: ToolKind[] = [
      "run", "read", "write", "edit", "patch", "search", "glob", "fetch",
      "web", "todo", "list", "question", "skill", "mcp", "tool",
    ];
    for (const k of kinds) expect(GLYPH[k]).toBeTruthy();
    expect(GLYPH.delete).toBeTruthy();
    expect(GLYPH.app).toBeTruthy();
  });
});
