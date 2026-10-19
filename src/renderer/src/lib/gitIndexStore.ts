import { hostOfCwd } from "./tcserver/projects";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  gitDiffIndex,
  gitLog,
  subscribeGitChanged,
  type GitDiffIndex,
  type GitDiffStats,
  type GitLogEntry,
} from "./fs";
import { invalidateWatchedFiles } from "./fileWatch";
import { onFileEvent, watchCwd } from "./projectWatch";

/**
 * One git snapshot per checkout — the diff index (branch, staged and
 * unstaged files with their +/−) and the recent log — shared by every git
 * UI: the rail's Changes tab, the diff pane, the title-bar and rail counts,
 * the file tree's status colours and the file tabs' counts. Every consumer
 * reads the same in-flight `git.diffIndex`, so a burst of tool results
 * costs one index call per checkout, not one per widget. Refreshed by the
 * server's tree watcher (a file event under the checkout, debounced), by
 * local git mutations (`notifyGitChanged`, debounced), and on window focus
 * for commits made elsewhere. No polling timer. A hidden window defers the
 * refresh to the next focus.
 */

export interface GitSnapshot {
  index: GitDiffIndex | null;
  log: GitLogEntry[] | null;
}

const LOG_LIMIT = 8;
const DEBOUNCE_MS = 250;
const EMPTY: GitSnapshot = { index: null, log: null };

interface Entry {
  snapshot: GitSnapshot;
  listeners: Set<() => void>;
  /** holders that read the log too (the Changes tab); others only the index */
  logHolds: number;
  inFlight: boolean;
  pending: boolean;
  /** a refresh was due while the window was hidden */
  stale: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  stop: (() => void) | null;
}

const entries = new Map<string, Entry>();

function entryFor(cwd: string): Entry {
  let entry = entries.get(cwd);
  if (!entry) {
    entry = {
      snapshot: EMPTY,
      listeners: new Set(),
      logHolds: 0,
      inFlight: false,
      pending: false,
      stale: false,
      timer: null,
      stop: null,
    };
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
  entry.stale = false;
  try {
    const host = hostOfCwd(cwd);
    const index = await gitDiffIndex(host, cwd);
    // Decided after the index lands, so a log reader that mounts mid-load
    // is served by this load instead of a second index call.
    const log =
      entry.logHolds > 0
        ? await gitLog(host, cwd, LOG_LIMIT).catch(() => [] as GitLogEntry[])
        : entry.snapshot.log;
    const prev = entry.snapshot.index;
    if (prev && sameIndex(prev, index)) {
      if (log !== entry.snapshot.log) publish(entry, { index: prev, log });
    } else {
      publish(entry, { index, log });
      // Files whose git state moved may have moved on disk too (a checkout,
      // a stash, a revert): re-stat the open ones.
      if (prev) invalidateWatchedFiles(changedFilePaths(prev, index));
    }
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
  const dom = typeof window !== "undefined";
  const hidden = () => dom && document.hidden;
  const schedule = () => {
    if (hidden()) {
      entry.stale = true;
      return;
    }
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
  const unsubGit = subscribeGitChanged(schedule, cwd);
  const onFocus = () => {
    if (!hidden()) schedule();
  };
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
export function holdGitSnapshot(cwd: string, opts: { log?: boolean } = {}): () => void {
  const entry = entryFor(cwd);
  const hold = () => undefined;
  entry.listeners.add(hold);
  const withLog = opts.log === true;
  if (withLog) {
    entry.logHolds += 1;
    // The first log reader on a checkout already indexed fetches the log
    // (a load in flight picks it up itself).
    if (entry.logHolds === 1 && entry.stop && !entry.inFlight && entry.snapshot.log === null) {
      void load(cwd, entry);
    }
  }
  start(cwd, entry);
  return () => {
    if (!entry.listeners.delete(hold)) return;
    if (withLog) entry.logHolds -= 1;
    if (entry.listeners.size === 0) entry.stop?.();
  };
}

export function getGitSnapshot(cwd: string): GitSnapshot {
  return entries.get(cwd)?.snapshot ?? EMPTY;
}

/** Is any git UI on screen showing this checkout? */
export function isGitSnapshotHeld(cwd: string): boolean {
  return (entries.get(cwd)?.listeners.size ?? 0) > 0;
}

/** Stats the badges show, derived from the index — never a second git call. */
export function statsOf(index: GitDiffIndex | null): GitDiffStats | null {
  return index
    ? { files: index.files.length, additions: index.additions, deletions: index.deletions }
    : null;
}

function useHeld(key: string | null, log: boolean): GitSnapshot {
  useEffect(() => (key ? holdGitSnapshot(key, { log }) : undefined), [key, log]);
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

const keyOf = (cwd: string | null | undefined, enabled: boolean): string | null =>
  enabled && cwd && cwd !== "~" ? cwd : null;

/** The checkout's index and log; rendering holds its watch open. Null cwd → empty. */
export function useGitSnapshot(cwd: string | null | undefined): GitSnapshot {
  return useHeld(keyOf(cwd, true), true);
}

/** The checkout's index alone (no log fetch). Disabled → null, and no watch. */
export function useGitIndex(cwd: string | null | undefined, enabled = true): GitDiffIndex | null {
  return useHeld(keyOf(cwd, enabled), false).index;
}

/** +/− and file count for the badges, from the shared index. */
export function useGitDiffStats(cwd: string | null | undefined, enabled = true): GitDiffStats | null {
  const index = useGitIndex(cwd, enabled);
  return useMemo(() => statsOf(index), [index]);
}

export function sameIndex(prev: GitDiffIndex, next: GitDiffIndex): boolean {
  if (
    prev.branch !== next.branch ||
    prev.additions !== next.additions ||
    prev.deletions !== next.deletions ||
    prev.files.length !== next.files.length ||
    prev.remote !== next.remote ||
    prev.upstream !== next.upstream ||
    prev.defaultBranch !== next.defaultBranch ||
    prev.ahead !== next.ahead ||
    prev.behind !== next.behind ||
    prev.aheadOfDefault !== next.aheadOfDefault
  ) {
    return false;
  }
  return prev.files.every((file, i) => {
    const other = next.files[i];
    return (
      other &&
      file.relative === other.relative &&
      file.status === other.status &&
      file.additions === other.additions &&
      file.deletions === other.deletions &&
      file.staged === other.staged &&
      file.unstaged === other.unstaged
    );
  });
}

/** Absolute paths whose git state differs between two indexes. */
export function changedFilePaths(prev: GitDiffIndex, next: GitDiffIndex): string[] {
  const paths: string[] = [];
  const previous = new Map(prev.files.map((file) => [file.relative, file]));
  const current = new Set(next.files.map((file) => file.relative));
  for (const file of next.files) {
    const before = previous.get(file.relative);
    if (
      !before ||
      before.status !== file.status ||
      before.additions !== file.additions ||
      before.deletions !== file.deletions ||
      before.staged !== file.staged ||
      before.unstaged !== file.unstaged
    ) {
      paths.push(file.path);
    }
  }
  for (const file of prev.files) {
    if (!current.has(file.relative)) paths.push(file.path);
  }
  return paths;
}

/** Test hook: forget every checkout. */
export function resetGitSnapshots(): void {
  for (const entry of entries.values()) entry.stop?.();
  entries.clear();
}
