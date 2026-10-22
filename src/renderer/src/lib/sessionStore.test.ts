import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSession,
  listSessionsByProject,
  loadSession,
  openableSession,
  searchSessions,
  shouldPersistSession,
  summaryFromMeta,
} from "./sessionStore";
import { newSession, type Session } from "./session";
import { sessionStore, type Link } from "./tcserver/store";
import type { EventRow, ServerPush, SessionMeta } from "./tcserver/types";

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    environmentId: "local",
    id: "s", parentId: null, projectId: null, workspaceId: null, threadType: null, planPath: null,
    provider: "codex", model: "gpt-5.5", reasoning: "medium", agentType: "implementer",
    title: "Fix the build", cwd: "/repo/", status: "idle", archived: false, pinned: true,
    permission: "safe", fast: false, ultrafast: false, context1m: false, busySince: null, pausedAt: null,
    frozenActiveElapsed: null, nativeId: "thread-1", createdAt: 5, updatedAt: 9, ...over,
  };
}

function wireMeta(over: Partial<SessionMeta> = {}): Omit<SessionMeta, "environmentId"> {
  const { environmentId: _environmentId, ...wire } = meta(over);
  return wire;
}

class FakeLink implements Link {
  environmentId = "local";
  profile = "local" as const;
  connected = true;
  metas: Omit<SessionMeta, "environmentId">[] = [];
  events = new Map<string, EventRow[]>();
  /** Resolves before a head (beforeSeq) fetch answers, when set. */
  holdHead: Promise<void> | null = null;
  /** Resolves before a tail fetch answers, when set. */
  holdTail: Promise<void> | null = null;
  /** What the host's own search answers (session.search). */
  searchHits: unknown[] = [];
  request<T>(method: string, params?: unknown): Promise<T> {
    if (method === "session.list") return Promise.resolve(this.metas as T);
    if (method === "session.search") return Promise.resolve({ hits: this.searchHits, truncated: false } as T);
    if (method === "session.events") {
      const { sessionId, afterSeq = 0, beforeSeq, tail } = params as {
        sessionId: string; afterSeq?: number; beforeSeq?: number; tail?: number;
      };
      let rows = (this.events.get(sessionId) ?? []).filter(
        (r) => r.seq > afterSeq && (beforeSeq === undefined || r.seq < beforeSeq),
      );
      if (tail !== undefined) {
        const users = rows.filter((r) => r.event.type === "user-text");
        if (users.length >= tail) {
          const from = users[users.length - tail].seq;
          rows = rows.filter((r) => r.seq >= from);
        }
      }
      const hold = beforeSeq !== undefined ? this.holdHead : tail !== undefined ? this.holdTail : null;
      return (hold ?? Promise.resolve()).then(() => rows as T);
    }
    return Promise.resolve(null as T);
  }
  onPush(_l: (push: ServerPush) => void) { return () => {}; }
  onOpen() { return () => {}; }
  onClose() { return () => {}; }
}

let link: FakeLink;
beforeEach(() => {
  link = new FakeLink();
  sessionStore.reset();
});
afterEach(() => sessionStore.reset());

describe("summaryFromMeta", () => {
  it("maps the sidebar row from server meta", () => {
    expect(summaryFromMeta(meta({}))).toEqual({
      id: "s", cwd: "/repo", harness: "codex", model: "codex:gpt-5.5", runtimeMode: "supervised",
      title: "Fix the build", providerSessionId: "thread-1", additions: 0, deletions: 0,
      createdAt: 5, updatedAt: 9, archived: undefined, pinned: true,
    });
  });
});

describe("listSessionsByProject", () => {
  it("filters by project path, newest first, roots only", async () => {
    link.metas = [
      wireMeta({ id: "a", cwd: "/repo", updatedAt: 1 }),
      wireMeta({ id: "b", cwd: "/repo/", updatedAt: 3 }),
      wireMeta({ id: "child", cwd: "/repo", parentId: "b" }),
      wireMeta({ id: "c", cwd: "/other" }),
    ];
    sessionStore.attach(link);
    expect((await listSessionsByProject("/repo")).map((r) => r.id)).toEqual(["b", "a"]);
    expect(await listSessionsByProject("~")).toEqual([]);
  });
});

