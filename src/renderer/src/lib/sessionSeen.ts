import { useSyncExternalStore } from "react";

/**
 * When the user last looked at each session, keyed by id. App writes it when
 * a session's tab becomes active; the sessions tab reads it to mark rows
 * unread. A host that keeps read marks (`SessionMeta.readAt`, CLAUDE.md
 * "Read and unread: the host's mark") overrides this window's own entry for
 * its threads through `installHostMarks` (lib/readMarks.ts), and Mark all
 * read is sent there too; a host without them leaves this map the answer.
 *
 * The renderer before the cutover kept the same `{id: timestamp}` map under
 * `thread-last-seen`. The first read adopts it, and stamps a one-time floor:
 * a thread with no entry counts as seen up to the floor, so the cutover does
 * not light up every settled thread while later ones still read unread.
 */

const KEY = "monocode.tc.lastSeen";
const OLD_KEY = "thread-last-seen";
const FLOOR_KEY = "monocode.tc.seenFloor";

export type SeenMap = Record<string, number>;

const listeners = new Set<() => void>();
let cache: SeenMap | null = null;
let floorCache: number | null = null;

/** The hosts' read marks (lib/readMarks.ts): the threads whose host keeps
 *  one, each one's mark, and where Mark all read sends. */
export type HostMarks = {
  /** Stable between changes; only the threads whose host keeps marks. */
  marks(): SeenMap;
  subscribe(listener: () => void): () => void;
  /** The person saw these threads up to `at`. */
  read(ids: Iterable<string>, at: number): void;
};

let host: HostMarks | null = null;
/** The local map with the hosts' marks over it; null when stale. */
let merged: SeenMap | null = null;

function notify(): void {
  merged = null;
  for (const listener of listeners) listener();
}

/** Puts the hosts' marks over this window's map; returns the uninstall. */
export function installHostMarks(marks: HostMarks): () => void {
  host = marks;
  const off = marks.subscribe(notify);
  notify();
  return () => {
    off();
    if (host === marks) host = null;
    notify();
  };
}

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

/** This window's own map, without the hosts' marks. */
function localSeen(): SeenMap {
  return (cache ??= read());
}

/** Stable between writes, so it can be a store snapshot. A thread whose
 *  host keeps read marks reads the host's. */
export function loadLastSeen(): SeenMap {
  if (!host) return localSeen();
  return (merged ??= { ...localSeen(), ...host.marks() });
}

/** Threads without an entry count as seen up to this time; 0 when unknown. */
export function seenFloor(): number {
  if (floorCache === null) {
    localSeen();
    floorCache = readFloor();
  }
  return floorCache;
}

export function markSessionSeen(id: string, at = Date.now()): void {
  if (!id) return;
  const prev = localSeen();
  if ((prev[id] ?? 0) >= at) return;
  const next = { ...prev, [id]: at };
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // private mode / quota
  }
  notify();
}

/** Marks every id seen in one write: a workspace's "Mark all read". `at`
 *  should be at least the newest thread's updatedAt, since the server's
 *  clock stamps those and this machine's may lag it. */
export function markSessionsSeen(ids: Iterable<string>, at = Date.now()): void {
  const list = [...ids];
  host?.read(list, at);
  const prev = localSeen();
  let next: SeenMap | null = null;
  for (const id of list) {
    if (!id || (prev[id] ?? 0) >= at) continue;
    (next ??= { ...prev })[id] = at;
  }
  if (!next) return;
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // private mode / quota
  }
  notify();
}

/** Every known thread read as of `at`, and the floor raised to it so a
 *  thread with no entry counts as seen too (the View menu, the rail). */
export function markAllSeen(ids: Iterable<string>, at = Date.now()): void {
  const list = [...ids];
  host?.read(list, at);
  const next: SeenMap = { ...localSeen() };
  for (const id of list) if (id) next[id] = Math.max(next[id] ?? 0, at);
  cache = next;
  floorCache = at;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    localStorage.setItem(FLOOR_KEY, String(at));
  } catch {
    // private mode / quota
  }
  notify();
}

/** Drops ids the server no longer knows. Once at boot, so the map stops
 *  growing with every deleted thread and each later write stays small. */
export function pruneLastSeen(known: ReadonlySet<string>): void {
  const prev = localSeen();
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
  notify();
}

/** Fires on writes from this window and, through the storage event, others. */
export function subscribeLastSeen(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== KEY && event.key !== FLOOR_KEY) return;
    cache = null;
    floorCache = null;
    merged = null;
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
