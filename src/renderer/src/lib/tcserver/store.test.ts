import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newSession } from "../session";
import { applyMeta, sessionFromMeta, sessionStore, type Link } from "./store";
import type { EventRow, ServerPush, SessionMeta } from "./types";

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: null,
    planPath: null,
    provider: "claude",
    model: "claude-sonnet-5",
    reasoning: "medium",
    agentType: "implementer",
    title: "claude · implementer",
    cwd: "/repo",
    status: "idle",
    archived: false,
    pinned: false,
    permission: "edits",
    fast: false,
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

const row = (sessionId: string, seq: number, event: EventRow["event"]): EventRow => ({
  sessionId,
  seq,
  ts: 1_000 + seq,
  event,
});

class FakeLink implements Link {
  connected = true;
  calls: { method: string; params: unknown }[] = [];
  metas: SessionMeta[] = [];
  events = new Map<string, EventRow[]>();
  private pushListeners = new Set<(push: ServerPush) => void>();
  private openListeners = new Set<() => void>();

  request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "session.list") return Promise.resolve(this.metas as T);
    if (method === "session.events") {
      const { sessionId, afterSeq } = params as { sessionId: string; afterSeq: number };
      const rows = (this.events.get(sessionId) ?? []).filter((r) => r.seq > afterSeq);
      return Promise.resolve(rows as T);
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
    expect(s.model).toBe("claude:sonnet-5");
    expect(s.runtimeMode).toBe("full-access");
    expect(s.busy).toBe(true);
    expect(s.modelSettings.effort).toBe("high");
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
    sessionStore.connect(link);
    await sessionStore.ready();
    const draft = newSession("claude", "/repo", undefined, undefined, undefined, { threadType: "planning" });
    sessionStore.mutate([draft]);
    expect(sessionStore.get(draft.id)?.threadType).toBe("planning");
    sessionStore.adopt(meta({ id: draft.id, threadType: "planning", planPath: "/repo/.temp-code/plan-x.md" }));
    expect(sessionStore.get(draft.id)?.planPath).toBe("/repo/.temp-code/plan-x.md");
  });
});

describe("sessionStore", () => {
  it("lists metas on connect without opening them", async () => {
    link.metas = [meta(), meta({ id: "s2", title: "two" })];
    sessionStore.connect(link);
    await sessionStore.ready();
    expect(sessionStore.metas().map((m) => m.id)).toEqual(["s1", "s2"]);
    expect(sessionStore.getSnapshot()).toEqual([]);
    expect(sessionStore.isDraft("s1")).toBe(false);
    expect(sessionStore.isDraft("nope")).toBe(true);
  });

  it("loads a transcript lazily, once, and subscribes", async () => {
    link.metas = [meta()];
    link.events.set("s1", [
      row("s1", 1, { type: "user-text", text: "hi" }),
      row("s1", 2, { type: "assistant-text", text: "yo", delta: false, msgId: "m", blockIndex: 0 }),
      row("s1", 3, { type: "turn-complete" }),
    ]);
    sessionStore.connect(link);
    await sessionStore.ready();
    await Promise.all([sessionStore.ensureLoaded("s1"), sessionStore.ensureLoaded("s1")]);
    expect(link.method("session.subscribe")).toBe(1);
    expect(link.method("session.events")).toBe(1);
    const s = sessionStore.get("s1")!;
    expect(s.blocks.map((b) => b.role)).toEqual(["user", "assistant"]);
    expect(s.busy).toBe(false);
  });

  it("folds event pushes into open sessions and notifies", async () => {
    link.metas = [meta()];
    sessionStore.connect(link);
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
    link.metas = [meta()];
    link.events.set("s1", [row("s1", 1, { type: "user-text", text: "hi" })]);
    sessionStore.connect(link);
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
    link.metas = [meta()];
    sessionStore.connect(link);
    await sessionStore.ready();
    sessionStore.mutate([{ ...sessionStore.get("s1")!, composerSeed: "draft text" }]);
    link.push({ push: "session", session: meta({ title: "Real title", status: "running" }) });
    const s = sessionStore.getSnapshot()[0];
    expect(s.title).toBe("Real title");
    expect(s.busy).toBe(true);
    expect(s.composerSeed).toBe("draft text");
  });

  it("drafts open through mutate and adopt their server meta on create", async () => {
    sessionStore.connect(link);
    await sessionStore.ready();
    const draft = newSession("claude", "/repo");
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
    link.metas = [meta({ status: "running" })];
    sessionStore.connect(link);
    await sessionStore.ready();
    sessionStore.mutate([sessionStore.get("s1")!]);
    let settled = false;
    const wait = sessionStore.waitIdle("s1").then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    link.push({ push: "session", session: meta({ status: "idle" }) });
    await wait;
    expect(settled).toBe(true);
  });

  it("closing a session in the updater keeps its transcript cached", async () => {
    link.metas = [meta()];
    link.events.set("s1", [row("s1", 1, { type: "user-text", text: "hi" })]);
    sessionStore.connect(link);
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
    link.metas = [meta()];
    sessionStore.connect(link);
    await sessionStore.ready();
    sessionStore.mutate([sessionStore.get("s1")!]);
    link.push({ push: "session-removed", sessionIds: ["s1"] });
    expect(sessionStore.get("s1")).toBeUndefined();
    expect(sessionStore.getSnapshot()).toEqual([]);
  });

  it("folds live edits per session and path, keeping the first start", () => {
    sessionStore.connect(link);
    const edit = (over: Record<string, unknown>) =>
      ({ push: "live-edit", cwd: "/repo", sessionIds: ["s1"], edit: { path: "a.ts", kind: "changed", diff: "-a\n+b", adds: 1, dels: 1, ts: 10, ...over } }) as ServerPush;
    link.push(edit({}));
    link.push(edit({ diff: null, adds: undefined, dels: undefined, ts: 20, settled: true }));
    const state = sessionStore.liveEditsOf("s1")["a.ts"];
    expect(state).toMatchObject({ path: "a.ts", adds: 1, dels: 1, diff: "-a\n+b", state: "settled", startedTs: 10, ts: 20 });
    expect(sessionStore.liveEditsOf("nope")).toEqual({});
  });

  it("raises onSessionAdded for new top-level sessions pushed after boot, once", async () => {
    link.metas = [meta({ id: "boot" })];
    sessionStore.connect(link);
    const added: string[] = [];
    sessionStore.onSessionAdded((m) => added.push(m.id));
    await sessionStore.ready();
    await Promise.resolve();
    link.push({ push: "session", session: meta({ id: "boot", status: "running" }) });
    link.push({ push: "session", session: meta({ id: "child", parentId: "boot" }) });
    link.push({ push: "session", session: meta({ id: "old", archived: true }) });
    link.push({ push: "session", session: meta({ id: "new", threadType: "implementation" }) });
    link.push({ push: "session", session: meta({ id: "new", status: "running" }) });
    sessionStore.adopt(meta({ id: "new" }));
    sessionStore.adopt(meta({ id: "made" }));
    expect(added).toEqual(["new", "made"]);
  });
});

