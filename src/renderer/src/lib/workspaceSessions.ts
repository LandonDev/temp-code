import type { AgentType, ProjectMeta, SessionMeta, WorkspaceMeta } from "./tcserver/types";
import { workspaceIdOf } from "./tcserver/workspaces";
import { sortAgents } from "./threads/agents";
import { projectLeaders } from "./linkedRail";

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
  /** Subagents of this root (or of a batch thread), ranked: waiting,
   *  failed, working, done. A master's own subagents only. */
  children?: ThreadRow[];
  /** A master's batch: the roots carrying its id (`batchHome`), ranked the
   *  same way, each with its own subagents under it. */
  batch?: ThreadRow[];
  /** Inside a master (`housedIds`): a batch thread, or a subagent of the
   *  master or of one of its threads. The master reads these; they are
   *  never unread and never count toward an unread sum. */
  housed?: boolean;
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
  /** The leader of a project linked across hosts, else the project. */
  project: ProjectMeta;
  /** Every copy's id in the list's scope, the leader's first; absent means
   *  the project alone. */
  projectIds?: string[];
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
  housed: boolean;
  kids: ThreadRow[] | undefined;
  batch: ThreadRow[] | undefined;
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
  housed: boolean,
  kids?: ThreadRow[],
  batch?: ThreadRow[],
): ThreadRow {
  const seen = lastSeen[meta.id];
  const hit = cache?.rows.get(meta.id);
  if (
    hit &&
    hit.meta === meta &&
    hit.seen === seen &&
    hit.floor === floor &&
    hit.housed === housed &&
    sameList(hit.kids, kids) &&
    sameList(hit.batch, batch)
  ) {
    next?.set(meta.id, hit);
    return hit.row;
  }
  const base = threadRow(meta, lastSeen, floor, housed);
  const row = kids || batch ? { ...base, ...(kids ? { children: kids } : {}), ...(batch ? { batch } : {}) } : base;
  next?.set(meta.id, { meta, seen, floor, housed, kids, batch, row });
  return row;
}

/** `floor`: threads with no lastSeen entry count as seen up to this time.
 *  `housed`: the thread sits inside a master (`housedIds`), never unread. */
