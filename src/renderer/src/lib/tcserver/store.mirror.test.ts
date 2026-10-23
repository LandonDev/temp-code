import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOT_SETTLE_MS, sessionStore, type Link } from "./store";
import type { ServerPush, SessionMeta } from "./types";
import type { SessionChanges } from "@server/shared/wire";
import type { MirrorHost } from "@server/shared/launchMirror";

/**
 * The launch mirror under the store: rows painted before any socket, the
 * resume from a cursor (`session.changes`), the whole list on `reset`, the
 * boot prune's settle deadline, and the quiet reconcile (a changed row
 * updated in place, a gone row dropped, an untouched one the same object).
 */

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    environmentId: "box",
    id: "s1",
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: "chat",
    planPath: null,
    provider: "claude",
    model: "claude-sonnet-5-5",
    reasoning: "medium",
    agentType: "implementer",
    title: "thread",
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

const wire = (over: Partial<SessionMeta> = {}): Omit<SessionMeta, "environmentId"> => {
  const { environmentId: _e, ...rest } = meta(over);
  return rest;
};

const host = (environmentId: string, sessions: SessionMeta[], cursor: MirrorHost["cursor"] = null): MirrorHost => ({
  environmentId,
  cursor,
  workspaces: [],
  projects: [],
  sessions: sessions.map((m) => ({ ...m })) as unknown as MirrorHost["sessions"],
  writtenAt: 1,
});

class FakeLink implements Link {
  connected = false;
  readonly profile = "remote" as const;
  calls: { method: string; params: unknown }[] = [];
  changes: SessionChanges | Error | null = null;
  list: Omit<SessionMeta, "environmentId">[] = [];
  private pushListeners = new Set<(push: ServerPush) => void>();
  private openListeners = new Set<() => void>();
  constructor(readonly environmentId: string) {}
  request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "session.changes") {
      if (this.changes instanceof Error) return Promise.reject(this.changes);
      if (this.changes) return Promise.resolve(this.changes as T);
      return Promise.reject(new Error("bad request: unknown method"));
    }
    if (method === "session.list") return Promise.resolve({ sessions: this.list, cursor: null } as T);
    if (method === "session.events")
      return Promise.resolve({ rows: [], moreBefore: false, moreAfter: false, reset: false, subscribed: true } as T);
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
  onClose(): () => void {
    return () => {};
  }
  open(): void {
    this.connected = true;
    for (const l of this.openListeners) l();
  }
  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settleAll = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await flush();
};

beforeEach(() => {
  sessionStore.reset();
});
afterEach(() => {
  sessionStore.reset();
  vi.useRealTimers();
});

describe("hydration", () => {
  it("paints the mirrored rows before any link is attached, stamped with their host", () => {
    sessionStore.hydrate([host("box", [meta({ id: "a" }), meta({ id: "b", status: "running" })], { seq: 5, generation: "g" })]);
    const ids = sessionStore.metas().map((m) => m.id);
    expect(ids.sort()).toEqual(["a", "b"]);
    expect(sessionStore.metaOf("a")?.environmentId).toBe("box");
    expect(sessionStore.get("b")?.busy).toBe(true);
    expect(sessionStore.isMirrored("box")).toBe(true);
    expect(sessionStore.cursorOf("box")).toEqual({ seq: 5, generation: "g" });
    expect(sessionStore.environmentIds()).toEqual([]);
  });

  it("never fires onSessionAdded for a mirrored row, and never overrides a row already known", () => {
    const added = vi.fn();
    sessionStore.onSessionAdded(added);
    sessionStore.hydrate([host("box", [meta({ id: "a" })])]);
    sessionStore.hydrate([host("box", [meta({ id: "a", title: "older copy" })])]);
    expect(added).not.toHaveBeenCalled();
    expect(sessionStore.metaOf("a")?.title).toBe("thread");
  });
});

