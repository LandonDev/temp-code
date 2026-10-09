import { describe, expect, it } from "vitest";
import type { Catalog } from "../lib/projectContext";
import type { Session } from "../lib/session";
import type { SessionMeta } from "../lib/tcserver/types";
import { projectSignals, sessionNeedsYou, workspaceRailStatuses } from "./useProjectSignals";

const catalog: Catalog = { workspaces: [], projects: [] };

type Signal = Parameters<typeof sessionNeedsYou>[0];

function session(over: Partial<Signal>): Session {
  return {
    cwd: "/repo",
    projectId: null,
    workspaceId: null,
    busy: false,
    status: "idle",
    treeCanContinue: false,
    ...over,
  } as Session;
}

describe("sessionNeedsYou", () => {
  it("counts waiting, errored and continuable threads, nothing else", () => {
    expect(sessionNeedsYou(session({ status: "waiting" }))).toBe(true);
    expect(sessionNeedsYou(session({ status: "error" }))).toBe(true);
    expect(sessionNeedsYou(session({ treeCanContinue: true }))).toBe(true);
    expect(sessionNeedsYou(session({ status: "running", busy: true }))).toBe(false);
    expect(sessionNeedsYou(session({ status: "idle" }))).toBe(false);
  });
});

describe("projectSignals", () => {
  it("puts a waiting thread and an errored one in needsYou, not busy", () => {
    const signals = projectSignals(
      [
        session({ cwd: "/a", status: "waiting", busy: true }),
        session({ cwd: "/b", status: "error" }),
      ],
      catalog,
    );
    expect(signals.needsYou).toEqual(["/a", "/b"]);
    expect(signals.busy).toEqual([]);
  });

  it("ignores an archived thread, busy or waiting", () => {
    const signals = projectSignals(
      [
        session({ cwd: "/a", status: "running", busy: true, archived: true }),
        session({ cwd: "/b", status: "waiting", busy: true, archived: true }),
      ],
      catalog,
    );
    expect(signals).toEqual({ busy: [], needsYou: [] });
  });

  it("leaves a running thread busy", () => {
    const signals = projectSignals(
      [session({ cwd: "/a", status: "running", busy: true })],
      catalog,
    );
    expect(signals.busy).toEqual(["/a"]);
    expect(signals.needsYou).toEqual([]);
  });

  it("drops a folder from busy when another thread there needs you", () => {
    const signals = projectSignals(
      [
        session({ cwd: "/a", status: "running", busy: true }),
        session({ cwd: "/a", status: "waiting" }),
      ],
      catalog,
    );
    expect(signals.busy).toEqual([]);
    expect(signals.needsYou).toEqual(["/a"]);
  });

  it("keys a loose chat under the home, beside the workspaces", () => {
    const signals = projectSignals(
      [
        session({ cwd: "~", status: "running", busy: true }),
        session({ cwd: "/a", status: "waiting" }),
      ],
      catalog,
    );
    expect(signals.busy).toEqual(["~"]);
    expect(signals.needsYou).toEqual(["/a"]);
  });

  it("ignores idle threads", () => {
    expect(projectSignals([session({ cwd: "/a" })], catalog)).toEqual({
      busy: [],
      needsYou: [],
    });
  });

  it("lists a folder once however many threads it holds", () => {
    const signals = projectSignals(
      [
        session({ cwd: "/a", status: "running", busy: true }),
        session({ cwd: "/a", status: "running", busy: true }),
      ],
      catalog,
    );
    expect(signals.busy).toEqual(["/a"]);
  });
});

function meta(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: "chat",
    planPath: null,
    provider: "claude",
    model: "claude",
    reasoning: "medium",
    agentType: "implementer",
    title: id,
    cwd: "/a",
    status: "idle",
    pinned: false,
    archived: false,
    permission: "supervised",
    fast: false,
    context1m: false,
    busySince: null,
    pausedAt: null,
    frozenActiveElapsed: null,
    nativeId: null,
    createdAt: 1,
    updatedAt: 100,
    ...over,
  } as SessionMeta;
}

