import { describe, expect, it } from "vitest";
import type { SessionMeta } from "../../../lib/tcserver/types";
import {
  addMenuItems,
  adoptCandidates,
  archiveCopy,
  batchThreadId,
  boardMenuItems,
  doneRows,
  linkedHosts,
  pairedProjectIds,
  pausedRows,
  remoteArchivePlan,
} from "./boardActions";

const meta = (over: Partial<SessionMeta>): SessionMeta =>
  ({ id: "x", environmentId: "local", projectId: "p1", parentId: null, archived: false, status: "idle", createdAt: 1, ...over }) as SessionMeta;
const master = { id: "m", environmentId: "local", projectId: "p1" };

describe("the board's menus", () => {
  it("takes done and paused rows by status", () => {
    const rows = ["idle", "done", "stopped", "error", "paused", "running"].map((status, i) => ({ meta: meta({ id: `c${i}`, status: status as SessionMeta["status"] }) }));
    expect(doneRows(rows).map((r) => r.meta.id)).toEqual(["c0", "c1"]);
    expect(pausedRows(rows).map((r) => r.meta.id)).toEqual(["c4"]);
  });

  it("Archive done counts the host's done: three done, never the paused child or the one idle without a completed turn", () => {
    const rows = [
      { meta: meta({ id: "a", status: "done" }) },
      { meta: meta({ id: "b", status: "idle" }) },
      { meta: meta({ id: "f", environmentId: "box", status: "idle" }) },
      { meta: meta({ id: "p", status: "paused" }) },
      { meta: meta({ id: "n", status: "idle" }) },
    ];
    // The host's list names a far child as <env>:<id>.
    const listed = doneRows(rows, { done: ["a", "b", "box:f"], blocked: { sessionId: "p", why: "paused" } });
    expect(listed.map((r) => r.meta.id)).toEqual(["a", "b", "f"]);
    expect(archiveCopy("done", listed.length, 0).title).toBe("Archive 3 done threads?");
    // An older host sends no list: the old rule less the child its block names.
    expect(doneRows(rows, { blocked: { sessionId: "n", why: "no-turn" } }).map((r) => r.meta.id)).toEqual(["a", "b", "f"]);
    expect(remoteArchivePlan(rows, { environmentId: "local" }, "done", ["a", "b"], { done: ["a", "b", "box:f"], blocked: null })).toEqual([
      { environmentId: "box", stop: [], archive: ["f"] },
    ]);
  });

  it("disables a switch with nothing to act on", () => {
    const items = boardMenuItems({ pausable: 0, paused: 1, done: 0, all: 3 });
    const by = (id: string) => items.find((i) => i.kind === "item" && i.id === id) as { label: string; disabled?: boolean };
    expect(by("pause")).toMatchObject({ label: "Pause all", disabled: true });
    expect(by("resume")).toMatchObject({ label: "Resume all", disabled: false });
    expect(by("archive-done")).toMatchObject({ label: "Archive done…", disabled: true });
    expect(by("archive-all")).toMatchObject({ label: "Archive all…", disabled: false });
    expect(addMenuItems(0).map((i) => (i.kind === "item" ? `${i.label}:${!!i.disabled}` : ""))).toEqual(["New thread…:false", "Add existing thread…:true"]);
  });

  it("writes the archive confirm with the live count and the resources clause", () => {
    expect(archiveCopy("done", 1, null)).toMatchObject({ title: "Archive 1 done thread?", confirmLabel: "Archive 1", cleanup: null });
    expect(archiveCopy("all", 7, 3)).toMatchObject({ title: "Archive all 7 threads?", cleanup: "and remove their 3 worktrees and simulators" });
    expect(archiveCopy("all", 7, 0).cleanup).toBeNull();
    expect(archiveCopy("all", 2, null).body).toMatch(/stopped first/);
  });

  it("offers the project's unarchived roots in no batch and no master, on the master's host and on the project's paired copies", () => {
    const metas = [
      meta({ id: "a", createdAt: 5 }),
      meta({ id: "b", createdAt: 2 }),
      meta({ id: "m", isMaster: true }),
      meta({ id: "other-master", isMaster: true }),
      meta({ id: "in-batch", masterId: "other-master" }),
      meta({ id: "sub", parentId: "a" }),
      meta({ id: "gone", archived: true }),
      meta({ id: "elsewhere", environmentId: "box", projectId: "p1-box", createdAt: 3 }),
      meta({ id: "p2", projectId: "p2" }),
    ];
    expect(adoptCandidates(metas, master).map((m) => m.id)).toEqual(["b", "a"]);
    expect(adoptCandidates(metas, master, new Set(["p1-box"])).map((m) => m.id)).toEqual(["b", "elsewhere", "a"]);
    expect(adoptCandidates(metas, { ...master, projectId: null })).toEqual([]);
  });

  it("finds the project's paired copies on the other hosts by repo, else by folder name", () => {
    const workspaces = [
      { id: "w1", environmentId: "local", path: "/Users/me/IdeaProjects/app", githubRepo: "me/app", name: "app" },
      { id: "w2", environmentId: "box", path: "/srv/work/app", githubRepo: "me/app", name: "app" },
      { id: "w3", environmentId: "box", path: "/srv/work/other", githubRepo: null, name: "other" },
    ] as unknown as Parameters<typeof pairedProjectIds>[1];
    const projects = [
      { id: "p1", environmentId: "local", cwd: "/Users/me/IdeaProjects/app" },
      { id: "p1-box", environmentId: "box", cwd: "/srv/work/app/" },
      { id: "p-other", environmentId: "box", cwd: "/srv/work/other" },
    ];
    expect([...pairedProjectIds({ environmentId: "local", cwd: "/Users/me/IdeaProjects/app" }, workspaces, projects)]).toEqual(["p1-box"]);
    expect(pairedProjectIds({ environmentId: "local", cwd: "/elsewhere" }, workspaces, projects).size).toBe(0);
  });
});

