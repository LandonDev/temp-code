import { describe, expect, it } from "vitest";
import type { Block } from "../lib/session";
import { estimateRowHeight, flattenTurns, ROW_GAP } from "./transcriptRows";

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
    const { rows, rowOfBlock } = flattenTurns(turns, true);
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
    const { rows, rowOfBlock } = flattenTurns([[user("u0"), reply("a0")]], false, { loadEarlier: true });
    expect(rows.map((r) => r.key)).toEqual(["more", "u0", "a0", "u0:end"]);
    expect(rowOfBlock().get("a0")).toBe(2);
    expect(estimateRowHeight(rows[0])).toBe(16 + 28);
  });

  it("marks only the running turn's last item, a group, live", () => {
    const turns = [[user("u0"), tool("t0"), tool("t1"), reply("a0"), tool("t2")]];
    const live = flattenTurns(turns, true).rows;
    expect(live.find((r) => r.key === "t0")).toMatchObject({ live: false });
    expect(live.find((r) => r.key === "t2")).toMatchObject({ live: true });
    // A paragraph after the last group: nothing is live.
    const after = flattenTurns([[user("u0"), tool("t0"), reply("a0")]], true).rows;
    expect(after.find((r) => r.key === "t0")).toMatchObject({ live: false });
    const idle = flattenTurns(turns, false).rows;
    expect(idle.find((r) => r.key === "t2")).toMatchObject({ live: false });
  });

  it("marks the group the open turn works in as working: running, paused, or under a step waiting on the person", () => {
    const turn = [user("u0"), tool("t0"), tool("t1")];
    const working = (rows: ReturnType<typeof flattenTurns>["rows"]) => rows.find((r) => r.key === "t0");
    expect(working(flattenTurns([turn], true).rows)).toMatchObject({ working: true });
    expect(working(flattenTurns([turn], false, { paused: true }).rows)).toMatchObject({ working: true });
    expect(working(flattenTurns([turn], false).rows)).toMatchObject({ working: false });
    // A question still waiting below the group: the work has not moved past it.
    const asking: Block = { ...tool("q0"), question: { questions: [] }, tool: { ...tool("q0").tool!, status: "running" } } as Block;
    expect(working(flattenTurns([[...turn, asking]], true).rows)).toMatchObject({ working: true });
    // Prose after it: the work moved on.
    expect(working(flattenTurns([[...turn, reply("a0")]], true).rows)).toMatchObject({ working: false });
    // Only the last turn works.
    expect(working(flattenTurns([turn, [user("u1"), reply("a1")]], true).rows)).toMatchObject({ working: false });
    // A working group is estimated open on its newest five rows.
    const many = [user("u0"), ...Array.from({ length: 9 }, (_, i) => tool(`m${i}`))];
    const row = flattenTurns([many], true).rows.find((r) => r.key === "m0")!;
    expect(estimateRowHeight(row)).toBe(16 + 28 + 28 * 5);
  });

  it("keeps a paused last turn open, with nothing in it live", () => {
    const turns = [[user("u0", "p", { startedAt: 10, durationMs: 900 }), tool("t0")]];
    const { rows } = flattenTurns(turns, false, { paused: true });
    expect(rows.find((r) => r.key === "u0:end")).toMatchObject({ turn: { settled: false, isLast: true } });
    expect(rows.find((r) => r.key === "t0")).toMatchObject({ live: false });
  });

  it("gives each row the gap of the boundary above it", () => {
    const thought: Block = { id: "r0", role: "reasoning", text: "Hm." };
    const notice: Block = { id: "n0", role: "system", text: "Goal set" };
    const failure: Block = { id: "err:0", role: "system", text: "boom" };
    const turns = [
      [user("u0"), reply("a0"), tool("t0"), notice, reply("a1"), failure],
      [user("u1"), thought, tool("t1"), reply("a2")],
    ];
    const gaps = Object.fromEntries(flattenTurns(turns, false).rows.map((r) => [r.key, r.gap]));
    expect(gaps).toEqual({
      // Nothing above the first row.
      u0: ROW_GAP.first,
      // A bubble to its first reply.
      a0: ROW_GAP.reply,
      // Block to line, line to line, line to block, block to card.
      t0: ROW_GAP.block,
      n0: ROW_GAP.line,
      a1: ROW_GAP.block,
      "err:0": ROW_GAP.block,
      // The last item to the closing line.
      "u0:end": ROW_GAP.end,
      // The previous turn to the next turn's first row.
      u1: ROW_GAP.turn,
      // A thought and a call fold into one line after the bubble.
      r0: ROW_GAP.reply,
      a2: ROW_GAP.block,
      "u1:end": ROW_GAP.end,
    });
    expect(ROW_GAP).toEqual({ first: 16, turn: 32, reply: 16, block: 12, line: 4, end: 8, more: 8 });
  });

  it("starts a wake turn with the turn gap and the first row under Load earlier with 8px", () => {
    const wake: Block = { id: "w0", role: "system", text: "Agent A: done", agent: { id: "a", title: "A", status: "done" } };
    const { rows } = flattenTurns([[user("u0"), reply("a0")], [wake, reply("a1")]], false, { loadEarlier: true });
    expect(rows.map((r) => [r.key, r.gap])).toEqual([
      ["more", ROW_GAP.first],
      ["u0", ROW_GAP.more],
      ["a0", ROW_GAP.reply],
      ["u0:end", ROW_GAP.end],
      ["w0", ROW_GAP.turn],
      ["a1", ROW_GAP.block],
      ["w0:end", ROW_GAP.end],
    ]);
  });

  it("puts two lines 4px apart: an undecided approval under a group", () => {
    const approval: Block = { id: "ap", role: "approval", text: "Run bun test?", approval: { requestId: 1 } } as Block;
    const { rows } = flattenTurns([[user("u0"), tool("t0"), approval]], true);
    expect(rows.find((r) => r.key === "ap")).toMatchObject({ gap: ROW_GAP.line });
  });

  it("reuses a turn's items while its array is the same object", () => {
    const turn = [user("u0"), tool("t0"), reply("a0")];
    const a = flattenTurns([turn], false).rows;
    const b = flattenTurns([turn], false).rows;
    expect(a[1].kind === "item" && b[1].kind === "item" && a[1].item === b[1].item).toBe(true);
    const c = flattenTurns([[...turn]], false).rows;
    expect(c[1].kind === "item" && a[1].kind === "item" && c[1].item !== a[1].item).toBe(true);
  });

  it("estimates a lone run as its steps' rows", () => {
    const thought: Block = { id: "r0", role: "reasoning", text: "Hm." };
    const { rows } = flattenTurns([[user("u0"), thought, tool("t0"), reply("a0")]], false);
    expect(estimateRowHeight(rows.find((r) => r.key === "r0")!)).toBe(ROW_GAP.reply + 28 * 2);
  });

  it("counts the host's folded steps: a call and a report are one closed line", () => {
    const report: Block = { id: "rp", role: "system", text: "Agent A: done", agent: { id: "a", title: "A", status: "done" } };
    const { rows } = flattenTurns([[user("u0"), report, tool("t0"), reply("a0")]], false);
    const run = rows.find((r) => r.key === "rp")!;
    expect(run.kind === "item" && run.item.type).toBe("activity");
    expect(estimateRowHeight(run)).toBe(ROW_GAP.reply + 28);
  });

  it("estimates heights by what a row holds", () => {
    const { rows } = flattenTurns(
      [[user("u0", "one\ntwo"), tool("t0"), tool("t1"), tool("t2"), tool("t3"), reply("a0", "x".repeat(200) + "\n```ts\nconst a = 1\n```")]],
      false,
    );
    const by = Object.fromEntries(rows.map((r) => [r.key, estimateRowHeight(r)]));
    // The first row's 16px, the bubble's 8px padding twice, 22px a line.
    expect(by.u0).toBe(16 + 16 + 22 * 2);
    // A group is closed by default: one 28px line, 16px under the bubble.
    expect(by.t0).toBe(16 + 28);
    // 2 wrapped lines of 100 characters, three fence lines, one fence, 12px under a line.
    expect(by.a0).toBe(12 + 22 * 5 + 40);
    expect(by["u0:end"]).toBe(8 + 28);
  });

  it("estimates a closing row that draws nothing at 0, gap and all", () => {
    const { rows } = flattenTurns([[user("u0"), reply("a0")], [user("u1"), reply("a1")]], false);
    // An earlier turn with no duration closes on nothing.
    expect(estimateRowHeight(rows.find((r) => r.key === "u0:end")!)).toBe(0);
    expect(estimateRowHeight(rows.find((r) => r.key === "u1:end")!)).toBe(8 + 28);
  });
});
