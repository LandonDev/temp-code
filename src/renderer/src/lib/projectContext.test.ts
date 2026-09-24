import { beforeEach, describe, expect, it } from "vitest";
import {
  contextForCwd,
  contextOfSession,
  forgetLastSession,
  homeOrWorkspacePath,
  loadLastSession,
  loadSelectedProject,
  rebaseToWorkspace,
  resolveLanding,
  resolveSessionContext,
  saveLastSession,
  saveSelectedProject,
  workspacePathOfSession,
} from "./projectContext";
import type { ProjectMeta, SessionMeta, WorkspaceMeta } from "./tcserver/types";

const workspaces: WorkspaceMeta[] = [
  { id: "w1", name: "repo", path: "/home/me/repo", git: true, createdAt: 1 },
];
const projects: ProjectMeta[] = [
  { id: "p1", workspaceId: "w1", name: "Auth", mode: "worktree", branch: "tc/auth", cwd: "/home/me/.temp-code/worktrees/auth", archived: false, createdAt: 2 },
  { id: "p2", workspaceId: "w1", name: "Local", mode: "local", branch: "main", cwd: "/home/me/repo", archived: false, createdAt: 3 },
  { id: "p3", workspaceId: "w1", name: "Old", mode: "worktree", branch: "tc/old", cwd: "/home/me/.temp-code/worktrees/old", archived: true, createdAt: 4 },
];
const catalog = { workspaces, projects };

function mockLocalStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
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
    configurable: true,
  });
}

describe("resolveSessionContext", () => {
  it("uses the selected project", () => {
    expect(resolveSessionContext({ ...catalog, projectId: "p1", workspacePath: "/home/me/repo" }))
      .toEqual({ projectId: "p1", workspaceId: "w1", cwd: projects[0].cwd });
  });
  it("falls back to a loose chat in the workspace", () => {
    expect(resolveSessionContext({ ...catalog, projectId: null, workspacePath: "/home/me/repo/" }))
      .toEqual({ projectId: null, workspaceId: "w1", cwd: "/home/me/repo" });
  });
  it("ignores an archived or unknown project", () => {
    expect(resolveSessionContext({ ...catalog, projectId: "p3", workspacePath: "/elsewhere" }))
      .toEqual({ projectId: null, workspaceId: null, cwd: "/elsewhere" });
  });
});

describe("contextForCwd", () => {
  it("finds the project at a worktree path", () => {
    expect(contextForCwd({ ...catalog, cwd: projects[0].cwd }).projectId).toBe("p1");
  });
  it("prefers the selected project when several share a cwd", () => {
    expect(contextForCwd({ ...catalog, cwd: "/home/me/repo", preferProjectId: "p2" }).projectId).toBe("p2");
  });
  it("a workspace path without a preferred project is a loose chat", () => {
    const ctx = contextForCwd({ ...catalog, cwd: "/home/me/repo" });
    expect(ctx).toEqual({ projectId: "p2", workspaceId: "w1", cwd: "/home/me/repo" });
  });
  it("a bare folder keeps its path with no ids", () => {
    expect(contextForCwd({ ...catalog, cwd: "/tmp/x" })).toEqual({ projectId: null, workspaceId: null, cwd: "/tmp/x" });
  });
});

describe("contextOfSession", () => {
  it("copies ids from a session that has them", () => {
    expect(contextOfSession({ cwd: "/x", projectId: "p1", workspaceId: null }, catalog))
      .toEqual({ projectId: "p1", workspaceId: null, cwd: "/x" });
  });
  it("places a legacy session by cwd", () => {
    expect(contextOfSession({ cwd: "/home/me/repo" }, catalog).workspaceId).toBe("w1");
  });
});

describe("workspacePathOfSession / rebaseToWorkspace", () => {
  it("maps a worktree thread to its workspace folder", () => {
    expect(workspacePathOfSession({ cwd: projects[0].cwd, projectId: "p1" }, catalog)).toBe("/home/me/repo");
    expect(workspacePathOfSession({ cwd: "/tmp/x" }, catalog)).toBe("/tmp/x");
  });
  it("returns the same array when nothing moves", () => {
    const sessions = [{ cwd: "/tmp/x", projectId: null, workspaceId: null }];
    expect(rebaseToWorkspace(sessions, catalog)).toBe(sessions);
    const moved = rebaseToWorkspace([{ cwd: projects[0].cwd, projectId: "p1", workspaceId: null }], catalog);
    expect(moved[0].cwd).toBe("/home/me/repo");
  });
});

describe("selected project persistence", () => {
  beforeEach(mockLocalStorage);
  it("round-trips per workspace path", () => {
    saveSelectedProject("/home/me/repo/", "p1");
    expect(loadSelectedProject("/home/me/repo")).toBe("p1");
    expect(loadSelectedProject("/other")).toBeNull();
    saveSelectedProject("/home/me/repo", null);
    expect(loadSelectedProject("/home/me/repo")).toBeNull();
  });
});

