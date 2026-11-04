import { useCallback, useSyncExternalStore } from "react";

/**
 * Which board rows have their task list folded open, for the window's
 * life (docs/LAYOUT.md "Master"). Keyed by `<masterId>:<row key>`; a plan's
 * row key is the plan's id, so the fold survives its build starting. Kept
 * outside React, so it survives the virtualizer unmounting a row, the
 * child pane and back, and a row changing section. Closed by default;
 * never persisted.
 */

const open = new Set<string>();
const listeners = new Set<() => void>();

export const taskFoldKey = (masterId: string, rowKey: string): string => `${masterId}:${rowKey}`;

export function isTaskFoldOpen(key: string): boolean {
  return open.has(key);
}

export function setTaskFoldOpen(key: string, next: boolean): void {
  if (open.has(key) === next) return;
  if (next) open.add(key);
  else open.delete(key);
  for (const listener of listeners) listener();
}

export function subscribeTaskFolds(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Closes every fold (tests). */
export function resetTaskFolds(): void {
  open.clear();
  for (const listener of listeners) listener();
}

/** A row's fold and its setter, the setter stable per row. */
export function useTaskFold(masterId: string, rowKey: string): [boolean, (next: boolean) => void] {
  const key = taskFoldKey(masterId, rowKey);
  const isOpen = useSyncExternalStore(subscribeTaskFolds, () => open.has(key));
  const set = useCallback((next: boolean) => setTaskFoldOpen(key, next), [key]);
  return [isOpen, set];
}
