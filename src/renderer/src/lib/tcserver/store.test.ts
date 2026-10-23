import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession } from "../session";
import { KEEP_RECENT, applyMeta, sessionFromMeta, sessionStore, type Link } from "./store";
import { ConnectionLostError, TimeoutError } from "../connection";
import type { EventRow, ServerPush, SessionMeta } from "./types";

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    environmentId: "local",
    id: "s1",
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: null,
    planPath: null,
    provider: "claude",
    model: "claude-sonnet-5-5",
    reasoning: "medium",
    agentType: "implementer",
    title: "claude · implementer",
    cwd: "/repo",
    status: "idle",
    archived: false,
    pinned: false,
    permission: "edits",
    fast: false,
    ultrafast: false,
    context1m: false,
    busySince: null,
    pausedAt: null,
    frozenActiveElapsed: null,
    nativeId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function wireMeta(over: Partial<SessionMeta> = {}): Omit<SessionMeta, "environmentId"> {
  const { environmentId: _environmentId, ...wire } = meta(over);
  return wire;
}

const row = (sessionId: string, seq: number, event: EventRow["event"]): EventRow => ({
  sessionId,
  seq,
  ts: 1_000 + seq,
  event,
});

class FakeLink implements Link {
  environmentId = "local";
  profile = "local" as const;
  connected = true;
  calls: { method: string; params: unknown }[] = [];
  metas: Omit<SessionMeta, "environmentId">[] = [];
  events = new Map<string, EventRow[]>();
  /** When set, head (beforeSeq) fetches wait on it. */
  holdHead: Promise<void> | null = null;
  /** When set, a resume or tail fetch waits on it. */
  holdEvents: Promise<void> | null = null;
  /** The next resume or tail fetches fail with these, in order. */
  eventErrors: Error[] = [];
  private pushListeners = new Set<(push: ServerPush) => void>();
  private openListeners = new Set<() => void>();

  /** Archived metas, served only to a `session.list` that asks for them. */
  archivedMetas: Omit<SessionMeta, "environmentId">[] = [];

  request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "session.list") {
      const p = (params ?? {}) as { archived?: boolean; projectId?: string };
      if (!p.archived) return Promise.resolve(this.metas as T);
      return Promise.resolve(
        this.archivedMetas.filter((m) => !p.projectId || m.projectId === p.projectId) as T,
      );
    }
    if (method === "session.events") {
      const { sessionId, afterSeq = 0, beforeSeq = Infinity, tail } = params as {
        sessionId: string;
        afterSeq?: number;
        beforeSeq?: number;
        tail?: number;
      };
      let rows = (this.events.get(sessionId) ?? []).filter((r) => r.seq > afterSeq && r.seq < beforeSeq);
      const { limit } = params as { limit?: number };
      if (limit) rows = rows.slice(0, limit);
      if (tail) {
        // Row budget, as the server counts it: a prompt or a message is a row.
        const starts = rows.filter((r) => r.event.type === "user-text" || r.event.type === "assistant-text").slice(-(tail + 1));
        if (starts.length === tail + 1) rows = rows.filter((r) => r.seq > starts[0].seq && r.seq >= starts[1].seq);
      }
      const result = rows as T;
      if (beforeSeq !== Infinity && this.holdHead) return this.holdHead.then(() => result);
      if (beforeSeq === Infinity) {
        const error = this.eventErrors.shift();
        if (this.holdEvents) return this.holdEvents.then(() => (error ? Promise.reject(error) : result));
        if (error) return Promise.reject(error);
      }
      return Promise.resolve(result);
    }
    return Promise.resolve(null as T);
  }
  onPush(l: (push: ServerPush) => void): () => void {
    this.pushListeners.add(l);
    return () => this.pushListeners.delete(l);
  }
  onOpen(l: () => void): () => void {
    this.openListeners.add(l);
    return () => this.openListeners.delete(l);
  }
  onClose() {
    return () => {};
  }
  push(push: ServerPush): void {
    for (const l of this.pushListeners) l(push);
  }
  reopen(): void {
    for (const l of this.openListeners) l();
  }
  method(name: string): number {
    return this.calls.filter((c) => c.method === name).length;
  }
}

let link: FakeLink;

beforeEach(() => {
  link = new FakeLink();
  sessionStore.reset();
});

afterEach(() => {
  sessionStore.reset();
});

describe("sessionFromMeta / applyMeta", () => {
  it("maps provider, model, policy, status", () => {
    const s = sessionFromMeta(meta({ permission: "auto", status: "running", reasoning: "high" }));
    expect(s.harness).toBe("claude");
    expect(s.model).toBe("claude:sonnet-5.5");
    expect(s.runtimeMode).toBe("full-access");
    expect(s.busy).toBe(true);
    expect(s.modelSettings.effort).toBe("high");
  });

  it("a server-side ultrafast change lands in the model settings like fast does", () => {
    const prev = meta();
    const local = sessionFromMeta(prev);
    const next = applyMeta(local, prev, { ...prev, ultrafast: true });
    expect(next.modelSettings.ultrafast).toBe("true");
    const back = applyMeta(next, { ...prev, ultrafast: true }, { ...prev, fast: true });
    expect(back.modelSettings).toMatchObject({ fast: "true", ultrafast: "false" });
  });

  it("only applies the fields that changed, keeping local edits", () => {
    const prev = meta();
    const local = { ...sessionFromMeta(prev), title: "typed title", modelSettings: { effort: "max" }, pendingSwitch: undefined, inboxCard: undefined };
    const next = applyMeta(local, prev, { ...prev, status: "running", nativeId: "abc" });
    expect(next.title).toBe("typed title");
    expect(next.modelSettings.effort).toBe("max");
    expect(next.busy).toBe(true);
    expect(next.providerSessionId).toBe("abc");
  });

  it("carries the thread fields across", () => {
    const m = meta({
      threadType: "planning",
      planPath: "/repo/.temp-code/plan-s1.md",
      parentId: null,
      agentType: "implementer",
      status: "running",
      busySince: 50,
      activity: "Editing a.ts",
      activityKind: "edit",
      tasks: { done: 1, total: 3, current: "Running tests" },
    });
    const s = sessionFromMeta(m);
    expect(s.threadType).toBe("planning");
    expect(s.planPath).toBe("/repo/.temp-code/plan-s1.md");
    expect(s.status).toBe("running");
    expect(s.busySince).toBe(50);
    expect(s.activityKind).toBe("edit");
    expect(s.tasks).toEqual({ done: 1, total: 3, current: "Running tests" });
    const same = applyMeta(s, m, { ...m, tasks: { done: 1, total: 3, current: "Running tests" } });
    expect(same.tasks).toBe(s.tasks);
    const moved = applyMeta(s, m, { ...m, tasks: { done: 2, total: 3, current: null }, activity: null });
    expect(moved.tasks?.done).toBe(2);
    expect(moved.activity).toBeNull();
  });

  it("a draft adopts the thread fields the server minted", async () => {
    sessionStore.attach(link);
    await sessionStore.ready();
    const draft = newSession("local", "claude", "/repo", undefined, undefined, undefined, { threadType: "planning" });
    sessionStore.mutate([draft]);
    expect(sessionStore.get(draft.id)?.threadType).toBe("planning");
    sessionStore.adopt(meta({ id: draft.id, threadType: "planning", planPath: "/repo/.temp-code/plan-x.md" }));
    expect(sessionStore.get(draft.id)?.planPath).toBe("/repo/.temp-code/plan-x.md");
  });

  it("a layout stub follows the host whose list adopts it", async () => {
    sessionStore.attach(link);
    await sessionStore.ready();
    // A pane restored from the saved layout before the box listed it: the
    // stub says local, the box answers for the thread.
    const stub = { ...newSession("local", "claude", "/srv/work"), id: "m1" };
    sessionStore.mutate([stub]);
    expect(sessionStore.get("m1")?.environmentId).toBe("local");
    const box = new FakeLink();
    box.environmentId = "env_box";
    box.metas = [wireMeta({ id: "m1", cwd: "/srv/work" })];
    sessionStore.attach(box);
    await vi.waitFor(() => expect(sessionStore.get("m1")?.environmentId).toBe("env_box"));
    expect(sessionStore.environmentOf("m1")).toBe("env_box");
    sessionStore.detach("env_box");
  });
});

