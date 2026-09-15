import type { SessionMeta } from "./tcserver/types";

/**
 * The sidebar project card's tree-aware status, as temp-code's ProjectRow
 * derived it. Each root thread lands in exactly one bucket, loudest first:
 * paused (its own or a descendant's), running (live work anywhere in the
 * tree, unless it is waiting on you or needs recovery), waiting, failed
 * (a recoverable failure the tree has not moved past), unread (settled,
 * unseen, not the open thread), else dormant.
 */

export type CardThread = Pick<
  SessionMeta,
  "id" | "title" | "status" | "updatedAt" | "threadType" | "busySince" | "frozenActiveElapsed"
> &
  Partial<
    Pick<
      SessionMeta,
      | "tasks"
      | "activity"
      | "activityKind"
      | "treeHasLiveWork"
      | "treeHasPaused"
      | "treeCanContinue"
      | "treeFrozenActiveElapsed"
    >
  >;

export type ProjectCardStatus<T extends CardThread = CardThread> = {
  paused: T[];
  running: T[];
  unread: T[];
  waiting: number;
  failed: number;
  dormant: number;
  total: number;
  /** Newest activity across the threads; 0 when there are none. */
  latest: number;
};

export function projectCardStatus<T extends CardThread>(
  threads: readonly T[],
  selectedId: string | null,
  lastSeen: Record<string, number>,
  /** Threads with no lastSeen entry count as seen up to this time. */
  floor = 0,
): ProjectCardStatus<T> {
  const paused = threads.filter((t) => t.status === "paused" || !!t.treeHasPaused);
  const isPaused = new Set(paused);
  const running = threads.filter(
    (t) =>
      !isPaused.has(t) &&
      t.status !== "waiting" &&
      !t.treeCanContinue &&
      (t.status === "running" || t.status === "starting" || !!t.treeHasLiveWork),
  );
  const waiting = threads.filter(
    (t) => !isPaused.has(t) && !t.treeCanContinue && t.status === "waiting",
  ).length;
  // Live work outranks a failure the thread already moved past.
  const failed = threads.filter(
    (t) => !isPaused.has(t) && !t.treeHasLiveWork && (t.status === "error" || !!t.treeCanContinue),
  ).length;
  const unread = threads.filter(
    (t) =>
      (t.status === "idle" || t.status === "done") &&
      !t.treeCanContinue &&
      !t.treeHasLiveWork &&
      t.id !== selectedId &&
      t.updatedAt > (lastSeen[t.id] ?? floor),
  );
  return {
    paused,
    running,
    unread,
    waiting,
    failed,
    dormant: threads.length - running.length - paused.length - unread.length - waiting - failed,
    total: threads.length,
    latest: threads.reduce((a, t) => Math.max(a, t.updatedAt), 0),
  };
}

export type BlockedThread<T extends CardThread> = {
  kind: "waiting" | "failed";
  thread: T;
};

/**
 * The threads `projectCardStatus()` only counts (`waiting`, `failed`), as
 * the thread objects themselves — same predicates, so a view that needs to
 * show WHICH thread is blocked never disagrees with the card's tally.
 */
export function blockedThreads<T extends CardThread>(threads: readonly T[]): BlockedThread<T>[] {
  const isPaused = new Set(threads.filter((t) => t.status === "paused" || !!t.treeHasPaused));
  const out: BlockedThread<T>[] = [];
  for (const t of threads) {
    if (isPaused.has(t)) continue;
    if (!t.treeCanContinue && t.status === "waiting") {
      out.push({ kind: "waiting", thread: t });
    } else if (!t.treeHasLiveWork && (t.status === "error" || !!t.treeCanContinue)) {
      out.push({ kind: "failed", thread: t });
    }
  }
  return out;
}

/** The whole-card tooltip: every non-zero state, then the open-tab count. */
export function cardTooltip(status: ProjectCardStatus, archivedCount: number): string {
  return [
    status.running.length > 0 && `${status.running.length} running`,
    status.paused.length > 0 && `${status.paused.length} paused`,
    status.waiting > 0 && `${status.waiting} waiting on you`,
    status.failed > 0 && `${status.failed} failed`,
    status.unread.length > 0 && `${status.unread.length} unread`,
    `${status.total} open ${status.total === 1 ? "tab" : "tabs"}`,
    archivedCount > 0 && `${archivedCount} archived`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The muted tail of the stats line. */
export function quietSummary(status: ProjectCardStatus, archivedCount: number): string {
  if (status.total === 0) return "No tabs";
  return [
    status.dormant > 0 && `${status.dormant} dormant`,
    archivedCount > 0 && `${archivedCount} archived`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Elapsed on a running line: since the working stretch began. */
export function runningElapsed(t: CardThread, now: number): number {
  return Math.max(0, now - (t.busySince ?? t.updatedAt));
}

/** Elapsed on a paused line: frozen at the pause, tree-wide when known. */
export function pausedElapsed(t: CardThread): number {
  return Math.max(0, t.treeFrozenActiveElapsed ?? t.frozenActiveElapsed ?? 0);
}

/** The tally subline, only for the threads whose work IS a task list. */
export function cardTasks(t: CardThread): NonNullable<SessionMeta["tasks"]> | null {
  return t.threadType === "implementation" ? (t.tasks ?? null) : null;
}

export type ProjectRunAction = "resume" | "pause" | null;

/** The menu's one pause/continue row: continue when anything is paused,
 *  pause when anything runs, nothing when the project is quiet. */
export function projectRunAction(status: ProjectCardStatus): ProjectRunAction {
  if (status.paused.length > 0) return "resume";
  if (status.running.length > 0) return "pause";
  return null;
}

/** Threads Stop interrupts: the running ones and the paused ones. */
export function stoppableThreads<T extends CardThread>(status: ProjectCardStatus<T>): T[] {
  return [...status.running, ...status.paused];
}
