import { useSyncExternalStore } from "react";
import { registry, type ConnectionRegistry } from "./registry";

/**
 * When each environment last had a live session, for the Environments pane
 * ("last seen 3 h ago" on an offline host). Noted when a session opens and
 * again when it closes, kept in localStorage so a restart still knows.
 */

const KEY = "monocode.environments.lastSeen";

let seen: Readonly<Record<string, number>> = load();
const listeners = new Set<() => void>();

function load(): Record<string, number> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    return value && typeof value === "object" ? (value as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(seen));
  } catch {
    /* private mode or full */
  }
}

function emit(): void {
  for (const l of listeners) l();
}

export function noteSeen(id: string, at: number = Date.now()): void {
  if (seen[id] === at) return;
  seen = { ...seen, [id]: at };
  save();
  emit();
}

export function forgetSeen(id: string): void {
  if (!(id in seen)) return;
  const { [id]: _gone, ...rest } = seen;
  seen = rest;
  save();
  emit();
}

export function lastSeenAt(id: string): number | null {
  return seen[id] ?? null;
}

export function useLastSeenAt(id: string): number | null {
  return useSyncExternalStore(subscribe, () => lastSeenAt(id), () => lastSeenAt(id));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Follow the registry: an environment is "seen" while its transport is open. */
export function trackLastSeen(reg: Pick<ConnectionRegistry, "subscribe" | "statuses"> = registry, now: () => number = Date.now): () => void {
  let open = new Set<string>();
  const sync = (): void => {
    const next = new Set<string>();
    for (const [id, status] of reg.statuses()) {
      if (status.transport !== "open") continue;
      next.add(id);
      if (!open.has(id)) noteSeen(id, now());
    }
    for (const id of open) if (!next.has(id)) noteSeen(id, now());
    open = next;
  };
  sync();
  return reg.subscribe(sync);
}

/** Test seam. */
export function resetLastSeen(): void {
  seen = {};
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* no storage */
  }
  emit();
}