describe("sessionStore", () => {
  it("lists metas on connect without opening them", async () => {
    link.metas = [wireMeta(), wireMeta({ id: "s2", title: "two" })];
    sessionStore.attach(link);
    await sessionStore.ready();
    expect(sessionStore.metas().map((m) => m.id)).toEqual(["s1", "s2"]);
    expect(sessionStore.getSnapshot()).toEqual([]);
    expect(sessionStore.isDraft("s1")).toBe(false);
    expect(sessionStore.isDraft("nope")).toBe(true);
  });

  it("loads a transcript lazily, once, and subscribes", async () => {
    link.metas = [wireMeta()];
    link.events.set("s1", [
      row("s1", 1, { type: "user-text", text: "hi" }),
      row("s1", 2, { type: "assistant-text", text: "yo", delta: false, msgId: "m", blockIndex: 0 }),
      row("s1", 3, { type: "turn-complete" }),
    ]);
    sessionStore.attach(link);
    await sessionStore.ready();
    await Promise.all([sessionStore.ensureLoaded("s1"), sessionStore.ensureLoaded("s1")]);
    expect(link.method("session.subscribe")).toBe(1);
    expect(link.method("session.events")).toBe(1);
    const s = sessionStore.get("s1")!;
    expect(s.blocks.map((b) => b.role)).toEqual(["user", "assistant"]);
    expect(s.busy).toBe(false);
  });

  it("folds event pushes into open sessions and notifies", async () => {
    link.metas = [wireMeta()];
    sessionStore.attach(link);
    await sessionStore.ready();
    await sessionStore.ensureLoaded("s1");
    sessionStore.mutate((prev) => [...prev, sessionStore.get("s1")!]);
    let notified = 0;
    const off = sessionStore.subscribe(() => notified++);
    link.push({ push: "event", row: row("s1", 1, { type: "user-text", text: "q" }) });
    link.push({ push: "event", row: row("s1", 2, { type: "assistant-text", text: "a", delta: true, msgId: "m", blockIndex: 0 }) });
    // The snapshot is current at once; listeners hear once per frame.
    expect(sessionStore.getSnapshot()[0].blocks).toHaveLength(2);
    expect(notified).toBe(0);
    await new Promise((r) => setTimeout(r, 30));
    off();
    expect(notified).toBe(1);
    const snap = sessionStore.getSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].blocks).toHaveLength(2);
    expect(snap[0].busy).toBe(true);
  });

  it("replays only the gap after a reconnect", async () => {
    link.metas = [wireMeta()];
    link.events.set("s1", [row("s1", 1, { type: "user-text", text: "hi" })]);
    sessionStore.attach(link);
    await sessionStore.ready();
    await sessionStore.ensureLoaded("s1");
    link.events.get("s1")!.push(row("s1", 2, { type: "assistant-text", text: "late", delta: false, msgId: "m", blockIndex: 0 }));
    link.reopen();
    await new Promise((r) => setTimeout(r, 0));
    const last = link.calls.filter((c) => c.method === "session.events").at(-1);
    expect(last?.params).toEqual({ sessionId: "s1", afterSeq: 1 });
    expect(sessionStore.get("s1")!.blocks).toHaveLength(2);
  });

  it("meta pushes update the view and keep local-only fields", async () => {
    link.metas = [wireMeta()];
    sessionStore.attach(link);
    await sessionStore.ready();
    sessionStore.mutate([{ ...sessionStore.get("s1")!, composerSeed: "draft text" }]);
    link.push({ push: "session", session: wireMeta({ title: "Real title", status: "running" }) });
    const s = sessionStore.getSnapshot()[0];
    expect(s.title).toBe("Real title");
    expect(s.busy).toBe(true);
    expect(s.composerSeed).toBe("draft text");
  });

  it("drafts open through mutate and adopt their server meta on create", async () => {
    sessionStore.attach(link);
    await sessionStore.ready();
    const draft = newSession("local", "claude", "/repo");
    sessionStore.mutate([draft]);
    expect(sessionStore.isDraft(draft.id)).toBe(true);
    expect(sessionStore.metas()).toEqual([]);
    sessionStore.appendOptimisticUser(draft.id, "first");
    expect(sessionStore.get(draft.id)!.blocks[0].pending).toBe(true);
    expect(sessionStore.get(draft.id)!.busy).toBe(true);
    sessionStore.adopt(meta({ id: draft.id, status: "running" }));
    expect(sessionStore.isDraft(draft.id)).toBe(false);
    expect(link.method("session.subscribe")).toBe(1);
    link.push({ push: "event", row: row(draft.id, 1, { type: "user-text", text: "first" }) });
    expect(sessionStore.get(draft.id)!.blocks).toHaveLength(1);
    expect(sessionStore.get(draft.id)!.blocks[0].pending).toBeUndefined();
  });

  it("waitIdle resolves when the turn settles", async () => {
    link.metas = [wireMeta({ status: "running" })];
    sessionStore.attach(link);
    await sessionStore.ready();
    sessionStore.mutate([sessionStore.get("s1")!]);
    let settled = false;
    const wait = sessionStore.waitIdle("s1").then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    link.push({ push: "session", session: wireMeta({ status: "idle" }) });
    await wait;
    expect(settled).toBe(true);
  });

  it("closing a session in the updater keeps its transcript cached", async () => {
    link.metas = [wireMeta()];
    link.events.set("s1", [row("s1", 1, { type: "user-text", text: "hi" })]);
    sessionStore.attach(link);
    await sessionStore.ready();
    await sessionStore.ensureLoaded("s1");
    sessionStore.mutate([sessionStore.get("s1")!]);
    sessionStore.mutate((prev) => prev.filter((s) => s.id !== "s1"));
    expect(sessionStore.getSnapshot()).toEqual([]);
    expect(sessionStore.get("s1")!.blocks).toHaveLength(1);
    await sessionStore.ensureLoaded("s1");
    expect(link.method("session.events")).toBe(1);
  });

  it("session-removed drops the entry", async () => {
    link.metas = [wireMeta()];
    sessionStore.attach(link);
    await sessionStore.ready();
    sessionStore.mutate([sessionStore.get("s1")!]);
    link.push({ push: "session-removed", sessionIds: ["s1"] });
    expect(sessionStore.get("s1")).toBeUndefined();
    expect(sessionStore.getSnapshot()).toEqual([]);
  });

  it("a removal from one environment never drops the copy another environment holds", async () => {
    const box = new FakeLink();
    box.environmentId = "env_box";
    link.metas = [wireMeta()];
    sessionStore.attach(link);
    await sessionStore.ready();
    box.metas = [wireMeta({ title: "on the box" })];
    sessionStore.attach(box);
    await vi.waitFor(() => expect(sessionStore.environmentOf("s1")).toBe("env_box"));
    link.push({ push: "session-removed", sessionIds: ["s1"] });
    expect(sessionStore.metaOf("s1")?.title).toBe("on the box");
    box.push({ push: "session-removed", sessionIds: ["s1"] });
    expect(sessionStore.metaOf("s1")).toBeNull();
  });

  it("session-moved re-points an open thread to its new host and resumes it after its last seq", async () => {
    const box = new FakeLink();
    box.environmentId = "env_box";
    link.metas = [wireMeta()];
    link.events.set("s1", [row("s1", 1, { type: "user-text", text: "hi" }), row("s1", 2, { type: "assistant-text", text: "hello", delta: false })]);
    sessionStore.attach(link);
    sessionStore.attach(box);
    await sessionStore.ready();
    await sessionStore.ensureLoaded("s1");
    sessionStore.mutate([sessionStore.get("s1")!]);
    box.events.set("s1", [...link.events.get("s1")!, row("s1", 3, { type: "user-text", text: "on the box now" })]);
    const heard: string[][] = [];
    sessionStore.onSessionMoved((ids, from, to) => heard.push([...ids, from, to]));
    link.push({ push: "session-moved", id: "s1", sessionIds: ["s1"], to: "env_box" });
    link.push({ push: "session-removed", sessionIds: ["s1"] });
    expect(heard).toEqual([["s1", "local", "env_box"]]);
    expect(sessionStore.environmentOf("s1")).toBe("env_box");
    expect(sessionStore.getSnapshot().map((x) => x.id)).toEqual(["s1"]);
    await vi.waitFor(() => expect(sessionStore.get("s1")!.blocks).toHaveLength(3));
    const resumed = box.calls.find((c) => c.method === "session.events")?.params as { afterSeq: number };
    expect(resumed.afterSeq).toBe(2);
    expect(box.method("session.subscribe")).toBe(1);
    expect(link.calls.some((c) => c.method === "session.unsubscribe")).toBe(true);
  });

  it("a host's own id finds the environment that answers as it (the desktop's server is `local`)", async () => {
    sessionStore.connect({
      onLink: () => () => {},
      statusOf: (id: string) => ({ lastHello: id === "local" ? { environmentId: "env_mac_real" } : null }),
    });
    sessionStore.attach(link);
    expect(sessionStore.attachedEnvironmentFor("env_mac_real")).toBe("local");
    expect(sessionStore.hostIdOf("local")).toBe("env_mac_real");
    expect(sessionStore.attachedEnvironmentFor("env_other")).toBeUndefined();
  });

  it("folds live edits per session and path, keeping the first start", () => {
    sessionStore.attach(link);
    const edit = (over: Record<string, unknown>) =>
      ({ push: "live-edit", cwd: "/repo", sessionIds: ["s1"], edit: { path: "a.ts", kind: "changed", diff: "-a\n+b", adds: 1, dels: 1, ts: 10, ...over } }) as ServerPush;
    link.push(edit({}));
    link.push(edit({ diff: null, adds: undefined, dels: undefined, ts: 20, settled: true }));
    const state = sessionStore.liveEditsOf("s1")["a.ts"];
    expect(state).toMatchObject({ path: "a.ts", adds: 1, dels: 1, diff: "-a\n+b", state: "settled", startedTs: 10, ts: 20 });
    expect(sessionStore.liveEditsOf("nope")).toEqual({});
  });

  it("raises onSessionAdded for new top-level sessions pushed after boot, once", async () => {
    link.metas = [wireMeta({ id: "boot" })];
    sessionStore.attach(link);
    const added: string[] = [];
    sessionStore.onSessionAdded((m) => added.push(m.id));
    await sessionStore.ready();
    await Promise.resolve();
    link.push({ push: "session", session: wireMeta({ id: "boot", status: "running" }) });
    link.push({ push: "session", session: wireMeta({ id: "child", parentId: "boot" }) });
    link.push({ push: "session", session: wireMeta({ id: "old", archived: true }) });
    link.push({ push: "session", session: wireMeta({ id: "new", threadType: "implementation" }) });
    link.push({ push: "session", session: wireMeta({ id: "new", status: "running" }) });
    sessionStore.adopt(meta({ id: "new" }));
    sessionStore.adopt(meta({ id: "made" }));
    expect(added).toEqual(["new", "made"]);
  });

  it("requestOpen raises onOpenRequested for a known session, never onSessionAdded", async () => {
    link.metas = [wireMeta({ id: "boot" })];
    sessionStore.attach(link);
    const added: string[] = [];
    const asked: string[] = [];
    sessionStore.onSessionAdded((m) => added.push(m.id));
    sessionStore.onOpenRequested((m) => asked.push(m.id));
    await sessionStore.ready();
    sessionStore.requestOpen("boot");
    sessionStore.requestOpen("nope");
    expect(asked).toEqual(["boot"]);
    expect(added).toEqual([]);
  });

  it("requestOpen skips no one: an archived or child thread still comes forward", async () => {
    link.metas = [wireMeta({ id: "old", archived: true }), wireMeta({ id: "kid", parentId: "old" })];
    sessionStore.attach(link);
    const asked: string[] = [];
    sessionStore.onOpenRequested((m) => asked.push(m.id));
    await sessionStore.ready();
    sessionStore.requestOpen("old");
    sessionStore.requestOpen("kid");
    expect(asked).toEqual(["old", "kid"]);
  });

  it("adopting a thread the store already holds raises onSessionAdded no second time", async () => {
    link.metas = [];
    sessionStore.attach(link);
    const added: string[] = [];
    sessionStore.onSessionAdded((m) => added.push(m.id));
    await sessionStore.ready();
    sessionStore.adopt(meta({ id: "made" }));
    sessionStore.adopt(meta({ id: "made", status: "running" }));
    link.push({ push: "session", session: wireMeta({ id: "made", status: "idle" }) });
    expect(added).toEqual(["made"]);
  });
});

