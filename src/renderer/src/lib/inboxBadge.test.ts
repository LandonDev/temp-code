import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubInboxItem, GithubInboxSnapshot } from "@server/shared/contract-github";
import type { Link } from "./tcserver/store";
import { workspaceStore } from "./tcserver/workspaces";
import { inboxStore } from "./inboxStore";
import { inboxUnseenFromCache, resetInboxBadge, subscribeInboxBadge } from "./inboxBadge";
import { DEFAULT_INBOX_FILTERS, saveInboxFilters } from "./inboxFilters";
import { markInboxItemSeen } from "./inboxSeen";

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

function snapshot(issueUpdatedAt: string, over: Partial<GithubInboxItem> = {}): GithubInboxSnapshot {
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
            ...over,
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
    expect(inboxUnseenFromCache()).toBe(false); // changed, but it waits on nobody
    off();
  });
});

describe("inbox badge lights only for what waits on the user", () => {
  const me = { login: "me", avatarUrl: "" };
  const pat = { login: "pat", avatarUrl: "" };
  const subscriptions: (() => void)[] = [];
  afterEach(() => {
    for (const off of subscriptions.splice(0)) off();
  });

  /** Seeds "seen" on a first snapshot, then swaps the item in a newer one; returns the dot. */
  async function dotAfter(first: Partial<GithubInboxItem>, next: Partial<GithubInboxItem>) {
    let at = "2026-01-01T00:00:00Z";
    let over = first;
    const link = fakeLink(() => snapshot(at, over));
    const off = subscribeInboxBadge(() => undefined);
    workspaceStore.connect(link);
    inboxStore.connect(link);
    link.open();
    await flush();
    expect(inboxUnseenFromCache()).toBe(false);
    at = "2026-02-01T00:00:00Z";
    over = next;
    await inboxStore.refreshGithub("open");
    subscriptions.push(off); // stays live so a seen mark can clear the dot
    return inboxUnseenFromCache();
  }

  it("stays off for someone else's PR that changed with nothing asked of the user", async () => {
    const pr: Partial<GithubInboxItem> = { kind: "pr", author: pat, checks: "FAILURE", reviewDecision: "APPROVED" };
    expect(await dotAfter(pr, pr)).toBe(false);
  });

  it("lights for a review asked of the user, and goes out once seen", async () => {
    const asked: Partial<GithubInboxItem> = { kind: "pr", author: pat, reviewRequested: ["me"] };
    expect(await dotAfter({ kind: "pr", author: pat }, asked)).toBe(true);
    markInboxItemSeen({ key: "github:acme/web:pr:1", updatedAt: "2026-02-01T00:00:00Z" });
    expect(inboxUnseenFromCache()).toBe(false);
  });

  it("lights for the user's PR with changes requested", async () => {
    const mine: Partial<GithubInboxItem> = { kind: "pr", author: me, reviewDecision: "REVIEW_REQUIRED" };
    expect(await dotAfter(mine, { ...mine, reviewDecision: "CHANGES_REQUESTED" })).toBe(true);
  });

  it("stays off for the user's draft", async () => {
    const draft: Partial<GithubInboxItem> = { kind: "pr", author: me, draft: true, reviewDecision: "CHANGES_REQUESTED" };
    expect(await dotAfter({ kind: "pr", author: me, draft: true }, draft)).toBe(false);
  });

  it("stays off for a workspace the user hid", async () => {
    saveInboxFilters({ ...DEFAULT_INBOX_FILTERS, hiddenWorkspaceIds: ["w1"] });
    const asked: Partial<GithubInboxItem> = { kind: "pr", author: pat, reviewRequested: ["me"] };
    expect(await dotAfter({ kind: "pr", author: pat }, asked)).toBe(false);
  });

  it("ignores the saved list filters", async () => {
    saveInboxFilters({ ...DEFAULT_INBOX_FILTERS, hiddenKinds: ["pr"] });
    const asked: Partial<GithubInboxItem> = { kind: "pr", author: pat, reviewRequested: ["me"] };
    expect(await dotAfter({ kind: "pr", author: pat }, asked)).toBe(true);
  });
});
