import type { AgentType, ProjectMeta, SessionMeta, WorkspaceMeta } from "./tcserver/types";
import { workspaceIdOf } from "./tcserver/workspaces";
import { sortAgents } from "./threads/agents";

/**
 * What the Sessions tab shows for one workspace: its project cards, its
 * archived projects, and the loose chats that hang off the workspace itself.
 * A null workspace is the home: the chats outside every workspace, no cards.
 * Pure; the component feeds it the store snapshots and the lastSeen map.
 */

export type ThreadRow = {
  id: string;
  title: string;
  status: SessionMeta["status"];
  updatedAt: number;
  unread: boolean;
  paused: boolean;
  /** The harness behind the turn is gone; Resume boots a fresh one. */
  stopped?: boolean;
  running: boolean;
  failed: boolean;
  /** failed: the host's one-line verdict, when it has one. */
  failure?: string | null;
  needsYou: boolean;
  busySince: number | null;
  /** What the project card needs to read the root's tree (see projectCardModel). */
  threadType: SessionMeta["threadType"];
  frozenActiveElapsed: number | null;
  tasks?: SessionMeta["tasks"];
  activity?: SessionMeta["activity"];
  activityKind?: SessionMeta["activityKind"];
  treeHasLiveWork?: boolean;
  treeHasPaused?: boolean;
  treeCanContinue?: boolean;
  treeFrozenActiveElapsed?: number | null;
  /** What "Archive dormant threads" spares (see threadStripModel). */
  pinned?: boolean;
  planPath?: string | null;
  /** Subagents of this root, ranked: waiting, failed, working, done; under
   *  a master, the roots of its batch too (`batchHome`). */
  children?: ThreadRow[];
  /** A root of a master's batch: the master's id (CLAUDE.md "Master threads"). */
  masterId?: string;
  /** The project the root belongs to; the rail's "Make master thread" needs it. */
  projectId?: string | null;
  /** Set on child rows; drives the row glyph. */
  agentType?: AgentType;
  provider?: string;
  model?: string;
  createdAt: number;
  /** The host the thread lives on (the row's host badge, when the window has two or more). */
  environmentId?: string;
};

export type ProjectGroup = {
  project: ProjectMeta;
  /** Live roots, newest first. */
  threads: ThreadRow[];
  /** Newest thread activity, or the project's creation when it has none. */
  latest: number;
  /** Archived roots, kept out of `threads` but counted on the card. */
  archivedCount: number;
};

export type WorkspaceSessionGroups = {
  projects: ProjectGroup[];
  archived: ProjectGroup[];
  chats: ThreadRow[];
};

type CachedRow = {
  meta: SessionMeta;
  seen: number | undefined;
  floor: number;
  kids: ThreadRow[] | undefined;
  row: ThreadRow;
};

/**
 * What the last grouping built, so the next one can hand back the same row
 * for a thread whose meta and seen state did not move, and the same group
 * for a project whose rows all came back unchanged. Memoized rows and cards
 * downstream then skip. One per sidebar; feed it to `groupWorkspaceSessions`.
 */
export type RowCache = {
  rows: Map<string, CachedRow>;
  groups: Map<string, ProjectGroup>;
  last: WorkspaceSessionGroups | null;
};

export const rowCache = (): RowCache => ({
  rows: new Map(),
  groups: new Map(),
  last: null,
});

const sameList = <T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean =>
  a === b ||
  (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));

/** `threadRow`, but the cached row when nothing it reads has changed. */
function cachedRow(
  cache: RowCache | undefined,
  next: Map<string, CachedRow> | undefined,
  meta: SessionMeta,
  lastSeen: Record<string, number>,
  floor: number,
  kids?: ThreadRow[],
): ThreadRow {
  const seen = lastSeen[meta.id];
  const hit = cache?.rows.get(meta.id);
  if (
    hit &&
    hit.meta === meta &&
    hit.seen === seen &&
    hit.floor === floor &&
    sameList(hit.kids, kids)
  ) {
    next?.set(meta.id, hit);
    return hit.row;
  }
  const base = threadRow(meta, lastSeen, floor);
  const row = kids ? { ...base, children: kids } : base;
  next?.set(meta.id, { meta, seen, floor, kids, row });
  return row;
}

export type ThreadSummary = {
  needYou: number;
  failed: number;
  paused: number;
  running: number;
  dormant: number;
  unread: number;
};