describe("M4 store fixes", () => {
  it("re-subscribes every open session after a reconnect", async () => {
    link.metas = [wireMeta(), wireMeta({ id: "s2" })];
    sessionStore.attach(link);
    await sessionStore.ready();
    await sessionStore.ensureLoaded("s1");
    await sessionStore.ensureLoaded("s2");
    expect(link.method("session.subscribe")).toBe(2);
    link.reopen();
    await new Promise((r) => setTimeout(r, 0));
    expect(link.method("session.subscribe")).toBe(4);
  });

  it("holds pushes that land during a replay and folds them once", async () => {
    link.metas = [wireMeta()];
    link.events.set("s1", [row("s1", 1, { type: "user-text", text: "hi" })]);
    sessionStore.attach(link);
    await sessionStore.ready();
    await sessionStore.ensureLoaded("s1");
    const late = row("s1", 2, { type: "assistant-text", text: "late", delta: false, msgId: "m", blockIndex: 0 });
    link.events.get("s1")!.push(late);
    link.reopen();
    // The replay is in flight: the server also pushes the same row live.
    link.push({ push: "event", row: late });
    link.push({ push: "event", row: row("s1", 3, { type: "turn-complete" }) });
    await new Promise((r) => setTimeout(r, 0));
    const s = sessionStore.get("s1")!;
    expect(s.blocks.map((b) => b.text)).toEqual(["hi", "late"]);
    expect(s.busy).toBe(false);
  });

  it("marks a session loaded once its history is in", async () => {
    link.metas = [wireMeta()];
    sessionStore.attach(link);
    await sessionStore.ready();
    expect(sessionStore.get("s1")?.loaded).toBeFalsy();
    await sessionStore.ensureLoaded("s1");
    expect(sessionStore.get("s1")?.loaded).toBe(true);
  });

  it("projects the tree flags off the meta", async () => {
    link.metas = [wireMeta({ treeCanContinue: true, treeHasLiveWork: true, treeHasPaused: false, treeFrozenActiveElapsed: 42 })];
    sessionStore.attach(link);
    await sessionStore.ready();
    await sessionStore.ensureLoaded("s1");
    expect(sessionStore.get("s1")).toMatchObject({ treeCanContinue: true, treeHasLiveWork: true, treeHasPaused: false, treeFrozenActiveElapsed: 42 });
    link.push({ push: "session", session: wireMeta({ treeCanContinue: false, treeHasLiveWork: false, treeHasPaused: true, treeFrozenActiveElapsed: null }) });
    expect(sessionStore.get("s1")).toMatchObject({ treeCanContinue: false, treeHasPaused: true, treeFrozenActiveElapsed: null });
  });
});

