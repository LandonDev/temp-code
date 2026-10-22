import type { ExplorerMenuItem } from "../../../chrome/ExplorerMenu";
import type { SessionMeta } from "../../../lib/tcserver/types";
import { hasRunningTurn } from "../../../lib/threadBatch";

/**
 * The board's title-bar actions (docs/LAYOUT.md "Master"), pure: which
 * rows each switch reaches, the menu's rows, the archive confirm's copy
 * and which of the project's threads the batch may adopt. The server
 * decides the actual set (`batch.archive`, `batch.adopt`); the counts here
 * are what the person reads before confirming.
 */

export type ArchiveWhich = "done" | "all";

/** The rows Archive done takes: finished, by the batch engine's rule
 *  (done, or idle after a turn); a stopped or errored row stays. */
export function doneRows<T extends { meta: Pick<SessionMeta, "status"> }>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.meta.status === "idle" || r.meta.status === "done");
}

/** The rows Resume all takes. */
export function pausedRows<T extends { meta: Pick<SessionMeta, "status"> }>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.meta.status === "paused");
}

/** The rows Pause all takes: a running turn anywhere in their tree (the
 *  fleet switches' rule, lib/threadBatch.ts). */
export function pausableRows<T extends { meta: SessionMeta }>(rows: readonly T[]): T[] {
  return rows.filter((r) => hasRunningTurn(r.meta));
}

/** The ⋯ menu: the fleet switches for this batch, a row with nothing to act on disabled. */
export function boardMenuItems(counts: { pausable: number; paused: number; done: number; all: number }): ExplorerMenuItem[] {
  return [
    { kind: "item", id: "pause", label: "Pause all", disabled: counts.pausable === 0 },
    { kind: "item", id: "resume", label: "Resume all", disabled: counts.paused === 0 },
    { kind: "sep" },
    { kind: "item", id: "archive-done", label: "Archive done…", disabled: counts.done === 0 },
    { kind: "item", id: "archive-all", label: "Archive all…", disabled: counts.all === 0 },
  ];
}

/** The + menu: a new thread, or one the project already has. */
export function addMenuItems(candidates: number): ExplorerMenuItem[] {
  return [
    { kind: "item", id: "new", label: "New thread…" },
    { kind: "item", id: "adopt", label: "Add existing thread…", disabled: candidates === 0 },
  ];
}

const threads = (n: number) => (n === 1 ? "thread" : "threads");

/** The archive confirm: the live count in the title, what happens in the
 *  body, the resources clause for its checkbox when the host counts any. */
export function archiveCopy(which: ArchiveWhich, count: number, resources: number | null): { title: string; body: string; cleanup: string | null; confirmLabel: string } {
  const title = which === "done" ? `Archive ${count} done ${threads(count)}?` : `Archive all ${count} ${threads(count)}?`;
  const body =
    which === "done"
      ? "They leave the board and stay in the archive list. The master stays."
      : "A running thread is stopped first. Every one leaves the board and stays in the archive list. The master stays.";
  const cleanup =
    resources !== null && resources > 0 ? `and remove their ${resources} ${resources === 1 ? "worktree or simulator" : "worktrees and simulators"}` : null;
  return { title, body, cleanup, confirmLabel: `Archive ${count}` };
}

/** The project's unarchived root threads on the master's host that are in
 *  no batch and are no master themselves, oldest first. */
export function adoptCandidates(
  metas: readonly SessionMeta[],
  master: Pick<SessionMeta, "id" | "environmentId" | "projectId">,
): SessionMeta[] {
  if (!master.projectId) return [];
  return metas
    .filter(
      (m) =>
        m.id !== master.id &&
        m.environmentId === master.environmentId &&
        m.projectId === master.projectId &&
        !m.parentId &&
        !m.archived &&
        !m.masterId &&
        !m.isMaster,
    )
    .sort((a, b) => a.createdAt - b.createdAt);
}
