import { hostOfCwd } from "./tcserver/projects";
import { statFiles } from "./fs";
import { editorPathsEqual } from "./search";

const MAX_PATHS = 64;

type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();
const mtimes = new Map<string, number | null | undefined>();
/** The host a watched path is stat'ed on when the watcher named one. */
const hosts = new Map<string, string>();
let inFlight = false;
let queued: string[] | "all" | null = null;

/** Watch a currently open file. First poll seeds mtime and does not notify.
 *  `host` is where the file lives (a tab from a box thread names the box);
 *  without it the catalog decides from the path. */
export function watchFile(path: string, onChange: Listener, host?: string): () => void {
  let set = listeners.get(path);
  if (!set) {
    set = new Set();
    listeners.set(path, set);
    mtimes.set(path, undefined);
  }
  if (host) hosts.set(path, host);
  set.add(onChange);
  if (typeof document === "undefined" || !document.hidden) {
    void poll([path]);
  }
  return () => {
    set.delete(onChange);
    if (set.size > 0) return;
    listeners.delete(path);
    mtimes.delete(path);
    hosts.delete(path);
  };
}

const hostOf = (path: string): string => hosts.get(path) ?? hostOfCwd(path);

/** Re-stat watched paths now (agent edit / shell / window focus). */
export function nudgeWatchedFiles(paths?: string[]) {
  if (listeners.size === 0) return;
  if (typeof document !== "undefined" && document.hidden) return;
  const watched = watchedPaths(paths);
  if (watched.length > 0) void poll(paths ? watched : "all");
}

/**
 * Reload open editors even when mtime looks unchanged (git restore can
 * rewrite a file in the same second as the last save).
 */
export function invalidateWatchedFiles(paths?: string[]) {
  if (listeners.size === 0) return;
  const watched = watchedPaths(paths);
  for (const path of watched) {
    mtimes.set(path, undefined);
    listeners.get(path)?.forEach((listener) => listener());
  }
  if (
    watched.length > 0 &&
    (typeof document === "undefined" || !document.hidden)
  ) {
    void poll(paths ? watched : "all");
  }
}

function watchedPaths(paths?: string[]): string[] {
  if (!paths) return [...listeners.keys()];
  const watched: string[] = [];
  for (const path of paths) {
    for (const key of listeners.keys()) {
      if (editorPathsEqual(key, path) && !watched.includes(key)) {
        watched.push(key);
      }
    }
  }
  return watched;
}

/** Update the mtime baseline after our own save so we do not reload it. */
export async function syncWatchedMtime(path: string): Promise<void> {
  if (!listeners.has(path)) return;
  try {
    const [stat] = await statFiles(hostOf(path), [path]);
    if (stat && listeners.has(path)) {
      mtimes.set(path, stat.mtimeMs);
    }
  } catch {
    /* next nudge will retry */
  }
}

async function poll(paths: string[] | "all") {
  if (inFlight) {
    if (paths === "all" || queued === "all") {
      queued = "all";
      return;
    }
    const next = queued == null ? [...paths] : [...queued, ...paths];
    queued = [...new Set(next)];
    return;
  }

  const list =
    paths === "all" ? [...listeners.keys()] : paths.filter((path) => listeners.has(path));
  if (list.length === 0) return;

  inFlight = true;
  try {
    // Each host stats its own files.
    const byHost = new Map<string, string[]>();
    for (const path of list) {
      const host = hostOf(path);
      byHost.set(host, [...(byHost.get(host) ?? []), path]);
    }
    const batches: [string, string[]][] = [];
    for (const [host, paths] of byHost) {
      for (let i = 0; i < paths.length; i += MAX_PATHS) batches.push([host, paths.slice(i, i + MAX_PATHS)]);
    }
    for (const [host, batch] of batches) {
      const stats = await statFiles(host, batch);
      for (const stat of stats) {
        if (!listeners.has(stat.path)) continue;
        const previous = mtimes.get(stat.path);
        mtimes.set(stat.path, stat.mtimeMs);
        // First observation is the baseline so opening a tab does not re-read.
        if (previous === undefined || previous === stat.mtimeMs) continue;
        listeners.get(stat.path)?.forEach((listener) => listener());
      }
    }
  } catch {
    /* next nudge will retry */
  } finally {
    inFlight = false;
    const next = queued;
    queued = null;
    if (next) void poll(next === "all" ? "all" : next);
  }
}

if (typeof document !== "undefined") {
  window.addEventListener("focus", () => {
    if (!document.hidden) nudgeWatchedFiles();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) nudgeWatchedFiles();
  });
}