describe("context reading", () => {
  const compacted = (seq: number): EventRow =>
    row("s1", seq, { type: "compaction", phase: "done", trigger: "auto", preTokens: 180_000, postTokens: 4_400 });

  it("the meta's persisted reading beats the log's last compaction", async () => {
    link.metas = [wireMeta({ context: { tokens: 120_000, window: 200_000 } })];
    link.events.set("s1", [
      row("s1", 1, { type: "user-text", text: "q" }),
      compacted(2),
      row("s1", 3, { type: "assistant-text", text: "a", delta: false, msgId: "m", blockIndex: 0 }),
      row("s1", 4, { type: "turn-complete" }),
    ]);
    sessionStore.attach(link);
    await sessionStore.ready();
    expect(sessionStore.get("s1")?.context).toEqual({ used: 120_000, window: 200_000 });
    await sessionStore.ensureComplete("s1");
    expect(sessionStore.get("s1")?.context).toEqual({ used: 120_000, window: 200_000 });
    // A live compaction is reported through the meta too; the fold's number does not jump the queue.
    link.push({ push: "event", row: compacted(5) });
    expect(sessionStore.get("s1")?.context).toEqual({ used: 120_000, window: 200_000 });
    link.push({ push: "session", session: wireMeta({ context: { tokens: 4_400, window: 200_000 } }) });
    expect(sessionStore.get("s1")?.context).toEqual({ used: 4_400, window: 200_000 });
  });

  it("without a meta reading the fold's compaction count fills in", async () => {
    link.metas = [wireMeta()];
    link.events.set("s1", [row("s1", 1, { type: "user-text", text: "q" }), compacted(2), row("s1", 3, { type: "turn-complete" })]);
    sessionStore.attach(link);
    await sessionStore.ready();
    await sessionStore.ensureComplete("s1");
    expect(sessionStore.get("s1")?.context).toEqual({ used: 4_400 });
  });
});

describe("M4b projections", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  it("keeps the id list and shells stable through event pushes and busy flips", async () => {
    link.metas = [wireMeta({ title: "one" }), wireMeta({ id: "s2", title: "two" })];
    sessionStore.attach(link);
    await sessionStore.ready();
    await sessionStore.ensureLoaded("s1");
    await sessionStore.ensureLoaded("s2");
    sessionStore.mutate(() => [sessionStore.get("s1")!, sessionStore.get("s2")!]);
    const ids = sessionStore.getIds();
    const shells = sessionStore.getShells();
    expect([...ids]).toEqual(["s1", "s2"]);
    expect(shells.map((s) => s.title)).toEqual(["one", "two"]);
    expect(shells[0]).not.toHaveProperty("blocks");

    link.push({ push: "event", row: row("s1", 1, { type: "user-text", text: "q" }) });
    await new Promise((r) => setTimeout(r, 30));
    link.push({ push: "session", session: wireMeta({ title: "one", status: "running" }) });
    await tick();
    expect(sessionStore.get("s1")!.busy).toBe(true);
    expect(sessionStore.getIds()).toBe(ids);
    expect(sessionStore.getShells()).toBe(shells);

    // A shell field changing swaps only that shell.
    link.push({ push: "session", session: wireMeta({ title: "renamed", status: "running" }) });
    await tick();
    const next = sessionStore.getShells();
    expect(next).not.toBe(shells);
    expect(next[0].title).toBe("renamed");
    expect(next[1]).toBe(shells[1]);
    expect(sessionStore.getIds()).toBe(ids);

    // A change further down keeps every shell before it.
    link.push({ push: "session", session: wireMeta({ id: "s2", title: "two again" }) });
    await tick();
    const later = sessionStore.getShells();
    expect(later).not.toBe(next);
    expect(later[0]).toBe(next[0]);
    expect(later[1].title).toBe("two again");
    expect(later).toHaveLength(2);

    // Closing a session changes both.
    sessionStore.mutate((prev) => prev.filter((s) => s.id !== "s2"));
    expect([...sessionStore.getIds()]).toEqual(["s1"]);
    expect(sessionStore.getShells()).toHaveLength(1);
  });
});

