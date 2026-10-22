import { registry } from "./connection/registry";
import { normalizeProjectPath, type RecentProject } from "./recents";
import type { ProjectMeta, WorkspaceMeta } from "./tcserver/types";

/**
 * One rail for every host. A workspace and its copies on other hosts share
 * a `linkId` (the linker stamps it; src/shared/projectLinks.ts), and the
 * rail draws them as one row with every copy's threads.
 *
 * The leader of a link is this machine's copy when it has one, else the
 * oldest copy. Everything the rail keeps in localStorage (order, pins,
 * recents, the selected project, labels, colours, mascots) stays keyed by
 * the paths and ids it always used; the other copies alias to the
 * leader's key (`aliasKeys`), so nothing migrates. A link holds at most
 * one copy per host; a second copy on one host stands alone.
 */

/** One rail row: a workspace, or one linked across hosts. `path` is the
 *  lead folder; `paths`, `workspaceIds` and `hosts` list every copy, the
 *  leader's first. */
export type RailItem = RecentProject & {
  paths: string[];
  workspaceIds: string[];
  hosts: string[];
};

type LinkIndex = {
  /** Workspace id → every copy of its link, the leader first (alone: itself). */
  copies: ReadonlyMap<string, readonly WorkspaceMeta[]>;
  /** Normalized path → that workspace's leader. */
  leaderByPath: ReadonlyMap<string, WorkspaceMeta>;
};

const older = (a: WorkspaceMeta, b: WorkspaceMeta): number => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const indexes = new WeakMap<readonly WorkspaceMeta[], { primary: string; index: LinkIndex }>();

/** The link groups of a catalog, built once per catalog array and primary host. */
export function linkIndex(workspaces: readonly WorkspaceMeta[], primary: string): LinkIndex {
  const hit = indexes.get(workspaces);
  if (hit && hit.primary === primary) return hit.index;
  const byLink = new Map<string, WorkspaceMeta[]>();
  for (const w of workspaces) {
    if (!w.linkId) continue;
    const list = byLink.get(w.linkId);
    if (list) list.push(w);
    else byLink.set(w.linkId, [w]);
  }
  const copies = new Map<string, readonly WorkspaceMeta[]>();
  for (const list of byLink.values()) {
    // One copy per host: the oldest on each; the rest stand alone.
    const perHost = new Map<string, WorkspaceMeta>();
    for (const w of [...list].sort(older)) if (!perHost.has(w.environmentId)) perHost.set(w.environmentId, w);
    if (perHost.size < 2) continue;
    const members = [...perHost.values()];
    const leader = perHost.get(primary) ?? members[0];
    const ordered = [leader, ...members.filter((w) => w !== leader)];
    for (const w of ordered) copies.set(w.id, ordered);
  }
  const leaderByPath = new Map<string, WorkspaceMeta>();
  for (const w of workspaces) {
    const key = normalizeProjectPath(w.path);
    if (!leaderByPath.has(key)) leaderByPath.set(key, copies.get(w.id)?.[0] ?? w);
  }
  const index = { copies, leaderByPath };
  indexes.set(workspaces, { primary, index });
  return index;
}

/** Every copy of a workspace, the leader first; null for an unknown id. */
export function linkedWorkspaceIds(
  workspaces: readonly WorkspaceMeta[],
  workspaceId: string | null,
  primary: string = registry.primaryEnvironmentId,
): string[] | null {
  if (workspaceId === null) return null;
  const copies = linkIndex(workspaces, primary).copies.get(workspaceId);
  return copies ? copies.map((w) => w.id) : [workspaceId];
}

/**
 * The keys a copy answers to: its leader's path and workspace id. A path
 * or id the catalog does not know, or one of a workspace that stands
 * alone, maps to itself.
 */
export function aliasKeys(
  workspaces: readonly WorkspaceMeta[],
  primary: string = registry.primaryEnvironmentId,
): { path(path: string): string; workspaceId(id: string): string } {
  const index = linkIndex(workspaces, primary);
  return {
    path: (path) => {
      if (!path || path === "~") return path;
      const leader = index.leaderByPath.get(normalizeProjectPath(path));
      return leader ? leader.path : path;
    },
    workspaceId: (id) => index.copies.get(id)?.[0].id ?? id,
  };
}

