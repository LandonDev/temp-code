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

export function isUnread(t: Pick<StripThread, "id" | "updatedAt">, lastSeen: SeenMap): boolean {
  return t.updatedAt > (lastSeen[t.id] ?? 0);
}

/** temp-code's live rule: anything not settled-and-seen. `done` settles
 *  like `idle` (the server's terminal status for a finished run). */
export function isLiveThread(t: StripThread, lastSeen: SeenMap, planReady: ReadyMap): boolean {
  return (
    !!t.draft ||
    (t.status !== "idle" && t.status !== "done") ||
    !!t.treeHasLiveWork ||
    !!t.treeHasPaused ||
    !!t.treeCanContinue ||
    isUnread(t, lastSeen) ||
    !!planReady[t.id]
  );
}

export function splitThreads<T extends StripThread>(
  threads: readonly T[],
  lastSeen: SeenMap,
  planReady: ReadyMap,
): { live: T[]; dormant: T[] } {
  const live: T[] = [];
  const dormant: T[] = [];
  for (const t of [...threads].sort(freshestFirst))
    (isLiveThread(t, lastSeen, planReady) ? live : dormant).push(t);
  return { live, dormant };
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
