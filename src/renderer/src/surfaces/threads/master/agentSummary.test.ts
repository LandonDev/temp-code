import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionStore } from "../../../lib/tcserver/store";
import type { SessionMeta, SessionStatus } from "../../../lib/tcserver/types";
import { AgentSummaries, agentTail, parentIndex, rowAgents, subtreeOf } from "./agentSummary";

const meta = (id: string, parentId: string | null, status: SessionStatus = "idle", extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({ provider: "claude", model: "claude-sonnet-5-5", permission: "edits", title: id, cwd: "/repo", id, parentId, status, archived: false, environmentId: "local", createdAt: 0, ...extra }) as unknown as SessionMeta;

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
      ["waiting", "Approve Bash"],
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
    expect(agentTail(r)).toEqual({ text: "3 more, 1 done", waiting: true });
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
    store.update(["c1", "c2"], parentIndex(metas));
    expect(wake).toHaveBeenCalledTimes(1);
    const first = store.get("c1");
    expect(first?.lines.map((l) => l.detail)).toEqual(["Reading a.ts"]);
    expect(store.get("c2")).toBeNull();

    store.update(["c1", "c2"], parentIndex([...metas, meta("unrelated", "x", "running")]));
    expect(wake).toHaveBeenCalledTimes(1);
    expect(store.get("c1")).toBe(first);

    store.update(["c1", "c2"], parentIndex([meta("c1", null), meta("c2", null), meta("a", "c1", "running", { activity: "Editing a.ts" })]));
    expect(wake).toHaveBeenCalledTimes(2);
    expect(store.get("c1")?.lines[0]!.detail).toBe("Editing a.ts");

    store.update(["c1", "c2"], parentIndex([meta("c1", null), meta("c2", null), meta("a", "c1", "idle")]));
    expect(wake).toHaveBeenCalledTimes(3);
    expect(store.get("c1")).toBeNull();
  });
});

describe("AgentSummaries from meta pushes", () => {
  beforeEach(() => {
    sessionStore.reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    sessionStore.reset();
    vi.useRealTimers();
  });
  const push = (m: SessionMeta) => sessionStore.injectPush({ push: "session", session: m }, m.environmentId);
  const flush = () => vi.runOnlyPendingTimersAsync();

  it("rebuilds exactly one of 16 child summaries for a nested agent push and none for an unrelated push", async () => {
    const ids = Array.from({ length: 16 }, (_, i) => `c${i}`);
    for (const id of ids) {
      push(meta(id, null, "running", { masterId: "master" }));
      push(meta(`${id}-agent`, id, "running"));
      push(meta(`${id}-nested`, `${id}-agent`, "running", { activity: "Reading" }));
    }
    await flush();
    const summaries = new AgentSummaries();
    const get = vi.fn(sessionStore.childrenOf);
    const index = { get };
    summaries.update(ids, index);
    const before = ids.map((id) => summaries.get(id));
    const off = sessionStore.onMetaChange((changes) => summaries.update(ids, index, changes.affected));
    get.mockClear();
    push(meta("c7-nested", "c7-agent", "waiting", { activity: "Bash" }));
    await flush();
    expect(get.mock.calls.filter(([id]) => ids.includes(id)).map(([id]) => id)).toEqual(["c7"]);
    for (const [i, id] of ids.entries()) {
      if (i === 7) expect(summaries.get(id)).not.toBe(before[i]);
      else expect(summaries.get(id)).toBe(before[i]);
    }
    expect(summaries.get("c7")?.lines[0]).toMatchObject({ id: "c7-nested", state: "waiting", detail: "Approve Bash" });

    get.mockClear();
    push(meta("unrelated", "elsewhere", "running"));
    await flush();
    expect(get).not.toHaveBeenCalled();
    off();
  });

  it("refreshes both old and new rows on a reparent, and the old row on removal", async () => {
    push(meta("agent", "c1", "running"));
    push(meta("nested", "agent", "waiting", { environmentId: "box" }));
    await flush();
    const summaries = new AgentSummaries();
    const ids = ["c1", "c2"];
    const index = { get: sessionStore.childrenOf };
    summaries.update(ids, index);
    const off = sessionStore.onMetaChange((changes) => summaries.update(ids, index, changes.affected));
    push(meta("agent", "c2", "running", { archived: true }));
    await flush();
    expect(summaries.get("c1")).toBeNull();
    expect(summaries.get("c2")?.lines.map((l) => l.id)).toEqual(["nested"]);
    sessionStore.injectPush({ push: "session-removed", sessionIds: ["agent"] }, "local");
    await flush();
    expect(summaries.get("c2")).toBeNull();
    off();
  });

  it("prunes a departed child's summary and signature, then rebuilds it if it rejoins", async () => {
    push(meta("agent", "c1", "running"));
    await flush();
    const summaries = new AgentSummaries();
    const get = vi.fn(sessionStore.childrenOf);
    const index = { get };
    summaries.update(["c1", "c2"], index);
    const first = summaries.get("c1");
    const wake = vi.fn();
    summaries.subscribe(wake);
    summaries.update(["c2"], index, new Set());
    expect(summaries.get("c1")).toBeNull();
    expect(wake).toHaveBeenCalledTimes(1);
    get.mockClear();
    summaries.update(["c2"], index, new Set(["c1"]));
    expect(get).not.toHaveBeenCalled();
    summaries.update(["c1", "c2"], index, new Set());
    expect(summaries.get("c1")).toEqual(first);
    expect(summaries.get("c1")).not.toBe(first);
  });

  it("matches a fresh catalog walk through tied ranks, archives, cycles, host moves and remove/re-add", async () => {
    const ids = ["c1", "c2"];
    const summaries = new AgentSummaries();
    const index = { get: sessionStore.childrenOf };
    summaries.update(ids, index);
    const off = sessionStore.onMetaChange((changes) => summaries.update(ids, index, changes.affected));
    const changes = [
      meta("first", "c1", "running"),
      meta("second", "c1", "running"),
      meta("nested", "first", "waiting"),
      meta("first", "c2", "running", { environmentId: "box" }),
      meta("first", "c1", "running", { archived: true }),
      meta("second", "nested", "running"),
      meta("first", "second", "running"),
      meta("first", "c1", "running"),
      null,
      meta("first", "c1", "running"),
    ];
    for (const change of changes) {
      if (change) push(change);
      else sessionStore.injectPush({ push: "session-removed", sessionIds: ["first"] }, "local");
      await flush();
      const fresh = parentIndex(sessionStore.metas());
      for (const id of ids) expect(summaries.get(id)).toEqual(rowAgents(subtreeOf(fresh, id)));
    }
    off();
  });
});
