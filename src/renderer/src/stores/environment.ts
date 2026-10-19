import { useStore } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import { LOCAL_ENVIRONMENT_ID } from "../lib/connection/registry";
import { windowSlot } from "../lib/native";

/**
 * Which machine the window is on (thread K2). The current environment
 * follows the workspace or thread on screen and is remembered per window
 * slot; each environment remembers the workspace it was last on, so a
 * switch lands where the user left that machine.
 */
export type EnvironmentState = {
  currentId: string;
  /** Environment id → workspace path last used there. */
  lastWorkspace: Readonly<Record<string, string>>;
};

const CURRENT_KEY = (slot: string) => `monocode.environment.current.${slot}`;
const LAST_WORKSPACE_KEY = "monocode.environment.lastWorkspace";

function slot(): string {
  try {
    return windowSlot();
  } catch {
    return "test";
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* no storage */
  }
}

function loadLastWorkspace(): Record<string, string> {
  try {
    const value = JSON.parse(read(LAST_WORKSPACE_KEY) ?? "{}") as unknown;
    return value && typeof value === "object" ? (value as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function initialEnvironmentState(overrides: Partial<EnvironmentState> = {}): EnvironmentState {
  return {
    currentId: read(CURRENT_KEY(slot())) || LOCAL_ENVIRONMENT_ID,
    lastWorkspace: loadLastWorkspace(),
    ...overrides,
  };
}

/** The environment `delta` steps from `currentId` in `ids`, wrapping; `currentId` when there is nowhere to go. */
export function stepEnvironment(ids: readonly string[], currentId: string, delta: number): string {
  if (ids.length === 0) return currentId;
  const at = ids.indexOf(currentId);
  if (at < 0) return ids[0];
  return ids[(at + delta + ids.length) % ids.length];
}

/** The environment at `index` (0-based; -1 is the last), or null past the end. */
export function environmentAt(ids: readonly string[], index: number): string | null {
  if (ids.length === 0) return null;
  if (index < 0) return ids[ids.length - 1];
  return ids[index] ?? null;
}

export const environmentStore = createStore<EnvironmentState>()(subscribeWithSelector(() => initialEnvironmentState()));

export function useEnvironmentState<T>(selector: (state: EnvironmentState) => T): T {
  return useStore(environmentStore, selector);
}

export const useCurrentEnvironmentId = (): string => useEnvironmentState((s) => s.currentId);

export const environment = {
  /** The window is now on `id`; `workspacePath` is where, when a workspace is on screen. */
  follow(id: string, workspacePath: string | null = null): void {
    const state = environmentStore.getState();
    const lastWorkspace =
      workspacePath && state.lastWorkspace[id] !== workspacePath ? { ...state.lastWorkspace, [id]: workspacePath } : state.lastWorkspace;
    if (state.currentId === id && lastWorkspace === state.lastWorkspace) return;
    environmentStore.setState({ currentId: id, lastWorkspace });
    if (state.currentId !== id) write(CURRENT_KEY(slot()), id);
    if (lastWorkspace !== state.lastWorkspace) write(LAST_WORKSPACE_KEY, JSON.stringify(lastWorkspace));
  },
  /** An environment was forgotten: its memory goes with it. */
  forget(id: string): void {
    const state = environmentStore.getState();
    if (!(id in state.lastWorkspace) && state.currentId !== id) return;
    const { [id]: _gone, ...lastWorkspace } = state.lastWorkspace;
    const currentId = state.currentId === id ? LOCAL_ENVIRONMENT_ID : state.currentId;
    environmentStore.setState({ currentId, lastWorkspace });
    write(CURRENT_KEY(slot()), currentId);
    write(LAST_WORKSPACE_KEY, JSON.stringify(lastWorkspace));
  },
  /** Test seam. */
  reset(): void {
    environmentStore.setState(initialEnvironmentState({ currentId: LOCAL_ENVIRONMENT_ID, lastWorkspace: {} }));
  },
};
