import { useSyncExternalStore } from "react";

/**
 * Whether the project's right rail is open. The title bar's toggle flips
 * it; the rail host (M5d) shows for the selected project while it is on.
 * Session-scoped, like temp-code's `railOpen`: a fresh launch starts closed.
 */

let open = false;
const listeners = new Set<() => void>();

export function isRightRailOpen(): boolean {
  return open;
}

export function setRightRailOpen(next: boolean): void {
  if (next === open) return;
  open = next;
  for (const listener of listeners) listener();
}

export function toggleRightRail(): void {
  setRightRailOpen(!open);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRightRailOpen(): boolean {
  return useSyncExternalStore(subscribe, isRightRailOpen, isRightRailOpen);
}
