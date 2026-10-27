import { describe, expect, it } from "vitest";
import { SESSION_LIST_PAGE } from "./sessionListWindow";
import type { Catalog } from "./projectContext";
import {
  groupMark,
  groupUnread,
  masterBlock,
  nextPage,
  rowState,
  sessionItemIndex,
  sidebarItems,
  windowRows,
  workspaceMarks,
} from "./sidebarRows";
import type { ProjectMeta, SessionMeta } from "./tcserver/types";
import {
  threadRow,
  type ProjectGroup,
  type ThreadRow,
  type WorkspaceSessionGroups,
} from "./workspaceSessions";

const project = (id: string, archived = false): ProjectMeta => ({
  environmentId: "local",
  id,
  workspaceId: "wa",
  name: id,
  mode: "worktree",
  branch: `tc/${id}`,
  cwd: `/wt/${id}`,
  archived,
  createdAt: 10,
});

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    environmentId: "local",
    id,
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: "chat",
    title: id,
    cwd: "/repo/a",
    status: "idle",
    archived: false,
    pinned: false,
    busySince: null,
    createdAt: 1,
    updatedAt: 100,
    ...extra,
  }) as SessionMeta;

const rows = (n: number): ThreadRow[] =>
  Array.from({ length: n }, (_, i) => threadRow(meta(`t${i}`), {}));

const group = (id: string, threads: ThreadRow[] = [], archived = false): ProjectGroup => ({
  project: project(id, archived),
  threads,
  latest: 100,
  archivedCount: 0,
});

const groups = (over: Partial<WorkspaceSessionGroups> = {}): WorkspaceSessionGroups => ({
  projects: [],
  archived: [],
  chats: [],
  ...over,
});

describe("sidebarItems", () => {
  it("lists cards first, then chats, then archived, keyed by project id", () => {
    const items = sidebarItems(
      groups({
        projects: [group("a"), group("b")],
        chats: rows(2),
        archived: [group("z", [], true)],
      }),
    );
    expect(items.map((i) => i.kind)).toEqual(["project", "project", "chats", "archived"]);
    expect(items.map((i) => i.key)).toEqual(["a", "b", "chats", "archived"]);
  });

  it("an empty home shows nothing, one chat brings its section, never the empty hint", () => {
    expect(sidebarItems(groups(), true)).toEqual([]);
    expect(sidebarItems(groups({ chats: rows(1) }), true).map((i) => i.kind)).toEqual(["chats"]);
    expect(sidebarItems(groups()).map((i) => i.kind)).toEqual(["empty"]);
  });

  it("leaves out empty sections and shows the empty hint when there is nothing", () => {
    expect(sidebarItems(groups({ projects: [group("a")] })).map((i) => i.kind)).toEqual([
      "project",
    ]);
    expect(sidebarItems(groups()).map((i) => i.kind)).toEqual(["empty"]);
  });
});

describe("sessionItemIndex", () => {
  it("finds the card, section or archived group holding a session, children included", () => {
    const kid = threadRow(meta("kid"), {});
    const parent = { ...threadRow(meta("parent"), {}), children: [kid] };
    const items = sidebarItems(
      groups({
        projects: [group("a", rows(2)), group("b", [parent])],
        chats: rows(3),
        archived: [group("z", [threadRow(meta("old"), {})], true)],
      }),
    );
    expect(sessionItemIndex(items, "t1")).toBe(0);
    expect(sessionItemIndex(items, "kid")).toBe(1);
    expect(sessionItemIndex(items, "t2")).toBe(2);
    expect(sessionItemIndex(items, "old")).toBe(3);
    expect(sessionItemIndex(items, "nope")).toBe(-1);
  });
});

