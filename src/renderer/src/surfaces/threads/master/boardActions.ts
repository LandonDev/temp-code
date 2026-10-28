import { Archive, ListPlus, MessageSquarePlus, Pause, Play } from "../../../chrome/icons";
import type { MenuRow } from "../../../chrome/menuRows";
import type { EnvironmentStatus } from "../../../lib/connection/types";
import { pairWorkspaces, partnersOf } from "../../../lib/projectPairs";
import type { BatchState } from "@server/shared/contract-batch";
import type { ProjectMeta, SessionMeta } from "../../../lib/tcserver/types";
import { hasRunningTurn } from "../../../lib/threadBatch";

/**
 * The board's title-bar actions (docs/LAYOUT.md "Master"), pure: which
 * rows each switch reaches on every host, the menu's rows, the archive
 * confirm's copy, how an archive is split between the master's host and
 * the others, which hosts the add sheet offers and which of the project's
 * threads, on any host, the batch may adopt. The server decides the actual
 * set (`batch.archive`, `batch.adopt`); the counts here are what the
 * person reads before confirming.
 */

export type ArchiveWhich = "done" | "all";

/** What the host says of its batch that Archive done reads. */
export type BatchDone = Pick<BatchState, "done" | "blocked">;

/** Is this id (bare on the master's host, `<env>:<id>` on another) the row's? */
const names = (id: string, meta: Pick<SessionMeta, "id" | "environmentId">): boolean => id === meta.id || id === `${meta.environmentId}:${meta.id}`;

/** The rows Archive done takes: the ones the host counts done
 *  (`BatchState.done`, batch.ts's rule: done, or idle on a completed turn
 *  with no failure). An older host sends no list: then done or idle, less
 *  the child the batch's `blocked` names (one idle on a turn it never
 *  completed). A stopped or errored row stays either way. */