/** `floor`: threads with no lastSeen entry count as seen up to this time. */
export function threadRow(
  meta: SessionMeta,
  lastSeen: Record<string, number>,
  floor = 0,
): ThreadRow {
  const running = meta.status === "starting" || meta.status === "running";
  const settled = meta.status === "idle" || meta.status === "done";
  return {
    id: meta.id,
    title: meta.title,
    status: meta.status,
    updatedAt: meta.updatedAt,
    running,
    paused: meta.status === "paused",
    stopped: meta.status === "stopped",
    failed: meta.status === "error",
    failure: meta.failure?.summary ?? null,
    needsYou: meta.status === "waiting",
    unread: settled && !running && meta.updatedAt > (lastSeen[meta.id] ?? floor),
    busySince: meta.busySince ?? null,
    threadType: meta.threadType,
    frozenActiveElapsed: meta.frozenActiveElapsed ?? null,
    tasks: meta.tasks,
    activity: meta.activity,
    activityKind: meta.activityKind,
    treeHasLiveWork: meta.treeHasLiveWork,
    treeHasPaused: meta.treeHasPaused,
    treeCanContinue: meta.treeCanContinue,
    treeFrozenActiveElapsed: meta.treeFrozenActiveElapsed,
    pinned: meta.pinned,
    planPath: meta.planPath,
    projectId: meta.projectId ?? null,
    createdAt: meta.createdAt,
    environmentId: meta.environmentId,
    ...(meta.parentId
      ? { agentType: meta.agentType, provider: meta.provider, model: meta.model }
      : meta.masterId
        ? { masterId: meta.masterId, provider: meta.provider, model: meta.model }
        : {}),
  };
}

/** The ids of the unarchived roots pinned as masters. */
export function railMasters(metas: readonly SessionMeta[]): Set<string> {
  const out = new Set<string>();
  for (const m of metas) if (m.isMaster && !m.parentId && !m.archived) out.add(m.id);
  return out;
}

/** The master a batch child belongs under in the rail, else null: a root
 *  carrying the id of an unarchived master that is one. Such a thread is
 *  never a root row; it is housed under the master, unless it is a plan
 *  whose build has started (`startedPlan`: the build is the row).
 *  An archived thread is neither. */
export function batchHome(
  meta: Pick<SessionMeta, "parentId" | "masterId" | "archived">,
  masters: ReadonlySet<string>,
): string | null {
  if (meta.parentId || meta.archived || !meta.masterId || !masters.has(meta.masterId)) return null;
  return meta.masterId;
}

/** A plan whose build has started: the build takes its place in the batch. */
export const startedPlan = (meta: Pick<SessionMeta, "threadType" | "implementationId">): boolean =>
  meta.threadType === "planning" && !!meta.implementationId;

/** The roots a card or popover reads, with the batch children housed under
 *  a master back beside it: a running or waiting batch thread is still the
 *  project's, whichever row it sits under. */
export function cardThreads(threads: readonly ThreadRow[]): ThreadRow[] {
  return threads.flatMap((t) => [t, ...(t.children?.filter((c) => c.masterId) ?? [])]);
}

/** Child rows keyed by the row they sit under, ranked: subagents under
 *  their parent, a master's batch under the master. Archived ones stay out. */
export function childRows(
  metas: readonly SessionMeta[],
  lastSeen: Record<string, number>,
  floor = 0,
  cache?: RowCache,
  next?: Map<string, CachedRow>,
  masters: ReadonlySet<string> = railMasters(metas),
): Map<string, ThreadRow[]> {
  const byParent = new Map<string, SessionMeta[]>();
  const batch = new Map<string, SessionMeta[]>();
  const add = (map: Map<string, SessionMeta[]>, key: string, meta: SessionMeta) => {
    const list = map.get(key);
    if (list) list.push(meta);
    else map.set(key, [meta]);
  };
  for (const meta of metas) {
    if (meta.archived) continue;
    if (meta.parentId) add(byParent, meta.parentId, meta);
    else {
      const home = batchHome(meta, masters);
      if (home && !startedPlan(meta)) add(batch, home, meta);
    }
  }
  const out = new Map<string, ThreadRow[]>();
  for (const [parentId, list] of byParent)
    out.set(
      parentId,
      sortAgents(list).map((m) => cachedRow(cache, next, m, lastSeen, floor)),
    );
  // A batch thread keeps its own subagents under it; under the master it
  // ranks with the master's subagents, when it has any.
  for (const [masterId, list] of batch) {
    const rows = list.map((m) => cachedRow(cache, next, m, lastSeen, floor, out.get(m.id)));
    out.set(masterId, sortAgents([...(out.get(masterId) ?? []), ...rows]));
  }
  return out;
}

