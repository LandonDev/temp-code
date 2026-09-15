import { useStore } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";

/**
 * Which roots show their subagent rows in the sidebar. A root shows them on
 * its own while it works; the user can pin either state, and an entry here
 * is that pin: true holds the rows open after it settles, false keeps them
 * folded while it works. No entry follows the work.
 */
export type SubagentRowsState = {
  pinned: Record<string, boolean>;
};

const KEY = "monocode.tc.subagentRows";

function load(): SubagentRowsState {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return { pinned: parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {} };
  } catch {
    return { pinned: {} };
  }
}

function save(state: SubagentRowsState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state.pinned));
  } catch {
    // private mode / quota
  }
}

/** Whether a root's subagent rows show: the pin when there is one, else the work. */
export const subagentRowsOpen = (
  state: SubagentRowsState,
  rootId: string,
  working: boolean,
): boolean => state.pinned[rootId] ?? working;

/** Flip a root's rows; a flip back to what the work would show drops the pin. */
export function toggleSubagentRows(
  state: SubagentRowsState,
  rootId: string,
  working: boolean,
): SubagentRowsState {
  const next = !subagentRowsOpen(state, rootId, working);
  const pinned = { ...state.pinned };
  if (next === working) delete pinned[rootId];
  else pinned[rootId] = next;
  return { pinned };
}

export const subagentRowsStore = createStore<SubagentRowsState>()(
  subscribeWithSelector(load),
);

export function useSubagentRows<T>(selector: (state: SubagentRowsState) => T): T {
  return useStore(subagentRowsStore, selector);
}

export const subagentRows = {
  toggle: (rootId: string, working: boolean) => {
    const next = toggleSubagentRows(subagentRowsStore.getState(), rootId, working);
    subagentRowsStore.setState(next);
    save(next);
  },
};
