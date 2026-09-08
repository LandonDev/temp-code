import { beforeEach, describe, expect, it } from "vitest";
import {
  contextForCwd,
  contextOfSession,
  loadSelectedProject,
  rebaseToWorkspace,
  resolveSessionContext,
  saveSelectedProject,
  workspacePathOfSession,
} from "./projectContext";
import type { ProjectMeta, WorkspaceMeta } from "./tcserver/types";

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