describe("windowRows", () => {
  it("hands back the same array when it all fits", () => {
    const all = rows(8);
    const out = windowRows(all, SESSION_LIST_PAGE, null);
    expect(out.shown).toBe(all);
    expect(out.hidden).toBe(0);
  });

  it("shows one page and counts the rest", () => {
    const out = windowRows(rows(100), SESSION_LIST_PAGE, null);
    expect(out.shown).toHaveLength(SESSION_LIST_PAGE);
    expect(out.hidden).toBe(100 - SESSION_LIST_PAGE);
  });

  it("grows a page at a time", () => {
    const out = windowRows(rows(100), nextPage(SESSION_LIST_PAGE), null);
    expect(out.shown).toHaveLength(2 * SESSION_LIST_PAGE);
    expect(out.hidden).toBe(100 - 2 * SESSION_LIST_PAGE);
  });

  it("reaches the active row wherever it sits", () => {
    const out = windowRows(rows(100), SESSION_LIST_PAGE, "t80");
    expect(out.shown).toHaveLength(81);
    expect(out.shown[80]?.id).toBe("t80");
    expect(out.hidden).toBe(19);
  });

  it("ignores an active id that is not in the list", () => {
    expect(windowRows(rows(100), SESSION_LIST_PAGE, "elsewhere").shown).toHaveLength(
      SESSION_LIST_PAGE,
    );
  });
});

describe("rowState", () => {
  it("folds the tree's flags into the one vocabulary", () => {
    expect(rowState({ status: "running" })).toBe("working");
    expect(rowState({ status: "starting" })).toBe("working");
    expect(rowState({ status: "idle", treeHasPaused: true })).toBe("paused");
    expect(rowState({ status: "waiting" })).toBe("waiting");
    // A waiting root whose tree needs recovery reads failed.
    expect(rowState({ status: "waiting", treeCanContinue: true })).toBe("failed");
    expect(rowState({ status: "error" })).toBe("failed");
    expect(rowState({ status: "idle", treeCanContinue: true })).toBe("failed");
    // Live work outranks a failure the tree already moved past.
    expect(rowState({ status: "error", treeHasLiveWork: true })).toBe("failed");
    expect(rowState({ status: "idle", treeCanContinue: true, treeHasLiveWork: true })).toBe("working");
    expect(rowState({ status: "idle", treeHasLiveWork: true })).toBe("working");
    expect(rowState({ status: "done", treeHasLiveWork: true })).toBe("working");
    expect(rowState({ status: "watching", treeHasLiveWork: true })).toBe("watching");
    expect(rowState({ status: "queued" })).toBe("queued");
    expect(rowState({ status: "stopped" })).toBe("stopped");
  });

  it("leaves a settled row unmarked", () => {
    expect(rowState({ status: "idle" })).toBe("idle");
    expect(rowState({ status: "done" })).toBe("done");
  });
});

const row = (id: string, extra: Partial<SessionMeta> = {}, seen: Record<string, number> = {}, housed = false) =>
  threadRow(meta(id, extra), seen, 0, housed);

describe("groupMark", () => {
  it("says the loudest state: needs you, failed, working, paused", () => {
    const paused = row("p", { status: "paused" });
    const running = row("r", { status: "running" });
    const failed = row("f", { status: "error" });
    const waiting = row("w", { status: "waiting" });
    expect(groupMark([paused, running, failed, waiting])?.state).toBe("waiting");
    expect(groupMark([paused, running, failed])?.state).toBe("failed");
    expect(groupMark([paused, running])?.state).toBe("working");
    expect(groupMark([paused])?.state).toBe("paused");
    expect(groupMark([row("watch", { status: "watching" })])?.state).toBe("working");
  });

  it("is null for a quiet group", () => {
    expect(groupMark([row("a"), row("b", { status: "done" }), row("q", { status: "queued" }), row("s", { status: "stopped" })])).toBeNull();
    expect(groupMark([])).toBeNull();
  });

  it("names the newest root in the state and counts the others", () => {
    const old = row("old", { status: "running", updatedAt: 10 });
    const fresh = row("fresh", { status: "running", updatedAt: 90 });
    const quiet = row("quiet", { updatedAt: 200 });
    expect(groupMark([old, fresh, quiet])).toEqual({ state: "working", about: fresh, others: [old], more: 1 });
  });

  it("names a waiting batch thread by its master, as a nested row or a flat one", () => {
    const child = row("b1", { status: "waiting", masterId: "m", updatedAt: 300 }, {}, true);
    const master = { ...row("m", { status: "watching", isMaster: true, updatedAt: 5 }), batch: [child] };
    const other = row("x", { status: "waiting", updatedAt: 100 });
    expect(groupMark([master, other])).toEqual({ state: "waiting", about: master, others: [other], more: 1 });
    // A flat list (the rail's) finds the master by its id.
    const flatMaster = row("m", { status: "watching", isMaster: true, updatedAt: 5 });
    expect(groupMark([flatMaster, child])).toEqual({ state: "waiting", about: flatMaster, others: [], more: 0 });
  });
});

