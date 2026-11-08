import { describe, expect, it } from "vitest";
import { landingOf, type Seen } from "./projectLanding";
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

const allSeen: Seen = { lastSeen: {}, floor: Number.MAX_SAFE_INTEGER };
const noneSeen: Seen = { lastSeen: {}, floor: 0 };
const land = (metas: SessionMeta[], projectId = "p1", seen: Seen = allSeen) =>
  landingOf({ projectId }, metas, catalog, seen)?.id ?? null;

describe("landingOf: 1. running or needs you", () => {
  it("an active thread beats a newer unread one and a newer dormant one", () => {
    const busy = meta({ id: "busy", status: "running", lastEventAt: 100 });
    const unread = meta({ id: "unread", status: "idle", lastEventAt: 900, updatedAt: 900 });
    expect(land([unread, busy], "p1", noneSeen)).toBe("busy");
  });

  it("counts waiting, paused, queued and watching", () => {
    for (const status of ["waiting", "paused", "queued", "watching"] as const) {
      expect(land([meta({ id: "quiet", status: "idle", lastEventAt: 900 }), meta({ id: status, status })])).toBe(status);
    }
  });

  it("a settled root watching its subagents is active", () => {
    const watching = meta({ id: "w", status: "idle", lastEventAt: 1, background: { tasks: [], agents: ["a1"] } as never });
    expect(land([meta({ id: "quiet", lastEventAt: 900 }), watching])).toBe("w");
  });

  it("takes the most recent of two active threads, by last event, then busySince", () => {
    expect(land([meta({ id: "older", status: "running", lastEventAt: 100 }), meta({ id: "newer", status: "waiting", lastEventAt: 200 })])).toBe("newer");
    expect(land([meta({ id: "a", status: "running", busySince: 300 }), meta({ id: "b", status: "running", updatedAt: 200 })])).toBe("a");
  });

  it("an active batch thread lands on its master", () => {
    const master = meta({ id: "m", isMaster: true, status: "idle", lastEventAt: 10 });
    const child = meta({ id: "c", masterId: "m", status: "running", lastEventAt: 50 });
    expect(land([master, child])).toBe("m");
  });

  it("a batch thread whose master is unpinned or archived counts as itself", () => {
    expect(land([meta({ id: "m", isMaster: false }), meta({ id: "c", masterId: "m", status: "running", lastEventAt: 9 })])).toBe("c");
    expect(land([meta({ id: "m2", isMaster: true, archived: true }), meta({ id: "c2", masterId: "m2", status: "running" })])).toBe("c2");
  });
});

describe("landingOf: 2. unread", () => {
  it("the most recent unread thread beats a newer read one", () => {
    const read = meta({ id: "read", lastEventAt: 900, updatedAt: 900 });
    const older = meta({ id: "older", lastEventAt: 100, updatedAt: 100 });
    const newer = meta({ id: "newer", status: "done", lastEventAt: 200, updatedAt: 200 });
    const seen: Seen = { lastSeen: { read: 900 }, floor: 0 };
    expect(land([read, older, newer], "p1", seen)).toBe("newer");
  });

  it("reads unread as the rail does: settled, updated since seen, the floor for no entry", () => {
    const t = meta({ id: "t", updatedAt: 50, lastEventAt: 50 });
    const other = meta({ id: "other", updatedAt: 900, lastEventAt: 900 });
    const seenTo = (at: number): Seen => ({ lastSeen: { t: at, other: 900 }, floor: 0 });
    expect(land([t, other], "p1", seenTo(40))).toBe("t");
    expect(land([t, other], "p1", seenTo(50))).toBe("other");
    expect(land([t, other], "p1", { lastSeen: { other: 900 }, floor: 60 })).toBe("other");
    // A failed or stopped thread is never unread.
    const failed = meta({ id: "f", status: "error", updatedAt: 50, lastEventAt: 50 });
    expect(land([failed, other], "p1", seenTo(0))).toBe("other");
  });

  it("a thread inside a master is never unread", () => {
    const master = meta({ id: "m", isMaster: true, updatedAt: 10, lastEventAt: 10 });
    const child = meta({ id: "c", masterId: "m", updatedAt: 800, lastEventAt: 800 });
    const plain = meta({ id: "plain", updatedAt: 100, lastEventAt: 100 });
    const seen: Seen = { lastSeen: { m: 10 }, floor: 0 };
    expect(land([master, child, plain], "p1", seen)).toBe("plain");
  });
});