describe("the batch across hosts", () => {
  const statusOf = (open: string[]) => (id: string) => ({ transport: open.includes(id) ? ("open" as const) : ("offline" as const) });
  const envs = [
    { id: "box", name: "The box" },
    { id: "local", name: "This Mac" },
    { id: "web", name: "Browser" },
    { id: "studio", name: "Studio" },
  ];

  it("offers the master's own host and every linked host, the master's first, never the browser slot", () => {
    expect(linkedHosts(envs, statusOf(["box"]), { environmentId: "local" }).map((e) => e.id)).toEqual(["local", "box"]);
    expect(linkedHosts(envs, statusOf(["box", "studio"]), { environmentId: "box" }).map((e) => e.id)).toEqual(["box", "studio"]);
    expect(linkedHosts(envs, statusOf([]), { environmentId: "local" }).map((e) => e.id)).toEqual(["local"]);
  });

  it("names a thread of another host in the cross-host id form, one at home by its id", () => {
    expect(batchThreadId({ id: "t1", environmentId: "local" }, { environmentId: "local" })).toBe("t1");
    expect(batchThreadId({ id: "t2", environmentId: "box" }, { environmentId: "local" })).toBe("box:t2");
  });

  it("plans the archive the master's host left to the others: done rows per host, live ones stopped first under all", () => {
    const rows = [
      { meta: meta({ id: "home-done" }) },
      { meta: meta({ id: "box-done", environmentId: "box", status: "done" }) },
      { meta: meta({ id: "box-run", environmentId: "box", status: "running" }) },
      { meta: meta({ id: "box-err", environmentId: "box", status: "error" }) },
      { meta: meta({ id: "studio-idle", environmentId: "studio" }) },
      { meta: meta({ id: "box-covered", environmentId: "box" }) },
    ];
    expect(remoteArchivePlan(rows, { environmentId: "local" }, "done", ["home-done", "box-covered"])).toEqual([
      { environmentId: "box", stop: [], archive: ["box-done"] },
      { environmentId: "studio", stop: [], archive: ["studio-idle"] },
    ]);
    expect(remoteArchivePlan(rows, { environmentId: "local" }, "all", [])).toEqual([
      { environmentId: "box", stop: ["box-run"], archive: ["box-done", "box-run", "box-err", "box-covered"] },
      { environmentId: "studio", stop: [], archive: ["studio-idle"] },
    ]);
    expect(remoteArchivePlan(rows, { environmentId: "local" }, "all", ["box-done", "box-run", "box-err", "box-covered", "studio-idle"])).toEqual([]);
  });
});
