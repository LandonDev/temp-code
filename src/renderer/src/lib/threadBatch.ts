import { useSyncExternalStore } from "react";
import type { SessionBatchResult } from "@server/shared/contract";
import type { Catalog } from "./projectContext";
import { workspacePathOfSession } from "./projectContext";
import { sameProjectPath } from "./recents";
import { registry } from "./connection/registry";
import * as serverCommands from "./tcserver/commands";
import { sessionStore } from "./tcserver/store";
import type { SessionMeta } from "./tcserver/types";

/**
 * The fleet switches: one action over every qualifying thread of a
 * project, a host, or everywhere. The menus call `requestThreadBatch`;
 * what qualifies is `batchTargets`, what the confirm says is
 * `batchConfirm`, and each run leaves one notice for the toast. Subagents follow
 * their parent: only roots are selected, and the server acts on trees.
 */

export type BatchAction = "pause" | "resume" | "stop" | "archiveDone";

export const BATCH_ACTIONS: readonly BatchAction[] = ["pause", "resume", "stop", "archiveDone"];

export type BatchScope =
  | { kind: "all" }
  /** `paths`: a workspace linked across hosts names every copy's folder. */
  | { kind: "project"; path: string; paths?: readonly string[]; name: string }
  | { kind: "host"; environmentId: string; name: string };

/** Idle for at least this long before Archive done takes a thread. */
export const ARCHIVE_DONE_AGE_MS = 10 * 60_000;

// A queued thread (created, not booted; CLAUDE.md "Master threads") is not
// live: Pause and Resume leave it. Stop takes it as "remove from the queue"
// and Archive done takes it too (it holds no turn); the server archives it
// on both.
const LIVE = new Set<string>(["starting", "running", "waiting"]);

export const isQueued = (t: SessionMeta): boolean => t.status === "queued";

/** A thread with a turn in flight somewhere in its tree, not paused. The
 *  master board's rows and its Pause all read the same rule. */
export function hasRunningTurn(t: SessionMeta): boolean {
  if (t.status === "paused") return false;
  return LIVE.has(t.status) || !!t.treeHasLiveWork;
}

/** Paused anywhere in the tree, or stopped by a restart (the status a
 *  later build adds; compared as text so this file needs nothing of it). */
function isPausedOrStopped(t: SessionMeta): boolean {
  return t.status === "paused" || !!t.treeHasPaused || t.status === "stopped";
}

export type BatchSelection = {
  catalog: Catalog;
  lastSeen: Record<string, number>;
  /** Threads with no lastSeen entry count as seen up to this time. */
  floor?: number;
  now?: number;
  scope: BatchScope;
};

function inScope(t: SessionMeta, scope: BatchScope, catalog: Catalog): boolean {
  switch (scope.kind) {
    case "all":
      return true;
    case "host":
      return t.environmentId === scope.environmentId;
    case "project": {
      const home = workspacePathOfSession(t, catalog);
      return (scope.paths ?? [scope.path]).some((p) => sameProjectPath(home, p));
    }
  }
}

/** Does one root qualify for the action, scope aside. */
export function qualifies(
  action: BatchAction,
  t: SessionMeta,
  lastSeen: Record<string, number>,
  floor = 0,
  now = Date.now(),
): boolean {
  switch (action) {
    case "pause":
      return hasRunningTurn(t);
    case "stop":
      return hasRunningTurn(t) || isQueued(t);
    case "resume":
      return isPausedOrStopped(t);
    case "archiveDone":
      if (isQueued(t)) return true;
      return (
        (t.status === "idle" || t.status === "done") &&
        !t.treeHasLiveWork &&
        !t.treeHasPaused &&
        !t.treeCanContinue &&
        !t.canContinue &&
        t.updatedAt <= (lastSeen[t.id] ?? floor) &&
        now - t.updatedAt >= ARCHIVE_DONE_AGE_MS
      );
  }
}

/** The roots the action would touch right now, in the store's order. */
export function batchTargets(
  action: BatchAction,
  metas: readonly SessionMeta[],
  sel: BatchSelection,
): SessionMeta[] {
  const now = sel.now ?? Date.now();
  const floor = sel.floor ?? 0;
  return metas.filter(
    (t) =>
      !t.parentId &&
      !t.archived &&
      inScope(t, sel.scope, sel.catalog) &&
      qualifies(action, t, sel.lastSeen, floor, now),
  );
}

// ── copy ───────────────────────────────────────────────────────────────

/** The menu item's label for an action. */
export const BATCH_LABEL: Record<BatchAction, string> = {
  pause: "Pause all",
  resume: "Resume all",
  stop: "Stop all",
  archiveDone: "Archive done",
};

