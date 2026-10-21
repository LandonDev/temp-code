import { useMemo, useSyncExternalStore } from "react";
import { registry } from "./connection";
import { newThreadMember, rememberProjectHost } from "./projectHostChoice";
import { clusterWorkspaces, EMPTY_PATH_MAP, type PathMap, type ProjectCluster } from "./projectIdentity";
import { normalizeProjectPath } from "./recents";
import { loadRailGroupByHost, subscribeRailGroupByHost } from "./settings";
import { useWorkspaceCatalog, workspaceStore } from "./tcserver/workspaces";
import type { WorkspaceMeta } from "./tcserver/types";

/**
 * The renderer's view of which workspaces are one project: the pure
 * clustering of `projectIdentity.ts` over the catalog, the path map the
 * main process keeps (`harness.status`), and the View menu's "Group by
 * host". With one host, or with the grouping on, every workspace stands
 * alone and the view says so (`merged: false`), so callers never pay for
 * the lookups then.
 */

export type ClusterView = {
  clusters: ProjectCluster<WorkspaceMeta>[];
  byWorkspaceId: ReadonlyMap<string, ProjectCluster<WorkspaceMeta>>;
  /** Keyed by normalized workspace path. */
  byPath: ReadonlyMap<string, ProjectCluster<WorkspaceMeta>>;
  /** False when nothing was joined: one host, or grouping by host. */
  merged: boolean;
};

const ALONE: ClusterView = { clusters: [], byWorkspaceId: new Map(), byPath: new Map(), merged: false };

/** Pure: the view for a catalog. `merge` false keeps every workspace alone. */
export function clusterView(workspaces: readonly WorkspaceMeta[], map: PathMap, merge: boolean): ClusterView {
  if (!merge || workspaces.length === 0) return ALONE;
  const hosts = new Set(workspaces.map((w) => w.environmentId));
  if (hosts.size < 2) return ALONE;
  const clusters = clusterWorkspaces(workspaces, map);
  const byWorkspaceId = new Map<string, ProjectCluster<WorkspaceMeta>>();
  const byPath = new Map<string, ProjectCluster<WorkspaceMeta>>();
  let merged = false;
  for (const cluster of clusters) {
    if (cluster.members.length > 1) merged = true;
    for (const m of cluster.members) {
      byWorkspaceId.set(m.id, cluster);
      const key = normalizeProjectPath(m.path);
      if (!byPath.has(key)) byPath.set(key, cluster);
    }
  }
  return merged ? { clusters, byWorkspaceId, byPath, merged } : ALONE;
}

/** The cluster a workspace path belongs to, if it was joined with another. */
export function clusterOfPath(view: ClusterView, path: string | null | undefined): ProjectCluster<WorkspaceMeta> | undefined {
  if (!view.merged || !path || path === "~") return undefined;
  return view.byPath.get(normalizeProjectPath(path));
}

/** Every workspace path that is the same project as `path` (itself first). */
export function pathsOf(view: ClusterView, path: string): string[] {
  const cluster = clusterOfPath(view, path);
  if (!cluster) return [path];
  const key = normalizeProjectPath(path);
  return [path, ...cluster.members.map((m) => m.path).filter((p) => normalizeProjectPath(p) !== key)];
}

/** Every workspace id that is the same project as `workspaceId` (itself first). */
export function workspaceIdsOf(view: ClusterView, workspaceId: string | null): string[] | null {
  if (workspaceId === null) return null;
  const cluster = view.merged ? view.byWorkspaceId.get(workspaceId) : undefined;
  if (!cluster) return [workspaceId];
  return [workspaceId, ...cluster.members.map((m) => m.id).filter((id) => id !== workspaceId)];
}

/** Two workspace paths name the same project: the same folder, or two joined checkouts. */
export function sameProject(view: ClusterView, a: string, b: string): boolean {
  const ka = normalizeProjectPath(a);
  const kb = normalizeProjectPath(b);
  if (ka === kb) return true;
  const ca = clusterOfPath(view, a);
  return !!ca && ca === clusterOfPath(view, b);
}

// ── the path map ─────────────────────────────────────────────────────────

const PATH_MAP_KEY = "monocode.projectPathMap";
const PATH_MAP_EVENT = "monocode:project-path-map-change";

