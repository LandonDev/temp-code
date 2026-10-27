import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newTab } from "../lib/layout";
import { loadSelectedProject, saveSelectedProject } from "../lib/projectContext";
import { loadArchivedProjects } from "../lib/recents";
import { newDefaultSession } from "../lib/session";
import type { ProjectMeta, WorkspaceCatalog, WorkspaceMeta } from "../lib/tcserver/types";
import { workspaceStore } from "../lib/tcserver/workspaces";
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
  environmentId: "local",
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
  environmentId: "local",
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
    const session = newDefaultSession("local", "/chat");
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
    expect(loadSelectedProject).toHaveBeenCalledWith("/other", expect.anything());
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
    expect(saveSelectedProject).toHaveBeenCalledWith("/repo", "p2", expect.anything());
  });

  describe("a project linked across hosts", () => {
    const MAC = "/Users/me/repo";
    const BOX = "/srv/agents/work/repo";
    const linked = {
      workspaces: [
        { ...workspace("wM", MAC, 1), linkId: "wl_1" },
        { ...workspace("wB", BOX, 1), environmentId: "env_box", linkId: "wl_1" },
      ],
      projects: [],
      icons: new Map(),
      defaults: new Map(),
      loaded: true,
    } as unknown as WorkspaceCatalog;

    beforeEach(async () => {
      const actual = await vi.importActual<typeof import("../lib/projectContext")>("../lib/projectContext");
      vi.mocked(loadSelectedProject).mockImplementation(actual.loadSelectedProject);
      vi.mocked(saveSelectedProject).mockImplementation(actual.saveSelectedProject);
      vi.spyOn(workspaceStore, "getSnapshot").mockReturnValue(linked);
      const data = new Map<string, string>();
      vi.stubGlobal("localStorage", {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, String(v)),
        removeItem: (k: string) => void data.delete(k),
      });
    });
    afterEach(() => {
      vi.mocked(loadSelectedProject).mockImplementation(() => null);
      vi.mocked(saveSelectedProject).mockImplementation(() => {});
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it("a box copy's path reads the leader's memory", () => {
      localStorage.setItem("monocode.tc.selectedProject", JSON.stringify({ [MAC]: "pM" }));
      projectStore.setState(initialProjectState({ projectCwd: "/elsewhere", selectedProjectId: null }));
      project.enterWorkspace(BOX);
      expect(projectStore.getState().projectCwd).toBe(BOX);
      expect(projectStore.getState().selectedProjectId).toBe("pM");
      // A pick on the box path is remembered for both copies.
      project.selectProject("pB");
      expect(JSON.parse(localStorage.getItem("monocode.tc.selectedProject")!)).toEqual({ [MAC]: "pB" });
    });

    it("following a copy's path keeps the folder, the recents and the selection", () => {
      projectStore.setState(initialProjectState({ projectCwd: MAC, selectedProjectId: "pM" }));
      const before = projectStore.getState();
      vi.mocked(loadSelectedProject).mockClear();
      project.followWorkspace(BOX);
      expect(projectStore.getState()).toBe(before);
      expect(loadSelectedProject).not.toHaveBeenCalled();
      project.followWorkspace("/elsewhere");
      expect(projectStore.getState().projectCwd).toBe("/elsewhere");
      expect(projectStore.getState().recents[0]?.path).toBe("/elsewhere");
    });
  });

  it("a pick of the workspace the thread is already in puts a stale header right", () => {
    projectStore.setState(initialProjectState({ projectCwd: "/w/beta", selectedProjectId: null }));
    expect(project.alreadyIn("/w/alpha", "/w/alpha")).toBe(true);
    expect(projectStore.getState().projectCwd).toBe("/w/alpha");
    const before = projectStore.getState();
    expect(project.alreadyIn("/w/alpha", "/w/alpha")).toBe(true);
    expect(projectStore.getState()).toBe(before);
    expect(project.alreadyIn("/w/beta", "/w/alpha")).toBe(false);
    expect(project.alreadyIn(undefined, "/w/alpha")).toBe(false);
  });

  it("a plain cwd move leaves the recents alone", () => {
    const held = projectStore.getState().recents;
    project.setProjectCwd("/elsewhere");
    expect(projectStore.getState().projectCwd).toBe("/elsewhere");
    expect(projectStore.getState().recents).toBe(held);
  });
});
