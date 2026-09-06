import { useSyncExternalStore } from "react";

/**
 * When the user last looked at each session, keyed by id. App writes it when
 * a session's tab becomes active; the sessions tab reads it to mark rows
 * unread. The server has no unread counter, so this stays client-local.
 */

const KEY = "monocode.tc.lastSeen";

type SeenMap = Record<string, number>;

const listeners = new Set<() => void>();
let cache: SeenMap | null = null;

function read(): SeenMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const out: SeenMap = {};
    for (const [id, at] of Object.entries(parsed)) {
      if (typeof at === "number" && Number.isFinite(at)) out[id] = at;
    }
    return out;
  } catch {
    return {};
  }
}

/** Stable between writes, so it can be a store snapshot. */
export function loadLastSeen(): SeenMap {
  return (cache ??= read());
}

export function markSessionSeen(id: string, at = Date.now()): void {
  if (!id) return;
  const prev = loadLastSeen();
  if ((prev[id] ?? 0) >= at) return;
  const next = { ...prev, [id]: at };
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // private mode / quota
  }
  for (const listener of listeners) listener();
}

/** Fires on writes from this window and, through the storage event, others. */
export function subscribeLastSeen(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== KEY) return;
    cache = null;
    listener();
  };
  const win = typeof window === "undefined" ? null : window;
  win?.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    win?.removeEventListener("storage", onStorage);
  };
}

export function useLastSeen(): SeenMap {
  return useSyncExternalStore(subscribeLastSeen, loadLastSeen);
}
