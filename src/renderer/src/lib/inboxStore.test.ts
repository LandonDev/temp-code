import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubInboxItem, GithubInboxSnapshot } from "@server/shared/contract-github";
import type { Link } from "./tcserver/store";
import type { ProjectMeta, WorkspaceMeta } from "./tcserver/types";
import { githubWorkspaces, inboxItemsFromSnapshot, inboxStore, workspaceIdForCwd } from "./inboxStore";

const invoke = vi.fn();
vi.mock("./native", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const ws = (over: Partial<WorkspaceMeta> = {}): WorkspaceMeta => ({
  id: "w1",
  name: "web",
  path: "/home/me/web",
  git: true,
  githubRepo: "acme/web",
  createdAt: 1,
  ...over,
});
const project = (over: Partial<ProjectMeta> = {}): ProjectMeta => ({
  id: "p1",
  workspaceId: "w1",
  name: "Auth",
  mode: "worktree",
  branch: "tc/auth",
  cwd: "/home/me/.temp-code/worktrees/auth",
  archived: false,
  createdAt: 2,
  ...over,
});
const ghItem = (over: Partial<GithubInboxItem> = {}): GithubInboxItem => ({
  kind: "pr",
  repo: "acme/web",
  number: 1,
  title: "PR",
  url: "https://github.com/acme/web/pull/1",
  state: "open",
  draft: false,
  updatedAt: "2026-10-01T00:00:00Z",
  author: { login: "Me", avatarUrl: "https://a/me" },
  assignees: [],
  labels: [],
  reviewDecision: "APPROVED",
  headRefName: "feat",
  baseRefName: "master",
  checks: "SUCCESS",
  reviewRequested: [],
  ...over,
});
const snapshot = (over: Partial<GithubInboxSnapshot> = {}): GithubInboxSnapshot => ({
  viewer: "me",
  auth: { state: "ok", message: "" },
  fetchedAt: 100,
  refreshing: false,
  repos: [{ repo: "acme/web", fetchedAt: 100, error: null, items: [ghItem()] }],
  ...over,
});

describe("inboxItemsFromSnapshot", () => {
  it("joins repos with workspaces, carries the new fields, and marks mine against the viewer", () => {
    const items = inboxItemsFromSnapshot(
      snapshot({
        repos: [
          {
            repo: "acme/web",
            fetchedAt: 1,
            error: null,
            items: [
              ghItem({ number: 1, updatedAt: "2026-10-01T00:00:00Z" }),
              ghItem({
                kind: "issue",
                number: 2,
                updatedAt: "2026-10-02T00:00:00Z",
                author: { login: "other", avatarUrl: "" },
                assignees: [{ login: "ME", avatarUrl: "" }],
                reviewRequested: ["me"],
              }),
            ],
          },
        ],
      }),
      [ws()],
      [],
      "",
    );
    expect(items.map((i) => i.number)).toEqual([2, 1]); // newest first
    expect(items[1]).toMatchObject({
      provider: "github",
      kind: "pr",
      workspaceId: "w1",
      projectPath: "/home/me/web",
      repo: "acme/web",
      author: { login: "Me", avatarUrl: "https://a/me" },
      reviewDecision: "APPROVED",
      headRefName: "feat",
      baseRefName: "master",
      checks: "SUCCESS",
      mine: { authored: true, assigned: false, reviewRequested: false },
    });
    expect(items[0].mine).toEqual({ authored: false, assigned: true, reviewRequested: true });
  });

  it("claims a repo shared by two workspaces for the older one, once", () => {
    const items = inboxItemsFromSnapshot(
      snapshot(),
      [ws({ id: "new", path: "/home/me/web-copy", createdAt: 9 }), ws({ id: "old", createdAt: 1 })],
      [],
      "",
    );
    expect(items).toHaveLength(1);
    expect(items[0].workspaceId).toBe("old");
  });

  it("skips repos no workspace names and workspaces off GitHub", () => {
    const items = inboxItemsFromSnapshot(
      snapshot({ repos: [{ repo: "acme/other", fetchedAt: 1, error: null, items: [ghItem({ repo: "acme/other" })] }] }),
      [ws(), ws({ id: "gl", path: "/gl", githubRepo: null })],
      [],
      "",
    );
    expect(items).toEqual([]);
    expect(githubWorkspaces([ws(), ws({ id: "gl", githubRepo: null }), ws({ id: "plain", git: false })]).map((w) => w.id)).toEqual(["w1"]);
  });

  it("uses the active project's folder when it lives in the item's workspace", () => {
    const p = project();
    expect(inboxItemsFromSnapshot(snapshot(), [ws()], [p], p.cwd)[0].projectPath).toBe(p.cwd);
    expect(inboxItemsFromSnapshot(snapshot(), [ws()], [p], "/elsewhere")[0].projectPath).toBe("/home/me/web");
    expect(inboxItemsFromSnapshot(null, [ws()], [p], p.cwd)).toEqual([]);
  });
});

describe("workspaceIdForCwd", () => {
  it("resolves a project cwd, a workspace path, and nothing else", () => {
    const catalog = { workspaces: [ws()], projects: [project()] };
    expect(workspaceIdForCwd(catalog, project().cwd)).toBe("w1");
    expect(workspaceIdForCwd(catalog, "/home/me/web/")).toBe("w1");
    expect(workspaceIdForCwd(catalog, "/nowhere")).toBeNull();
    expect(workspaceIdForCwd(catalog, "")).toBeNull();
  });
});

// ── the store ──

type FakeLink = Link & { calls: { method: string; params: unknown }[]; open: () => void; answer: GithubInboxSnapshot };

function fakeLink(connected: boolean): FakeLink {
  const openers = new Set<() => void>();
  const link: FakeLink = {
    calls: [],
    answer: snapshot(),
    connected,
    request<T>(method: string, params?: unknown): Promise<T> {
      link.calls.push({ method, params });
      if (method === "github.inbox") return Promise.resolve(link.answer as T);
      if (method === "github.inboxRefresh") return Promise.resolve({ ...link.answer, fetchedAt: 200 } as T);
      return Promise.reject(new Error(`unexpected ${method}`));
    },
    onPush: () => () => undefined,
    onOpen: (listener) => {
      openers.add(listener);
      return () => openers.delete(listener);
    },
    open: () => {
      for (const l of openers) l();
    },
  };
  return link;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invoke.mockReset();
  inboxStore.reset();
});
afterEach(() => inboxStore.reset());