describe("searchSessions", () => {
  it("matches titles and loaded transcripts", async () => {
    link.metas = [wireMeta({ id: "a", title: "Refactor auth" }), wireMeta({ id: "b", title: "Other", archived: true })];
    link.events.set("a", [{ sessionId: "a", seq: 1, ts: 1, event: { type: "user-text", text: "please refactor the login flow" } }]);
    sessionStore.attach(link);
    await getSession("a");
    const { hits } = await searchSessions({ query: "refactor" });
    expect(hits.map((h) => h.kind)).toEqual(["conversation", "message"]);
    expect(hits[1].preview).toContain("refactor the login");
    expect((await searchSessions({ query: "other" })).hits).toEqual([]);
    expect((await searchSessions({ query: "other", includeArchived: true })).hits).toHaveLength(1);
  });

  it("a hit in a thread's notes keeps its own row, even for a loaded transcript", async () => {
    link.metas = [wireMeta({ id: "a", title: "Gateway work" }), wireMeta({ id: "b", title: "Other" })];
    link.events.set("a", [{ sessionId: "a", seq: 1, ts: 1, event: { type: "user-text", text: "fix the gateway port" } }]);
    link.searchHits = [
      { sessionId: "a", seq: 0, role: "assistant", snippet: "## Pointers - gateway.ts", ts: 5, source: "notes" },
      { sessionId: "a", seq: 1, role: "user", snippet: "fix the gateway port", ts: 1 },
      { sessionId: "b", seq: 3, role: "assistant", snippet: "gateway elsewhere", ts: 2 },
    ];
    sessionStore.attach(link);
    await getSession("a");
    const { hits } = await searchSessions({ query: "gateway" });
    expect(hits.map((h) => `${h.sessionId}:${h.kind}:${h.role ?? "-"}:${h.seq ?? "-"}`)).toEqual([
      "a:conversation:-:-",
      "a:message:user:1",
      "a:message:notes:0",
      "b:message:assistant:3",
    ]);
    expect(hits[2].preview).toBe("## Pointers - gateway.ts");
  });
});

describe("getSession", () => {
  it("returns the folded session and drafts as-is", async () => {
    link.metas = [wireMeta({ id: "a" })];
    link.events.set("a", [{ sessionId: "a", seq: 1, ts: 1, event: { type: "user-text", text: "hi" } }]);
    sessionStore.attach(link);
    const s = await getSession("a");
    expect(s?.blocks).toHaveLength(1);
    expect(s?.runtimeMode).toBe("supervised");
    const draft = newSession("local", "claude", "/repo");
    sessionStore.mutate([draft]);
    expect(await getSession(draft.id)).toBe(sessionStore.get(draft.id));
    expect(await getSession("nope")).toBeNull();
  });
});

describe("loadSession", () => {
  it("returns once the last turns are folded; getSession waits for the whole log", async () => {
    link.metas = [wireMeta({ id: "a" })];
    const rows: EventRow[] = [];
    // 305 one-row turns: the 300-row tail starts at q6.
    for (let turn = 1; turn <= 305; turn++) {
      rows.push({ sessionId: "a", seq: rows.length + 1, ts: turn, event: { type: "user-text", text: `q${turn}` } });
      rows.push({ sessionId: "a", seq: rows.length + 1, ts: turn, event: { type: "turn-complete" } });
    }
    link.events.set("a", rows);
    let releaseHead!: () => void;
    link.holdHead = new Promise<void>((r) => (releaseHead = r));
    sessionStore.attach(link);
    const tail = await loadSession("a");
    expect(tail?.loaded).toBe(true);
    expect(tail?.blocks[0]?.text).toBe("q6");
    expect(sessionStore.isComplete("a")).toBe(false);
    let whole: Session | null | undefined;
    const pending = getSession("a").then((s) => (whole = s));
    await Promise.resolve();
    expect(whole).toBeUndefined();
    releaseHead();
    await pending;
    expect(whole?.blocks[0]?.text).toBe("q1");
    expect(sessionStore.isComplete("a")).toBe(true);
  });
});

describe("openableSession", () => {
  const rows = (id: string): EventRow[] => [{ sessionId: id, seq: 1, ts: 1, event: { type: "user-text", text: "hi" } }];

  it("opens on the last turns when they come in time", async () => {
    link.metas = [wireMeta({ id: "a" })];
    link.events.set("a", rows("a"));
    sessionStore.attach(link);
    const s = await openableSession("a", 300);
    expect(s?.load?.phase).toBe("loaded");
    expect(s?.blocks.map((b) => b.text)).toEqual(["hi"]);
  });

  it("opens on the meta, still loading, when the host is slow, and the rows follow", async () => {
    link.metas = [wireMeta({ id: "a" })];
    link.events.set("a", rows("a"));
    let release!: () => void;
    link.holdTail = new Promise<void>((r) => (release = r));
    sessionStore.attach(link);
    const s = await openableSession("a", 20);
    expect(s?.id).toBe("a");
    expect(s?.blocks).toEqual([]);
    expect(s?.load?.phase).toBe("loading");
    release();
    await vi.waitFor(() => expect(sessionStore.get("a")?.load?.phase).toBe("loaded"));
    expect(sessionStore.get("a")?.blocks.map((b) => b.text)).toEqual(["hi"]);
  });

  it("is null for a thread no host knows", async () => {
    sessionStore.attach(link);
    expect(await openableSession("nope", 20)).toBeNull();
  });
});

describe("shouldPersistSession", () => {
  it("needs a project and a user turn", () => {
    expect(shouldPersistSession(newSession("local", "claude", "~"))).toBe(false);
    const s = { ...newSession("local", "claude", "/repo"), blocks: [{ id: "1", role: "user" as const, text: "x" }] };
    expect(shouldPersistSession(s)).toBe(true);
  });
});
