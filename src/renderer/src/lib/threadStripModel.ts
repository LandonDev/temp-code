import type { SessionMeta, SessionStatus } from "./tcserver/types";

/**
 * temp-code's thread strip rules, as pure functions over server metas.
 * The strip shows the selected project's root threads — every one of them,
 * open in a tab or not — and never a loose chat. Live chips (working,
 * paused, recoverable, needs-you, unread, plan-ready) hold the top row,
 * the rest settle on the shelf; each row is freshest activity first.
 * Being open or selected earns nothing, and a blank thread is not forced
 * live: once looked at it goes to the shelf like any other.
 */

export type StripThread = Pick<
  SessionMeta,
  "id" | "status" | "updatedAt" | "projectId" | "parentId" | "archived"
> &
  Partial<
    Pick<SessionMeta, "treeHasLiveWork" | "treeHasPaused" | "treeCanContinue">
  > & {
    /** Minted locally, not on the server yet; always live. */
    draft?: boolean;
  };

export type SeenMap = Record<string, number>;
export type ReadyMap = Record<string, boolean>;

/** Root, unarchived threads of `projectId`, freshest first. No project → nothing:
 *  loose chats never sit on the strip. */
export function projectRootThreads<T extends StripThread>(
  threads: readonly T[],
  projectId: string | null,
): T[] {
  if (!projectId) return [];
  return threads
    .filter((t) => t.projectId === projectId && !t.parentId && !t.archived)
    .sort(freshestFirst);
}

/** Archived roots of `projectId`, freshest first, for the shelf. */
export function archivedRootThreads<T extends StripThread>(
  threads: readonly T[],
  projectId: string | null,
): T[] {
  if (!projectId) return [];
  return threads
    .filter((t) => t.projectId === projectId && !t.parentId && t.archived)
    .sort(freshestFirst);
}

/** `floor`: threads with no lastSeen entry count as seen up to this time. */
export function isUnread(
  t: Pick<StripThread, "id" | "updatedAt">,
  lastSeen: SeenMap,
  floor = 0,
): boolean {
  return t.updatedAt > (lastSeen[t.id] ?? floor);
}

/** temp-code's live rule: anything not settled-and-seen. `done` settles
 *  like `idle` (the server's terminal status for a finished run). */
/** What the live rule reads; every StripThread and ThreadRow has it. */
export type LiveInput = Pick<StripThread, "id" | "status" | "updatedAt"> &
  Partial<Pick<StripThread, "treeHasLiveWork" | "treeHasPaused" | "treeCanContinue" | "draft">>;

export function isLiveThread(
  t: LiveInput,
  lastSeen: SeenMap,
  planReady: ReadyMap,
  floor = 0,
): boolean {
  return (
    !!t.draft ||
    (t.status !== "idle" && t.status !== "done") ||
    !!t.treeHasLiveWork ||
    !!t.treeHasPaused ||
    !!t.treeCanContinue ||
    isUnread(t, lastSeen, floor) ||
    !!planReady[t.id]
  );
}

export function splitThreads<T extends StripThread>(
  threads: readonly T[],
  lastSeen: SeenMap,
  planReady: ReadyMap,
  floor = 0,
): { live: T[]; dormant: T[] } {
  const live: T[] = [];
  const dormant: T[] = [];
  for (const t of [...threads].sort(freshestFirst))
    (isLiveThread(t, lastSeen, planReady, floor) ? live : dormant).push(t);
  return { live, dormant };
}

/** The roots "Archive dormant threads" takes: settled, seen, nothing live
 *  or paused or recoverable in the tree, not pinned, and not a planning
 *  thread holding a plan (its readiness is polled elsewhere, so it is
 *  spared rather than guessed at). Working, needs-you, unread and pinned
 *  roots are never touched. */
export function dormantThreads<
  T extends LiveInput & Partial<Pick<SessionMeta, "pinned" | "threadType" | "planPath">>,
>(
  threads: readonly T[],
  lastSeen: SeenMap,
  floor = 0,
  exclude: ReadonlySet<string> = NONE,
): T[] {
  return threads.filter(
    (t) =>
      !exclude.has(t.id) &&
      !t.pinned &&
      !(t.threadType === "planning" && t.planPath) &&
      !isLiveThread(t, lastSeen, {}, floor),
  );
}

const NONE: ReadonlySet<string> = new Set();

/** The focused session's whole thread — its root and every descendant —
 *  which "Archive dormant threads" spares: the thread on screen is in use
 *  however settled it looks. Empty when nothing is focused. */
export function focusedTree(
  metas: readonly Pick<SessionMeta, "id" | "parentId">[],
  focusedId: string | null | undefined,
): Set<string> {
  const tree = new Set<string>();
  if (!focusedId) return tree;
  const byId = new Map(metas.map((m) => [m.id, m]));
  let root = byId.get(focusedId);
  while (root?.parentId && byId.has(root.parentId)) root = byId.get(root.parentId);
  tree.add(root?.id ?? focusedId);
  for (let grew = true; grew; ) {
    grew = false;
    for (const m of metas)
      if (m.parentId && tree.has(m.parentId) && !tree.has(m.id)) {
        tree.add(m.id);
        grew = true;
      }
  }
  return tree;
}

/** What the chip wears: a paused descendant reads as paused, a recoverable
 *  failure anywhere in the tree as failed, otherwise the root's own status. */
export function displayStatus(
  t: Pick<StripThread, "status" | "treeHasPaused" | "treeCanContinue">,
): SessionStatus {
  if (t.treeHasPaused) return "paused";
  if (t.treeCanContinue) return "error";
  return t.status;
}

export type ChipTone = "warning" | "danger" | "info" | null;

/** The chip's wash, one glance apart: amber when it needs you or is paused,
 *  red when it failed, blue when finished unseen, nothing otherwise. */
export function chipTone(status: SessionStatus, unread: boolean): ChipTone {
  if (status === "waiting" || status === "paused") return "warning";
  if (status === "error") return "danger";
  if ((status === "idle" || status === "done") && unread) return "info";
  return null;
}

/** Roots with live work anywhere in their tree — what Pause All pauses. */
export function runningRoots<T extends StripThread>(threads: readonly T[]): T[] {
  return threads.filter((t) => !t.parentId && !t.archived && !!t.treeHasLiveWork);
}

function freshestFirst(a: StripThread, b: StripThread): number {
  return b.updatedAt - a.updatedAt;
}
