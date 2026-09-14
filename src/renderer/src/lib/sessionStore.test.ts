import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSession,
  listSessionsByProject,
  loadSession,
  searchSessions,
  shouldPersistSession,
  summaryFromMeta,
} from "./sessionStore";
import { newSession, type Session } from "./session";
import { sessionStore, type Link } from "./tcserver/store";
import type { EventRow, ServerPush, SessionMeta } from "./tcserver/types";

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    id: "s", parentId: null, projectId: null, workspaceId: null, threadType: null, planPath: null,
    provider: "codex", model: "gpt-5.5", reasoning: "medium", agentType: "implementer",
    title: "Fix the build", cwd: "/repo/", status: "idle", archived: false, pinned: true,
    permission: "safe", fast: false, context1m: false, busySince: null, pausedAt: null,
    frozenActiveElapsed: null, nativeId: "thread-1", createdAt: 5, updatedAt: 9, ...over,
  };
}

class FakeLink implements Link {
  connected = true;
  metas: SessionMeta[] = [];
  events = new Map<string, EventRow[]>();
  /** Resolves before a head (beforeSeq) fetch answers, when set. */
  holdHead: Promise<void> | null = null;
  request<T>(method: string, params?: unknown): Promise<T> {
    if (method === "session.list") return Promise.resolve(this.metas as T);
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
      const hold = beforeSeq !== undefined ? this.holdHead : null;
      return (hold ?? Promise.resolve()).then(() => rows as T);
    }
    return Promise.resolve(null as T);
  }
  onPush(_l: (push: ServerPush) => void) { return () => {}; }
  onOpen() { return () => {}; }
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
      meta({ id: "a", cwd: "/repo", updatedAt: 1 }),
      meta({ id: "b", cwd: "/repo/", updatedAt: 3 }),
      meta({ id: "child", cwd: "/repo", parentId: "b" }),
      meta({ id: "c", cwd: "/other" }),
    ];
    sessionStore.connect(link);
    expect((await listSessionsByProject("/repo")).map((r) => r.id)).toEqual(["b", "a"]);
    expect(await listSessionsByProject("~")).toEqual([]);
  });
});

describe("searchSessions", () => {
  it("matches titles and loaded transcripts", async () => {
    link.metas = [meta({ id: "a", title: "Refactor auth" }), meta({ id: "b", title: "Other", archived: true })];
    link.events.set("a", [{ sessionId: "a", seq: 1, ts: 1, event: { type: "user-text", text: "please refactor the login flow" } }]);
    sessionStore.connect(link);
    await getSession("a");
    const { hits } = await searchSessions({ query: "refactor" });
    expect(hits.map((h) => h.kind)).toEqual(["conversation", "message"]);
    expect(hits[1].preview).toContain("refactor the login");
    expect((await searchSessions({ query: "other" })).hits).toEqual([]);
    expect((await searchSessions({ query: "other", includeArchived: true })).hits).toHaveLength(1);
  });
});

describe("getSession", () => {
  it("returns the folded session and drafts as-is", async () => {
    link.metas = [meta({ id: "a" })];
    link.events.set("a", [{ sessionId: "a", seq: 1, ts: 1, event: { type: "user-text", text: "hi" } }]);
    sessionStore.connect(link);
    const s = await getSession("a");
    expect(s?.blocks).toHaveLength(1);
    expect(s?.runtimeMode).toBe("supervised");
    const draft = newSession("claude", "/repo");
    sessionStore.mutate([draft]);
    expect(await getSession(draft.id)).toBe(sessionStore.get(draft.id));
    expect(await getSession("nope")).toBeNull();
  });
});

describe("loadSession", () => {
  it("returns once the last turns are folded; getSession waits for the whole log", async () => {
    link.metas = [meta({ id: "a" })];
    const rows: EventRow[] = [];
    // 305 one-row turns: the 300-row tail starts at q6.
    for (let turn = 1; turn <= 305; turn++) {
      rows.push({ sessionId: "a", seq: rows.length + 1, ts: turn, event: { type: "user-text", text: `q${turn}` } });
      rows.push({ sessionId: "a", seq: rows.length + 1, ts: turn, event: { type: "turn-complete" } });
    }
    link.events.set("a", rows);
    let releaseHead!: () => void;
    link.holdHead = new Promise<void>((r) => (releaseHead = r));
    sessionStore.connect(link);
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

describe("shouldPersistSession", () => {
  it("needs a project and a user turn", () => {
    expect(shouldPersistSession(newSession("claude", "~"))).toBe(false);
    const s = { ...newSession("claude", "/repo"), blocks: [{ id: "1", role: "user" as const, text: "x" }] };
    expect(shouldPersistSession(s)).toBe(true);
  });
});
