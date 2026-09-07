import { useSyncExternalStore } from "react";
import type { SessionSummary } from "./sessionStore";

/**
 * The project history rows (every visited project), outside App state: the
 * server's meta pushes refresh them several times per turn, and only the
 * search view reads them on screen, so App must not re-render for them.
 */
type Updater = SessionSummary[] | ((current: SessionSummary[]) => SessionSummary[]);

let rows: SessionSummary[] = [];
const listeners = new Set<() => void>();

export const historyStore = {
  get: (): SessionSummary[] => rows,
  set(updater: Updater): void {
    const next = typeof updater === "function" ? updater(rows) : updater;
    if (next === rows) return;
    rows = next;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Every visited project's history rows as React state. */
export function useHistoryRows(): SessionSummary[] {
  return useSyncExternalStore(historyStore.subscribe, historyStore.get);
}
