import { describe, expect, it } from "vitest";
import type { Block } from "../lib/session";
import { estimateRowHeight, flattenTurns } from "./transcriptRows";

const user = (id: string, text = "prompt", extra: Partial<Block> = {}): Block => ({ id, role: "user", text, ...extra });
const tool = (id: string): Block => ({
  id,
  role: "tool",
  text: `Read ${id}`,
  tool: { callId: id, name: "Read", kind: "read", status: "completed", title: `Read ${id}`, input: { file_path: `/r/${id}` } },
});
const reply = (id: string, text = "answer"): Block => ({ id, role: "assistant", text });

describe("flattenTurns", () => {
  it("makes one row per turn item and a closing row per turn, keyed by first block", () => {
    const turns = [
      [user("u0", "p", { startedAt: 10, doneTs: 1510 }), tool("t0"), tool("t1"), reply("a0")],
      [user("u1"), reply("a1")],
    ];
    const { rows, rowOfBlock } = flattenTurns(turns, false, true);
    expect(rows.map((r) => r.key)).toEqual(["u0", "t0", "a0", "u0:end", "u1", "a1", "u1:end"]);
    // Both tool calls sit in the group row keyed by the first of them.
    expect(rowOfBlock().get("t0")).toBe(1);
    expect(rowOfBlock().get("t1")).toBe(1);
    expect(rowOfBlock().get("a1")).toBe(5);
    expect(rowOfBlock()).toBe(rowOfBlock());
    expect(rows[3]).toMatchObject({ kind: "end", turn: { durationMs: 1500, settled: true, isLast: false } });
    // The live turn (busy, last) is not settled; the earlier one is.
    expect(rows[6]).toMatchObject({ kind: "end", turn: { settled: false, isLast: true } });
  });

  it("puts the Load earlier row above everything when asked", () => {
    const { rows, rowOfBlock } = flattenTurns([[user("u0"), reply("a0")]], false, false, { loadEarlier: true });
    expect(rows.map((r) => r.key)).toEqual(["more", "u0", "a0", "u0:end"]);
    expect(rowOfBlock().get("a0")).toBe(2);
    expect(estimateRowHeight(rows[0])).toBe(52);
  });

  it("marks the live turn's last group to open by itself and settles everything once idle", () => {
    const turns = [[user("u0"), tool("t0"), tool("t1"), reply("a0"), tool("t2")]];
    const live = flattenTurns(turns, false, true).rows;
    expect(live.find((r) => r.key === "t0")).toMatchObject({ autoOpen: false });
    expect(live.find((r) => r.key === "t2")).toMatchObject({ autoOpen: true });
    const idle = flattenTurns(turns, false, false).rows;
    expect(idle.find((r) => r.key === "t2")).toMatchObject({ autoOpen: false, done: true });
  });

  it("reuses a turn's items while its array is the same object", () => {
    const turn = [user("u0"), tool("t0"), reply("a0")];
    const a = flattenTurns([turn], false, false).rows;
    const b = flattenTurns([turn], false, false).rows;
    expect(a[1].kind === "item" && b[1].kind === "item" && a[1].item === b[1].item).toBe(true);
    const c = flattenTurns([turn], true, false).rows;
    expect(c[1].kind === "item" && a[1].kind === "item" && c[1].item !== a[1].item).toBe(true);
  });

  it("estimates heights by what a row holds", () => {
    const { rows } = flattenTurns(
      [[user("u0", "one\ntwo"), tool("t0"), tool("t1"), tool("t2"), tool("t3"), reply("a0", "x".repeat(200) + "\n```ts\nconst a = 1\n```")]],
      false,
      false,
    );
    const by = Object.fromEntries(rows.map((r) => [r.key, estimateRowHeight(r)]));
    expect(by.u0).toBe(46 + 40);
    expect(by.t0).toBe(28 * 3);
    // 3 wrapped lines of text, three fence lines, one fence.
    expect(by.a0).toBe(16 + 24 * 6 + 40);
    expect(by["u0:end"]).toBe(36);
  });
});
