import { describe, expect, it } from "vitest";
import { projectCardStatus } from "./projectCardModel";
import { SESSION_LIST_PAGE } from "./sessionListWindow";
import { liveLines, nextPage, sessionItemIndex, sidebarItems, windowRows } from "./sidebarRows";
import type { ProjectMeta, SessionMeta } from "./tcserver/types";
import {
  threadRow,
  type ProjectGroup,
  type ThreadRow,
  type WorkspaceSessionGroups,
} from "./workspaceSessions";

const project = (id: string, archived = false): ProjectMeta => ({
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

describe("liveLines", () => {
  it("prints running, then paused, then unread, keyed by thread id", () => {
    const threads = [
      threadRow(meta("done", { status: "done", updatedAt: 50 }), {}),
      threadRow(meta("run", { status: "running", busySince: 40 }), {}),
      threadRow(meta("wait", { status: "waiting" }), {}),
      threadRow(meta("pause", { status: "paused" }), {}),
      threadRow(meta("seen", { status: "idle", updatedAt: 5 }), { seen: 9 }),
    ];
    const lines = liveLines(projectCardStatus(threads, null, { seen: 9 }));
    expect(lines.map((l) => `${l.kind}:${l.id}`)).toEqual([
      "running:run",
      "paused:pause",
      "unread:done",
    ]);
    expect(lines[0]?.thread).toBe(threads[1]);
  });
});