describe("M4 store fixes", () => {
  it("re-subscribes every open session after a reconnect", async () => {
    link.metas = [meta(), meta({ id: "s2" })];
    sessionStore.connect(link);
    await sessionStore.ready();
    await sessionStore.ensureLoaded("s1");
    await sessionStore.ensureLoaded("s2");
    expect(link.method("session.subscribe")).toBe(2);
    link.reopen();
    await new Promise((r) => setTimeout(r, 0));
    expect(link.method("session.subscribe")).toBe(4);
  });

  it("holds pushes that land during a replay and folds them once", async () => {
    link.metas = [meta()];
    link.events.set("s1", [row("s1", 1, { type: "user-text", text: "hi" })]);
    sessionStore.connect(link);
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
    link.metas = [meta()];
    sessionStore.connect(link);
    await sessionStore.ready();
    expect(sessionStore.get("s1")?.loaded).toBeFalsy();
    await sessionStore.ensureLoaded("s1");
    expect(sessionStore.get("s1")?.loaded).toBe(true);
  });

  it("projects the tree flags off the meta", async () => {
    link.metas = [meta({ treeCanContinue: true, treeHasLiveWork: true, treeHasPaused: false, treeFrozenActiveElapsed: 42 })];
    sessionStore.connect(link);
    await sessionStore.ready();
    await sessionStore.ensureLoaded("s1");
    expect(sessionStore.get("s1")).toMatchObject({ treeCanContinue: true, treeHasLiveWork: true, treeHasPaused: false, treeFrozenActiveElapsed: 42 });
    link.push({ push: "session", session: meta({ treeCanContinue: false, treeHasLiveWork: false, treeHasPaused: true, treeFrozenActiveElapsed: null }) });
    expect(sessionStore.get("s1")).toMatchObject({ treeCanContinue: false, treeHasPaused: true, treeFrozenActiveElapsed: null });
  });
});

describe("M4b projections", () => {
  it("keeps the id list and shells stable through event pushes and busy flips", async () => {
    link.metas = [meta({ title: "one" }), meta({ id: "s2", title: "two" })];
    sessionStore.connect(link);
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
    link.push({ push: "session", session: meta({ title: "one", status: "running" }) });
    expect(sessionStore.get("s1")!.busy).toBe(true);
    expect(sessionStore.getIds()).toBe(ids);
    expect(sessionStore.getShells()).toBe(shells);

    // A shell field changing swaps only that shell.
    link.push({ push: "session", session: meta({ title: "renamed", status: "running" }) });
    const next = sessionStore.getShells();
    expect(next).not.toBe(shells);
    expect(next[0].title).toBe("renamed");
    expect(next[1]).toBe(shells[1]);
    expect(sessionStore.getIds()).toBe(ids);

    // A change further down keeps every shell before it.
    link.push({ push: "session", session: meta({ id: "s2", title: "two again" }) });
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