const newestFirst = (a: ThreadRow, b: ThreadRow) => b.updatedAt - a.updatedAt;
const latestFirst = (a: ProjectGroup, b: ProjectGroup) => b.latest - a.latest;

export function groupWorkspaceSessions(
  metas: readonly SessionMeta[],
  projects: readonly ProjectMeta[],
  workspaces: readonly WorkspaceMeta[],
  workspaceId: string | null,
  lastSeen: Record<string, number>,
  floor = 0,
  cache?: RowCache,
): WorkspaceSessionGroups {
  const here = projects.filter((p) => p.workspaceId === workspaceId);
  const ids = new Set(here.map((p) => p.id));
  const byProject = new Map<string, ThreadRow[]>();
  const archivedCount = new Map<string, number>();
  const chats: ThreadRow[] = [];
  const nextRows = cache ? new Map<string, CachedRow>() : undefined;
  const masters = railMasters(metas);
  const children = childRows(metas, lastSeen, floor, cache, nextRows, masters);

  for (const meta of metas) {
    if (meta.parentId || batchHome(meta, masters)) continue;
    if (workspaceIdOf(meta, projects, workspaces) !== workspaceId) continue;
    const projectId =
      meta.projectId && ids.has(meta.projectId) ? meta.projectId : null;
    if (meta.archived) {
      if (projectId)
        archivedCount.set(projectId, (archivedCount.get(projectId) ?? 0) + 1);
      continue;
    }
    const row = cachedRow(cache, nextRows, meta, lastSeen, floor, children.get(meta.id));
    if (!projectId) {
      chats.push(row);
      continue;
    }
    const list = byProject.get(projectId);
    if (list) list.push(row);
    else byProject.set(projectId, [row]);
  }

  chats.sort(newestFirst);
  const nextGroups = cache ? new Map<string, ProjectGroup>() : undefined;
  const groups = here.map((project): ProjectGroup => {
    const threads = (byProject.get(project.id) ?? []).sort(newestFirst);
    const latest = threads[0]?.updatedAt ?? project.createdAt;
    const count = archivedCount.get(project.id) ?? 0;
    const prev = cache?.groups.get(project.id);
    const group =
      prev &&
      prev.project === project &&
      prev.latest === latest &&
      prev.archivedCount === count &&
      sameList(prev.threads, threads)
        ? prev
        : { project, threads, latest, archivedCount: count };
    nextGroups?.set(project.id, group);
    return group;
  });

  const last = cache?.last;
  const keep = <T>(fresh: T[], old: T[] | undefined): T[] =>
    old && sameList(old, fresh) ? old : fresh;
  const out: WorkspaceSessionGroups = {
    projects: keep(
      groups.filter((g) => !g.project.archived).sort(latestFirst),
      last?.projects,
    ),
    archived: keep(
      groups.filter((g) => g.project.archived).sort(latestFirst),
      last?.archived,
    ),
    chats: keep(chats, last?.chats),
  };
  // The cache is written here, inside the caller's useMemo. A render React
  // throws away loses one generation of reuse and nothing else: every hit
  // is re-checked against the metas it is handed.
  if (cache) {
    cache.rows = nextRows!;
    cache.groups = nextGroups!;
    cache.last = out;
  }
  return out;
}

/** Each thread counts once: running, then paused, waiting, failed, unread, else dormant. */
export function summarizeThreads(threads: readonly ThreadRow[]): ThreadSummary {
  const out: ThreadSummary = {
    needYou: 0,
    failed: 0,
    paused: 0,
    running: 0,
    dormant: 0,
    unread: 0,
  };
  for (const t of threads) {
    if (t.running) out.running++;
    else if (t.paused) out.paused++;
    else if (t.needsYou) out.needYou++;
    else if (t.failed) out.failed++;
    else if (t.unread) out.unread++;
    else out.dormant++;
  }
  return out;
}
