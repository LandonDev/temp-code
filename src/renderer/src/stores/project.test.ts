import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newTab } from "../lib/layout";
import { loadSelectedProject, saveSelectedProject } from "../lib/projectContext";
import { loadArchivedProjects } from "../lib/recents";
import { newDefaultSession } from "../lib/session";
import type { ProjectMeta, WorkspaceMeta } from "../lib/tcserver/types";
import {
  dockCwdOf,
  gitCwdOf,
  initialProjectState,
  moveToWorkspace,
  project,
  projectStore,
  railRecentsOf,
  selectProject,
  setRecents,
  sidebarCwdOf,
  type ProjectState,
} from "./project";

vi.mock("../lib/recents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/recents")>()),
  loadArchivedProjects: vi.fn(() => []),
}));

vi.mock("../lib/projectContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/projectContext")>()),
  loadSelectedProject: vi.fn(() => null),
  saveSelectedProject: vi.fn(),
}));

const meta = (id: string, cwd: string, archived = false): ProjectMeta => ({
  id,
  workspaceId: "w1",
  name: id,
  mode: "worktree" as ProjectMeta["mode"],
  branch: null,
  cwd,
  archived,
  createdAt: 1,
});

const workspace = (id: string, path: string, createdAt: number): WorkspaceMeta => ({
  id,
  name: id,
  path,
  git: true,
  createdAt,
});

const state: ProjectState = {
  projectCwd: "/repo",
  recents: [{ path: "/repo", openedAt: 5 }],
  selectedProjectId: "p1",
};

describe("project reducers", () => {
  it("return the same state when nothing changes", () => {
    expect(moveToWorkspace(state, "/repo", "ignored")).toBe(state);
    expect(selectProject(state, "p1")).toBe(state);
    expect(setRecents(state, state.recents)).toBe(state);
  });

  it("a move takes the new folder's selection; staying keeps the current one", () => {
    const moved = moveToWorkspace(state, "/other", "p9");
    expect(moved.projectCwd).toBe("/other");
    expect(moved.selectedProjectId).toBe("p9");
    expect(moved.recents).toBe(state.recents);
    const stayed = moveToWorkspace(state, "/repo", "p9", []);
    expect(stayed.selectedProjectId).toBe("p1");
    expect(stayed.recents).toEqual([]);
  });
});

describe("derived cwds", () => {
  const projects = [meta("p1", "/repo/.worktrees/p1"), meta("p2", "/repo/.worktrees/p2", true)];

  it("the dock follows the selected live project, else the workspace", () => {
    expect(dockCwdOf(state, projects)).toBe("/repo/.worktrees/p1");
    expect(dockCwdOf({ ...state, selectedProjectId: "p2" }, projects)).toBe("/repo");
    expect(dockCwdOf({ ...state, selectedProjectId: null }, projects)).toBe("/repo");
  });

  it("the sidebar prefers the focused chat, then the focused file, then the dock", () => {
    const session = newDefaultSession("/chat");
    const tab = newTab(session.id);
    expect(sidebarCwdOf(state, projects, session, tab)).toBe("/chat");
    expect(sidebarCwdOf(state, projects, undefined, tab)).toBe("/repo/.worktrees/p1");
    expect(sidebarCwdOf(state, projects, undefined, undefined)).toBe("/repo/.worktrees/p1");
  });

  it("git runs in the chat's worktree when it has one", () => {
    expect(gitCwdOf({ cwd: "/chat", worktreeCwd: "/chat/.wt" }, "/side")).toBe("/chat/.wt");
    expect(gitCwdOf({ cwd: "/chat" }, "/side")).toBe("/chat");
    expect(gitCwdOf(undefined, "/side")).toBe("/side");
  });

  it("rail rows come from the catalog once loaded, with local opened-at times", () => {
    const recents = [{ path: "/b", openedAt: 50 }];
    const catalog = {
      loaded: true,
      workspaces: [workspace("a", "/a/", 10), workspace("b", "/b", 20), workspace("h", "~", 30)],
    };
    expect(railRecentsOf(recents, { loaded: false, workspaces: catalog.workspaces })).toBe(recents);
    expect(railRecentsOf(recents, catalog)).toEqual([
      { path: "/a", openedAt: 10 },
      { path: "/b", openedAt: 50 },
    ]);
    vi.mocked(loadArchivedProjects).mockReturnValueOnce([{ path: "/a", openedAt: 1 }]);
    expect(railRecentsOf(recents, catalog)).toEqual([{ path: "/b", openedAt: 50 }]);
  });
});

describe("project actions", () => {
  beforeEach(() => {
    projectStore.setState(initialProjectState({ projectCwd: "/repo", selectedProjectId: "p1" }));
    vi.mocked(loadSelectedProject).mockClear();
    vi.mocked(saveSelectedProject).mockClear();
  });
  afterEach(() => projectStore.setState(initialProjectState({ projectCwd: "~" })));

  it("entering another workspace loads its remembered project and leads the recents", () => {
    vi.mocked(loadSelectedProject).mockReturnValueOnce("p7");
    project.enterWorkspace("/other");
    const s = projectStore.getState();
    expect(s.projectCwd).toBe("/other");
    expect(s.selectedProjectId).toBe("p7");
    expect(s.recents[0]?.path).toBe("/other");
    expect(loadSelectedProject).toHaveBeenCalledWith("/other");
  });

  it("re-entering the current workspace keeps the selection and skips the load", () => {
    project.enterWorkspace("/repo");
    expect(projectStore.getState().selectedProjectId).toBe("p1");
    expect(loadSelectedProject).not.toHaveBeenCalled();
  });

  it("the default cwd fills empty recents only", () => {
    project.adoptDefaultCwd("/first");
    expect(projectStore.getState().recents.map((r) => r.path)).toContain("/first");
    const held = projectStore.getState().recents;
    project.adoptDefaultCwd("/second");
    expect(projectStore.getState().projectCwd).toBe("/second");
    expect(projectStore.getState().recents).toBe(held);
  });

  it("picking a project saves it for the current folder, once", () => {
    project.selectProject("p2");
    project.selectProject("p2");
    expect(projectStore.getState().selectedProjectId).toBe("p2");
    expect(saveSelectedProject).toHaveBeenCalledTimes(1);
    expect(saveSelectedProject).toHaveBeenCalledWith("/repo", "p2");
  });

  it("a plain cwd move leaves the recents alone", () => {
    const held = projectStore.getState().recents;
    project.setProjectCwd("/elsewhere");
    expect(projectStore.getState().projectCwd).toBe("/elsewhere");
    expect(projectStore.getState().recents).toBe(held);
  });
});
