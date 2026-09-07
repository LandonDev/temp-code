import { useEffect, useSyncExternalStore } from "react";
import {
  gitDiffIndex,
  gitLog,
  subscribeGitChanged,
  type GitDiffIndex,
  type GitLogEntry,
} from "./fs";
import { onFileEvent, watchCwd } from "./projectWatch";

/**
 * One git snapshot per checkout — the diff index (branch, staged and
 * unstaged files with their +/−) and the recent log — shared by the rail's
 * Changes tab and the file tabs' counts. Refreshed by the server's tree
 * watcher (a file event under the checkout, debounced), by local git
 * mutations (`notifyGitChanged`), and on window focus for commits made
 * elsewhere. No polling timer.
 */

export interface GitSnapshot {
  index: GitDiffIndex | null;
  log: GitLogEntry[] | null;
}

const LOG_LIMIT = 8;
const DEBOUNCE_MS = 200;
const EMPTY: GitSnapshot = { index: null, log: null };

interface Entry {
  snapshot: GitSnapshot;
  listeners: Set<() => void>;
  inFlight: boolean;
  pending: boolean;
  timer: number | null;
  stop: (() => void) | null;
}

const entries = new Map<string, Entry>();

function entryFor(cwd: string): Entry {
  let entry = entries.get(cwd);
  if (!entry) {
    entry = { snapshot: EMPTY, listeners: new Set(), inFlight: false, pending: false, timer: null, stop: null };
    entries.set(cwd, entry);
  }
  return entry;
}

function publish(entry: Entry, snapshot: GitSnapshot): void {
  entry.snapshot = snapshot;
  for (const l of entry.listeners) l();
}

async function load(cwd: string, entry: Entry): Promise<void> {
  if (entry.inFlight) {
    entry.pending = true;
    return;
  }
  entry.inFlight = true;
  try {
    const [index, log] = await Promise.all([
      gitDiffIndex(cwd),
      gitLog(cwd, LOG_LIMIT).catch(() => [] as GitLogEntry[]),
    ]);
    publish(entry, { index, log });
  } catch {
    publish(entry, { index: null, log: null });
  } finally {
    entry.inFlight = false;
    if (entry.pending) {
      entry.pending = false;
      void load(cwd, entry);
    }
  }
}

/** Reload now (after a local mutation). Resolves once the snapshot is in. */
export function refreshGitSnapshot(cwd: string): Promise<void> {
  return load(cwd, entryFor(cwd));
}

function start(cwd: string, entry: Entry): void {
  if (entry.stop) return;
  const schedule = () => {
    if (entry.timer !== null) return;
    entry.timer = window.setTimeout(() => {
      entry.timer = null;
      void load(cwd, entry);
    }, DEBOUNCE_MS);
  };
  const prefix = `${cwd}/`;
  const release = watchCwd(cwd);
  const unsubFiles = onFileEvent((e) => {
    if (e.path === cwd || e.path.startsWith(prefix)) schedule();
  });
  const unsubGit = subscribeGitChanged(schedule);
  const onFocus = () => {
    if (!document.hidden) schedule();
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);
  entry.stop = () => {
    release();
    unsubFiles();
    unsubGit();
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onFocus);
    if (entry.timer !== null) window.clearTimeout(entry.timer);
    entry.timer = null;
    entry.stop = null;
  };
  void load(cwd, entry);
}

/** The checkout's snapshot; subscribing holds its watch open. Null cwd → empty. */
export function useGitSnapshot(cwd: string | null | undefined): GitSnapshot {
  const key = cwd && cwd !== "~" ? cwd : null;
  useEffect(() => {
    if (!key) return;
    const entry = entryFor(key);
    const l = () => undefined;
    entry.listeners.add(l);
    start(key, entry);
    return () => {
      entry.listeners.delete(l);
      if (entry.listeners.size === 0) entry.stop?.();
    };
  }, [key]);
  return useSyncExternalStore(
    (l) => {
      if (!key) return () => undefined;
      const entry = entryFor(key);
      entry.listeners.add(l);
      return () => {
        entry.listeners.delete(l);
      };
    },
    () => (key ? entryFor(key).snapshot : EMPTY),
    () => EMPTY,
  );
}

/** Test hook. */
export function resetGitSnapshots(): void {
  for (const entry of entries.values()) entry.stop?.();
  entries.clear();
}
