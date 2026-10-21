import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLaunchMirrorWriter, summarize, type WriterCatalogSource, type WriterSessionSource } from "./launchMirror";
import type { MirrorCursor, MirrorWrite } from "@server/shared/launchMirror";
import type { ProjectMeta, SessionMeta, WorkspaceMeta } from "./types";

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    environmentId: "local",
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

class Sessions implements WriterSessionSource {
  rows: SessionMeta[] = [];
  listed: string[] = [];
  cursors = new Map<string, MirrorCursor>();
  private listeners = new Set<() => void>();
  onMetaChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  metas(): SessionMeta[] {
    return this.rows;
  }
  cursorOf(id: string): MirrorCursor | null {
    return this.cursors.get(id) ?? null;
  }
  listedEnvironmentIds(): string[] {
    return this.listed;
  }
  change(): void {
    for (const l of this.listeners) l();
  }
}

class Catalog implements WriterCatalogSource {
  workspaces: WorkspaceMeta[] = [];
  projects: ProjectMeta[] = [];
  private listeners = new Set<() => void>();
  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  getSnapshot() {
    return { workspaces: this.workspaces, projects: this.projects };
  }
  change(): void {
    for (const l of this.listeners) l();
  }
}

const ws = (id: string, environmentId: string): WorkspaceMeta =>
  ({ id, environmentId, name: id, path: `/${id}`, git: false, createdAt: 1 }) as unknown as WorkspaceMeta;

let sessions: Sessions;
let catalog: Catalog;
let writes: MirrorWrite[];
let off: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  sessions = new Sessions();
  catalog = new Catalog();
  writes = [];
  off = () => {};
});
afterEach(() => {
  off();
  vi.useRealTimers();
});

const install = (delayMs = 100) => {
  off = installLaunchMirrorWriter({ sessions, catalog, write: (w) => writes.push(w), delayMs });
};

describe("summarize", () => {
  it("drops the transient fields and keeps the rest, environment included", () => {
    const s = summarize(meta({ activity: "Editing x.ts", activityKind: "edit", tasks: { done: 1, total: 3 } }));
    expect(s).not.toHaveProperty("activity");
    expect(s).not.toHaveProperty("activityKind");
    expect(s.environmentId).toBe("local");
    expect(s.tasks).toEqual({ done: 1, total: 3 });
  });
});

describe("installLaunchMirrorWriter", () => {
  it("writes nothing for a host that has not listed", () => {
    sessions.rows = [meta({ environmentId: "box", id: "a" })];
    install();
    vi.advanceTimersByTime(200);
    expect(writes).toEqual([]);
  });

  it("the first write for a listed host is full, with its cursor and lists; nothing is written again while nothing changes", () => {
    sessions.rows = [meta({ id: "a", activity: "Editing" }), meta({ id: "b" }), meta({ environmentId: "box", id: "c" })];
    sessions.listed = ["local"];
    sessions.cursors.set("local", { seq: 4, generation: "g" });
    catalog.workspaces = [ws("w1", "local"), ws("w2", "box")];
    install();
    vi.advanceTimersByTime(100);
    expect(writes).toHaveLength(1);
    const [w] = writes;
    expect(w.environmentId).toBe("local");
    expect(w.full).toBe(true);
    expect(w.upserts?.map((s) => s.id)).toEqual(["a", "b"]);
    expect(w.upserts?.[0]).not.toHaveProperty("activity");
    expect(w.cursor).toEqual({ seq: 4, generation: "g" });
    expect(w.workspaces).toEqual([catalog.workspaces[0]]);
    expect(w.projects).toEqual([]);
    sessions.change();
    vi.advanceTimersByTime(200);
    expect(writes).toHaveLength(1);
  });

  it("later writes carry only the rows whose meta object changed and the ids that left", () => {
    const a = meta({ id: "a" });
    const b = meta({ id: "b" });
    sessions.rows = [a, b];
    sessions.listed = ["local"];
    install();
    vi.advanceTimersByTime(100);
    sessions.rows = [{ ...a, title: "renamed", updatedAt: 9 }];
    sessions.change();
    vi.advanceTimersByTime(100);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({ environmentId: "local", upserts: [summarize({ ...a, title: "renamed", updatedAt: 9 })], removed: ["b"] });
  });

  it("coalesces a burst of changes into one write after the quiet period", () => {
    sessions.listed = ["local"];
    sessions.rows = [meta({ id: "a" })];
    install(100);
    for (let i = 0; i < 8; i++) {
      sessions.rows = [meta({ id: "a", updatedAt: i })];
      sessions.change();
      vi.advanceTimersByTime(10);
    }
    expect(writes).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(writes).toHaveLength(1);
    expect(writes[0].upserts?.[0].updatedAt).toBe(7);
  });

  it("a cursor move alone is written; a catalog change alone is written; each host separately", () => {
    sessions.listed = ["local", "box"];
    sessions.rows = [meta({ id: "a" }), meta({ environmentId: "box", id: "b" })];
    install();
    vi.advanceTimersByTime(100);
    expect(writes.map((w) => w.environmentId).sort()).toEqual(["box", "local"]);
    sessions.cursors.set("box", { seq: 2, generation: "g" });
    sessions.change();
    vi.advanceTimersByTime(100);
    expect(writes).toHaveLength(3);
    expect(writes[2]).toEqual({ environmentId: "box", cursor: { seq: 2, generation: "g" } });
    catalog.workspaces = [ws("w1", "local")];
    catalog.change();
    vi.advanceTimersByTime(100);
    expect(writes).toHaveLength(4);
    expect(writes[3]).toEqual({ environmentId: "local", workspaces: catalog.workspaces });
  });

  it("flushes a pending write at once when the page hides, and stops after teardown", () => {
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    };
    sessions.listed = ["local"];
    sessions.rows = [meta({ id: "a" })];
    off = installLaunchMirrorWriter({ sessions, catalog, write: (w) => writes.push(w), delayMs: 1_000, doc });
    doc.visibilityState = "hidden";
    for (const l of listeners) l();
    expect(writes).toHaveLength(1);
    off();
    sessions.rows = [];
    sessions.change();
    vi.advanceTimersByTime(2_000);
    expect(writes).toHaveLength(1);
  });
});
