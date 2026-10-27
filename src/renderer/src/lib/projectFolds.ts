import { useStore } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

/**
 * Which projects in the workspace column are folded shut. A project starts
 * open; the person's close is an entry here, and opening it again drops the
 * entry. Persisted, so a fold survives a relaunch.
 */
export type ProjectFoldsState = {
  closed: Record<string, true>;
};

const KEY = "monocode.tc.projectFolds";

function load(): ProjectFoldsState {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return { closed: {} };
    return { closed: Object.fromEntries(parsed.filter((id): id is string => typeof id === "string").map((id) => [id, true])) };
  } catch {
    return { closed: {} };
  }
}

function save(state: ProjectFoldsState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.keys(state.closed)));
  } catch {
    // private mode / quota
  }
}

/** Whether a project's threads show: open unless the person closed it. */
export const projectOpen = (state: ProjectFoldsState, projectId: string): boolean => !state.closed[projectId];

/** Flip a project's fold; reopening drops its entry. */
export function toggleProject(state: ProjectFoldsState, projectId: string): ProjectFoldsState {
  const closed = { ...state.closed };
  if (closed[projectId]) delete closed[projectId];
  else closed[projectId] = true;
  return { closed };
}

export const projectFoldsStore = createStore<ProjectFoldsState>()(subscribeWithSelector(load));

export function useProjectOpen(projectId: string): boolean {
  return useStore(projectFoldsStore, (s) => projectOpen(s, projectId));
}

export const projectFolds = {
  toggle: (projectId: string) => {
    const next = toggleProject(projectFoldsStore.getState(), projectId);
    projectFoldsStore.setState(next);
    save(next);
  },
  /** Re-read the persisted folds (tests, a second window's write). */
  reload: () => projectFoldsStore.setState(load()),
};
