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

export type ThreadSummary = {
  needYou: number;
  failed: number;
  paused: number;
  running: number;
  dormant: number;
  unread: number;
};

export function threadRow(
  meta: SessionMeta,
  lastSeen: Record<string, number>,
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
    unread: settled && !running && meta.updatedAt > (lastSeen[meta.id] ?? 0),
    busySince: meta.busySince ?? null,
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
      sortAgents(list).map((m) => threadRow(m, lastSeen)),
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
): WorkspaceSessionGroups {
  const here = projects.filter((p) => p.workspaceId === workspaceId);
  const ids = new Set(here.map((p) => p.id));
  const byProject = new Map<string, ThreadRow[]>();
  const archivedCount = new Map<string, number>();
  const chats: ThreadRow[] = [];
  const children = childRows(metas, lastSeen);
  const withChildren = (row: ThreadRow): ThreadRow => {
    const kids = children.get(row.id);
    return kids ? { ...row, children: kids } : row;
  };

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
    const row = withChildren(threadRow(meta, lastSeen));
    if (!projectId) {
      chats.push(row);
      continue;
    }
    const list = byProject.get(projectId);
    if (list) list.push(row);
    else byProject.set(projectId, [row]);
  }

  chats.sort(newestFirst);
  const groups = here.map((project): ProjectGroup => {
    const threads = (byProject.get(project.id) ?? []).sort(newestFirst);
    return {
      project,
      threads,
      latest: threads[0]?.updatedAt ?? project.createdAt,
      archivedCount: archivedCount.get(project.id) ?? 0,
    };
  });

  return {
    projects: groups.filter((g) => !g.project.archived).sort(latestFirst),
    archived: groups.filter((g) => g.project.archived).sort(latestFirst),
    chats,
  };
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