describe("tail-first load", () => {
  /** `turns` user turns of three rows each: prompt, final text, turn-complete. */
  const log = (turns: number): EventRow[] => {
    const rows: EventRow[] = [];
    for (let t = 0; t < turns; t++) {
      rows.push(row("s1", t * 3 + 1, { type: "user-text", text: `q${t}` }));
      rows.push(row("s1", t * 3 + 2, { type: "assistant-text", text: `a${t}`, delta: false, msgId: `m${t}`, blockIndex: 0 }));
      rows.push(row("s1", t * 3 + 3, { type: "turn-complete" }));
    }
    return rows;
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("paints the last 300 rows first and folds the head behind them with stable ids", async () => {
    link.metas = [wireMeta()];
    link.events.set("s1", log(200));
    let release: () => void = () => {};
    link.holdHead = new Promise((r) => (release = r));
    sessionStore.attach(link);
    await sessionStore.ready();
    await sessionStore.ensureLoaded("s1");
    const tail = sessionStore.get("s1")!;
    expect(tail.loaded).toBe(true);
    expect(sessionStore.isComplete("s1")).toBe(false);
    expect(tail.blocks).toHaveLength(300);
    expect(tail.blocks[0]).toMatchObject({ role: "user", text: "q50" });
    const tailIds = tail.blocks.map((b) => b.id);
    const calls = link.calls.filter((c) => c.method === "session.events").map((c) => c.params);
    expect(calls).toEqual([
      { sessionId: "s1", afterSeq: 0, tail: 300 },
      { sessionId: "s1", afterSeq: 0, beforeSeq: 151, limit: 4000 },
    ]);
    release();
    await sessionStore.ensureComplete("s1");
    const whole = sessionStore.get("s1")!;
    expect(whole.blocks).toHaveLength(400);
    expect(whole.blocks.slice(100).map((b) => b.id)).toEqual(tailIds);
    expect(whole.blocks[0]).toMatchObject({ role: "user", text: "q0" });
    expect(sessionStore.isComplete("s1")).toBe(true);
    expect(link.method("session.events")).toBe(2);
    // lastSeq is the log's end: a reconnect replays nothing.
    link.reopen();
    await tick();
    expect(link.calls.filter((c) => c.method === "session.events").at(-1)?.params).toEqual({ sessionId: "s1", afterSeq: 600 });
  });

  it("a push during the head fetch survives the refold, in order", async () => {
    link.metas = [wireMeta()];
    link.events.set("s1", log(200));
    let release: () => void = () => {};
    link.holdHead = new Promise((r) => (release = r));
    sessionStore.attach(link);
    await sessionStore.ready();
    await sessionStore.ensureLoaded("s1");
    link.push({ push: "event", row: row("s1", 601, { type: "user-text", text: "late" }) });
    expect(sessionStore.get("s1")!.blocks).toHaveLength(301);
    expect(sessionStore.get("s1")!.busy).toBe(true);
    release();
    await sessionStore.ensureComplete("s1");
    const s = sessionStore.get("s1")!;
    expect(s.blocks).toHaveLength(401);
    expect(s.blocks.at(-1)).toMatchObject({ role: "user", text: "late" });
    expect(s.busy).toBe(true);
    link.reopen();
    await tick();
    expect(link.calls.filter((c) => c.method === "session.events").at(-1)?.params).toEqual({ sessionId: "s1", afterSeq: 601 });
  });

  it("a short log arrives whole in one request", async () => {
    link.metas = [wireMeta()];
    link.events.set("s1", log(5));
    sessionStore.attach(link);
    await sessionStore.ready();
    await sessionStore.ensureLoaded("s1");
    expect(sessionStore.isComplete("s1")).toBe(true);
    expect(sessionStore.get("s1")!.blocks).toHaveLength(10);
    await sessionStore.ensureComplete("s1");
    expect(link.method("session.events")).toBe(1);
  });
});

describe("meta push coalescing", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("many session pushes in one tick reach meta listeners once, after the flush", async () => {
    link.metas = [wireMeta()];
    sessionStore.attach(link);
    await sessionStore.ready();
    let metaCalls = 0;
    let storeCalls = 0;
    sessionStore.onMetaChange(() => metaCalls++);
    sessionStore.subscribe(() => storeCalls++);
    for (let i = 1; i <= 50; i++) {
      link.push({ push: "session", session: wireMeta({ title: `t${i}`, updatedAt: i }) });
    }
    expect(metaCalls).toBe(0);
    expect(storeCalls).toBe(0);
    await flush();
    expect(metaCalls).toBe(1);
    expect(storeCalls).toBe(1);
  });

  it("metaOf and metas() read the newest push at once, and metas() is stable between changes", async () => {
    link.metas = [wireMeta()];
    sessionStore.attach(link);
    await sessionStore.ready();
    const before = sessionStore.metas();
    expect(sessionStore.metas()).toBe(before);
    link.push({ push: "session", session: wireMeta({ title: "fresh", updatedAt: 9 }) });
    expect(sessionStore.metaOf("s1")?.title).toBe("fresh");
    const after = sessionStore.metas();
    expect(after).not.toBe(before);
    expect(after[0].title).toBe("fresh");
    expect(sessionStore.metas()).toBe(after);
    link.push({ push: "session-removed", sessionIds: ["s1"] });
    expect(sessionStore.metaOf("s1")).toBeNull();
    expect(sessionStore.metas()).toEqual([]);
  });

  it("a synchronous bump from a local action delivers the pending meta notification with it", async () => {
    link.metas = [wireMeta()];
    sessionStore.attach(link);
    await sessionStore.ready();
    let metaCalls = 0;
    sessionStore.onMetaChange(() => metaCalls++);
    link.push({ push: "session", session: wireMeta({ title: "pushed" }) });
    expect(metaCalls).toBe(0);
    sessionStore.mutate([sessionStore.get("s1")!]);
    expect(metaCalls).toBe(1);
    await flush();
    expect(metaCalls).toBe(1);
  });

  it("event pushes are no longer flushed early by a meta push", async () => {
    link.metas = [wireMeta()];
    sessionStore.attach(link);
    await sessionStore.ready();
    await sessionStore.ensureLoaded("s1");
    sessionStore.mutate([sessionStore.get("s1")!]);
    let storeCalls = 0;
    sessionStore.subscribe(() => storeCalls++);
    link.push({ push: "event", row: row("s1", 1, { type: "user-text", text: "q" }) });
    link.push({ push: "session", session: wireMeta({ status: "running" }) });
    link.push({ push: "event", row: row("s1", 2, { type: "assistant-text", text: "a", delta: true, msgId: "m", blockIndex: 0 }) });
    expect(storeCalls).toBe(0);
    await flush();
    expect(storeCalls).toBe(1);
    expect(sessionStore.get("s1")!.blocks).toHaveLength(2);
  });
});

