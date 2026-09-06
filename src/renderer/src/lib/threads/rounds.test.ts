import { describe, expect, it } from "vitest";
import type { Block } from "../session";
import { actKind, activeMs, changeStat, diffLines, diskBlock, groupByTodo, wholeChange } from "./rounds";

const edit = (id: string, path: string, adds: number, lines: string[], ts: number): Block => ({
  id,
  role: "tool",
  text: `Edit ${path}`,
  ts,
  doneTs: ts + 10,
  tool: {
    callId: id,
    name: "Edit",
    kind: "edit",
    status: "completed",
    preview: { kind: "write", path, additions: adds, deletions: 0, lines: lines.map((text) => ({ kind: "add" as const, text })) },
  },
});

describe("rounds", () => {
  it("activeMs counts tool runs and skips the gap before a user message", () => {
    const blocks: Block[] = [
      { id: "u1", role: "user", text: "go", ts: 0 },
      { id: "t1", role: "tool", text: "Read", ts: 100, doneTs: 400 },
      { id: "a1", role: "assistant", text: "ok", ts: 500 },
      { id: "u2", role: "user", text: "more", ts: 10_000 },
      { id: "a2", role: "assistant", text: "done", ts: 10_200 },
    ];
    expect(activeMs(blocks)).toBe(100 + 100 + 200);
    expect(activeMs(blocks, 10_500)).toBe(700);
  });

  it("groups by todo with clamping", () => {
    const blocks: Block[] = [
      { id: "a", role: "tool", text: "", todo: -1 },
      { id: "b", role: "tool", text: "", todo: 0 },
      { id: "c", role: "tool", text: "", todo: 5 },
      { id: "d", role: "tool", text: "" },
    ];
    const g = groupByTodo(blocks, 2);
    expect([...g.keys()]).toEqual([-1, 0, 1]);
    expect(g.get(1)?.map((b) => b.id)).toEqual(["c"]);
    expect(g.get(-1)?.map((b) => b.id)).toEqual(["a", "d"]);
    expect([...groupByTodo(blocks, 0).keys()]).toEqual([-1]);
  });

  it("classifies activity by tool kind and name", () => {
    const t = (name: string, kind?: string): Block => ({ id: name, role: "tool", text: "", tool: { name, kind } });
    expect(actKind(t("Edit", "edit"))).toBe("edit");
    expect(actKind(t("Read", "read"))).toBe("read");
    expect(actKind(t("Grep", "search"))).toBe("search");
    expect(actKind(t("Bash", "execute"))).toBe("command");
    expect(actKind(t("mcp__orchestrator__spawn_agent", "other"))).toBe("subagent");
    expect(actKind(t("WebFetch", "other"))).toBe("web");
    expect(actKind(t("TaskCreate", "TaskCreate"))).toBe("tool");
  });

  it("fuses several edits to one file into one card", () => {
    const a = edit("e1", "/repo/a.ts", 1, ["x"], 100);
    const b = edit("e2", "/repo/a.ts", 2, ["y", "z"], 200);
    expect(wholeChange("/repo/a.ts", [a])).toBe(a);
    const merged = wholeChange("/repo/a.ts", [a, b]);
    expect(merged.tool?.preview).toMatchObject({ path: "/repo/a.ts", additions: 3, deletions: 0 });
    expect(merged.tool?.preview?.lines?.map((l) => l.text)).toEqual(["x", "y", "z"]);
    expect(merged.ts).toBe(100);
    expect(merged.doneTs).toBe(210);
    expect(changeStat([a, b])).toEqual({ adds: 3, dels: 0 });
  });

  it("turns a live edit into an edit block with parsed diff lines", () => {
    const b = diskBlock({
      path: "src/x.ts",
      kind: "changed",
      adds: 1,
      dels: 1,
      diff: "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n",
      state: "settled",
      startedTs: 5,
      ts: 9,
    });
    expect(b.tool?.kind).toBe("edit");
    expect(b.tool?.preview?.lines).toEqual([
      { number: 1, kind: "del", text: "old" },
      { number: 1, kind: "add", text: "new" },
      { number: 2, kind: "context", text: "same" },
    ]);
    expect(diffLines("")).toEqual([]);
  });
});
