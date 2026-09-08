import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSession,
  listSessionsByProject,
  searchSessions,
  shouldPersistSession,
  summaryFromMeta,
} from "./sessionStore";
import { newSession } from "./session";
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
  request<T>(method: string, params?: unknown): Promise<T> {
    if (method === "session.list") return Promise.resolve(this.metas as T);
    if (method === "session.events") {
      const { sessionId } = params as { sessionId: string };
      return Promise.resolve((this.events.get(sessionId) ?? []) as T);
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

describe("shouldPersistSession", () => {
  it("needs a project and a user turn", () => {
    expect(shouldPersistSession(newSession("claude", "~"))).toBe(false);
    const s = { ...newSession("claude", "/repo"), blocks: [{ id: "1", role: "user" as const, text: "x" }] };
    expect(shouldPersistSession(s)).toBe(true);
  });
});