describe("landingOf: 3. the most recently active dormant thread", () => {
  it("takes the newest unarchived root, idle, done, stopped or failed alike", () => {
    for (const status of ["idle", "done", "stopped", "error"] as const) {
      expect(land([meta({ id: "old", lastEventAt: 1 }), meta({ id: status, status, lastEventAt: 500 })])).toBe(status);
    }
  });

  it("an archived thread is never chosen: newest, unread, running, or the one last on screen", () => {
    const gone = meta({ id: "gone", archived: true, status: "running", lastEventAt: 900, updatedAt: 900 });
    expect(land([gone, meta({ id: "kept", lastEventAt: 1 })], "p1", noneSeen)).toBe("kept");
    expect(landingOf({ projectId: "p1" }, [gone, meta({ id: "kept" })], catalog, noneSeen, "gone")?.id).toBe("kept");
    expect(landingOf({ workspacePath: "/home/me/repo" }, [gone], catalog, noneSeen)).toBeNull();
  });

  it("a dormant batch thread lands on its master", () => {
    const master = meta({ id: "m", isMaster: true, lastEventAt: 10 });
    expect(land([master, meta({ id: "c", masterId: "m", lastEventAt: 50 })])).toBe("m");
  });

  it("never a subagent, nor a thread of an archived project", () => {
    expect(land([meta({ parentId: "root", status: "running" })])).toBeNull();
    const shelved = { workspaces, projects: projects.map((p) => (p.id === "p2" ? { ...p, archived: true } : p)) };
    const t = meta({ id: "t", projectId: "p2" });
    expect(landingOf({ workspacePath: "/home/me/repo" }, [t], shelved, allSeen)).toBeNull();
  });
});

describe("landingOf: 4. the draft", () => {
  it("is null only when nothing unarchived is left in the scope", () => {
    expect(land([])).toBeNull();
    expect(land([meta({ archived: true }), meta({ projectId: "p2" })])).toBeNull();
  });
});

describe("landingOf: scopes", () => {
  it("a project takes every linked copy, with the winner's host", () => {
    const elsewhere = meta({ id: "x", projectId: "p2", status: "running", lastEventAt: 900 });
    const far = meta({ id: "far", environmentId: "env_box", projectId: "p1-box", workspaceId: "w-box", cwd: "/srv/work/repo", lastEventAt: 500 });
    const won = landingOf({ projectId: "p1" }, [elsewhere, far], catalog, allSeen);
    expect(won?.id).toBe("far");
    expect(won?.environmentId).toBe("env_box");
  });

  it("a workspace folder takes its threads on every linked copy; the home only its own chats", () => {
    const far = meta({ id: "far", environmentId: "env_box", projectId: "p1-box", workspaceId: "w-box", cwd: "/srv/work/repo", lastEventAt: 900 });
    const home = meta({ id: "home", projectId: null, workspaceId: null, cwd: "/home/me", lastEventAt: 1 });
    expect(landingOf({ workspacePath: "/home/me/repo/" }, [far, home], catalog, allSeen)?.id).toBe("far");
    expect(landingOf({ workspacePath: "/srv/work/repo" }, [far, home], catalog, allSeen)?.id).toBe("far");
    expect(landingOf({ workspacePath: "~" }, [far, home], catalog, allSeen)?.id).toBe("home");
  });

  it("a loose chat follows its workspace when the workspace moves", () => {
    const moved = { projects, workspaces: [{ ...workspaces[0], path: "/home/me/elsewhere" }] };
    const loose = meta({ id: "loose", projectId: null, workspaceId: "w1", cwd: "/home/me/repo" });
    expect(landingOf({ workspacePath: "/home/me/elsewhere" }, [loose], moved, allSeen)?.id).toBe("loose");
    expect(landingOf({ workspacePath: "/home/me/repo" }, [loose], moved, allSeen)).toBeNull();
  });

  it("the thread on screen wins while it is an unarchived root of the scope", () => {
    const metas = [meta({ id: "busy", status: "running" }), meta({ id: "reading" })];
    expect(landingOf({ projectId: "p1" }, metas, catalog, allSeen, "reading")?.id).toBe("reading");
    const other = meta({ id: "other", projectId: "p2" });
    expect(landingOf({ projectId: "p1" }, [...metas, other], catalog, allSeen, "other")?.id).toBe("busy");
    const archived = meta({ id: "archived", archived: true });
    expect(landingOf({ projectId: "p1" }, [...metas, archived], catalog, allSeen, "archived")?.id).toBe("busy");
  });
});