describe("last thread per project / workspace", () => {
  beforeEach(mockLocalStorage);
  const meta = (id: string, over: Partial<SessionMeta> = {}): SessionMeta =>
    ({
      id,
      parentId: null,
      projectId: "p1",
      workspaceId: null,
      archived: false,
      cwd: "/home/me/.temp-code/worktrees/auth",
      ...over,
    }) as SessionMeta;

  it("round-trips per project and per workspace folder, and forgets a thread everywhere", () => {
    saveLastSession({ projectId: "p1" }, "s1");
    saveLastSession({ workspacePath: "/home/me/repo/" }, "s1");
    expect(loadLastSession({ projectId: "p1" })).toBe("s1");
    expect(loadLastSession({ workspacePath: "/home/me/repo" })).toBe("s1");
    expect(loadLastSession({ projectId: "p2" })).toBeNull();
    forgetLastSession("s1");
    expect(loadLastSession({ projectId: "p1" })).toBeNull();
    expect(loadLastSession({ workspacePath: "/home/me/repo" })).toBeNull();
  });

  it("lands on the remembered thread while it is live and still in scope", () => {
    saveLastSession({ projectId: "p1" }, "s1");
    saveLastSession({ workspacePath: "/home/me/repo" }, "s1");
    const metas = [meta("s1")];
    expect(resolveLanding({ projectId: "p1" }, metas, catalog)).toBe("s1");
    expect(resolveLanding({ workspacePath: "/home/me/repo/" }, metas, catalog)).toBe("s1");
  });

  it("seeds blank when the thread is missing, archived, or moved to another project", () => {
    saveLastSession({ projectId: "p1" }, "s1");
    expect(resolveLanding({ projectId: "p1" }, [], catalog)).toBeNull();
    expect(resolveLanding({ projectId: "p1" }, [meta("s1", { archived: true })], catalog)).toBeNull();
    expect(resolveLanding({ projectId: "p1" }, [meta("s1", { projectId: "p2" })], catalog)).toBeNull();
    expect(resolveLanding({ projectId: "p2" }, [meta("s1")], catalog)).toBeNull();
    expect(resolveLanding({ projectId: "p1" }, [meta("s1", { parentId: "root" })], catalog)).toBeNull();
  });

  it("the newest thread wins a scope, and forgetting one leaves the others", () => {
    saveLastSession({ projectId: "p1" }, "s1");
    saveLastSession({ projectId: "p1" }, "s2");
    saveLastSession({ projectId: "p2" }, "s1");
    expect(loadLastSession({ projectId: "p1" })).toBe("s2");
    forgetLastSession("s2");
    expect(loadLastSession({ projectId: "p1" })).toBeNull();
    expect(loadLastSession({ projectId: "p2" })).toBe("s1");
  });

  it("forgets a workspace landing once the workspace moved", () => {
    saveLastSession({ workspacePath: "/home/me/repo" }, "s1");
    const moved = {
      projects,
      workspaces: [{ ...workspaces[0], path: "/home/me/elsewhere" }],
    };
    expect(resolveLanding({ workspacePath: "/home/me/repo" }, [meta("s1")], moved)).toBeNull();
    saveLastSession({ workspacePath: "/home/me/elsewhere" }, "s1");
    expect(resolveLanding({ workspacePath: "/home/me/elsewhere" }, [meta("s1")], moved)).toBe("s1");
    // A loose chat hangs off its workspace by id, so it moves with it too.
    const loose = meta("s2", { projectId: null, workspaceId: "w1", cwd: "/home/me/repo" });
    saveLastSession({ workspacePath: "/home/me/elsewhere" }, "s2");
    expect(resolveLanding({ workspacePath: "/home/me/elsewhere" }, [loose], moved)).toBe("s2");
  });

  it("lands the home on its last loose chat, whatever home directory the server wrote", () => {
    const loose = meta("s3", { projectId: null, workspaceId: null, cwd: "/home/me" });
    saveLastSession({ workspacePath: "/home/me" }, "s3");
    expect(loadLastSession({ workspacePath: "~" })).toBe("s3");
    expect(resolveLanding({ workspacePath: "~" }, [loose], catalog)).toBe("s3");
    // A workspace chat never lands the home.
    const ws = meta("s4", { projectId: null, workspaceId: "w1", cwd: "/home/me/repo" });
    saveLastSession({ workspacePath: "~" }, "s4");
    expect(resolveLanding({ workspacePath: "~" }, [ws], catalog)).toBeNull();
  });
});

describe("homeOrWorkspacePath", () => {
  it("keeps a workspace folder and folds everything else into the home", () => {
    expect(homeOrWorkspacePath("/home/me/repo/")).toBe("/home/me/repo");
    expect(homeOrWorkspacePath("~")).toBe("~");
    expect(homeOrWorkspacePath("/")).toBe("~");
    expect(homeOrWorkspacePath("")).toBe("~");
  });
});
