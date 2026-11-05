import { useCallback, useSyncExternalStore } from "react";

/**
 * The person's choice for a board row's task list, for the window's life
 * (docs/LAYOUT.md "Master"). The fold's default follows the thread: open
 * while it is live (Working, Needs you, Queued), closed once it sits under
 * Done (`taskFoldOpen`). A choice is kept only where the person's hand
 * differs from that default: a list closed while the thread works stays
 * closed through a new pass, one opened after it finished stays open, and
 * a click back to the default clears the choice. Keyed by
 * `<masterId>:<row key>`; a plan's row key is the plan's id, so the choice
 * survives its build starting. Kept outside React, so it survives the
 * virtualizer unmounting a row, the child pane and back, and a row
 * changing section. Never persisted.
 */

const choices = new Map<string, boolean>();
const listeners = new Set<() => void>();

export const taskFoldKey = (masterId: string, rowKey: string): string => `${masterId}:${rowKey}`;

/** The person's choice for a row, or undefined while it follows the default. */
export function taskFoldChoice(key: string): boolean | undefined {
  return choices.get(key);
}

/** Whether a row's list is open: the person's choice, else open while live. */
export function taskFoldOpen(key: string, live: boolean): boolean {
  return choices.get(key) ?? live;
}

/** Records the person's choice; undefined goes back to the default. */
export function setTaskFoldChoice(key: string, choice: boolean | undefined): void {
  if (choices.get(key) === choice) return;
  if (choice === undefined) choices.delete(key);
  else choices.set(key, choice);
  for (const listener of listeners) listener();
}

export function subscribeTaskFolds(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forgets every choice (tests). */
export function resetTaskFolds(): void {
  choices.clear();
  for (const listener of listeners) listener();
}

/** A row's choice and its setter, the setter stable per row. */
export function useTaskFold(masterId: string, rowKey: string): [boolean | undefined, (choice: boolean | undefined) => void] {
  const key = taskFoldKey(masterId, rowKey);
  const choice = useSyncExternalStore(subscribeTaskFolds, () => choices.get(key));
  const set = useCallback((next: boolean | undefined) => setTaskFoldChoice(key, next), [key]);
  return [choice, set];
}
