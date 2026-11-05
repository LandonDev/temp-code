import { homeOrWorkspacePath, landingPathOfSession, type Catalog, type LandingScope } from "./projectContext";
import { aliasKeys } from "./linkedRail";
import { rowState } from "./sidebarRows";
import type { SessionMeta } from "./tcserver/types";

/** The states a person comes back to a project for; done, idle, stopped,
 *  failed and plan-ready are not. */
const ACTIVE = new Set(["working", "waiting", "paused", "queued", "watching"]);

/**
 * The thread a scope comes back to over its remembered landing: the most
 * recent active root of the project on any linked copy (or of the
 * workspace folder, or the home), by its last event, else busySince, else
 * createdAt. A batch thread stands in for its master, whose board is where
 * the person watches it; a subagent never counts. The meta carries the
 * host the thread lives on. Null when nothing there is active, or when the
 * thread on screen (`shownId`) is already in the scope: the person is in
 * the project, and a thread turning active never takes their place.
 */
export function activeLanding(
  scope: LandingScope,
  metas: readonly SessionMeta[],
  catalog: Catalog,
  shownId?: string | null,
): SessionMeta | null {
  const project = "projectId" in scope ? scope.projectId : null;
  const linkId = project && catalog.projects.find((p) => p.id === project)?.linkId;
  const here = project ? "" : homeOrWorkspacePath(aliasKeys(catalog.workspaces).path((scope as { workspacePath: string }).workspacePath));
  const inScope = (meta: SessionMeta) =>
    project
      ? meta.projectId === project || (!!linkId && catalog.projects.some((p) => p.id === meta.projectId && p.linkId === linkId))
      : homeOrWorkspacePath(landingPathOfSession(meta, catalog)) === here;
  const byId = (id: string) => metas.find((meta) => meta.id === id);
  const shown = shownId ? byId(shownId) : undefined;
  if (shown && inScope(shown)) return null;
  let best: SessionMeta | null = null;
  let bestAt = -Infinity;
  for (const meta of metas) {
    if (meta.archived || meta.parentId || !ACTIVE.has(rowState(meta))) continue;
    const master = meta.masterId ? byId(meta.masterId) : undefined;
    const lands = master?.isMaster && !master.archived ? master : meta;
    const at = meta.lastEventAt ?? meta.busySince ?? meta.createdAt;
    if (at > bestAt && inScope(lands)) {
      best = lands;
      bestAt = at;
    }
  }
  return best;
}
