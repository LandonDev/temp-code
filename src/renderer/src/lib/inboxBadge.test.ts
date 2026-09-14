import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("./native", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  clearInboxCache,
  listInboxItems,
  type InboxQuery,
} from "./githubTasks";
import {
  inboxUnseenFromCache,
  resetInboxBadge,
  subscribeInboxBadge,
} from "./inboxBadge";

const query: InboxQuery = {
  assignedToMe: false,
  state: "open",
  search: "",
  linearHiddenTeamIds: [],
};

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

function workItem(number: number, updatedAt: string) {
  return {
    kind: "issue",
    number,
    title: `#${number}`,
    url: `https://github.com/acme/web/issues/${number}`,
    state: "open",
    updatedAt,
    labels: [],
    assignees: [],
    draft: false,
    repo: "acme/web",
  };
}

/** Answers the server the way a project with one open issue would. */
function answerLikeServer(issueUpdatedAt: string) {
  invoke.mockImplementation((method: string, args?: { kind?: string }) => {
    if (method === "git_github_repo") return Promise.resolve("acme/web");
    if (method === "git_github_work_items") {
      return Promise.resolve(
        args?.kind === "issue" ? [workItem(1, issueUpdatedAt)] : [],
      );
    }
    if (method === "linear_status") return Promise.resolve({ connected: false });
    return Promise.reject(new Error(`unexpected ${method}`));
  });
}

beforeEach(() => {
  mockLocalStorage();
  clearInboxCache();
  resetInboxBadge();
  invoke.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("inbox badge with the inbox closed", () => {
  it("never issues a request: not on subscribe, not on read, not over time", async () => {
    const off = subscribeInboxBadge(() => undefined);
    expect(inboxUnseenFromCache()).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(inboxUnseenFromCache()).toBe(false);
    off();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("inbox badge after the open inbox fetched", () => {
  it("seeds seen on the first list, then lights up for a newer item", async () => {
    let ticks = 0;
    const off = subscribeInboxBadge(() => void ticks++);

    answerLikeServer("2026-01-01T00:00:00Z");
    await listInboxItems([{ path: "/tmp/web" }], query);
    expect(ticks).toBeGreaterThan(0);
    expect(inboxUnseenFromCache()).toBe(false);

    answerLikeServer("2026-02-01T00:00:00Z");
    await listInboxItems([{ path: "/tmp/web" }], query, { force: true });
    expect(inboxUnseenFromCache()).toBe(true);
    off();
  });
});

describe("listInboxItems", () => {
  it("runs one fetch at a time and one gh call at a time inside it", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    invoke.mockImplementation(async (method: string, args?: { cwd?: string; kind?: string }) => {
      order.push(`${method}:${args?.cwd ?? ""}:${args?.kind ?? ""}`);
      if (method === "git_github_repo") {
        if (args?.cwd === "/tmp/a") await gate;
        return `acme/${args?.cwd?.slice(5)}`;
      }
      if (method === "git_github_work_items") return [];
      if (method === "linear_status") return { connected: false };
      throw new Error(`unexpected ${method}`);
    });

    const first = listInboxItems([{ path: "/tmp/a" }, { path: "/tmp/b" }], query);
    const second = listInboxItems([{ path: "/tmp/c" }], query);
    await vi.advanceTimersByTimeAsync(0);
    // Only the first project's repo lookup has started; nothing else fans out.
    expect(order).toEqual(["git_github_repo:/tmp/a:"]);

    release();
    await first;
    await second;
    expect(order).toEqual([
      "git_github_repo:/tmp/a:",
      "git_github_repo:/tmp/b:",
      "git_github_work_items:/tmp/a:issue",
      "git_github_work_items:/tmp/a:pr",
      "git_github_work_items:/tmp/b:issue",
      "git_github_work_items:/tmp/b:pr",
      "linear_status::",
      "git_github_repo:/tmp/c:",
      "git_github_work_items:/tmp/c:issue",
      "git_github_work_items:/tmp/c:pr",
      "linear_status::",
    ]);
  });
});