describe("groupUnread", () => {
  it("reads a settled, unseen root and never a housed one", () => {
    expect(groupUnread([row("a", { status: "done", updatedAt: 50 }, { a: 10 })])).toBe(true);
    expect(groupUnread([row("a", { status: "done", updatedAt: 50 }, { a: 90 })])).toBe(false);
    expect(groupUnread([row("a", { status: "done", updatedAt: 50 }, { a: 10 }, true)])).toBe(false);
    // A root whose tree still works says Working, not unread.
    expect(groupUnread([row("a", { status: "done", updatedAt: 50, treeHasLiveWork: true }, { a: 10 })])).toBe(false);
  });
});

describe("masterBlock", () => {
  it("carries each batch thread's state, loudest first, and counts queued and settled", () => {
    const b = (id: string, status: SessionMeta["status"]) => row(id, { status, masterId: "m" }, {}, true);
    const master = {
      ...row("m", { status: "watching", isMaster: true }),
      batch: [b("run", "running"), b("wait", "waiting"), b("q", "queued"), b("done", "done"), b("idle", "idle")],
    };
    const block = masterBlock(master, false)!;
    expect(block.state).toBe("watching");
    expect(block.lines.map((l) => [l.thread.id, l.state])).toEqual([
      ["wait", "waiting"],
      ["run", "working"],
    ]);
    expect(block).toMatchObject({ queued: 1, done: 2, total: 5 });
  });

  it("is null for a seen, settled master over a finished batch", () => {
    const master = { ...row("m", { isMaster: true }), batch: [row("d", { status: "done", masterId: "m" }, {}, true)] };
    expect(masterBlock(master, false)).toBeNull();
    expect(masterBlock(master, true)).not.toBeNull();
  });
});

describe("workspaceMarks", () => {
  const empty: Catalog = { workspaces: [], projects: [] };
  const at = (cwd: string) => ({ cwd, workspaceId: null });

  it("is quiet for a seen, idle thread and unread for an unseen settled one", () => {
    expect(workspaceMarks([meta("t1", at("/a"))], empty, { t1: 100 }).has("/a")).toBe(false);
    expect(workspaceMarks([meta("t1", { ...at("/a"), status: "done" })], empty, { t1: 50 }).get("/a")).toEqual({
      mark: null,
      unread: true,
    });
  });

  it("gives the word and the thread behind it, keeping workspaces apart", () => {
    const marks = workspaceMarks(
      [meta("t1", { ...at("/a"), status: "running" }), meta("t2", { ...at("/b"), status: "waiting" })],
      empty,
      {},
    );
    expect(marks.get("/a")?.mark).toMatchObject({ state: "working", about: { id: "t1" }, more: 0 });
    expect(marks.get("/b")?.mark).toMatchObject({ state: "waiting", about: { id: "t2" } });
  });

  it("skips archived threads, subagents, and an archived project's threads", () => {
    const retired: Catalog = {
      workspaces: [],
      projects: [{ ...project("p1", true), cwd: "/a" }],
    };
    const marks = workspaceMarks(
      [
        meta("t0", { ...at("/a"), status: "error", projectId: "p1" }),
        meta("t1", { ...at("/a"), status: "running", archived: true }),
        meta("t2", { ...at("/a"), status: "waiting", parentId: "t1" }),
      ],
      retired,
      {},
    );
    expect(marks.has("/a")).toBe(false);
  });

  it("folds a linked workspace's copies under the leader's key", () => {
    const keyOf = (path: string) => (path === "/srv/b" ? "/a" : path);
    const marks = workspaceMarks(
      [
        meta("t1", { ...at("/a"), status: "running", updatedAt: 10 }),
        meta("t2", { ...at("/srv/b"), status: "running", environmentId: "env_box", updatedAt: 20 }),
      ],
      empty,
      {},
      0,
      keyOf,
    );
    expect([...marks.keys()]).toEqual(["/a"]);
    expect(marks.get("/a")?.mark).toMatchObject({ state: "working", about: { id: "t2" }, more: 1 });
  });
});
