import { describe, expect, it, vi } from "vitest";
import type { SessionMeta, SessionStatus } from "../../../lib/tcserver/types";
import { AgentSummaries, agentSummary, agentSummaryParts, agentSummaryText, parentIndex, subtreeOf } from "./agentSummary";

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

describe("agentSummary", () => {
  it("is null with no agents", () => {
    expect(agentSummary([])).toBeNull();
    expect(agentSummaryText(null)).toBe("");
  });

  it("says the count and only the nonzero live states, in the fleet's words", () => {
    const s = agentSummary([
      { status: "running" },
      { status: "starting" },
      { status: "waiting" },
      { status: "idle" },
      { status: "done" },
    ] as SessionMeta[]);
    expect(s).toEqual({ total: 5, working: 2, waiting: 1, failed: 0 });
    expect(agentSummaryText(s)).toBe("5 agents · 2 working · 1 needs approval");
    expect(agentSummaryParts(s!).map((p) => p.tone)).toEqual([undefined, undefined, "text-warning"]);
  });

  it("names a failure in the danger tone, and one settled agent alone", () => {
    expect(agentSummaryParts(agentSummary([{ status: "error" }] as SessionMeta[])!)).toEqual([{ text: "1 agent" }, { text: "1 failed", tone: "text-danger" }]);
    expect(agentSummaryText(agentSummary([{ status: "done" }] as SessionMeta[]))).toBe("1 agent");
  });
});

describe("AgentSummaries", () => {
  it("keeps each row's object and wakes listeners only when a summary changed", () => {
    const store = new AgentSummaries();
    const wake = vi.fn();
    store.subscribe(wake);
    const metas = [meta("c1", null), meta("c2", null), meta("a", "c1", "running")];
    store.update(["c1", "c2"], metas);
    expect(wake).toHaveBeenCalledTimes(1);
    const first = store.get("c1");
    expect(first).toEqual({ total: 1, working: 1, waiting: 0, failed: 0 });
    expect(store.get("c2")).toBeNull();

    store.update(["c1", "c2"], [...metas, meta("unrelated", "x", "running")]);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(store.get("c1")).toBe(first);

    store.update(["c1", "c2"], [meta("c1", null), meta("c2", null), meta("a", "c1", "idle")]);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(store.get("c1")).toEqual({ total: 1, working: 0, waiting: 0, failed: 0 });
  });
});
