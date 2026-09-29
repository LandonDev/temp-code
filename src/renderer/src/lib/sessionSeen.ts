import { useSyncExternalStore } from "react";

/**
 * When the user last looked at each session, keyed by id. App writes it when
 * a session's tab becomes active; the sessions tab reads it to mark rows
 * unread. The server has no unread counter, so this stays client-local.
 *
 * The renderer before the cutover kept the same `{id: timestamp}` map under
 * `thread-last-seen`. The first read adopts it, and stamps a one-time floor:
 * a thread with no entry counts as seen up to the floor, so the cutover does
 * not light up every settled thread while later ones still read unread.
 */

const KEY = "monocode.tc.lastSeen";
const OLD_KEY = "thread-last-seen";
const FLOOR_KEY = "monocode.tc.seenFloor";

type SeenMap = Record<string, number>;

const listeners = new Set<() => void>();
let cache: SeenMap | null = null;
let floorCache: number | null = null;

function parseMap(raw: string | null): SeenMap | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: SeenMap = {};
    for (const [id, at] of Object.entries(parsed)) {
      if (typeof at === "number" && Number.isFinite(at)) out[id] = at;
    }
    return out;
  } catch {
    return null;
  }
}

/** Reads the map, adopting the old renderer's on the first run, and stamps
 *  the floor when it is missing. The old key stays so a bad run can be
 *  undone by clearing the two new keys. */
function read(): SeenMap {
  try {
    let map = parseMap(localStorage.getItem(KEY));
    if (!map || Object.keys(map).length === 0) {
      const old = parseMap(localStorage.getItem(OLD_KEY));
      if (old && Object.keys(old).length > 0) {
        map = old;
        localStorage.setItem(KEY, JSON.stringify(old));
      }
    }
    if (localStorage.getItem(FLOOR_KEY) === null)
      localStorage.setItem(FLOOR_KEY, String(Date.now()));
    return map ?? {};
  } catch {
    return {};
  }
}

function readFloor(): number {
  try {
    const at = Number(localStorage.getItem(FLOOR_KEY));
    return Number.isFinite(at) && at > 0 ? at : 0;
  } catch {
    return 0;
  }
}

/** Stable between writes, so it can be a store snapshot. */
export function loadLastSeen(): SeenMap {
  return (cache ??= read());
}

/** Threads without an entry count as seen up to this time; 0 when unknown. */
export function seenFloor(): number {
  if (floorCache === null) {
    loadLastSeen();
    floorCache = readFloor();
  }
  return floorCache;
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

/** Drops ids the server no longer knows. Once at boot, so the map stops
 *  growing with every deleted thread and each later write stays small. */
export function pruneLastSeen(known: ReadonlySet<string>): void {
  const prev = loadLastSeen();
  const next: SeenMap = {};
  let dropped = 0;
  for (const [id, at] of Object.entries(prev)) {
    if (known.has(id)) next[id] = at;
    else dropped += 1;
  }
  if (dropped === 0) return;
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
    if (event.key !== null && event.key !== KEY && event.key !== FLOOR_KEY) return;
    cache = null;
    floorCache = null;
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

export function useSeenFloor(): number {
  return useSyncExternalStore(subscribeLastSeen, seenFloor);
}
