import { describe, expect, it } from "vitest";
import { activeLanding } from "./projectLanding";
import type { ProjectMeta, SessionMeta, WorkspaceMeta } from "./tcserver/types";

const workspaces: WorkspaceMeta[] = [
  { environmentId: "local", id: "w1", name: "repo", path: "/home/me/repo", git: true, createdAt: 1, linkId: "wl_r" },
  { environmentId: "env_box", id: "w-box", name: "repo", path: "/srv/work/repo", git: true, createdAt: 1, linkId: "wl_r" },
];
const projects: ProjectMeta[] = [
  { environmentId: "local", id: "p1", workspaceId: "w1", name: "Auth", mode: "local", branch: "main", cwd: "/home/me/repo", archived: false, createdAt: 2, linkId: "pl_a" },
  { environmentId: "env_box", id: "p1-box", workspaceId: "w-box", name: "Auth", mode: "local", branch: "main", cwd: "/srv/work/repo", archived: false, createdAt: 2, linkId: "pl_a" },
  { environmentId: "local", id: "p2", workspaceId: "w1", name: "Other", mode: "local", branch: "main", cwd: "/home/me/repo", archived: false, createdAt: 3 },
];
const catalog = { workspaces, projects };

let n = 0;
const meta = (over: Partial<SessionMeta>): SessionMeta =>
  ({
    environmentId: "local",
    id: `s${++n}`,
    projectId: "p1",
    workspaceId: "w1",
    cwd: "/home/me/repo",
    status: "idle",
    archived: false,
    parentId: null,
    busySince: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }) as SessionMeta;

const land = (metas: SessionMeta[], projectId = "p1") => activeLanding({ projectId }, metas, catalog)?.id ?? null;

describe("activeLanding", () => {
  it("lands on an active plain thread", () => {
    const quiet = meta({ id: "quiet", status: "idle", lastEventAt: 900 });
    const busy = meta({ id: "busy", status: "running", lastEventAt: 100 });
    expect(land([quiet, busy])).toBe("busy");
  });

  it("counts waiting, paused, queued and watching, and not done, stopped, failed or archived", () => {
    for (const status of ["waiting", "paused", "queued", "watching"] as const) {
      expect(land([meta({ id: status, status })])).toBe(status);
    }
    for (const status of ["done", "stopped", "error", "idle"] as const) {
      expect(land([meta({ status })])).toBeNull();
    }
    expect(land([meta({ status: "running", archived: true })])).toBeNull();
  });

  it("a settled root watching its subagents is active", () => {
    const watching = meta({ id: "w", status: "idle", background: { tasks: [], agents: ["a1"] } as never });
    expect(land([watching])).toBe("w");
  });

  it("takes the most recent of two active threads", () => {
    const older = meta({ id: "older", status: "running", lastEventAt: 100 });
    const newer = meta({ id: "newer", status: "waiting", lastEventAt: 200 });
    expect(land([older, newer])).toBe("newer");
  });

  it("reads busySince, then createdAt, when there is no last event", () => {
    const a = meta({ id: "a", status: "running", busySince: 300, createdAt: 1 });
    const b = meta({ id: "b", status: "running", createdAt: 200 });
    expect(land([a, b])).toBe("a");
  });

  it("an active batch thread lands on its master", () => {
    const master = meta({ id: "m", isMaster: true, status: "idle", lastEventAt: 10 });
    const child = meta({ id: "c", masterId: "m", status: "running", lastEventAt: 50 });
    expect(land([master, child])).toBe("m");
  });

  it("a master whose child is newer beats an older active plain thread", () => {
    const plain = meta({ id: "plain", status: "running", lastEventAt: 100 });
    const master = meta({ id: "m", isMaster: true, status: "idle", lastEventAt: 10 });
    const child = meta({ id: "c", masterId: "m", status: "running", lastEventAt: 200 });
    expect(land([plain, master, child])).toBe("m");
    expect(land([meta({ id: "plain2", status: "running", lastEventAt: 300 }), master, child])).toBe("plain2");
  });

  it("a batch thread whose master is unpinned or archived counts as itself", () => {
    const unpinned = meta({ id: "m", isMaster: false });
    expect(land([unpinned, meta({ id: "c", masterId: "m", status: "running" })])).toBe("c");
    const archived = meta({ id: "m2", isMaster: true, archived: true });
    expect(land([archived, meta({ id: "c2", masterId: "m2", status: "running" })])).toBe("c2");
  });

  it("a subagent never counts", () => {
    const root = meta({ id: "root", status: "idle" });
    expect(land([root, meta({ parentId: "root", status: "running" })])).toBeNull();
  });

  it("is null with nothing active, so the remembered landing applies", () => {
    expect(land([meta({ status: "idle" }), meta({ status: "done" })])).toBeNull();
  });

  it("only the project's threads, on every linked copy, with the winner's host", () => {
    const elsewhere = meta({ id: "x", projectId: "p2", status: "running", lastEventAt: 900 });
    const far = meta({ id: "far", environmentId: "env_box", projectId: "p1-box", workspaceId: "w-box", cwd: "/srv/work/repo", status: "running", lastEventAt: 500 });
    const won = activeLanding({ projectId: "p1" }, [elsewhere, far], catalog);
    expect(won?.id).toBe("far");
    expect(won?.environmentId).toBe("env_box");
  });

  it("a workspace folder takes its threads on every linked copy; the home only its own chats", () => {
    const far = meta({ id: "far", environmentId: "env_box", projectId: "p1-box", workspaceId: "w-box", cwd: "/srv/work/repo", status: "running" });
    const home = meta({ id: "home", projectId: null, workspaceId: null, cwd: "~", status: "running" });
    expect(activeLanding({ workspacePath: "/home/me/repo/" }, [far, home], catalog)?.id).toBe("far");
    expect(activeLanding({ workspacePath: "~" }, [far, home], catalog)?.id).toBe("home");
  });

  it("nothing while the thread on screen is already in the project, a linked copy's included", () => {
    const metas = [meta({ id: "busy", status: "running" }), meta({ id: "reading", status: "idle" })];
    expect(activeLanding({ projectId: "p1" }, metas, catalog, "reading")).toBeNull();
    const far = meta({ id: "far", environmentId: "env_box", projectId: "p1-box", workspaceId: "w-box", cwd: "/srv/work/repo" });
    expect(activeLanding({ projectId: "p1" }, [...metas, far], catalog, "far")).toBeNull();
    const other = meta({ id: "other", projectId: "p2" });
    expect(activeLanding({ projectId: "p1" }, [...metas, other], catalog, "other")?.id).toBe("busy");
  });
});