/** A row for a folder that stands alone. */
export function soloRailItem(item: RecentProject, workspace?: WorkspaceMeta): RailItem {
  return {
    ...item,
    paths: [item.path],
    workspaceIds: workspace ? [workspace.id] : [],
    hosts: workspace ? [workspace.environmentId] : [],
  };
}

/**
 * The rail's rows with linked copies joined. A row sits where its first
 * copy sits in `items`; its lead is the link's leader when the rail lists
 * it, else the first listed copy. A copy the rail does not list (an
 * archived folder) stays out of the row.
 */
export function mergeRailItems(
  items: readonly RecentProject[],
  workspaces: readonly WorkspaceMeta[],
  primary: string = registry.primaryEnvironmentId,
): RailItem[] {
  const index = linkIndex(workspaces, primary);
  const byPath = new Map<string, WorkspaceMeta>();
  for (const w of workspaces) {
    const key = normalizeProjectPath(w.path);
    if (!byPath.has(key)) byPath.set(key, w);
  }
  const listed = new Map(items.map((item) => [normalizeProjectPath(item.path), item] as const));
  const out: RailItem[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = normalizeProjectPath(item.path);
    if (seen.has(key)) continue;
    const workspace = byPath.get(key);
    const copies = workspace ? index.copies.get(workspace.id) : undefined;
    const members = copies
      ?.map((w) => ({ w, item: listed.get(normalizeProjectPath(w.path)) }))
      .filter((m): m is { w: WorkspaceMeta; item: RecentProject } => !!m.item);
    if (!members || members.length < 2) {
      seen.add(key);
      out.push(soloRailItem(item, workspace));
      continue;
    }
    for (const m of members) seen.add(normalizeProjectPath(m.w.path));
    // `copies` is leader-first, so members[0] is the leader when listed.
    const lead = copies![0] === members[0].w ? members[0] : members.find((m) => m.item === item) ?? members[0];
    const ordered = [lead, ...members.filter((m) => m !== lead)];
    out.push({
      path: lead.item.path,
      openedAt: Math.max(...members.map((m) => m.item.openedAt)),
      paths: ordered.map((m) => m.item.path),
      workspaceIds: ordered.map((m) => m.w.id),
      hosts: ordered.map((m) => m.w.environmentId),
    });
  }
  return out;
}

/** The pinned and unpinned rows, links joined: a linked row is pinned when
 *  any copy is, and then shows only there. */
export function mergeRailSections(
  sections: { pinned: readonly RecentProject[]; projects: readonly RecentProject[] },
  workspaces: readonly WorkspaceMeta[],
  primary: string = registry.primaryEnvironmentId,
): { pinned: RailItem[]; projects: RailItem[] } {
  const rows = mergeRailItems([...sections.pinned, ...sections.projects], workspaces, primary);
  const pinnedKeys = new Set(sections.pinned.map((p) => normalizeProjectPath(p.path)));
  const pinned: RailItem[] = [];
  const projects: RailItem[] = [];
  for (const row of rows) (row.paths.some((p) => pinnedKeys.has(normalizeProjectPath(p))) ? pinned : projects).push(row);
  return { pinned, projects };
}

/**
 * Inside linked workspaces, projects link too (by their own `linkId`).
 * For a scope of workspace ids (the leader's first), each project's
 * leader: the copy whose workspace comes first in the scope, else the
 * oldest. Projects without a link, or alone in the scope, lead themselves.
 */
export function projectLeaders(projects: readonly ProjectMeta[], scope: readonly string[]): Map<string, ProjectMeta> {
  const rank = (p: ProjectMeta) => {
    const at = scope.indexOf(p.workspaceId);
    return at < 0 ? scope.length : at;
  };
  const byLink = new Map<string, ProjectMeta>();
  for (const p of projects) {
    if (!p.linkId || !scope.includes(p.workspaceId)) continue;
    const best = byLink.get(p.linkId);
    if (!best || rank(p) < rank(best) || (rank(p) === rank(best) && p.createdAt < best.createdAt)) byLink.set(p.linkId, p);
  }
  const out = new Map<string, ProjectMeta>();
  for (const p of projects) {
    if (!scope.includes(p.workspaceId)) continue;
    out.set(p.id, (p.linkId && byLink.get(p.linkId)) || p);
  }
  return out;
}