export function threadRow(
  meta: SessionMeta,
  lastSeen: Record<string, number>,
  floor = 0,
  housed = false,
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
    unread: !housed && settled && !running && meta.updatedAt > (lastSeen[meta.id] ?? floor),
    ...(housed ? { housed: true } : {}),
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

/**
 * Every session inside a master: the roots of its batch (`batchHome`, a
 * plan whose build started included) and every subagent, at any depth, of
 * the master or of one of those roots. The person reads the master; the
 * master reads these, so none of them is ever unread, and none counts
 * toward a project's, workspace's or host's unread sum or Mark all read.
 * The master itself is not in the set.
 */
export function housedIds(
  metas: readonly SessionMeta[],
  masters: ReadonlySet<string> = railMasters(metas),
): Set<string> {
  const out = new Set<string>();
  if (masters.size === 0) return out;
  const kids = new Map<string, string[]>();
  const stack: string[] = [...masters];
  for (const m of metas) {
    if (m.parentId) (kids.get(m.parentId) ?? kids.set(m.parentId, []).get(m.parentId)!).push(m.id);
    else if (batchHome(m, masters)) {
      out.add(m.id);
      stack.push(m.id);
    }
  }
  while (stack.length) {
    for (const id of kids.get(stack.pop()!) ?? []) {
      if (out.has(id)) continue;
      out.add(id);
      stack.push(id);
    }
  }
  return out;
}

/** The roots a card or popover reads, with each master's batch back beside
 *  it: a running or waiting batch thread is still the project's, whichever
 *  row it sits under. Its rows are `housed`, so they count toward the
 *  card's working and needs-you tallies and never toward its unread. */
export function cardThreads(threads: readonly ThreadRow[]): ThreadRow[] {
  return threads.flatMap((t) => (t.batch ? [t, ...t.batch] : [t]));
}

export type ChildRows = {
  /** Subagent rows keyed by their parent. */
  agents: Map<string, ThreadRow[]>;
  /** Batch rows keyed by their master. */
  batch: Map<string, ThreadRow[]>;
};

/** Child rows keyed by the row they sit under, ranked: subagents under
 *  their parent, a master's batch under the master, apart from the
 *  master's own subagents. Archived ones stay out. */
export function childRows(
  metas: readonly SessionMeta[],
  lastSeen: Record<string, number>,
  floor = 0,
  cache?: RowCache,
  next?: Map<string, CachedRow>,
  masters: ReadonlySet<string> = railMasters(metas),
  housed: ReadonlySet<string> = housedIds(metas, masters),
): ChildRows {
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
  const agents = new Map<string, ThreadRow[]>();
  for (const [parentId, list] of byParent)
    agents.set(
      parentId,
      sortAgents(list).map((m) => cachedRow(cache, next, m, lastSeen, floor, housed.has(m.id))),
    );
  // A batch thread keeps its own subagents under it.
  const batchRows = new Map<string, ThreadRow[]>();
  for (const [masterId, list] of batch)
    batchRows.set(
      masterId,
      sortAgents(list).map((m) => cachedRow(cache, next, m, lastSeen, floor, true, agents.get(m.id))),
    );
  return { agents, batch: batchRows };
}

const newestFirst = (a: ThreadRow, b: ThreadRow) => b.updatedAt - a.updatedAt;
const latestFirst = (a: ProjectGroup, b: ProjectGroup) => b.latest - a.latest;

/** Whether a workspace id is in a list's scope: one id, the home (null),
 *  or a workspace's copies on several hosts. */
export function scopeTest(scope: string | null | readonly string[]): (workspaceId: string | null | undefined) => boolean {
  if (typeof scope === "string") return (id) => id === scope;
  if (scope === null) return (id) => id === null || id === undefined;
  const set = new Set(scope);
  return (id) => id != null && set.has(id);
}

/**
 * `scope`: one workspace, the home (null), or a workspace's copies on
 * several hosts (the leader's first, lib/linkedRail.ts). Copies interleave
 * as one list: a project linked across them is one group (its leader's
 * meta, every copy's threads), the loose chats one list, newest first.
 */
export function groupWorkspaceSessions(
  metas: readonly SessionMeta[],
  projects: readonly ProjectMeta[],
  workspaces: readonly WorkspaceMeta[],
  scope: string | null | readonly string[],
  lastSeen: Record<string, number>,
  floor = 0,
  cache?: RowCache,
): WorkspaceSessionGroups {
  const inScope = scopeTest(scope);
  const copies = Array.isArray(scope) && scope.length > 1 ? projectLeaders(projects, scope) : null;
  const leaderOf = (id: string): string => copies?.get(id)?.id ?? id;
  const all = projects.filter((p) => inScope(p.workspaceId));
  const here = all.filter((p) => leaderOf(p.id) === p.id);
  const ids = new Set(all.map((p) => p.id));
  const memberIds = new Map<string, string[]>();
  for (const p of all) {
    const lead = leaderOf(p.id);
    const list = memberIds.get(lead);
    if (!list) memberIds.set(lead, [lead]);
    if (lead !== p.id) memberIds.get(lead)!.push(p.id);
  }
  const byProject = new Map<string, ThreadRow[]>();
  const archivedCount = new Map<string, number>();
  const chats: ThreadRow[] = [];
  const nextRows = cache ? new Map<string, CachedRow>() : undefined;
  const masters = railMasters(metas);
  const housed = housedIds(metas, masters);
  const children = childRows(metas, lastSeen, floor, cache, nextRows, masters, housed);

  for (const meta of metas) {
    if (meta.parentId || batchHome(meta, masters)) continue;
    if (!inScope(workspaceIdOf(meta, projects, workspaces))) continue;
    const projectId =
      meta.projectId && ids.has(meta.projectId) ? leaderOf(meta.projectId) : null;
    if (meta.archived) {
      if (projectId)
        archivedCount.set(projectId, (archivedCount.get(projectId) ?? 0) + 1);
      continue;
    }
    const row = cachedRow(
      cache,
      nextRows,
      meta,
      lastSeen,
      floor,
      false,
      children.agents.get(meta.id),
      children.batch.get(meta.id),
    );
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
    const projectIds = memberIds.get(project.id) ?? [project.id];
    const prev = cache?.groups.get(project.id);
    const group =
      prev &&
      prev.project === project &&
      prev.latest === latest &&
      prev.archivedCount === count &&
      sameList(prev.projectIds, projectIds) &&
      sameList(prev.threads, threads)
        ? prev
        : { project, projectIds, threads, latest, archivedCount: count };
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
