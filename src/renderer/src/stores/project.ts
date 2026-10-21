import { useMemo } from "react";
import { useStore } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import { focusedFileTab, type WorkspaceTab } from "../lib/layout";
import { loadSelectedProject, saveSelectedProject } from "../lib/projectContext";
import {
  lastProjectPath,
  loadArchivedProjects,
  looksLikeProject,
  normalizeProjectPath,
  rememberProject,
  sameProjectPath,
  type RecentProject,
} from "../lib/recents";
import { sessionWorkCwd } from "../lib/session";
import { sessionStore, useSessionShells, type SessionShell } from "../lib/tcserver/store";
import {
  useWorkspaceCatalog,
  workspaceByPath,
  workspaceStore,
  type WorkspaceCatalog,
} from "../lib/tcserver/workspaces";
import type { ProjectMeta } from "../lib/tcserver/types";
import { activeSessionOf, useWorkspaceTabs, workspaceTabsStore } from "./workspace";

/**
 * Where the window is: the workspace folder, the project picked inside it,
 * and the recents that fill the rail. Changes on a project switch, so
 * rarely; the rail and sidebar read it through selectors.
 *
 * The cwds the chrome shows are derived, not stored: `dockCwdOf`,
 * `sidebarCwdOf` and `gitCwdOf` below take the live inputs and return the
 * same answer in a render and in a callback.
 */
export type ProjectState = {
  /** The workspace folder the window is on. */
  projectCwd: string;
  recents: RecentProject[];
  /** The project picked in this workspace, remembered per folder. */
  selectedProjectId: string | null;
};

export function initialProjectState(
  overrides: Partial<ProjectState> = {},
): ProjectState {
  const projectCwd = overrides.projectCwd ?? lastProjectPath() ?? "~";
  return {
    projectCwd,
    recents: [],
    selectedProjectId: loadSelectedProject(projectCwd),
    ...overrides,
  };
}

/**
 * The window moves to `cwd`. A move to another folder takes that folder's
 * remembered selection; staying put keeps the current one. `state` itself
 * when nothing moves.
 */
export function moveToWorkspace(
  state: ProjectState,
  cwd: string,
  selectedProjectId: string | null,
  recents: RecentProject[] = state.recents,
): ProjectState {
  const moved = cwd !== state.projectCwd;
  const selection = moved ? selectedProjectId : state.selectedProjectId;
  if (!moved && recents === state.recents && selection === state.selectedProjectId) {
    return state;
  }
  return { ...state, projectCwd: cwd, selectedProjectId: selection, recents };
}

export function selectProject(state: ProjectState, projectId: string | null): ProjectState {
  return state.selectedProjectId === projectId ? state : { ...state, selectedProjectId: projectId };
}

export function setRecents(state: ProjectState, recents: RecentProject[]): ProjectState {
  return state.recents === recents ? state : { ...state, recents };
}

// ── derived ─────────────────────────────────────────────────────────────

export function selectedProjectOf(
  state: Pick<ProjectState, "selectedProjectId">,
  projects: ProjectMeta[],
): ProjectMeta | undefined {
  return state.selectedProjectId
    ? projects.find((p) => p.id === state.selectedProjectId && !p.archived)
    : undefined;
}

/** Where a project terminal opens and which dock it lands in: the
 *  selected project's checkout (its worktree), else the workspace root. */
export function dockCwdOf(
  state: Pick<ProjectState, "projectCwd" | "selectedProjectId">,
  projects: ProjectMeta[],
): string {
  return selectedProjectOf(state, projects)?.cwd ?? state.projectCwd;
}

/** The folder the sidebar lists: the focused chat's, else the focused
 *  file's, else the selected project's, else the workspace root. */
export function sidebarCwdOf(
  state: Pick<ProjectState, "projectCwd" | "selectedProjectId">,
  projects: ProjectMeta[],
  active: { cwd: string } | undefined,
  activeTab: WorkspaceTab | undefined,
): string {
  return (
    active?.cwd ??
    (activeTab ? focusedFileTab(activeTab)?.cwd : undefined) ??
    dockCwdOf(state, projects)
  );
}

/** The checkout git commands run in: the focused chat's work tree, else the sidebar's folder. */
export function gitCwdOf(
  active: Parameters<typeof sessionWorkCwd>[0] | undefined,
  sidebarCwd: string,
): string {
  return active ? sessionWorkCwd(active) : sidebarCwd;
}