let pathMap: PathMap | null = null;

function readPathMap(): PathMap {
  if (pathMap) return pathMap;
  try {
    const raw = localStorage.getItem(PATH_MAP_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<PathMap>) : null;
    pathMap = parsed ? { roots: parsed.roots ?? {}, prefixes: parsed.prefixes ?? {} } : EMPTY_PATH_MAP;
  } catch {
    pathMap = EMPTY_PATH_MAP;
  }
  return pathMap;
}

/** The map in force; the shipped rules alone until the main process answers. */
export function projectPathMap(): PathMap {
  return readPathMap();
}

export function setProjectPathMap(next: PathMap | null): void {
  pathMap = next ?? EMPTY_PATH_MAP;
  try {
    if (next) localStorage.setItem(PATH_MAP_KEY, JSON.stringify(next));
    else localStorage.removeItem(PATH_MAP_KEY);
  } catch {
    // private mode / quota
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PATH_MAP_EVENT));
}

function subscribePathMap(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(PATH_MAP_EVENT, onChange);
  return () => window.removeEventListener(PATH_MAP_EVENT, onChange);
}

/**
 * Ask this machine's server for the map the harness sync uses (the
 * setting, else the shipped history-map.json) and keep it for the next
 * boot. Nothing changes on a failure: the generic rules already pair the
 * usual folders.
 */
export async function refreshProjectPathMap(): Promise<void> {
  try {
    const status = await registry.primary().request<{ pathMap?: PathMap | null }>("harness.status");
    if (status?.pathMap) setProjectPathMap({ roots: status.pathMap.roots ?? {}, prefixes: status.pathMap.prefixes ?? {} });
  } catch {
    /* not connected yet, or an older server */
  }
}

/** Load the map once the primary link opens (and again on every reconnect). */
export function connectProjectPathMap(): () => void {
  const link = registry.primary();
  if (link.connected) void refreshProjectPathMap();
  return link.onOpen(() => void refreshProjectPathMap());
}

// ── hooks and the non-hook snapshot ──────────────────────────────────────

export function useRailGroupByHost(): boolean {
  return useSyncExternalStore(subscribeRailGroupByHost, loadRailGroupByHost, () => false);
}

function useProjectPathMap(): PathMap {
  return useSyncExternalStore(subscribePathMap, readPathMap, readPathMap);
}

export function useProjectClusters(): ClusterView {
  const { workspaces } = useWorkspaceCatalog();
  const map = useProjectPathMap();
  const groupByHost = useRailGroupByHost();
  return useMemo(() => clusterView(workspaces, map, !groupByHost), [groupByHost, map, workspaces]);
}

let lastInput: { workspaces: readonly WorkspaceMeta[]; map: PathMap; merge: boolean } | null = null;
let lastView: ClusterView = ALONE;

/** The view for callbacks outside React, memoized on its inputs. */
export function projectClusters(): ClusterView {
  const workspaces = workspaceStore.workspaces;
  const map = readPathMap();
  const merge = !loadRailGroupByHost();
  if (lastInput && lastInput.workspaces === workspaces && lastInput.map === map && lastInput.merge === merge) return lastView;
  lastInput = { workspaces, map, merge };
  lastView = clusterView(workspaces, map, merge);
  return lastView;
}

// ── where a new thread starts ────────────────────────────────────────────

/**
 * The workspace folder a new thread in `projectCwd` starts in: the same
 * folder, unless the project is checked out on several hosts, when it is the
 * checkout on the host the user last used there (else this machine's).
 */
export function newThreadWorkspacePath(projectCwd: string): string {
  const cluster = clusterOfPath(projectClusters(), projectCwd);
  if (!cluster) return projectCwd;
  return newThreadMember(cluster.members, cluster.key, registry.primaryEnvironmentId)?.path ?? projectCwd;
}

/** A thread the user started in a merged project: its host is the one to default to next time. */
export function noteThreadHost(session: { environmentId: string; cwd: string; workspaceId?: string | null }): void {
  const view = projectClusters();
  const cluster = clusterOfPath(view, session.cwd) ?? (session.workspaceId ? view.byWorkspaceId.get(session.workspaceId) : undefined);
  if (cluster && cluster.hosts.length > 1) rememberProjectHost(cluster.key, session.environmentId);
}
