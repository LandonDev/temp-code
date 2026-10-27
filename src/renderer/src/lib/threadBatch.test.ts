import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalog } from "./projectContext";
import type { ProjectMeta, SessionMeta, WorkspaceMeta } from "./tcserver/types";

vi.mock("./tcserver/commands", () => ({ sessionBatch: vi.fn() }));
vi.mock("./connection/registry", () => ({
  registry: { environment: (id: string) => (id === "env_box" ? { id, name: "the box" } : undefined) },
}));

import * as commands from "./tcserver/commands";
import { sessionStore } from "./tcserver/store";
import {
  ARCHIVE_DONE_AGE_MS,
  batchConfirm,
  batchTargets,
  cancelThreadBatch,
  confirmThreadBatch,
  hostScope,
  needsConfirm,
  requestThreadBatch,
  resetThreadBatchForTests,
  resourcesHeldBy,
  runThreadBatch,
  setResourceCleanup,
  useBatchNotices,
  useBatchPending,
  type BatchSelection,
} from "./threadBatch";

const catalog: Catalog = {
  workspaces: [{ id: "w1", path: "/srv/work", environmentId: "env_box" } as WorkspaceMeta],
  projects: [{ id: "p1", workspaceId: "w1", cwd: "/srv/work/app", archived: false, environmentId: "env_box" } as ProjectMeta],
};

const NOW = 1_000_000_000;

function meta(over: Partial<SessionMeta>): SessionMeta {
  return {
    id: "s",
    environmentId: "local",
    parentId: null,
    projectId: null,
    workspaceId: null,
    cwd: "/tmp/a",
    title: "t",
    status: "idle",
    archived: false,
    updatedAt: NOW - ARCHIVE_DONE_AGE_MS - 1,
    ...over,
  } as SessionMeta;
}

const all: BatchSelection = { catalog, lastSeen: {}, floor: NOW, now: NOW, scope: { kind: "all" } };
const ids = (list: SessionMeta[]) => list.map((t) => t.id);

describe("batchTargets", () => {
  const running = meta({ id: "run", status: "running" });
  const starting = meta({ id: "start", status: "starting" });
  const waiting = meta({ id: "wait", status: "waiting" });
  const fleet = meta({ id: "fleet", status: "idle", treeHasLiveWork: true });
  const paused = meta({ id: "paused", status: "paused" });
  const pausedTree = meta({ id: "pausedTree", status: "idle", treeHasPaused: true });
  const stopped = meta({ id: "stopped", status: "stopped" });
  const idle = meta({ id: "idle", status: "idle" });
  const done = meta({ id: "done", status: "done" });
  const errored = meta({ id: "err", status: "error" });
  const child = meta({ id: "child", status: "running", parentId: "run" });
  const archived = meta({ id: "gone", status: "running", archived: true });
  const metas = [running, starting, waiting, fleet, paused, pausedTree, stopped, idle, done, errored, child, archived];

  it("pause takes every root with a running turn, not a paused or archived one, never a subagent", () => {
    expect(ids(batchTargets("pause", metas, all))).toEqual(["run", "start", "wait", "fleet"]);
  });
  it("stop takes the same running turns", () => {
    expect(ids(batchTargets("stop", metas, all))).toEqual(["run", "start", "wait", "fleet"]);
  });
  it("resume takes paused trees and stopped threads", () => {
    expect(ids(batchTargets("resume", metas, all))).toEqual(["paused", "pausedTree", "stopped"]);
  });
  it("archive done takes idle, read threads older than ten minutes with nothing pending", () => {
    expect(ids(batchTargets("archiveDone", metas, all))).toEqual(["idle", "done"]);
  });
  it("a queued thread: Pause and Resume leave it, Stop and Archive done remove it from the queue", () => {
    const queued = meta({ id: "queued", status: "queued", updatedAt: NOW });
    const list = [...metas, queued];
    expect(ids(batchTargets("pause", list, all))).not.toContain("queued");
    expect(ids(batchTargets("resume", list, all))).not.toContain("queued");
    expect(ids(batchTargets("stop", list, all))).toContain("queued");
    expect(ids(batchTargets("archiveDone", list, all))).toContain("queued");
  });
  it("archive done leaves an unread thread, a recent one, a failed one and a waiting one", () => {
    const unread = meta({ id: "unread", updatedAt: NOW - ARCHIVE_DONE_AGE_MS - 5 });
    const recent = meta({ id: "recent", updatedAt: NOW - ARCHIVE_DONE_AGE_MS + 1 });
    const failed = meta({ id: "failed", status: "idle", treeCanContinue: true });
    const retry = meta({ id: "retry", status: "idle", canContinue: true });
    const sel: BatchSelection = { ...all, floor: 0, lastSeen: { idle: NOW, done: NOW, recent: NOW, failed: NOW, retry: NOW } };
    expect(ids(batchTargets("archiveDone", [unread, recent, failed, retry, idle, done, waiting], sel))).toEqual(["idle", "done"]);
  });
  it("archive done counts a thread with no seen entry as read up to the floor", () => {
    expect(ids(batchTargets("archiveDone", [idle], { ...all, floor: idle.updatedAt - 1 }))).toEqual([]);
    expect(ids(batchTargets("archiveDone", [idle], { ...all, floor: idle.updatedAt }))).toEqual(["idle"]);
  });
  it("scopes to a project by workspace path and to a host by environment", () => {
    const onBox = meta({ id: "box", status: "running", projectId: "p1", cwd: "/srv/work/app", environmentId: "env_box" });
    const here = meta({ id: "here", status: "running", cwd: "/tmp/here" });
    const list = [onBox, here];
    expect(ids(batchTargets("pause", list, { ...all, scope: { kind: "project", path: "/srv/work", name: "work" } }))).toEqual(["box"]);
    expect(ids(batchTargets("pause", list, { ...all, scope: { kind: "project", path: "/tmp/here", name: "here" } }))).toEqual(["here"]);
    expect(ids(batchTargets("pause", list, { ...all, scope: { kind: "host", environmentId: "env_box", name: "box" } }))).toEqual(["box"]);
    expect(ids(batchTargets("pause", list, { ...all, scope: { kind: "host", environmentId: "local", name: "Mac" } }))).toEqual(["here"]);
  });
  it("scopes a workspace linked across hosts to every copy's folder", () => {
    const onBox = meta({ id: "box", status: "running", projectId: "p1", cwd: "/srv/work/app", environmentId: "env_box" });
    const here = meta({ id: "here", status: "running", cwd: "/tmp/here" });
    const elsewhere = meta({ id: "elsewhere", status: "running", cwd: "/tmp/other" });
    const scope = { kind: "project" as const, path: "/tmp/here", paths: ["/tmp/here", "/srv/work"], name: "app" };
    expect(ids(batchTargets("pause", [onBox, here, elsewhere], { ...all, scope }))).toEqual(["box", "here"]);
  });
});