/** Rail rows: every server workspace, opened-at from the local recents. */
export function railRecentsOf(
  recents: RecentProject[],
  catalog: Pick<WorkspaceCatalog, "loaded" | "workspaces">,
): RecentProject[] {
  if (!catalog.loaded) return recents;
  const hidden = new Set(loadArchivedProjects().map((item) => item.path));
  return catalog.workspaces
    .map((w) => ({
      path: normalizeProjectPath(w.path),
      openedAt:
        recents.find((r) => sameProjectPath(r.path, w.path))?.openedAt ?? w.createdAt,
    }))
    .filter((item) => looksLikeProject(item.path) && !hidden.has(item.path));
}

// ── the store ───────────────────────────────────────────────────────────

export const projectStore = createStore<ProjectState>()(
  subscribeWithSelector(() => initialProjectState()),
);

export function useProject<T>(selector: (state: ProjectState) => T): T {
  return useStore(projectStore, selector);
}

export function useSelectedWorkspaceId(): string | null {
  const projectCwd = useProject((s) => s.projectCwd);
  const { workspaces } = useWorkspaceCatalog();
  return workspaceByPath(workspaces, projectCwd)?.id ?? null;
}

export function useRailRecents(): RecentProject[] {
  const recents = useProject((s) => s.recents);
  const catalog = useWorkspaceCatalog();
  return useMemo(
    () => railRecentsOf(recents, catalog),
    [recents, catalog.loaded, catalog.workspaces],
  );
}

/** The dock cwd as of now, for callbacks. */
export function currentDockCwd(): string {
  return dockCwdOf(projectStore.getState(), workspaceStore.getSnapshot().projects);
}

const update = (reducer: (state: ProjectState) => ProjectState) =>
  projectStore.setState(reducer);

const selectionFor = (state: ProjectState, cwd: string) =>
  cwd === state.projectCwd ? state.selectedProjectId : loadSelectedProject(cwd);

/** The bound actions: each applies a reducer above to the live store. */
export const project = {
  /** Open `cwd` as the window's workspace and bump it to the top of the recents. */
  enterWorkspace: (cwd: string) =>
    update((s) => moveToWorkspace(s, cwd, selectionFor(s, cwd), rememberProject(cwd))),
  /** Move to `cwd` without touching the recents. */
  setProjectCwd: (cwd: string) => update((s) => moveToWorkspace(s, cwd, selectionFor(s, cwd))),
  /** The default folder on a first launch: recents fill only when they are empty. */
  adoptDefaultCwd: (cwd: string) =>
    update((s) =>
      moveToWorkspace(
        s,
        cwd,
        selectionFor(s, cwd),
        s.recents.length > 0 ? s.recents : rememberProject(cwd),
      ),
    ),
  /** Pick a project in this workspace; the choice is remembered per folder. */
  selectProject: (projectId: string | null) => {
    const before = projectStore.getState();
    update((s) => selectProject(s, projectId));
    if (projectStore.getState() !== before) saveSelectedProject(before.projectCwd, projectId);
  },
  setRecents: (recents: RecentProject[]) => update((s) => setRecents(s, recents)),
};

/** The tab on screen and the session it shows, as React state. */
export function useActivePane(): {
  activeTab: WorkspaceTab | undefined;
  active: SessionShell | undefined;
} {
  const tabs = useWorkspaceTabs((s) => s.tabs);
  const activeTabId = useWorkspaceTabs((s) => s.activeTabId);
  const sessions = useSessionShells();
  return useMemo(
    () => activeSessionOf(tabs, activeTabId, sessions),
    [tabs, activeTabId, sessions],
  );
}

/** The active pane and the two folders the chrome derives from it, as React state. */
export function useProjectCwds(): {
  activeTab: WorkspaceTab | undefined;
  active: SessionShell | undefined;
  sidebarCwd: string;
  gitCwd: string;
} {
  const { activeTab, active } = useActivePane();
  const projectCwd = useProject((s) => s.projectCwd);
  const selectedProjectId = useProject((s) => s.selectedProjectId);
  const { projects } = useWorkspaceCatalog();
  const sidebarCwd = sidebarCwdOf({ projectCwd, selectedProjectId }, projects, active, activeTab);
  return { activeTab, active, sidebarCwd, gitCwd: gitCwdOf(active, sidebarCwd) };
}

/** The tab on screen and the session it shows, as of now, for callbacks. */
export function currentActivePane() {
  const { tabs, activeTabId } = workspaceTabsStore.getState();
  return activeSessionOf(tabs, activeTabId, sessionStore.getSnapshot());
}

/** The folder the sidebar shows, as of now; the render computes the same from live values. */
export function currentSidebarCwd(): string {
  const { activeTab, active } = currentActivePane();
  return sidebarCwdOf(
    projectStore.getState(),
    workspaceStore.getSnapshot().projects,
    active,
    activeTab,
  );
}

/** The checkout git commands run in, as of now. */
export function currentGitCwd(): string {
  return gitCwdOf(currentActivePane().active, currentSidebarCwd());
}
