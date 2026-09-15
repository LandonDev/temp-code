import type { AgentType, ProjectMeta, SessionMeta, WorkspaceMeta } from "./tcserver/types";
import { workspaceIdOf } from "./tcserver/workspaces";
import { sortAgents } from "./threads/agents";

/**
 * What the Sessions tab shows for one workspace: its project cards, its
 * archived projects, and the loose chats that hang off the workspace itself.
 * Pure; the component feeds it the store snapshots and the lastSeen map.
 */

export type ThreadRow = {
  id: string;
  title: string;
  status: SessionMeta["status"];
  updatedAt: number;
  unread: boolean;
  paused: boolean;
  running: boolean;
  failed: boolean;
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
  /** Subagents of this root, ranked: waiting, failed, working, done. */
  children?: ThreadRow[];
  /** Set on child rows; drives the row glyph. */
  agentType?: AgentType;
  provider?: string;
  model?: string;
  createdAt: number;
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
    failed: meta.status === "error",
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
    createdAt: meta.createdAt,
    ...(meta.parentId
      ? { agentType: meta.agentType, provider: meta.provider, model: meta.model }
      : {}),
  };
}

/** Child rows keyed by parent id, ranked. Archived children stay out. */
export function childRows(
  metas: readonly SessionMeta[],
  lastSeen: Record<string, number>,
  floor = 0,
  cache?: RowCache,
  next?: Map<string, CachedRow>,
): Map<string, ThreadRow[]> {
  const byParent = new Map<string, SessionMeta[]>();
  for (const meta of metas) {
    if (!meta.parentId || meta.archived) continue;
    const list = byParent.get(meta.parentId);
    if (list) list.push(meta);
    else byParent.set(meta.parentId, [meta]);
  }
  const out = new Map<string, ThreadRow[]>();
  for (const [parentId, list] of byParent)
    out.set(
      parentId,
      sortAgents(list).map((m) => cachedRow(cache, next, m, lastSeen, floor)),
    );
  return out;
}

const newestFirst = (a: ThreadRow, b: ThreadRow) => b.updatedAt - a.updatedAt;
const latestFirst = (a: ProjectGroup, b: ProjectGroup) => b.latest - a.latest;

export function groupWorkspaceSessions(
  metas: readonly SessionMeta[],
  projects: readonly ProjectMeta[],
  workspaces: readonly WorkspaceMeta[],
  workspaceId: string,
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
  const children = childRows(metas, lastSeen, floor, cache, nextRows);

  for (const meta of metas) {
    if (meta.parentId) continue;
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
