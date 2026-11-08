import { homeOrWorkspacePath, landingPathOfSession, type Catalog, type LandingScope } from "./projectContext";
import { aliasKeys } from "./linkedRail";
import { loadLastSeen, seenFloor, type SeenMap } from "./sessionSeen";
import { rowState } from "./sidebarRows";
import type { SessionMeta } from "./tcserver/types";
import { housedIds } from "./workspaceSessions";

/** The states a person comes back to a project for: running or needing them. */
const ACTIVE = new Set(["working", "waiting", "paused", "queued", "watching"]);

/** What the rail reads a thread's unread mark from (lib/sessionSeen.ts). */
export type Seen = { lastSeen: SeenMap; floor: number };

export const seenNow = (): Seen => ({ lastSeen: loadLastSeen(), floor: seenFloor() });

const recency = (meta: SessionMeta) => meta.lastEventAt ?? meta.busySince ?? meta.updatedAt ?? meta.createdAt;

/** Unread exactly as the rail has it (`threadRow`): a settled thread updated
 *  since it was last seen, never one inside a master (`housedIds`). */
const isUnread = (meta: SessionMeta, seen: Seen, housed: ReadonlySet<string>) =>
  !housed.has(meta.id) &&
  (meta.status === "idle" || meta.status === "done") &&
  meta.updatedAt > (seen.lastSeen[meta.id] ?? seen.floor);

/**
 * The thread a project (on every linked copy), a workspace folder or the home
 * comes back on, the one rule every path takes:
 * 1. the most recent root that is running or needs the person;
 * 2. else the most recent unread root;
 * 3. else the most recently active unarchived root (idle, done, stopped,
 *    failed alike);
 * 4. else null: the scope's draft, since nothing unarchived is left.
 * Recency is the last event, else busySince, else the last update. A batch
 * thread stands in for its master, whose board is where the person watches
 * it; a subagent, an archived thread and a thread of an archived project
 * never count. When the thread on screen (`shownId`) is an unarchived root
 * of the scope, it is the answer: the person is already there.
 */
export function landingOf(
  scope: LandingScope,
  metas: readonly SessionMeta[],
  catalog: Catalog,
  seen: Seen,
  shownId?: string | null,
): SessionMeta | null {
  const project = "projectId" in scope ? scope.projectId : null;
  const linkId = project && catalog.projects.find((p) => p.id === project)?.linkId;
  const archivedProjects = new Set(catalog.projects.filter((p) => p.archived).map((p) => p.id));
  const here = project ? "" : homeOrWorkspacePath(aliasKeys(catalog.workspaces).path((scope as { workspacePath: string }).workspacePath));
  const inScope = (meta: SessionMeta) =>
    !meta.archived &&
    !meta.parentId &&
    !(meta.projectId && archivedProjects.has(meta.projectId)) &&
    (project
      ? meta.projectId === project || (!!linkId && catalog.projects.some((p) => p.id === meta.projectId && p.linkId === linkId))
      : homeOrWorkspacePath(landingPathOfSession(meta, catalog)) === here);
  const byId = new Map(metas.map((meta) => [meta.id, meta]));
  const shown = shownId ? byId.get(shownId) : undefined;
  if (shown && inScope(shown)) return shown;
  const housed = housedIds(metas);
  // Per step, the most recent candidate and when it last moved.
  const best: [SessionMeta | null, number][] = [[null, -Infinity], [null, -Infinity], [null, -Infinity]];
  for (const meta of metas) {
    if (meta.archived || meta.parentId) continue;
    const master = meta.masterId ? byId.get(meta.masterId) : undefined;
    const lands = master?.isMaster && !master.archived ? master : meta;
    if (!inScope(lands)) continue;
    const step = ACTIVE.has(rowState(meta)) ? 0 : isUnread(meta, seen, housed) ? 1 : 2;
    const at = recency(meta);
    if (at > best[step][1]) best[step] = [lands, at];
  }
  return best[0][0] ?? best[1][0] ?? best[2][0];
}
