import { useStore } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import type { FilePaneTab } from "../lib/layout";
import {
  addTerminalToDock,
  createProjectTerminal,
  findProjectTerminal,
  mapProjectTerminal,
  patchProjectTerminals,
  type ProjectTerminalDock,
} from "../lib/projectTerminal";
import { sameProjectPath } from "../lib/recents";
import type { TerminalMetaPatch } from "../lib/terminalTab";

/**
 * The project terminal docks: one per project folder, each a pane of
 * terminals with a side, a size and whether it is open. Every reducer that
 * can be a no-op hands back the same `state` then, so a write that does
 * nothing notifies nobody.
 */
export type TerminalsState = { docks: ProjectTerminalDock[] };

export function initialTerminalsState(docks: ProjectTerminalDock[] = []): TerminalsState {
  return { docks };
}

export function setDocks(state: TerminalsState, docks: ProjectTerminalDock[]): TerminalsState {
  return docks === state.docks ? state : { docks };
}

/** Update the dock at `projectPath`; null from `update` removes it. */
export function updateDock(
  state: TerminalsState,
  projectPath: string,
  update: (dock: ProjectTerminalDock) => ProjectTerminalDock | null,
): TerminalsState {
  const next = mapProjectTerminal(state.docks, projectPath, update);
  return sameDocks(next, state.docks) ? state : { docks: next };
}

/** A terminal joins the project's dock, which opens; the first one makes the dock. */
export function openTerminal(
  state: TerminalsState,
  projectPath: string,
  file: FilePaneTab,
): TerminalsState {
  const existing = findProjectTerminal(state.docks, projectPath);
  return {
    docks: existing
      ? mapProjectTerminal(state.docks, projectPath, (dock) => addTerminalToDock(dock, file))
      : [...state.docks, createProjectTerminal(projectPath, file)],
  };
}

export function patchTerminal(
  state: TerminalsState,
  fileId: string,
  patch: TerminalMetaPatch,
): TerminalsState {
  return setDocks(state, patchProjectTerminals(state.docks, fileId, patch));
}

/** A removed project takes its dock with it. */
export function removeProject(state: TerminalsState, projectPath: string): TerminalsState {
  const docks = state.docks.filter((dock) => !sameProjectPath(dock.projectPath, projectPath));
  return docks.length === state.docks.length ? state : { docks };
}

function sameDocks(a: ProjectTerminalDock[], b: ProjectTerminalDock[]): boolean {
  return a.length === b.length && a.every((dock, i) => dock === b[i]);
}

export const terminalsStore = createStore<TerminalsState>()(
  subscribeWithSelector(() => initialTerminalsState()),
);

export function useTerminals<T>(selector: (state: TerminalsState) => T): T {
  return useStore(terminalsStore, selector);
}

/** The dock of `projectPath` as of now, for callbacks. */
export function currentDock(projectPath: string): ProjectTerminalDock | undefined {
  return findProjectTerminal(terminalsStore.getState().docks, projectPath);
}

/** The docks as of now, for callbacks and the quit path. */
export function currentDocks(): ProjectTerminalDock[] {
  return terminalsStore.getState().docks;
}

const apply = (reduce: (state: TerminalsState) => TerminalsState) =>
  terminalsStore.setState(reduce);

export const terminals = {
  setDocks: (docks: ProjectTerminalDock[]) => apply((s) => setDocks(s, docks)),
  updateDock: (
    projectPath: string,
    update: (dock: ProjectTerminalDock) => ProjectTerminalDock | null,
  ) => apply((s) => updateDock(s, projectPath, update)),
  openTerminal: (projectPath: string, file: FilePaneTab) =>
    apply((s) => openTerminal(s, projectPath, file)),
  patchTerminal: (fileId: string, patch: TerminalMetaPatch) =>
    apply((s) => patchTerminal(s, fileId, patch)),
  removeProject: (projectPath: string) => apply((s) => removeProject(s, projectPath)),
};
