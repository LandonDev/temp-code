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
  timer: ReturnType<typeof setTimeout> | null;
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
    entry.timer = setTimeout(() => {
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
  const dom = typeof window !== "undefined";
  if (dom) {
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
  }
  entry.stop = () => {
    release();
    unsubFiles();
    unsubGit();
    if (dom) {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    }
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    entry.stop = null;
  };
  void load(cwd, entry);
}

/** Hold a checkout's snapshot live; the watch closes when the last holder lets go. */
export function holdGitSnapshot(cwd: string): () => void {
  const entry = entryFor(cwd);
  const hold = () => undefined;
  entry.listeners.add(hold);
  start(cwd, entry);
  return () => {
    entry.listeners.delete(hold);
    if (entry.listeners.size === 0) entry.stop?.();
  };
}

export function getGitSnapshot(cwd: string): GitSnapshot {
  return entries.get(cwd)?.snapshot ?? EMPTY;
}

/** The checkout's snapshot; rendering holds its watch open. Null cwd → empty. */
export function useGitSnapshot(cwd: string | null | undefined): GitSnapshot {
  const key = cwd && cwd !== "~" ? cwd : null;
  useEffect(() => (key ? holdGitSnapshot(key) : undefined), [key]);
  return useSyncExternalStore(
    (l) => {
      if (!key) return () => undefined;
      const entry = entryFor(key);
      entry.listeners.add(l);
      return () => {
        entry.listeners.delete(l);
      };
    },
    () => (key ? getGitSnapshot(key) : EMPTY),
    () => EMPTY,
  );
}

/** Test hook: forget every checkout. */
export function resetGitSnapshots(): void {
  for (const entry of entries.values()) entry.stop?.();
  entries.clear();
}