describe("archived metas on demand", () => {
  it("the boot list carries no archived threads; ensureArchived fetches one project's", async () => {
    link.metas = [wireMeta({ id: "live", projectId: "p1" })];
    link.archivedMetas = [
      wireMeta({ id: "old1", projectId: "p1", archived: true }),
      wireMeta({ id: "old2", projectId: "p2", archived: true }),
    ];
    sessionStore.attach(link);
    await sessionStore.ready();
    expect(sessionStore.metas().map((m) => m.id)).toEqual(["live"]);
    expect(link.calls.filter((c) => c.method === "session.list")).toHaveLength(1);
    await sessionStore.ensureArchived("local", "p1");
    await sessionStore.ensureArchived("local", "p1");
    expect(sessionStore.metas().map((m) => m.id).sort()).toEqual(["live", "old1"]);
    expect(link.calls.filter((c) => c.method === "session.list")).toHaveLength(2);
    // a resync re-lists the loaded scope and keeps it
    await sessionStore.resync(link);
    expect(sessionStore.metas().map((m) => m.id).sort()).toEqual(["live", "old1"]);
  });

  it("ensureMeta reaches an archived thread the live list left out", async () => {
    link.metas = [];
    link.archivedMetas = [wireMeta({ id: "old", archived: true })];
    sessionStore.attach(link);
    await sessionStore.ready();
    expect(sessionStore.metaOf("old")).toBeNull();
    expect((await sessionStore.ensureMeta("old"))?.id).toBe("old");
  });

  it("an archived meta that arrived by push survives a resync", async () => {
    link.metas = [wireMeta({ id: "a" })];
    sessionStore.attach(link);
    await sessionStore.ready();
    link.push({ push: "session", session: wireMeta({ id: "a", archived: true }) });
    link.metas = [];
    await sessionStore.resync(link);
    expect(sessionStore.metaOf("a")?.archived).toBe(true);
    // once its scope is listed and it is gone, it goes
    await sessionStore.ensureArchived("local");
    await sessionStore.resync(link);
    expect(sessionStore.metaOf("a")).toBeNull();
  });
});