export function doneRows<T extends { meta: Pick<SessionMeta, "id" | "environmentId" | "status"> }>(rows: readonly T[], batch?: BatchDone | null): T[] {
  const listed = batch?.done;
  if (listed) return rows.filter((r) => listed.some((id) => names(id, r.meta)));
  const blocked = batch?.blocked?.sessionId;
  return rows.filter((r) => (r.meta.status === "idle" || r.meta.status === "done") && !(blocked && names(blocked, r.meta)));
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
export function boardMenuItems(counts: { pausable: number; paused: number; done: number; all: number }): MenuRow[] {
  return [
    { kind: "item", id: "pause", label: "Pause all", icon: Pause, disabled: counts.pausable === 0 },
    { kind: "item", id: "resume", label: "Resume all", icon: Play, disabled: counts.paused === 0 },
    { kind: "sep" },
    { kind: "item", id: "archive-done", label: "Archive done…", icon: Archive, disabled: counts.done === 0 },
    { kind: "item", id: "archive-all", label: "Archive all…", icon: Archive, disabled: counts.all === 0 },
  ];
}

/** The + menu: a new thread, or one the project already has. */
export function addMenuItems(candidates: number): MenuRow[] {
  return [
    { kind: "item", id: "new", label: "New thread…", icon: MessageSquarePlus },
    { kind: "item", id: "adopt", label: "Add existing thread…", icon: ListPlus, disabled: candidates === 0 },
  ];
}

const threads = (n: number) => (n === 1 ? "thread" : "threads");

/** The archive confirm: the live count in the title, what happens in the
 *  body, the resources clause for its checkbox when the host counts any. */
export function archiveCopy(which: ArchiveWhich, count: number, resources: number | null): { title: string; body: string; cleanup: string | null; confirmLabel: string } {
  const title = which === "done" ? `Archive ${count} done ${threads(count)}?` : `Archive all ${count} ${threads(count)}?`;
  const body =
    which === "done"
      ? "The master stays."
      : "Running threads stop first; the master stays.";
  const cleanup =
    resources !== null && resources > 0 ? `and remove their ${resources} ${resources === 1 ? "worktree or simulator" : "worktrees and simulators"}` : null;
  return { title, body, cleanup, confirmLabel: `Archive ${count}` };
}

/**
 * The project's unarchived root threads, on any host, that are in no batch
 * and are no master themselves, oldest first. On another host the project
 * is its paired copy (`pairedProjectIds`: the same repo, else the same
 * folder name, lib/projectPairs.ts), so a thread there has that copy's id.
 */
export function adoptCandidates(
  metas: readonly SessionMeta[],
  master: Pick<SessionMeta, "id" | "environmentId" | "projectId">,
  pairedProjectIds: ReadonlySet<string> = new Set(),
): SessionMeta[] {
  if (!master.projectId) return [];
  const projectIds = new Set([master.projectId, ...pairedProjectIds]);
  return metas
    .filter(
      (m) =>
        m.id !== master.id &&
        !!m.projectId &&
        projectIds.has(m.projectId) &&
        !m.parentId &&
        !m.archived &&
        !m.masterId &&
        !m.isMaster,
    )
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** The ids of the project's copies on the other hosts: the same GitHub
 *  repo, else the same folder name (lib/projectPairs.ts), the seam the add
 *  sheet's host choices use too. */
export function pairedProjectIds(
  master: Pick<SessionMeta, "environmentId" | "cwd">,
  workspaces: Parameters<typeof pairWorkspaces>[0],
  projects: readonly Pick<ProjectMeta, "id" | "environmentId" | "cwd">[],
): Set<string> {
  const strip = (path: string) => path.replace(/\/+$/, "");
  const partners = partnersOf(pairWorkspaces(workspaces), master.environmentId, master.cwd);
  const ids = new Set<string>();
  for (const partner of partners) {
    const project = projects.find((p) => p.environmentId === partner.environmentId && strip(p.cwd) === strip(partner.cwd));
    if (project) ids.add(project.id);
  }
  return ids;
}

/** The id a thread of another host goes by on the master's host: the
 *  `<envId>:<sessionId>` form every cross-host supervision tool routes by
 *  (CLAUDE.md "Threads on the Mac from the box"); a thread at home keeps
 *  its own id. */
export function batchThreadId(meta: Pick<SessionMeta, "id" | "environmentId">, master: Pick<SessionMeta, "environmentId">): string {
  return meta.environmentId === master.environmentId ? meta.id : `${meta.environmentId}:${meta.id}`;
}

/** The hosts the add sheet may start a child on: the master's own, and
 *  every other saved host whose link is open, the master's first; `web`
 *  (the browser's own slot) never. */
export function linkedHosts<T extends { id: string; name: string }>(
  environments: readonly T[],
  statusOf: (id: string) => Pick<EnvironmentStatus, "transport"> | undefined,
  master: Pick<SessionMeta, "environmentId">,
): T[] {
  return environments
    .filter((e) => e.id !== "web" && (e.id === master.environmentId || statusOf(e.id)?.transport === "open"))
    .sort((a, b) => (a.id === master.environmentId ? -1 : b.id === master.environmentId ? 1 : 0));
}

/**
 * How an archive reaches every host. The master's host runs `batch.archive`
 * (the batch's own rule: done = done or idle after a turn, all = every
 * one, live ones stopped first), and answers which ids it archived. Each
 * other host then takes, through its own `session.batch`, the rows of
 * that host the answer did not cover: the live ones stopped first under
 * `all`, then the archive. Once the master's host archives across hosts
 * itself, its answer covers them and the fallback has nothing to do.
 */
export function remoteArchivePlan<T extends { meta: Pick<SessionMeta, "id" | "environmentId" | "status"> & SessionMeta }>(
  rows: readonly T[],
  master: Pick<SessionMeta, "environmentId">,
  which: ArchiveWhich,
  archivedByMaster: readonly string[],
  batch?: BatchDone | null,
): { environmentId: string; stop: string[]; archive: string[] }[] {
  const covered = new Set(archivedByMaster);
  const wanted = which === "done" ? doneRows(rows, batch) : rows;
  const byHost = new Map<string, { environmentId: string; stop: string[]; archive: string[] }>();
  for (const { meta } of wanted) {
    if (meta.environmentId === master.environmentId || covered.has(meta.id)) continue;
    const plan = byHost.get(meta.environmentId) ?? { environmentId: meta.environmentId, stop: [], archive: [] };
    if (which === "all" && hasRunningTurn(meta)) plan.stop.push(meta.id);
    plan.archive.push(meta.id);
    byHost.set(meta.environmentId, plan);
  }
  return [...byHost.values()];
}