describe("workspaceRailStatuses", () => {
  it("is quiet for an idle, already-seen thread", () => {
    const statuses = workspaceRailStatuses([meta("t1")], catalog, { t1: 100 });
    expect(statuses.has("/a")).toBe(false);
  });

  it("surfaces unread for a settled thread newer than its last-seen mark", () => {
    const statuses = workspaceRailStatuses([meta("t1", { status: "done" })], catalog, {
      t1: 50,
    });
    expect(statuses.get("/a")).toEqual({ kind: "unread", count: 1 });
  });

  it("does not surface unread once the thread has been seen", () => {
    const statuses = workspaceRailStatuses([meta("t1", { status: "done" })], catalog, {
      t1: 500,
    });
    expect(statuses.has("/a")).toBe(false);
  });

  it("ranks paused over everything else in the same workspace", () => {
    const statuses = workspaceRailStatuses(
      [
        meta("t1", { status: "paused" }),
        meta("t2", { status: "running" }),
        meta("t3", { status: "waiting" }),
      ],
      catalog,
      {},
    );
    expect(statuses.get("/a")).toEqual({ kind: "paused", count: 1 });
  });

  it("ranks needs-you (waiting or a recoverable failure) over busy and unread", () => {
    const statuses = workspaceRailStatuses(
      [
        meta("t1", { status: "waiting" }),
        meta("t2", { status: "running" }),
        meta("t3", { status: "done" }),
      ],
      catalog,
      { t3: 50 },
    );
    expect(statuses.get("/a")).toEqual({ kind: "needsYou", count: 1 });
  });

  it("ranks busy over unread, and carries the running thread for the rail's inline line", () => {
    const running = meta("t1", { status: "running" });
    const statuses = workspaceRailStatuses(
      [running, meta("t2", { status: "done" })],
      catalog,
      { t2: 50 },
    );
    expect(statuses.get("/a")).toEqual({ kind: "busy", count: 1, running: [running] });
  });

  it("counts every thread in the dominant bucket, not just one", () => {
    const statuses = workspaceRailStatuses(
      [meta("t1", { status: "waiting" }), meta("t2", { status: "error" })],
      catalog,
      {},
    );
    expect(statuses.get("/a")).toEqual({ kind: "needsYou", count: 2 });
  });

  it("keeps two workspaces apart", () => {
    const running = meta("t1", { status: "running", cwd: "/a" });
    const statuses = workspaceRailStatuses(
      [running, meta("t2", { status: "waiting", cwd: "/b" })],
      catalog,
      {},
    );
    expect(statuses.get("/a")).toEqual({ kind: "busy", count: 1, running: [running] });
    expect(statuses.get("/b")).toEqual({ kind: "needsYou", count: 1 });
  });

  it("names every running thread, loudest first, for a workspace with several", () => {
    const t1 = meta("t1", { status: "running" });
    const t2 = meta("t2", { status: "starting" });
    const statuses = workspaceRailStatuses([t1, t2], catalog, {});
    expect(statuses.get("/a")).toEqual({ kind: "busy", count: 2, running: [t1, t2] });
  });

  it("skips a thread whose project is archived, even if the thread itself is not", () => {
    // The popover (groupWorkspaceSessions) puts an archived project's
    // threads in `groups.archived`, never `groups.projects` — the chip
    // must agree, or it opens a popover with nothing in it.
    const withArchivedProject: Catalog = {
      workspaces: [],
      projects: [
        {
          id: "p1",
          workspaceId: "w1",
          name: "Retired",
          mode: "local",
          branch: null,
          cwd: "/a",
          archived: true,
          createdAt: 1,
        },
      ],
    };
    const statuses = workspaceRailStatuses(
      [meta("t1", { status: "error", projectId: "p1" })],
      withArchivedProject,
      {},
    );
    expect(statuses.has("/a")).toBe(false);
  });

  it("skips archived and subagent-child threads", () => {
    const statuses = workspaceRailStatuses(
      [
        meta("t1", { status: "running", archived: true }),
        meta("t2", { status: "waiting", parentId: "t1" }),
      ],
      catalog,
      {},
    );
    expect(statuses.has("/a")).toBe(false);
  });
});
