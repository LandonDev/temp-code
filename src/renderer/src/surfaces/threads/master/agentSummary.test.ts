import { describe, expect, it, vi } from "vitest";
import type { SessionMeta, SessionStatus } from "../../../lib/tcserver/types";
import { AgentSummaries, agentTail, parentIndex, rowAgents, subtreeOf } from "./agentSummary";

const meta = (id: string, parentId: string | null, status: SessionStatus = "idle", extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, parentId, status, archived: false, environmentId: "local", createdAt: 0, ...extra }) as unknown as SessionMeta;

describe("subtreeOf", () => {
  it("counts subagents of subagents by the parentId chain", () => {
    const metas = [meta("c", null), meta("a1", "c"), meta("a2", "c"), meta("a11", "a1"), meta("a111", "a11"), meta("x", "other")];
    expect(subtreeOf(parentIndex(metas), "c").map((m) => m.id).sort()).toEqual(["a1", "a11", "a111", "a2"]);
  });

  it("leaves archived agents out, still counting the live ones under them", () => {
    const metas = [meta("a1", "c", "idle", { archived: true }), meta("a11", "a1", "running"), meta("a2", "c", "running", { archived: true })];
    expect(subtreeOf(parentIndex(metas), "c").map((m) => m.id)).toEqual(["a11"]);
  });

  it("takes a far host's agents, which carry the child's bare id", () => {
    const metas = [meta("far", null, "running", { environmentId: "box" }), meta("b1", "far", "running", { environmentId: "box" })];
    expect(subtreeOf(parentIndex(metas), "far").map((m) => m.environmentId)).toEqual(["box"]);
  });

  it("survives a cycle", () => {
    const metas = [meta("a", "b"), meta("b", "a")];
    expect(subtreeOf(parentIndex(metas), "a").map((m) => m.id)).toEqual(["b"]);
  });
});

describe("rowAgents", () => {
  it("is null with no agents, and with only settled ones", () => {
    expect(rowAgents([])).toBeNull();
    expect(rowAgents([meta("a", "c", "idle"), meta("b", "c", "done"), meta("s", "c", "stopped")])).toBeNull();
  });

  it("lists the live ones, the person's first, oldest first within a state, in the board row's words", () => {
    const r = rowAgents([
      meta("run", "c", "running", { createdAt: 1, title: "Edit the rail", activity: "Editing Rail.tsx" }),
      meta("old", "c", "idle", { createdAt: 0 }),
      meta("wait", "c", "waiting", { createdAt: 5, title: "Run tests", activity: "Bash" }),
      meta("fail", "c", "error", { createdAt: 3, failure: { summary: "Usage cap until 14:00" } as SessionMeta["failure"] }),
    ])!;
    expect(r.lines.map((l) => l.id)).toEqual(["wait", "fail", "run"]);
    expect(r.lines.map((l) => [l.state, l.detail])).toEqual([
      ["waiting", "approve Bash"],
      ["failed", "Usage cap until 14:00"],
      ["working", "Editing Rail.tsx"],
    ]);
    expect(r.lines[2]).toMatchObject({ title: "Edit the rail", environmentId: "local" });
    expect(r).toMatchObject({ more: 0, moreWaiting: 0, done: 1 });
    expect(agentTail(r)).toEqual({ text: "1 done", waiting: false });
  });

  it("caps the lines and counts the rest, saying when one past the cap waits", () => {
    const agents = [
      ...["w1", "w2", "w3", "w4"].map((id, i) => meta(id, "c", "waiting", { createdAt: i })),
      meta("r", "c", "running", { createdAt: 9 }),
      meta("p", "c", "paused", { createdAt: 10 }),
      meta("d", "c", "done"),
    ];
    const r = rowAgents(agents)!;
    expect(r.lines.map((l) => l.id)).toEqual(["w1", "w2", "w3"]);
    expect(r.lines[0]).toMatchObject({ state: "waiting", detail: "" });
    expect(agentTail(r)).toEqual({ text: "and 3 more, 1 done", waiting: true });
    expect(agentTail(rowAgents(agents.slice(0, 3))!)).toBeNull();
  });

  it("leaves a paused agent's detail to its glyph", () => {
    expect(rowAgents([meta("p", "c", "paused")])!.lines[0]).toMatchObject({ state: "paused", detail: "" });
  });
});

describe("AgentSummaries", () => {
  it("keeps each row's object and wakes listeners only when a row's agents changed", () => {
    const store = new AgentSummaries();
    const wake = vi.fn();
    store.subscribe(wake);
    const metas = [meta("c1", null), meta("c2", null), meta("a", "c1", "running", { activity: "Reading a.ts" })];
    store.update(["c1", "c2"], metas);
    expect(wake).toHaveBeenCalledTimes(1);
    const first = store.get("c1");
    expect(first?.lines.map((l) => l.detail)).toEqual(["Reading a.ts"]);
    expect(store.get("c2")).toBeNull();

    store.update(["c1", "c2"], [...metas, meta("unrelated", "x", "running")]);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(store.get("c1")).toBe(first);

    store.update(["c1", "c2"], [meta("c1", null), meta("c2", null), meta("a", "c1", "running", { activity: "Editing a.ts" })]);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(store.get("c1")?.lines[0]!.detail).toBe("Editing a.ts");

    store.update(["c1", "c2"], [meta("c1", null), meta("c2", null), meta("a", "c1", "idle")]);
    expect(wake).toHaveBeenCalledTimes(3);
    expect(store.get("c1")).toBeNull();
  });
});
