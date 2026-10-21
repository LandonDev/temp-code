/**
 * Which workspaces, across hosts, are the same project.
 *
 * The Mac keeps a checkout under `~/IdeaProjects/<X>` or
 * `~/Desktop/Websites/<X>`; the box keeps the same one under
 * `/srv/agents/work/<X>` (docs/box.md "Harness config: synced from the
 * Mac", the path map in scripts/box/history-map.json). `projectKey` folds
 * a path into that box-side spelling, so two checkouts of one project
 * share a key; `clusterWorkspaces` joins workspaces on different hosts
 * whose keys agree, or whose git origins do, and leaves everything on one
 * host apart. Pure: no stores, no DOM.
 */

export type PathMap = {
  /** Workspace roots: source path → destination path. */
  roots: Record<string, string>;
  /** Fallbacks for paths outside a mapped root, longest match wins. */
  prefixes: Record<string, string>;
};

export const EMPTY_PATH_MAP: PathMap = { roots: {}, prefixes: {} };

/** The box's work root when the map does not say otherwise. */
export const DEFAULT_WORK_ROOT = "/srv/agents/work";

/** The Mac folders whose children are the box's `<work>/<X>`. */
const PROJECT_PARENTS = ["/IdeaProjects/", "/Desktop/Websites/"];

export const stripSlash = (path: string): string => path.replace(/\/+$/, "") || "/";

const under = (path: string, from: string): boolean =>
  path === from || path.startsWith(from === "/" ? "/" : `${from}/`);

const byLength = (table: Record<string, string>): [string, string][] =>
  Object.entries(table)
    .map(([from, to]): [string, string] => [stripSlash(from), stripSlash(to)])
    .sort((a, b) => b[0].length - a[0].length);

const apply = (path: string, table: [string, string][]): string | null => {
  for (const [from, to] of table) if (under(path, from)) return stripSlash(to + path.slice(from.length));
  return null;
};

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const dirname = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";

/**
 * The work root the map's roots land in: the parent every `X → …/X` root
 * shares (the most common one when they differ), else the shipped default.
 */
export function workRootOf(map: PathMap): string {
  const tally = new Map<string, number>();
  for (const [from, to] of Object.entries(map.roots)) {
    const src = stripSlash(from);
    const dst = stripSlash(to);
    if (basename(src) !== basename(dst)) continue;
    const parent = dirname(dst);
    tally.set(parent, (tally.get(parent) ?? 0) + 1);
  }
  let best = DEFAULT_WORK_ROOT;
  let most = 0;
  for (const [parent, n] of tally) {
    if (n > most) {
      best = parent;
      most = n;
    }
  }
  return best;
}

/**
 * The host-neutral spelling of a workspace path: a mapped root lands on
 * its destination; a child of `IdeaProjects` or `Desktop/Websites` lands
 * under the work root; anything else goes through the prefixes, else
 * stays as it is. A box path is already in that form, so it maps to
 * itself.
 */
export function projectKey(path: string, map: PathMap = EMPTY_PATH_MAP): string {
  const clean = stripSlash(path);
  const rooted = apply(clean, byLength(map.roots));
  if (rooted !== null) return rooted;
  for (const parent of PROJECT_PARENTS) {
    const at = clean.indexOf(parent);
    if (at < 0) continue;
    const rest = clean.slice(at + parent.length);
    if (!rest) break;
    return `${workRootOf(map)}/${rest}`;
  }
  return apply(clean, byLength(map.prefixes)) ?? clean;
}

export type ClusterMember = {
  id: string;
  path: string;
  environmentId: string;
  /** GitHub `owner/name`; two checkouts sharing one are the same project. */
  githubRepo?: string | null;
};

export type ProjectCluster<W extends ClusterMember = ClusterMember> = {
  /** Stable across hosts and sessions: the smallest project key among the members. */
  key: string;
  /** In the order given. */
  members: W[];
  /** Distinct environment ids, in member order. */
  hosts: string[];
};

/**
 * Workspaces joined into projects: two workspaces on different hosts are
 * one project when their keys agree or their git origins do; two on the
 * same host never join directly (a bridge through a third host can still
 * put them together). Clusters come back in first-member order.
 */
export function clusterWorkspaces<W extends ClusterMember>(
  workspaces: readonly W[],
  map: PathMap = EMPTY_PATH_MAP,
): ProjectCluster<W>[] {
  const n = workspaces.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const keys = workspaces.map((w) => projectKey(w.path, map));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (workspaces[i].environmentId === workspaces[j].environmentId) continue;
      const sameKey = keys[i] === keys[j];
      const repo = workspaces[i].githubRepo;
      const sameRepo = !!repo && repo === workspaces[j].githubRepo;
      if (sameKey || sameRepo) union(i, j);
    }
  }
  const out = new Map<number, ProjectCluster<W>>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const cluster = out.get(root);
    if (cluster) {
      cluster.members.push(workspaces[i]);
      if (keys[i] < cluster.key) cluster.key = keys[i];
      if (!cluster.hosts.includes(workspaces[i].environmentId)) cluster.hosts.push(workspaces[i].environmentId);
    } else {
      out.set(root, { key: keys[i], members: [workspaces[i]], hosts: [workspaces[i].environmentId] });
    }
  }
  return [...out.values()];
}