describe("reconcile with a cursor", () => {
  it("resumes with afterSeq and the generation, merges the changed rows in place and drops the gone ones without listing", async () => {
    sessionStore.hydrate([host("box", [meta({ id: "a" }), meta({ id: "b" }), meta({ id: "c" })], { seq: 5, generation: "g" })]);
    const untouched = sessionStore.metaOf("c");
    const link = new FakeLink("box");
    link.changes = {
      reset: false,
      seq: 9,
      generation: "g",
      sessions: [wire({ id: "a", title: "renamed", status: "running", updatedAt: 7 })],
      removed: ["b"],
    };
    sessionStore.attach(link);
    link.open();
    await settleAll();
    expect(link.calls[0]).toEqual({ method: "session.changes", params: { afterSeq: 5, generation: "g" } });
    expect(link.count("session.list")).toBe(0);
    expect(sessionStore.metaOf("a")?.title).toBe("renamed");
    expect(sessionStore.get("a")?.busy).toBe(true);
    expect(sessionStore.metaOf("b")).toBeNull();
    // Quiet: the row nothing changed on is the same object, so nothing re-renders or re-enters.
    expect(sessionStore.metaOf("c")).toBe(untouched);
    expect(sessionStore.cursorOf("box")).toEqual({ seq: 9, generation: "g" });
    expect(sessionStore.isMirrored("box")).toBe(false);
    expect(sessionStore.listedEnvironmentIds()).toEqual(["box"]);
  });

  it("lists whole on reset, keeps the new head as the cursor, and drops what the list no longer has", async () => {
    sessionStore.hydrate([host("box", [meta({ id: "a" }), meta({ id: "stale" })], { seq: 5, generation: "old-run" })]);
    const link = new FakeLink("box");
    link.changes = { reset: true, seq: 2, generation: "new-run" };
    link.list = [wire({ id: "a", title: "fresh" })];
    sessionStore.attach(link);
    link.open();
    await settleAll();
    expect(link.calls.map((c) => c.method)).toEqual(["session.changes", "session.list"]);
    expect(sessionStore.metaOf("a")?.title).toBe("fresh");
    expect(sessionStore.metaOf("stale")).toBeNull();
    expect(sessionStore.cursorOf("box")).toEqual({ seq: 2, generation: "new-run" });
    expect(sessionStore.isMirrored("box")).toBe(false);
  });

  it("with no cursor asks for the head alone, then lists whole; the head becomes the cursor", async () => {
    const link = new FakeLink("box");
    link.changes = { reset: false, seq: 11, generation: "g", sessions: [], removed: [] };
    link.list = [wire({ id: "a" })];
    sessionStore.attach(link);
    link.open();
    await settleAll();
    expect(link.calls[0]).toEqual({ method: "session.changes", params: { afterSeq: 0 } });
    expect(link.count("session.list")).toBe(1);
    expect(sessionStore.metaOf("a")).not.toBeNull();
    expect(sessionStore.cursorOf("box")).toEqual({ seq: 11, generation: "g" });
  });

  it("an older host that refuses session.changes lists whole as before", async () => {
    sessionStore.hydrate([host("box", [meta({ id: "gone" })], { seq: 5, generation: "g" })]);
    const link = new FakeLink("box");
    link.changes = null;
    link.list = [wire({ id: "a" })];
    sessionStore.attach(link);
    link.open();
    await settleAll();
    expect(link.count("session.list")).toBe(1);
    expect(sessionStore.metaOf("gone")).toBeNull();
    expect(sessionStore.metaOf("a")).not.toBeNull();
    // The mirror's cursor stays until a host that speaks session.changes answers a head.
    expect(sessionStore.cursorOf("box")).toEqual({ seq: 5, generation: "g" });
  });

  it("a removal from one host leaves the same id another host holds", async () => {
    sessionStore.hydrate([host("box", [meta({ id: "x" })], { seq: 1, generation: "g" }), host("mac", [meta({ id: "x", environmentId: "mac" })])]);
    const link = new FakeLink("box");
    link.changes = { reset: false, seq: 2, generation: "g", sessions: [], removed: ["x"] };
    sessionStore.attach(link);
    link.open();
    await settleAll();
    // The first hydrate claimed the id for box (ids are unique across hosts), so box's removal takes it.
    expect(sessionStore.metaOf("x")).toBeNull();
  });
});

