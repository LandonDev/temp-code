import { rowState } from "./sidebarRows";
import type { SessionMeta } from "./tcserver/types";
import { housedIds } from "./workspaceSessions";

/** The rail's Working section shows only with this many rows: with one, the
 *  workspace row's line under it already names the thread. */
export const WORKING_MIN = 2;
/** Rows shown before "N more". */
export const WORKING_CAP = 4;

export type WorkingState = "waiting" | "working" | "done";

export type WorkingRow = { id: string; state: WorkingState; meta: SessionMeta };

const RANK: Record<WorkingState, number> = { waiting: 0, working: 1, done: 2 };

/**
 * The rail's Working section, as rows: every root thread on every host the
 * window knows that needs the person, runs a turn, or finished while the
 * window looked elsewhere and has not been looked at (`unseenDone`, the
 * live agent tracker's). Archived threads stay out, and so does any thread
 * housed in a master's batch: its master stands for it. Needs you first,
 * then working by when the turn began, oldest first, then done.
 */
export function workingRows(
  metas: readonly SessionMeta[],
  unseenDone: ReadonlySet<string>,
  housed: ReadonlySet<string> = housedIds(metas),
): WorkingRow[] {
  const rows: WorkingRow[] = [];
  for (const meta of metas) {
    if (meta.parentId || meta.archived || housed.has(meta.id)) continue;
    const state = rowState(meta);
    if (state === "waiting" || state === "working") rows.push({ id: meta.id, state, meta });
    else if (unseenDone.has(meta.id) && (meta.status === "idle" || meta.status === "done")) rows.push({ id: meta.id, state: "done", meta });
  }
  return rows.sort(
    (a, b) =>
      RANK[a.state] - RANK[b.state] ||
      (a.state === "working" ? (a.meta.busySince ?? Infinity) - (b.meta.busySince ?? Infinity) : b.meta.updatedAt - a.meta.updatedAt),
  );
}
