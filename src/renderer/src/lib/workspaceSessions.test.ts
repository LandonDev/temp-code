import { describe, expect, it } from "vitest";
import type { ProjectMeta, SessionMeta, WorkspaceMeta } from "./tcserver/types";
import {
  groupWorkspaceSessions,
  summarizeThreads,
  threadRow,
} from "./workspaceSessions";

const ws = (id: string, path: string): WorkspaceMeta => ({
  id,
  name: id,
  path,
  git: true,
  createdAt: 1,
});

const project = (
  id: string,
  workspaceId: string,
  extra: Partial<ProjectMeta> = {},
): ProjectMeta => ({
  id,
  workspaceId,
  name: id,
  mode: "worktree",
  branch: `tc/${id}`,
  cwd: `/wt/${id}`,
  archived: false,
  createdAt: 10,
  ...extra,
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

const workspaces = [ws("wa", "/repo/a"), ws("wb", "/repo/b")];
const projects = [
  project("p1", "wa"),
  project("p2", "wa"),
  project("pb", "wb"),
];

describe("groupWorkspaceSessions", () => {
  it("places threads by project, workspace id, then cwd, and drops other workspaces", () => {
    const metas = [
      meta("t-project", { projectId: "p1", cwd: "/wt/p1" }),
      meta("t-loose", { workspaceId: "wa" }),
      meta("t-legacy", { cwd: "/repo/a/" }),
      meta("t-other", { workspaceId: "wb" }),
      meta("t-other-project", { projectId: "pb", cwd: "/wt/pb" }),
      meta("t-child", { parentId: "t-project", projectId: "p1" }),
    ];
    const out = groupWorkspaceSessions(metas, projects, workspaces, "wa", {});
    expect(
      out.projects.find((g) => g.project.id === "p1")?.threads.map((t) => t.id),
    ).toEqual(["t-project"]);
    expect(out.chats.map((t) => t.id).sort()).toEqual(["t-legacy", "t-loose"]);
    expect(out.archived).toEqual([]);
  });

  it("nests children under their root, ranked, and skips archived ones", () => {
    const metas = [
      meta("root", { projectId: "p1", cwd: "/wt/p1" }),
      meta("loose", { workspaceId: "wa" }),
      meta("c-done", { parentId: "root", projectId: "p1", status: "idle", createdAt: 1, agentType: "explorer" }),
      meta("c-wait", { parentId: "root", projectId: "p1", status: "waiting", createdAt: 3, agentType: "implementer" }),
      meta("c-run", { parentId: "root", projectId: "p1", status: "running", createdAt: 2 }),
      meta("c-gone", { parentId: "root", projectId: "p1", archived: true }),
      meta("c-loose", { parentId: "loose", workspaceId: "wa", agentType: "reviewer" }),
    ];
    const out = groupWorkspaceSessions(metas, projects, workspaces, "wa", {});
    const root = out.projects.find((g) => g.project.id === "p1")?.threads[0];
    expect(root?.id).toBe("root");
    expect(root?.children?.map((c) => c.id)).toEqual(["c-wait", "c-run", "c-done"]);
    expect(root?.children?.[0].agentType).toBe("implementer");
    expect(out.chats.map((t) => t.id)).toEqual(["loose"]);
    expect(out.chats[0].children?.map((c) => c.id)).toEqual(["c-loose"]);
    expect(out.chats[0].agentType).toBeUndefined();
  });

  it("treats a thread whose project is unknown as a loose chat", () => {
    const metas = [meta("orphan", { projectId: "gone", workspaceId: "wa" })];
    const out = groupWorkspaceSessions(metas, projects, workspaces, "wa", {});
    expect(out.chats.map((t) => t.id)).toEqual(["orphan"]);
  });

  it("sorts threads newest first and projects by latest activity, empty ones by createdAt", () => {
    const list = [
      project("old", "wa", { createdAt: 50 }),
      project("busy", "wa", { createdAt: 5 }),
      project("fresh", "wa", { createdAt: 500 }),
    ];
    const metas = [
      meta("a", { projectId: "busy", updatedAt: 100 }),
      meta("b", { projectId: "busy", updatedAt: 300 }),
      meta("c", { projectId: "old", updatedAt: 200 }),
    ];
    const out = groupWorkspaceSessions(metas, list, workspaces, "wa", {});
    expect(out.projects.map((g) => g.project.id)).toEqual([
      "fresh",
      "busy",
      "old",
    ]);
    expect(out.projects[1]?.threads.map((t) => t.id)).toEqual(["b", "a"]);
    expect(out.projects[1]?.latest).toBe(300);
    expect(out.projects[0]?.latest).toBe(500);
  });

  it("splits archived projects out with their threads and counts archived threads", () => {
    const list = [
      project("live", "wa"),
      project("gone", "wa", { archived: true }),
    ];
    const metas = [
      meta("x", { projectId: "gone" }),
      meta("y", { projectId: "live" }),
      meta("z", { projectId: "live", archived: true }),
    ];
    const out = groupWorkspaceSessions(metas, list, workspaces, "wa", {});
    expect(out.projects.map((g) => g.project.id)).toEqual(["live"]);
    expect(out.projects[0]?.threads.map((t) => t.id)).toEqual(["y"]);
    expect(out.projects[0]?.archivedCount).toBe(1);
    expect(out.archived.map((g) => g.project.id)).toEqual(["gone"]);
    expect(out.archived[0]?.threads.map((t) => t.id)).toEqual(["x"]);
  });

  it("sorts loose chats newest first", () => {
    const metas = [
      meta("a", { workspaceId: "wa", updatedAt: 1 }),
      meta("b", { workspaceId: "wa", updatedAt: 3 }),
      meta("c", { workspaceId: "wa", updatedAt: 2 }),
    ];
    const out = groupWorkspaceSessions(metas, projects, workspaces, "wa", {});
    expect(out.chats.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });
});

describe("threadRow", () => {
  it("marks idle and done threads unread only when newer than lastSeen", () => {
    const seen = { a: 100, b: 50 };
    expect(threadRow(meta("a", { updatedAt: 100 }), seen).unread).toBe(false);
    expect(
      threadRow(meta("b", { updatedAt: 100, status: "done" }), seen).unread,
    ).toBe(true);
    expect(threadRow(meta("c", { updatedAt: 100 }), seen).unread).toBe(true);
  });

  it("never marks a running, waiting, paused, or failed thread unread", () => {
    for (const status of [
      "starting",
      "running",
      "waiting",
      "paused",
      "error",
    ] as const) {
      expect(threadRow(meta("t", { status, updatedAt: 100 }), {}).unread).toBe(
        false,
      );
    }
  });

  it("derives the state flags from status", () => {
    expect(threadRow(meta("t", { status: "starting" }), {}).running).toBe(true);
    expect(
      threadRow(meta("t", { status: "running", busySince: 7 }), {}),
    ).toMatchObject({
      running: true,
      busySince: 7,
    });
    expect(threadRow(meta("t", { status: "waiting" }), {}).needsYou).toBe(true);
    expect(threadRow(meta("t", { status: "error" }), {}).failed).toBe(true);
    expect(threadRow(meta("t", { status: "paused" }), {}).paused).toBe(true);
  });
});

describe("summarizeThreads", () => {
  it("counts each thread once", () => {
    const rows = [
      meta("1", { status: "running" }),
      meta("2", { status: "waiting" }),
      meta("3", { status: "error" }),
      meta("4", { status: "paused" }),
      meta("5", { status: "idle", updatedAt: 10 }),
      meta("6", { status: "idle", updatedAt: 10 }),
    ].map((m) => threadRow(m, { "6": 10 }));
    expect(summarizeThreads(rows)).toEqual({
      running: 1,
      needYou: 1,
      failed: 1,
      paused: 1,
      unread: 1,
      dormant: 1,
    });
  });
});
