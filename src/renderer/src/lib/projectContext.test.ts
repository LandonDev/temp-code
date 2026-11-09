import { beforeEach, describe, expect, it } from "vitest";
import {
  contextForCwd,
  contextOfSession,
  folderKey,
  homeOrWorkspacePath,
  loadSelectedProject,
  landingPathOfSession,
  rebaseToWorkspace,
  resolveSessionContext,
  sameFolder,
  saveSelectedProject,
  workspacePathOfSession,
} from "./projectContext";
import type { ProjectMeta, WorkspaceMeta } from "./tcserver/types";

const workspaces: WorkspaceMeta[] = [
  { environmentId: "local", id: "w1", name: "repo", path: "/home/me/repo", git: true, createdAt: 1 },
];
const projects: ProjectMeta[] = [
  { environmentId: "local", id: "p1", workspaceId: "w1", name: "Auth", mode: "worktree", branch: "tc/auth", cwd: "/home/me/.temp-code/worktrees/auth", archived: false, createdAt: 2 },
  { environmentId: "local", id: "p2", workspaceId: "w1", name: "Local", mode: "local", branch: "main", cwd: "/home/me/repo", archived: false, createdAt: 3 },
  { environmentId: "local", id: "p3", workspaceId: "w1", name: "Old", mode: "worktree", branch: "tc/old", cwd: "/home/me/.temp-code/worktrees/old", archived: true, createdAt: 4 },
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
    expect(workspacePathOfSession({ cwd: "/tmp/x", workspaceId: "w-unlisted" }, catalog)).toBe("/tmp/x");
  });
  it("places a thread outside every workspace on the home, whatever folder it runs in, on the Mac or the box", () => {
    // A box chat's home directory and any folder that is no workspace read as the home here.
    expect(workspacePathOfSession({ cwd: "/srv/agents/home", projectId: null, workspaceId: null }, catalog)).toBe("~");
    expect(landingPathOfSession({ cwd: "/srv/agents/home", projectId: null, workspaceId: null }, catalog)).toBe("~");
    expect(workspacePathOfSession({ cwd: "/tmp/x" }, catalog)).toBe("~");
    expect(workspacePathOfSession({ cwd: "~" }, catalog)).toBe("~");
    expect(workspacePathOfSession({ cwd: "/home/me/repo", workspaceId: "w1" }, catalog)).toBe("/home/me/repo");
  });
  it("returns the same array when nothing moves", () => {
    const sessions = [{ cwd: "/home/me/repo", projectId: null, workspaceId: "w1" }];
    expect(rebaseToWorkspace(sessions, catalog)).toBe(sessions);
    const moved = rebaseToWorkspace([{ cwd: projects[0].cwd, projectId: "p1", workspaceId: null }], catalog);
    expect(moved[0].cwd).toBe("/home/me/repo");
  });
});

describe("selected project persistence", () => {
  beforeEach(mockLocalStorage);
  const linked = {
    workspaces: [
      { ...workspaces[0], linkId: "wl_r" },
      { environmentId: "env_box", id: "w-box", name: "repo", path: "/srv/work/repo/", git: true, createdAt: 1, linkId: "wl_r" },
      { environmentId: "env_box", id: "w-solo", name: "solo", path: "/srv/work/solo", git: true, createdAt: 1 },
    ],
  };
  const SELECTED = "monocode.tc.selectedProject";
  const stored = () => JSON.parse(localStorage.getItem(SELECTED) ?? "{}") as Record<string, string>;

  it("round-trips per workspace path", () => {
    saveSelectedProject("/home/me/repo/", "p1", catalog);
    expect(loadSelectedProject("/home/me/repo", catalog)).toBe("p1");
    expect(loadSelectedProject("/other", catalog)).toBeNull();
    saveSelectedProject("/home/me/repo", null, catalog);
    expect(loadSelectedProject("/home/me/repo", catalog)).toBeNull();
  });

  it("keys a linked copy's path by the link's leader", () => {
    expect(folderKey("/srv/work/repo/", linked)).toBe("/home/me/repo");
    expect(folderKey("/home/me/repo/", linked)).toBe("/home/me/repo");
    expect(folderKey("/srv/work/solo", linked)).toBe("/srv/work/solo");
    expect(folderKey("/elsewhere/", linked)).toBe("/elsewhere");
    expect(sameFolder("/srv/work/repo", "/home/me/repo", linked)).toBe(true);
    expect(sameFolder("/srv/work/solo", "/home/me/repo", linked)).toBe(false);
    // Without the link the two paths are two folders.
    expect(sameFolder("/srv/work/repo", "/home/me/repo", catalog)).toBe(false);
  });

  it("a box copy's path saves and reads the leader's memory", () => {
    saveSelectedProject("/srv/work/repo", "p-box", linked);
    expect(stored()).toEqual({ "/home/me/repo": "p-box" });
    expect(loadSelectedProject("/home/me/repo", linked)).toBe("p-box");
    expect(loadSelectedProject("/srv/work/repo/", linked)).toBe("p-box");
  });

  it("reads an entry under a copy's raw path once and moves it under the key", () => {
    localStorage.setItem(SELECTED, JSON.stringify({ "/srv/work/repo": "p-old" }));
    expect(loadSelectedProject("/srv/work/repo", linked)).toBe("p-old");
    expect(stored()).toEqual({ "/home/me/repo": "p-old" });
    expect(loadSelectedProject("/home/me/repo", linked)).toBe("p-old");
  });

  it("the key's own entry wins over a stale raw one", () => {
    localStorage.setItem(SELECTED, JSON.stringify({ "/home/me/repo": "p-mac", "/srv/work/repo": "p-wt" }));
    expect(loadSelectedProject("/srv/work/repo", linked)).toBe("p-mac");
  });
});