describe("batchConfirm", () => {
  const box = { kind: "host", environmentId: "env_box", name: "the box" } as const;
  it("says one line per action, with no separator", () => {
    expect(batchConfirm("pause", 2, box).body).toBe("Each keeps its place and continues from there.");
    expect(batchConfirm("stop", 2, box).body).toBe("Their turns end now; each keeps its history.");
    expect(batchConfirm("stop", 3, box, null, 1).body).toBe("Their turns end now; each keeps its history.");
    expect(batchConfirm("archiveDone", 2, box).body).toBe("Idle ten minutes or more, read, and waiting on nothing.");
  });
  it("names the count and the host", () => {
    const c = batchConfirm("pause", 15, box);
    expect(c.title).toBe("Pause 15 running threads on the box?");
    expect(c.confirmLabel).toBe("Pause 15");
    expect(c.danger).toBe(false);
    expect(c.cleanup).toBeNull();
  });
  it("names the queued threads Stop removes from the queue", () => {
    expect(batchConfirm("stop", 5, box, null, 2).title).toBe("Stop 3 running threads and remove 2 from the queue on the box?");
    expect(batchConfirm("stop", 5, box, null, 2).confirmLabel).toBe("Stop 5");
    const only = batchConfirm("stop", 2, box, null, 2);
    expect(only.title).toBe("Remove 2 threads from the queue on the box?");
    expect(only.confirmLabel).toBe("Remove 2");
    expect(only.body).toBe("They have not started, so nothing is lost.");
    expect(batchConfirm("archiveDone", 3, box, 1, 1).title).toBe("Archive 2 finished threads and remove 1 from the queue on the box?");
  });
  it("speaks in the singular, and of a project or everywhere", () => {
    expect(batchConfirm("stop", 1, { kind: "project", path: "/x", name: "temp-code" }).title).toBe("Stop 1 running thread in temp-code?");
    expect(batchConfirm("archiveDone", 3, { kind: "all" }).title).toBe("Archive 3 finished threads everywhere?");
    expect(batchConfirm("stop", 1, box).danger).toBe(true);
  });
  it("offers the resources clause only when the host can release them", () => {
    expect(batchConfirm("archiveDone", 6, box, 6).cleanup).toBe("and remove their 6 worktrees and simulators");
    expect(batchConfirm("archiveDone", 6, box, 1).cleanup).toBe("and remove their 1 worktree or simulator");
    expect(batchConfirm("archiveDone", 6, box, 0).cleanup).toBeNull();
    expect(batchConfirm("archiveDone", 6, box, null).cleanup).toBeNull();
    expect(batchConfirm("pause", 6, box, 6).cleanup).toBeNull();
  });
  it("says when the count fell to nothing", () => {
    const c = batchConfirm("pause", 0, box);
    expect(c.title).toBe("Nothing to pause on the box");
    expect(c.cleanup).toBeNull();
  });
  it("needs no confirm for resume", () => {
    expect(needsConfirm("resume")).toBe(false);
    expect(needsConfirm("pause")).toBe(true);
    expect(needsConfirm("stop")).toBe(true);
    expect(needsConfirm("archiveDone")).toBe(true);
  });
});

