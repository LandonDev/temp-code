import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubInboxSnapshot } from "@server/shared/contract-github";
import type { Link } from "./tcserver/store";
import { workspaceStore } from "./tcserver/workspaces";
import { inboxStore } from "./inboxStore";
import { inboxUnseenFromCache, resetInboxBadge, subscribeInboxBadge } from "./inboxBadge";

const invoke = vi.fn();
vi.mock("./native", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

function mockLocalStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() {
        return data.size;
      },
    },
  });
}

function snapshot(issueUpdatedAt: string): GithubInboxSnapshot {
  return {
    viewer: "me",
    auth: { state: "ok", message: "" },
    fetchedAt: 1,
    refreshing: false,
    repos: [
      {
        repo: "acme/web",
        fetchedAt: 1,
        error: null,
        items: [
          {
            kind: "issue",
            repo: "acme/web",
            number: 1,
            title: "#1",
            url: "https://github.com/acme/web/issues/1",
            state: "open",
            draft: false,
            updatedAt: issueUpdatedAt,
            author: null,
            assignees: [],
            labels: [],
            reviewDecision: "",
            headRefName: "",
            baseRefName: "",
            checks: null,
            reviewRequested: [],
          },
        ],
      },
    ],
  };
}

/** A link that answers the two catalog reads and the stored snapshot, and counts every request. */
function fakeLink(answer: () => GithubInboxSnapshot): Link & { calls: string[]; open: () => void } {
  const openers = new Set<() => void>();
  const link = {
    calls: [] as string[],
    connected: false,
    request<T>(method: string): Promise<T> {
      link.calls.push(method);
      if (method === "github.inbox") return Promise.resolve(answer() as T);
      if (method === "github.inboxRefresh") return Promise.resolve(answer() as T);
      if (method === "workspace.list")
        return Promise.resolve([{ id: "w1", name: "web", path: "/tmp/web", git: true, githubRepo: "acme/web", createdAt: 1 }] as T);
      if (method === "project.list") return Promise.resolve([] as T);
      if (method === "defaults.get") return Promise.reject(new Error("none"));
      return Promise.reject(new Error(`unexpected ${method}`));
    },
    onPush: () => () => undefined,
    onOpen: (listener: () => void) => {
      openers.add(listener);
      return () => openers.delete(listener);
    },
    open: () => {
      link.connected = true;
      for (const l of openers) l();
    },
  };
  return link;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mockLocalStorage();
  inboxStore.reset();
  workspaceStore.reset();
  resetInboxBadge();
  invoke.mockReset();
});

afterEach(() => {
  inboxStore.reset();
  workspaceStore.reset();
});

describe("inbox badge with the inbox closed", () => {
  it("never asks the server to fetch: not on subscribe, not on read, not over time", async () => {
    vi.useFakeTimers();
    try {
      const link = fakeLink(() => snapshot("2026-01-01T00:00:00Z"));
      workspaceStore.connect(link);
      inboxStore.connect(link);
      link.open();
      await vi.advanceTimersByTimeAsync(0);
      const off = subscribeInboxBadge(() => undefined);
      expect(inboxUnseenFromCache()).toBe(false);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(inboxUnseenFromCache()).toBe(false);
      off();
      expect(link.calls.filter((m) => m === "github.inboxRefresh")).toEqual([]);
      expect(link.calls.filter((m) => m === "github.inbox")).toHaveLength(1);
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("inbox badge from the stored snapshot", () => {
  it("seeds seen on the first stored list, then lights up for a newer item", async () => {
    let at = "2026-01-01T00:00:00Z";
    const link = fakeLink(() => snapshot(at));
    let ticks = 0;
    const off = subscribeInboxBadge(() => void ticks++);
    workspaceStore.connect(link);
    inboxStore.connect(link);
    link.open();
    await flush();
    expect(ticks).toBeGreaterThan(0);
    expect(inboxUnseenFromCache()).toBe(false); // the first stored list is "seen"

    at = "2026-02-01T00:00:00Z";
    await inboxStore.refreshGithub("open"); // what the open inbox view does
    expect(inboxUnseenFromCache()).toBe(true);
    off();
  });
});