/** Resume needs no confirm: nothing is lost by resuming. */
export function needsConfirm(action: BatchAction): boolean {
  return action !== "resume";
}

export type BatchFailure = { sessionId: string; environmentId: string; title: string; error: string };

// ── the pending confirm and the notices ──────────────────────────────

export type BatchRequest = { action: BatchAction; scope: BatchScope };

export type BatchNotice = { key: number; action: BatchAction; succeeded: number; failed: BatchFailure[] };

type State = { pending: BatchRequest | null; notices: readonly BatchNotice[] };
let state: State = { pending: null, notices: [] };
const listeners = new Set<() => void>();
let nextKey = 1;

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useBatchPending(): BatchRequest | null {
  return useSyncExternalStore(subscribe, () => state.pending);
}

export function useBatchNotices(): readonly BatchNotice[] {
  return useSyncExternalStore(subscribe, () => state.notices);
}

export function dismissBatchNotice(key: number): void {
  set({ notices: state.notices.filter((n) => n.key !== key) });
}

export function cancelThreadBatch(): void {
  set({ pending: null });
}

/**
 * What releases an archived thread's worktree and devices: set by the
 * build that has one (thread resources), null until then. `count` says
 * how many of the given threads hold something, for the confirm's clause.
 */
export type ResourceCleanup = { count(sessionIds: readonly string[]): number };
let resourceCleanup: ResourceCleanup | null = null;
export function setResourceCleanup(next: ResourceCleanup | null): void {
  resourceCleanup = next;
}
export function resourcesHeldBy(sessionIds: readonly string[]): number | null {
  return resourceCleanup ? resourceCleanup.count(sessionIds) : null;
}

/** A menu picked an action: resume runs at once, the rest wait for the confirm. */
export function requestThreadBatch(action: BatchAction, scope: BatchScope, sel: () => BatchSelection): Promise<void> {
  if (!needsConfirm(action)) return runThreadBatch(action, sel());
  set({ pending: { action, scope } });
  return Promise.resolve();
}

/** The confirm's OK: runs the pending request on what qualifies now. */
export async function confirmThreadBatch(sel: BatchSelection, options: { cleanup?: boolean } = {}): Promise<void> {
  const pending = state.pending;
  if (!pending) return;
  set({ pending: null });
  await runThreadBatch(pending.action, sel, options);
}

const SERVER_ACTION: Record<BatchAction, serverCommands.SessionBatchAction> = {
  pause: "pause",
  resume: "resume",
  stop: "stop",
  archiveDone: "archive",
};

/**
 * Run the action on every qualifying root: one `session.batch` per host,
 * the hosts in parallel, the threads four at a time on each. The result
 * lands as one notice the toasts read; a thread that failed is named.
 */
export async function runThreadBatch(
  action: BatchAction,
  sel: BatchSelection,
  options: { cleanup?: boolean } = {},
): Promise<void> {
  const targets = batchTargets(action, sessionStore.metas(), sel).filter((t) => !sessionStore.isDraft(t.id));
  const byHost = new Map<string, SessionMeta[]>();
  for (const t of targets) {
    const list = byHost.get(t.environmentId);
    if (list) list.push(t);
    else byHost.set(t.environmentId, [t]);
  }
  const titleOf = (id: string) => sessionStore.metaOf(id)?.title ?? sessionStore.get(id)?.title ?? id;
  let succeeded = 0;
  const failed: BatchFailure[] = [];
  await Promise.all(
    [...byHost].map(async ([environmentId, list]) => {
      const ids = list.map((t) => t.id);
      let result: SessionBatchResult;
      try {
        result = await serverCommands.sessionBatch(environmentId, SERVER_ACTION[action], ids, options);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        for (const id of ids) failed.push({ sessionId: id, environmentId, title: titleOf(id), error });
        return;
      }
      succeeded += result.succeeded.length;
      for (const f of result.failed) failed.push({ sessionId: f.sessionId, environmentId, title: titleOf(f.sessionId), error: f.error });
    }),
  );
  set({ notices: [...state.notices, { key: nextKey++, action, succeeded, failed: [...failed] }] });
}

/** The host's display name for a scope, as the registry knows it. */
export function hostScope(environmentId: string): BatchScope {
  return { kind: "host", environmentId, name: registry.environment(environmentId)?.name ?? environmentId };
}

/** Test seam. */
export function resetThreadBatchForTests(): void {
  state = { pending: null, notices: [] };
  resourceCleanup = null;
  nextKey = 1;
}