describe("the mounted set", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  /** `n` settled turns: a prompt and its turn-complete, so the fold leaves the session idle. */
  const rowsFor = (id: string, n: number): EventRow[] =>
    Array.from({ length: n }, (_, i) => [
      row(id, i * 2 + 1, { type: "user-text", text: `q${i}` }),
      row(id, i * 2 + 2, { type: "turn-complete" }),
    ]).flat();

  it("a reconnect replays only the mounted transcripts and unloads the rest", async () => {
    link.metas = [wireMeta({ id: "a" }), wireMeta({ id: "b" }), wireMeta({ id: "kid", parentId: "a" })];
    for (const id of ["a", "b", "kid"]) link.events.set(id, rowsFor(id, 2));
    sessionStore.attach(link);
    await sessionStore.ready();
    await Promise.all(["a", "b", "kid"].map((id) => sessionStore.ensureLoaded(id, "test")));
    expect(sessionStore.loadedCount()).toBe(3);
    sessionStore.setMounted(["a"]);
    link.calls.length = 0;
    link.reopen();
    await tick();
    await tick();
    const replayed = link.calls.filter((c) => c.method === "session.events").map((c) => (c.params as { sessionId: string }).sessionId).sort();
    // a and its child replay; b is dropped
    expect(replayed).toEqual(["a", "kid"]);
    expect(sessionStore.get("b")?.loaded).toBe(false);
    expect(sessionStore.get("b")?.blocks).toEqual([]);
    expect(sessionStore.get("a")?.loaded).toBe(true);
    expect(sessionStore.loadedCount()).toBe(2);
    // and b loads again when asked, from the start
    await sessionStore.ensureLoaded("b", "test");
    expect(sessionStore.get("b")?.blocks).toHaveLength(2);
    expect(link.calls.filter((c) => c.method === "session.events").at(-1)?.params).toMatchObject({ sessionId: "b", afterSeq: 0 });
  });

  it("a mounted master keeps its batch threads' transcripts (and their subagents'): the board opens them in its own pane", async () => {
    link.metas = [
      wireMeta({ id: "m", isMaster: true }),
      wireMeta({ id: "child", masterId: "m" }),
      wireMeta({ id: "kid", parentId: "child" }),
      wireMeta({ id: "other" }),
    ];
    for (const id of ["child", "kid", "other"]) link.events.set(id, rowsFor(id, 2));
    sessionStore.attach(link);
    await sessionStore.ready();
    await Promise.all(["child", "kid", "other"].map((id) => sessionStore.ensureLoaded(id, "test")));
    vi.useFakeTimers();
    try {
      sessionStore.setMounted(["m"]);
      await vi.advanceTimersByTimeAsync(3100);
    } finally {
      vi.useRealTimers();
    }
    expect(sessionStore.get("child")?.loaded).toBe(true);
    expect(sessionStore.get("kid")?.loaded).toBe(true);
    expect(sessionStore.get("other")?.loaded).toBe(false);
  });

  it("a transcript whose tab left the warm set unloads after the grace period, unless busy", async () => {
    link.metas = [wireMeta({ id: "a" }), wireMeta({ id: "b" }), wireMeta({ id: "busy", status: "running" })];
    for (const id of ["a", "b"]) link.events.set(id, rowsFor(id, 2));
    // a prompt with no completion yet: the fold keeps it busy
    link.events.set("busy", [row("busy", 1, { type: "user-text", text: "go" })]);
    sessionStore.attach(link);
    await sessionStore.ready();
    await Promise.all(["a", "b", "busy"].map((id) => sessionStore.ensureLoaded(id, "test")));
    expect(sessionStore.loadedCount()).toBe(3);
    vi.useFakeTimers();
    try {
      sessionStore.setMounted(["a"]);
      await vi.advanceTimersByTimeAsync(3100);
    } finally {
      vi.useRealTimers();
    }
    expect(sessionStore.get("a")?.loaded).toBe(true);
    expect(sessionStore.get("b")?.loaded).toBe(false);
    expect(sessionStore.get("busy")?.loaded).toBe(true);
    expect(link.calls.filter((c) => c.method === "session.unsubscribe").map((c) => (c.params as { sessionId: string }).sessionId)).toEqual(["b"]);
  });

  it("the recently shown stay loaded and subscribed after their pane leaves, the latest KEEP_RECENT; a switch back fetches nothing", async () => {
    const ids = Array.from({ length: KEEP_RECENT + 2 }, (_, i) => `r${i}`);
    link.metas = [...ids, "never"].map((id) => wireMeta({ id }));
    for (const id of [...ids, "never"]) link.events.set(id, rowsFor(id, 2));
    sessionStore.attach(link);
    await sessionStore.ready();
    await sessionStore.ensureLoaded("never", "test");
    vi.useFakeTimers();
    try {
      // One pane, switched through every thread in turn.
      for (const id of ids) {
        sessionStore.setMounted([id]);
        await sessionStore.ensureLoaded(id, "test");
      }
      await vi.advanceTimersByTimeAsync(3100);
    } finally {
      vi.useRealTimers();
    }
    const shown = ids.at(-1)!;
    const kept = ids.slice(-1 - KEEP_RECENT, -1);
    const dropped = ids.slice(0, ids.length - 1 - KEEP_RECENT);
    expect(sessionStore.get(shown)?.loaded).toBe(true);
    for (const id of kept) expect(sessionStore.get(id)?.loaded).toBe(true);
    for (const id of [...dropped, "never"]) expect(sessionStore.get(id)?.loaded).toBe(false);
    const unsubscribed = link.calls.filter((c) => c.method === "session.unsubscribe").map((c) => (c.params as { sessionId: string }).sessionId);
    expect(unsubscribed.sort()).toEqual([...dropped, "never"].sort());
    // Back to a kept one: loaded already, no request.
    link.calls.length = 0;
    sessionStore.setMounted([kept[0]]);
    await sessionStore.ensureLoaded(kept[0], "test");
    expect(link.calls.filter((c) => c.method === "session.events")).toEqual([]);
    // A row pushed to a kept thread while it was off screen is already folded.
    link.push({ push: "event", row: row(kept[1], 5, { type: "user-text", text: "while away" }) });
    expect(sessionStore.get(kept[1])?.blocks.at(-1)?.text).toBe("while away");
    // A reconnect replays the kept ones' gaps with the mounted one's.
    link.calls.length = 0;
    link.reopen();
    await tick();
    await tick();
    const replayed = link.calls.filter((c) => c.method === "session.events").map((c) => (c.params as { sessionId: string }).sessionId);
    expect(replayed.sort()).toEqual([shown, ...kept].sort());
  });

  it("a burst of loads reports itself once, naming the callers", async () => {
    link.metas = Array.from({ length: 30 }, (_, i) => wireMeta({ id: `s${i}` }));
    sessionStore.attach(link);
    await sessionStore.ready();
    for (let i = 0; i < 25; i++) await sessionStore.ensureLoaded(`s${i}`, i < 20 ? "pane" : "agents");
    const reports = link.calls.filter((c) => c.method === "stall.report").map((c) => (c.params as { line: string }).line);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/^transcript-burst 21 loads in 10s \(pane=20,agents=1\)/);
    for (let i = 25; i < 30; i++) await sessionStore.ensureLoaded(`s${i}`, "agents");
    expect(link.calls.filter((c) => c.method === "stall.report")).toHaveLength(1);
  });

  it("a long head loads in slices", async () => {
    link.metas = [wireMeta()];
    const rows: EventRow[] = [];
    for (let i = 0; i < 9000; i++) rows.push(row("s1", i + 1, { type: "user-text", text: `q${i}` }));
    link.events.set("s1", rows);
    sessionStore.attach(link);
    await sessionStore.ready();
    await sessionStore.ensureComplete("s1");
    const calls = link.calls.filter((c) => c.method === "session.events").map((c) => c.params as Record<string, unknown>);
    expect(calls[0]).toEqual({ sessionId: "s1", afterSeq: 0, tail: 300 });
    const head = calls.slice(1);
    expect(head.map((c) => c.limit)).toEqual([4000, 4000, 4000]);
    expect(head.map((c) => c.afterSeq)).toEqual([0, 4000, 8000]);
    expect(sessionStore.get("s1")?.blocks).toHaveLength(9000);
  });
});