describe("the request, the confirm and the run", () => {
  const sessionBatch = vi.mocked(commands.sessionBatch);
  const running = meta({ id: "a", status: "running", title: "Search" });
  const onBox = meta({ id: "b", status: "running", title: "Build", environmentId: "env_box" });
  const idle = meta({ id: "c", status: "idle" });
  beforeEach(() => {
    resetThreadBatchForTests();
    sessionBatch.mockReset();
    vi.spyOn(sessionStore, "metas").mockReturnValue([running, onBox, idle]);
    vi.spyOn(sessionStore, "isDraft").mockReturnValue(false);
    vi.spyOn(sessionStore, "metaOf").mockImplementation((id) => [running, onBox, idle].find((t) => t.id === id) ?? null);
  });
  afterEach(() => vi.restoreAllMocks());

  it("runs resume at once and leaves the rest for the confirm", async () => {
    sessionBatch.mockResolvedValue({ attempted: [], succeeded: [], failed: [] });
    await requestThreadBatch("resume", { kind: "all" }, () => all);
    expect(__pending()).toBeNull();
    await requestThreadBatch("pause", { kind: "all" }, () => all);
    expect(__pending()).toEqual({ action: "pause", scope: { kind: "all" } });
    cancelThreadBatch();
    expect(__pending()).toBeNull();
    expect(sessionBatch).not.toHaveBeenCalled();
  });

  it("sends one batch per host with the qualifying ids, and folds the answers into one notice", async () => {
    sessionBatch.mockImplementation(async (env, _action, ids) =>
      env === "local"
        ? { attempted: [...ids], succeeded: [], failed: [{ sessionId: "a", error: "harness not responding" }] }
        : { attempted: [...ids], succeeded: [...ids], failed: [] },
    );
    await requestThreadBatch("pause", { kind: "all" }, () => all);
    await confirmThreadBatch(all);
    expect(sessionBatch.mock.calls.map(([env, action, ids, opts]) => [env, action, ids, opts])).toEqual([
      ["local", "pause", ["a"], {}],
      ["env_box", "pause", ["b"], {}],
    ]);
    const notices = __notices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ action: "pause", succeeded: 1 });
    expect(notices[0].failed).toEqual([{ sessionId: "a", environmentId: "local", title: "Search", error: "harness not responding" }]);
    expect(__pending()).toBeNull();
  });

  it("names every thread of a host whose call itself failed", async () => {
    sessionBatch.mockRejectedValue(new Error("link down"));
    await runThreadBatch("stop", { ...all, scope: hostScope("env_box") });
    expect(sessionBatch).toHaveBeenCalledWith("env_box", "stop", ["b"], {});
    expect(__notices()[0]).toMatchObject({ action: "stop", succeeded: 0, failed: [{ sessionId: "b", environmentId: "env_box", title: "Build", error: "link down" }] });
  });

  it("passes cleanup through for an archive and counts resources only through the seam", async () => {
    expect(resourcesHeldBy(["a"])).toBeNull();
    setResourceCleanup({ count: (list) => list.length });
    expect(resourcesHeldBy(["a", "b"])).toBe(2);
    sessionBatch.mockResolvedValue({ attempted: ["c"], succeeded: ["c"], failed: [] });
    const sel: BatchSelection = { ...all, lastSeen: { c: NOW } };
    await requestThreadBatch("archiveDone", { kind: "all" }, () => sel);
    await confirmThreadBatch(sel, { cleanup: true });
    expect(sessionBatch).toHaveBeenCalledWith("local", "archive", ["c"], { cleanup: true });
    expect(__notices()[0]).toMatchObject({ action: "archiveDone", succeeded: 1, failed: [] });
  });

  it("names the host as the registry does", () => {
    expect(hostScope("env_box")).toEqual({ kind: "host", environmentId: "env_box", name: "the box" });
    expect(hostScope("env_other")).toEqual({ kind: "host", environmentId: "env_other", name: "env_other" });
  });
});

// The store's readers, without React: the hooks are useSyncExternalStore
// over these same snapshots.
function __pending() {
  return readStore().pending;
}
function __notices() {
  return readStore().notices;
}
function readStore() {
  // useSyncExternalStore is mocked below to call getSnapshot synchronously.
  return { pending: useBatchPending(), notices: useBatchNotices() };
}

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() };
});