describe("inboxStore", () => {
  it("connect reads the stored snapshot once and never asks for a refresh", async () => {
    const link = fakeLink(false);
    inboxStore.connect(link);
    expect(link.calls).toEqual([]);
    link.open();
    await flush();
    expect(link.calls.map((c) => c.method)).toEqual(["github.inbox"]);
    expect(inboxStore.getSnapshot()).toMatchObject({ githubLoaded: true, github: { fetchedAt: 100 }, refreshing: false });
    await flush();
    expect(link.calls.map((c) => c.method)).toEqual(["github.inbox"]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("connect on an open socket reads at once", async () => {
    const link = fakeLink(true);
    inboxStore.connect(link);
    await flush();
    expect(link.calls.map((c) => c.method)).toEqual(["github.inbox"]);
  });

  it("refreshGithub calls the server once per request, shares a call in flight, and stores the result", async () => {
    const link = fakeLink(true);
    inboxStore.connect(link);
    await flush();
    const a = inboxStore.refreshGithub("open");
    const b = inboxStore.refreshGithub("interval");
    expect(inboxStore.getSnapshot().refreshing).toBe(true);
    expect(await b).toBe(await a);
    expect(link.calls.map((c) => [c.method, c.params])).toEqual([
      ["github.inbox", undefined],
      ["github.inboxRefresh", { reason: "open" }],
    ]);
    expect(inboxStore.getSnapshot()).toMatchObject({ refreshing: false, github: { fetchedAt: 200 } });
    await inboxStore.refreshGithub("manual");
    expect(link.calls).toHaveLength(3);
  });

  it("refreshLinear runs the Linear fetch for a query, fresh for a minute unless forced", async () => {
    invoke.mockImplementation((method: string) => {
      if (method === "linear_status") return Promise.resolve({ connected: true });
      if (method === "linear_list_issues")
        return Promise.resolve([
          {
            id: "L1",
            identifier: "ENG-1",
            number: 1,
            title: "Issue",
            url: "https://linear.app/x",
            state: "Todo",
            stateType: "unstarted",
            updatedAt: "2026-10-01T00:00:00Z",
            labels: [],
            assignees: [],
            draft: false,
            repo: "Eng",
            teamId: "t1",
            teamName: "Eng",
            projectPath: "",
          },
        ]);
      return Promise.reject(new Error(`unexpected ${method}`));
    });
    const query = { assignedToMe: false, state: "open" as const, hiddenTeamIds: [] };
    const items = await inboxStore.refreshLinear(query);
    expect(items.map((i) => [i.provider, i.identifier])).toEqual([["linear", "ENG-1"]]);
    expect(inboxStore.getSnapshot().linear).toMatchObject({ items, error: null, loading: false });
    await inboxStore.refreshLinear(query);
    expect(invoke.mock.calls.filter((c) => c[0] === "linear_list_issues")).toHaveLength(1);
    await inboxStore.refreshLinear(query, { force: true });
    expect(invoke.mock.calls.filter((c) => c[0] === "linear_list_issues")).toHaveLength(2);
    await inboxStore.refreshLinear({ ...query, assignedToMe: true });
    expect(invoke.mock.calls.filter((c) => c[0] === "linear_list_issues")).toHaveLength(3);
  });
});

/**
 * The fork-storm rule: the store has no clock of its own, and the server's
 * fetch request is wired in exactly one renderer file. The open inbox view
 * owns every timer and calls `refreshGithub`.
 */
describe("inbox network paths", () => {
  const root = new URL("..", import.meta.url).pathname;

  function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) sources(full, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  }

  it("inboxStore.ts keeps no timer and no visibility listener", () => {
    const source = readFileSync(new URL("./inboxStore.ts", import.meta.url), "utf8");
    for (const banned of ["setInterval", "setTimeout", "visibilitychange", "addEventListener"]) {
      expect(source, `must not use ${banned}`).not.toContain(banned);
    }
  });

  it("github.inboxRefresh is requested from inboxStore.ts alone", () => {
    const offenders = sources(root)
      .filter((file) => readFileSync(file, "utf8").includes("inboxRefresh"))
      .map((file) => file.slice(root.length))
      .filter((file) => file !== "lib/inboxStore.ts");
    expect(offenders).toEqual([]);
  });
});
