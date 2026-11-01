import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { newTab } from "./layout";
import { sessionStore, type Link } from "./tcserver/store";
import type { EventRow, ServerPush, SessionMeta } from "./tcserver/types";
import type { WorkspaceSnapshot } from "./workspaceSnapshot";

/**
 * Stability 1, cause 1: a saved tab whose thread no host answered for at
 * launch (archived since, moved, or its host not up yet) restores as that
 * thread, provisional, and resolves on its host's word. It never comes back
 * as a draft under its old title, which drew the new-chat screen.
 */
const saved = vi.hoisted(() => ({ snapshot: null as unknown }));
vi.mock("./sessionStore", async (original) => ({
  ...(await original<typeof import("./sessionStore")>()),
  loadWorkspaceSnapshot: async () => saved.snapshot,
}));
vi.mock("./fs", () => ({ restoreSessionCheckout: async (session: unknown) => session }));

function wireMeta(over: Partial<SessionMeta>): Omit<SessionMeta, "environmentId"> {
  return {
    id: "s", parentId: null, projectId: "p1", workspaceId: null, threadType: "planning", planPath: null,
    provider: "claude", model: "claude-sonnet-5-5", reasoning: "medium", agentType: "implementer",
    title: "t", cwd: "/repo", status: "idle", archived: false, pinned: false, permission: "edits",
    fast: false, ultrafast: false, context1m: false, busySince: null, pausedAt: null, frozenActiveElapsed: null,
    nativeId: null, createdAt: 1, updatedAt: 1, ...over,
  };
}

class FakeLink implements Link {
  environmentId = "local";
  profile = "local" as const;
  connected = true;
  archivedMetas: Omit<SessionMeta, "environmentId">[] = [];
  events = new Map<string, EventRow[]>();
  request<T>(method: string, params?: unknown): Promise<T> {
    if (method === "session.list") {
      const archived = (params as { archived?: boolean } | undefined)?.archived;
      return Promise.resolve((archived ? this.archivedMetas : []) as T);
    }
    if (method === "session.events") {
      const { sessionId, afterSeq = 0 } = params as { sessionId: string; afterSeq?: number };
      return Promise.resolve((this.events.get(sessionId) ?? []).filter((r) => r.seq > afterSeq) as T);
    }
    return Promise.resolve(null as T);
  }
  onPush(_l: (push: ServerPush) => void) {
    return () => {};
  }
  private opens = new Set<() => void>();
  onOpen(l: () => void) {
    this.opens.add(l);
    return () => this.opens.delete(l);
  }
  reopen(): void {
    for (const l of this.opens) l();
  }
  onClose() {
    return () => {};
  }
}

const stub = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  environmentId: "local",
  cwd: "/repo",
  harness: "claude",
  model: "claude:sonnet-5.5",
  modelSettings: {},
  runtimeMode: "supervised",
  title: "",
  projectId: "p1",
  ...over,
});

let link: FakeLink;
/** The plan's host, down while the window restores. */
let box: FakeLink;
beforeEach(() => {
  sessionStore.reset();
  link = new FakeLink();
  box = new FakeLink();
  box.environmentId = "box";
  box.connected = false;
});
afterEach(() => sessionStore.reset());

it("a saved tab for an archived box thread restores as that thread and loads its rows once the box answers; an unknown one reads gone; an unsent draft restores as before", async () => {
  box.archivedMetas = [wireMeta({ id: "plan", title: "Plan: ship it", archived: true })];
  box.events.set("plan", [{ sessionId: "plan", seq: 1, ts: 1, event: { type: "user-text", text: "plan the ship" } }]);
  const tabs = ["plan", "legacy", "ghost", "draft"].map(newTab);
  saved.snapshot = {
    tabs,
    sessions: [
      stub("plan", { environmentId: "box", title: "Plan: ship it", persisted: true }),
      // A layout saved before the stamp: its title says it was a thread.
      stub("legacy", { title: "Old build" }),
      stub("ghost", { title: "Deleted since", persisted: true }),
      stub("draft", { persisted: false }),
    ],
    activeTabId: tabs[3].id,
    projectCwd: "/repo",
    projectTerminals: [],
  } satisfies Partial<WorkspaceSnapshot> as unknown;
  sessionStore.attach(link);
  sessionStore.attach(box);
  const { loadResumedWorkspace } = await import("./appLifecycle");
  const workspace = await loadResumedWorkspace();

  // The chip keeps its name and project from the moment the window paints,
  // and the tab waits for its host: never a draft, never "loaded" with no rows.
  const restored = workspace?.sessions.find((s) => s.id === "plan");
  expect(restored).toMatchObject({ title: "Plan: ship it", projectId: "p1" });
  expect(sessionStore.isProvisional("plan")).toBe(true);
  expect(sessionStore.get("plan")?.load?.phase).toBe("loading");
  expect(sessionStore.isDraft("draft")).toBe(true);
  expect(sessionStore.isProvisional("draft")).toBe(false);

  box.connected = true;
  box.reopen();
  await vi.waitFor(() => expect(sessionStore.get("plan")?.load?.phase).toBe("loaded"));
  expect(sessionStore.isDraft("plan")).toBe(false);
  expect(sessionStore.get("plan")?.blocks.map((b) => b.text)).toEqual(["plan the ship"]);
  expect(sessionStore.get("plan")?.load?.empty).toBe(false);
  await vi.waitFor(() => expect(sessionStore.get("ghost")?.load?.phase).toBe("gone"));
  expect(sessionStore.get("legacy")?.load?.phase).toBe("gone");
  expect(sessionStore.get("ghost")?.title).toBe("Deleted since");
});
