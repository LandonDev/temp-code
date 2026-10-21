import type { Environment } from "./connection/types";
import type { ClusterView } from "./projectMerge";
import { clusterOfPath } from "./projectMerge";
import { normalizeProjectPath, type RecentProject } from "./recents";

export type EnvironmentGroup = {
  environment: Environment;
  items: RecentProject[];
};

/**
 * The rail's workspace rows split by the machine they live on, in the
 * registry's order (this machine first); a folder no host claims is this
 * machine's. Every environment gets a group, even an empty one, so the
 * user can add a workspace there. This is the View menu's "Group by host".
 */
export function groupByEnvironment(
  items: readonly RecentProject[],
  environments: readonly Environment[],
  environmentOf: (path: string) => string | undefined,
): EnvironmentGroup[] {
  const groups = environments.map((environment) => ({ environment, items: [] as RecentProject[] }));
  const byId = new Map(groups.map((g) => [g.environment.id, g] as const));
  const fallback = groups[0];
  for (const item of items) {
    const id = environmentOf(item.path);
    ((id !== undefined ? byId.get(id) : undefined) ?? fallback)?.items.push(item);
  }
  return groups;
}

/**
 * One rail row: a workspace, or the same project on several hosts. `path`
 * is the lead (this machine's checkout when there is one, else the first in
 * rail order), `paths` every member's folder (lead first), `hosts` the
 * environments that have it, `key` the project's stable key.
 */
export type RailItem = RecentProject & {
  paths: string[];
  hosts: string[];
  key: string;
};

/** A row for a workspace that stands alone. */
export function soloRailItem(item: RecentProject, host?: string): RailItem {
  return { ...item, paths: [item.path], hosts: host ? [host] : [], key: normalizeProjectPath(item.path) };
}

/**
 * The default rail: one row per project, the hosts' checkouts merged. Rows
 * keep the order of their first member; a cluster's lead is its member on
 * `primary` when that host has it. A row from only one host is still one
 * row (with that host). `environmentOf` names a lone folder's host.
 */
export function mergeRailItems(
  items: readonly RecentProject[],
  view: ClusterView,
  primary: string,
  environmentOf: (path: string) => string | undefined,
): RailItem[] {
  const out: RailItem[] = [];
  const seen = new Set<string>();
  const byKey = new Map(items.map((item) => [normalizeProjectPath(item.path), item] as const));
  for (const item of items) {
    const key = normalizeProjectPath(item.path);
    if (seen.has(key)) continue;
    const cluster = clusterOfPath(view, item.path);
    if (!cluster) {
      seen.add(key);
      out.push(soloRailItem(item, environmentOf(item.path)));
      continue;
    }
    // Members in rail order, and only the ones the rail actually lists
    // (an archived-away folder stays out).
    const members = cluster.members
      .map((m) => ({ member: m, item: byKey.get(normalizeProjectPath(m.path)) }))
      .filter((x): x is { member: (typeof cluster.members)[number]; item: RecentProject } => !!x.item)
      .sort((a, b) => items.indexOf(a.item) - items.indexOf(b.item));
    for (const { item: m } of members) seen.add(normalizeProjectPath(m.path));
    const lead = members.find((x) => x.member.environmentId === primary) ?? members[0];
    const paths = [lead.item.path, ...members.filter((x) => x !== lead).map((x) => x.item.path)];
    const hosts: string[] = [];
    for (const x of [lead, ...members.filter((y) => y !== lead)]) {
      if (!hosts.includes(x.member.environmentId)) hosts.push(x.member.environmentId);
    }
    out.push({
      path: lead.item.path,
      openedAt: Math.max(...members.map((x) => x.item.openedAt)),
      paths,
      hosts,
      key: cluster.key,
    });
  }
  return out;
}

/**
 * The pinned and unpinned rows with projects merged: a project is pinned
 * when any of its checkouts is, and then appears only there.
 */
export function mergeRailSections(
  sections: { pinned: readonly RecentProject[]; projects: readonly RecentProject[] },
  view: ClusterView,
  primary: string,
  environmentOf: (path: string) => string | undefined,
): { pinned: RailItem[]; projects: RailItem[] } {
  const all = mergeRailItems([...sections.pinned, ...sections.projects], view, primary, environmentOf);
  const pinnedKeys = new Set(sections.pinned.map((p) => normalizeProjectPath(p.path)));
  const pinned: RailItem[] = [];
  const projects: RailItem[] = [];
  for (const row of all) {
    (row.paths.some((p) => pinnedKeys.has(normalizeProjectPath(p))) ? pinned : projects).push(row);
  }
  return { pinned, projects };
}