describe("the settle deadline", () => {
  it("counts a mirrored host that has not answered, and a listed one, within the deadline; an unknown one not", async () => {
    vi.useFakeTimers();
    sessionStore.hydrate([host("box", [meta({ id: "a" })], { seq: 1, generation: "g" })]);
    const box = new FakeLink("box");
    const local = new FakeLink("local");
    local.list = [];
    local.changes = { reset: false, seq: 0, generation: "l", sessions: [], removed: [] };
    const silent = new FakeLink("silent");
    sessionStore.attach(box);
    sessionStore.attach(local);
    sessionStore.attach(silent);
    local.open();
    const settled = sessionStore.settledEnvironments();
    await vi.advanceTimersByTimeAsync(BOOT_SETTLE_MS + 10);
    const set = await settled;
    expect(set.has("local")).toBe(true);
    expect(set.has("box")).toBe(true);
    expect(set.has("silent")).toBe(false);
    expect(sessionStore.metaOf("a")).not.toBeNull();
  });

  it("resolves before the deadline once every attached host has listed", async () => {
    vi.useFakeTimers();
    const local = new FakeLink("local");
    local.changes = { reset: false, seq: 0, generation: "l", sessions: [], removed: [] };
    sessionStore.attach(local);
    local.open();
    const settled = sessionStore.settledEnvironments();
    await vi.advanceTimersByTimeAsync(50);
    expect((await settled).has("local")).toBe(true);
  });

  it("whenPainted resolves once each host has listed or was mirrored", async () => {
    vi.useFakeTimers();
    sessionStore.hydrate([host("box", [meta({ id: "a" })])]);
    const box = new FakeLink("box");
    const local = new FakeLink("local");
    local.changes = { reset: false, seq: 0, generation: "l", sessions: [], removed: [] };
    sessionStore.attach(box);
    sessionStore.attach(local);
    let painted = false;
    void sessionStore.whenPainted().then(() => {
      painted = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(painted).toBe(false);
    local.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(painted).toBe(true);
  });
});

describe("a host whose link opens after another has listed", () => {
  it("whenPainted waits for its list rather than giving up on it", async () => {
    vi.useFakeTimers();
    const box = new FakeLink("box");
    box.changes = { reset: false, seq: 0, generation: "b", sessions: [], removed: [] };
    const local = new FakeLink("local");
    local.changes = { reset: false, seq: 0, generation: "l", sessions: [], removed: [] };
    sessionStore.attach(box);
    sessionStore.attach(local);
    let painted = false;
    void sessionStore.whenPainted().then(() => {
      painted = true;
    });
    local.open();
    await vi.advanceTimersByTimeAsync(20);
    expect(painted).toBe(false);
    box.open();
    await vi.advanceTimersByTimeAsync(20);
    expect(painted).toBe(true);
  });

  it("settledEnvironments counts a host that lists inside the deadline", async () => {
    vi.useFakeTimers();
    const box = new FakeLink("box");
    box.changes = { reset: false, seq: 0, generation: "b", sessions: [], removed: [] };
    const local = new FakeLink("local");
    local.changes = { reset: false, seq: 0, generation: "l", sessions: [], removed: [] };
    sessionStore.attach(box);
    sessionStore.attach(local);
    local.open();
    const settled = sessionStore.settledEnvironments();
    await vi.advanceTimersByTimeAsync(BOOT_SETTLE_MS / 2);
    box.open();
    await vi.advanceTimersByTimeAsync(20);
    const set = await settled;
    expect([...set].sort()).toEqual(["box", "local"]);
  });
});

describe("detach", () => {
  it("drops a mirrored host's rows and cursor when the environment is removed", () => {
    sessionStore.hydrate([host("box", [meta({ id: "a" })], { seq: 1, generation: "g" })]);
    const link = new FakeLink("box");
    sessionStore.attach(link);
    sessionStore.detach("box");
    expect(sessionStore.metaOf("a")).toBeNull();
    expect(sessionStore.cursorOf("box")).toBeNull();
    expect(sessionStore.isMirrored("box")).toBe(false);
  });
});

describe("launch mirror: the load phase", () => {
  it("a mirrored row reads loading, never loaded-empty, until its host answers", async () => {
    vi.useFakeTimers();
    sessionStore.hydrate([host("box", [meta({ id: "a" })], { seq: 1, generation: "g" })]);
    expect(sessionStore.get("a")?.load?.phase).toBe("loading");
    expect(sessionStore.get("a")?.loaded).toBeFalsy();
    const box = new FakeLink("box");
    box.changes = { seq: 1, generation: "g", reset: false, sessions: [], removed: [] };
    sessionStore.attach(box);
    // The pane asks before the socket is up: nothing goes out, it waits loading.
    await expect(sessionStore.ensureLoaded("a", "pane")).rejects.toThrow("not connected");
    expect(box.count("session.events")).toBe(0);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sessionStore.get("a")?.load?.phase).toBe("slow");
    box.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(box.count("session.events")).toBe(1);
    expect(sessionStore.get("a")?.load?.phase).toBe("loaded");
    expect(sessionStore.get("a")?.loaded).toBe(true);
  });
});