describe("the load phase", () => {
  afterEach(() => vi.useRealTimers());

  const phase = (id = "s1") => sessionStore.get(id)?.load?.phase;

  it("a first load reads loading, slow once 8 s pass, and loaded on the answer", async () => {
    vi.useFakeTimers();
    link.metas = [wireMeta()];
    link.events.set("s1", [row("s1", 1, { type: "user-text", text: "hi" })]);
    sessionStore.attach(link);
    await sessionStore.ready();
    expect(phase()).toBe("loading");
    let release!: () => void;
    link.holdEvents = new Promise<void>((r) => (release = r));
    const since = Date.now();
    const loaded = sessionStore.ensureLoaded("s1");
    expect(sessionStore.get("s1")?.load).toEqual({ phase: "loading", since, attempt: 0 });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(phase()).toBe("loading");
    await vi.advanceTimersByTimeAsync(1);
    expect(sessionStore.get("s1")?.load).toEqual({ phase: "slow", since, attempt: 0 });
    expect(sessionStore.get("s1")?.blocks).toEqual([]);
    release();
    await loaded;
    expect(phase()).toBe("loaded");
    expect(sessionStore.get("s1")?.loaded).toBe(true);
    expect(sessionStore.get("s1")?.blocks.map((b) => b.text)).toEqual(["hi"]);
    // Nothing flips it back once the answer is in.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(phase()).toBe("loaded");
  });

  it("a failed first load says why and retries by itself after 1, 2, 4 s, on the same socket", async () => {
    vi.useFakeTimers();
    link.metas = [wireMeta()];
    link.events.set("s1", [row("s1", 1, { type: "user-text", text: "hi" })]);
    sessionStore.attach(link);
    await sessionStore.ready();
    link.eventErrors = [
      new ConnectionLostError("connection closed"),
      new TimeoutError("session.events", 30_000),
      new ConnectionLostError("connection closed"),
    ];
    const first = await sessionStore.ensureLoaded("s1").catch((e: unknown) => e);
    expect((first as Error).message).toBe("connection closed");
    const since = sessionStore.get("s1")!.load!.since;
    expect(sessionStore.get("s1")?.load).toEqual({ phase: "failed", since, attempt: 1, error: "connection closed", retryAt: Date.now() + 1_000 });
    expect(link.method("session.events")).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(link.method("session.events")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(link.method("session.events")).toBe(2);
    expect(sessionStore.get("s1")?.load).toMatchObject({ phase: "failed", attempt: 2, error: "timed out", retryAt: Date.now() + 2_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sessionStore.get("s1")?.load).toMatchObject({ phase: "failed", attempt: 3, retryAt: Date.now() + 4_000 });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(link.method("session.events")).toBe(4);
    expect(sessionStore.get("s1")?.load).toEqual({ phase: "loaded", since, attempt: 0, empty: false });
    expect(sessionStore.get("s1")?.blocks.map((b) => b.text)).toEqual(["hi"]);
    // No reconnect was needed: the list ran once.
    expect(link.method("session.list")).toBe(1);
  });

  it("Retry now tries a failed load at once; a load nobody shows stops retrying", async () => {
    vi.useFakeTimers();
    link.metas = [wireMeta(), wireMeta({ id: "s2" })];
    sessionStore.attach(link);
    await sessionStore.ready();
    link.eventErrors = [new ConnectionLostError("connection closed")];
    await sessionStore.ensureLoaded("s1").catch(() => undefined);
    expect(phase("s1")).toBe("failed");
    sessionStore.retryLoad("s1");
    await vi.advanceTimersByTimeAsync(0);
    expect(phase("s1")).toBe("loaded");
    expect(link.method("session.events")).toBe(2);
    // s2 keeps failing, then leaves the mounted set: after the grace period
    // it reads as not started and no longer retries.
    link.eventErrors = Array.from({ length: 20 }, () => new ConnectionLostError("connection closed"));
    await sessionStore.ensureLoaded("s2").catch(() => undefined);
    sessionStore.setMounted(["s1"]);
    await vi.advanceTimersByTimeAsync(3_000);
    // Its next try finds it outside the mounted set and stops there.
    expect(link.method("session.events")).toBe(3);
    expect(phase("s2")).toBe("loading");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(link.method("session.events")).toBe(3);
  });

  it("a host's own refusal fails without retrying until Retry now", async () => {
    vi.useFakeTimers();
    link.metas = [wireMeta()];
    sessionStore.attach(link);
    await sessionStore.ready();
    link.eventErrors = [new Error("unknown session")];
    await sessionStore.ensureLoaded("s1").catch(() => undefined);
    expect(sessionStore.get("s1")?.load).toMatchObject({ phase: "failed", attempt: 1, error: "unknown session" });
    expect(sessionStore.get("s1")?.load?.retryAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(link.method("session.events")).toBe(1);
    sessionStore.retryLoad("s1");
    await vi.advanceTimersByTimeAsync(0);
    expect(phase()).toBe("loaded");
  });

  it("a first load that fails after pushes landed starts over from the tail, unsubscribed meanwhile", async () => {
    vi.useFakeTimers();
    link.metas = [wireMeta()];
    link.events.set("s1", [row("s1", 1, { type: "user-text", text: "first" }), row("s1", 2, { type: "user-text", text: "second" })]);
    sessionStore.attach(link);
    await sessionStore.ready();
    let release!: () => void;
    link.holdEvents = new Promise<void>((r) => (release = r));
    link.eventErrors = [new TimeoutError("session.events", 30_000)];
    const failed = sessionStore.ensureLoaded("s1").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    // A live row arrives while the first fetch waits, then the fetch times out.
    link.push({ push: "event", row: row("s1", 3, { type: "user-text", text: "live" }) });
    release();
    expect(await failed).toBeInstanceOf(TimeoutError);
    expect(sessionStore.get("s1")?.blocks).toEqual([]);
    expect(link.method("session.unsubscribe")).toBe(1);
    link.holdEvents = null;
    link.events.get("s1")!.push(row("s1", 3, { type: "user-text", text: "live" }));
    await vi.advanceTimersByTimeAsync(1_000);
    const retry = link.calls.filter((c) => c.method === "session.events").at(-1)?.params as { afterSeq?: number; tail?: number };
    expect(retry).toMatchObject({ afterSeq: 0, tail: 300 });
    expect(sessionStore.get("s1")?.blocks.map((b) => b.text)).toEqual(["first", "second", "live"]);
  });

  it("a failed load whose pane closed while it was in flight stops at its next try", async () => {
    vi.useFakeTimers();
    link.metas = [wireMeta()];
    sessionStore.attach(link);
    await sessionStore.ready();
    sessionStore.setMounted(["s1"]);
    let release!: () => void;
    link.holdEvents = new Promise<void>((r) => (release = r));
    link.eventErrors = [new TimeoutError("session.events", 30_000)];
    const failed = sessionStore.ensureLoaded("s1").catch(() => undefined);
    sessionStore.setMounted([]);
    await vi.advanceTimersByTimeAsync(3_000);
    release();
    await failed;
    expect(phase()).toBe("failed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(link.method("session.events")).toBe(1);
    expect(phase()).toBe("loading");
  });

  it("a draft whose host has not listed reads slow after 8 s", async () => {
    vi.useFakeTimers();
    sessionStore.mutate([{ ...newSession("local", "claude", "/repo"), id: "stub" }]);
    expect(phase("stub")).toBe("loading");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(phase("stub")).toBe("slow");
  });

  it("a draft reads loading until its host has listed, and a new one after that is loaded", async () => {
    const early = { ...newSession("local", "claude", "/repo"), id: "early" };
    sessionStore.mutate([early]);
    expect(phase("early")).toBe("loading");
    sessionStore.attach(link);
    await sessionStore.ready();
    await vi.waitFor(() => expect(phase("early")).toBe("loaded"));
    const late = { ...newSession("local", "claude", "/repo"), id: "late" };
    sessionStore.mutate((prev) => [...prev, late]);
    expect(phase("late")).toBe("loaded");
    // An updater never sets the phase: the store keeps its own.
    sessionStore.mutate((prev) => prev.map((s) => ({ ...s, load: undefined })));
    expect(phase("late")).toBe("loaded");
  });

  it("a layout stub the host claims stays loading until its rows are in, never loaded-empty", async () => {
    link.metas = [wireMeta()];
    link.events.set("s1", [row("s1", 1, { type: "user-text", text: "hi" })]);
    let release!: () => void;
    link.holdEvents = new Promise<void>((r) => (release = r));
    sessionStore.mutate([{ ...newSession("local", "claude", "/repo"), id: "s1" }]);
    expect(phase()).toBe("loading");
    sessionStore.attach(link);
    await vi.waitFor(() => expect(link.method("session.events")).toBe(1));
    expect(sessionStore.isDraft("s1")).toBe(false);
    expect(phase()).toBe("loading");
    expect(sessionStore.get("s1")?.blocks).toEqual([]);
    release();
    await vi.waitFor(() => expect(phase()).toBe("loaded"));
    expect(sessionStore.get("s1")?.blocks.map((b) => b.text)).toEqual(["hi"]);
  });
});
