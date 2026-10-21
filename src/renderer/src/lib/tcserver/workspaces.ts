import { useEffect, useSyncExternalStore } from "react";
import { normalizeProjectPath } from "../recents";
import type { Link } from "../connection";
import type { ProjectMeta, ServerPush, ThreadDefaults, WireProjectMeta, WireWorkspaceMeta, WorkspaceIcon, WorkspaceMeta } from "./types";
import { BUILT_IN_SCOPE, parseDefaultsScope, type DefaultsScope } from "./defaults";

/**
 * The server's workspace and project lists, beside `sessionStore`. Both
 * lists load when the socket opens and follow the `workspaces` and
 * `projects` pushes; `refresh()` re-reads them for callers that cannot
 * wait on a push. Icons load lazily, once per workspace per launch.
 */

export type WorkspaceCatalog = {
  workspaces: WorkspaceMeta[];
  projects: ProjectMeta[];
  icons: ReadonlyMap<string, WorkspaceIcon>;
  /** Thread defaults per workspace id ("" = global): the set in force there
   *  and whether the scope stores its own. Absent until loaded. */
  defaults: ReadonlyMap<string, DefaultsScope>;
  loaded: boolean;
};

const EMPTY: WorkspaceCatalog = {
  workspaces: [],
  projects: [],
  icons: new Map(),
  defaults: new Map(),
  loaded: false,
};

const GLOBAL = "";

/** Defaults and rules scopes are per environment: `env|workspaceId` or `env|`. */
export function scopeKey(environmentId: string, workspaceId: string | null | undefined): string {
  return `${environmentId}|${workspaceId ?? GLOBAL}`;
}

type SessionLike = {
  cwd: string;
  projectId?: string | null;
  workspaceId?: string | null;
};

// ── pure helpers ───────────────────────────────────────────────────────

/**
 * Lookups over a catalog array, built once per array identity: the
 * catalog store hands out the same arrays until a push replaces them, so
 * every consumer that places sessions per meta push pays O(1) per
 * session instead of a linear scan over the projects and workspaces.
 */
type WorkspaceIndex = {
  byId: ReadonlyMap<string, WorkspaceMeta>;
  /** keyed by normalized path; the first workspace at a path wins, as find() did */
  byKey: ReadonlyMap<string, WorkspaceMeta>;
};
const projectIndexes = new WeakMap<readonly ProjectMeta[], ReadonlyMap<string, ProjectMeta>>();
const workspaceIndexes = new WeakMap<readonly WorkspaceMeta[], WorkspaceIndex>();

export function projectIndex(projects: readonly ProjectMeta[]): ReadonlyMap<string, ProjectMeta> {
  let index = projectIndexes.get(projects);
  if (!index) {
    index = new Map(projects.map((p) => [p.id, p]));
    projectIndexes.set(projects, index);
  }
  return index;
}

export function workspaceIndex(workspaces: readonly WorkspaceMeta[]): WorkspaceIndex {
  let index = workspaceIndexes.get(workspaces);
  if (!index) {
    const byId = new Map<string, WorkspaceMeta>();
    const byKey = new Map<string, WorkspaceMeta>();
    for (const w of workspaces) {
      byId.set(w.id, w);
      const key = normalizeProjectPath(w.path);
      if (!byKey.has(key)) byKey.set(key, w);
    }
    index = { byId, byKey };
    workspaceIndexes.set(workspaces, index);
  }
  return index;
}

export function workspaceByPath(
  workspaces: readonly WorkspaceMeta[],
  path: string | null | undefined,
): WorkspaceMeta | undefined {
  if (!path || path === "~") return undefined;
  return workspaceIndex(workspaces).byKey.get(normalizeProjectPath(path));
}

/**
 * The key a workspace's label, colour and mascot are stored under. Workspace
 * ids keep two folders with the same basename apart; a path the catalog does
 * not know yet (a fresh pick, an archived project) falls back to the basename
 * so nothing is lost before the catalog catches up.
 */
export function workspaceLabelKey(
  workspaces: readonly WorkspaceMeta[],
  path: string,
  fallback: string,
): string {
  return workspaceByPath(workspaces, path)?.id ?? fallback;
}

export function projectOf(
  projects: readonly ProjectMeta[],
  session: Pick<SessionLike, "projectId">,
): ProjectMeta | undefined {
  return session.projectId ? projectIndex(projects).get(session.projectId) : undefined;
}

/** Where a session belongs: through its project, else its own workspace,
 *  else the workspace whose path is its cwd (sessions from before ids). */
export function workspaceIdOf(
  session: SessionLike,
  projects: readonly ProjectMeta[],
  workspaces: readonly WorkspaceMeta[],
): string | null {
  const project = projectOf(projects, session);
  if (project) return project.workspaceId;
  if (session.workspaceId) return session.workspaceId;
  return workspaceByPath(workspaces, session.cwd)?.id ?? null;
}

// ── store ──────────────────────────────────────────────────────────────

class WorkspaceStore {
  private state: WorkspaceCatalog = EMPTY;
  private listeners = new Set<() => void>();
  private links = new Map<string, { link: Link; detach: (() => void)[] }>();
  private offRegistry: (() => void) | null = null;
  private iconRequests = new Set<string>();

  /** Follow the registry: one catalog slice per environment. */
  connect(registry: { onLink(listener: (link: Link, event: "added" | "removed") => void): () => void }): void {
    this.offRegistry?.();
    this.offRegistry = registry.onLink((link, event) => {
      if (event === "added") this.attach(link);
      else this.detach(link.environmentId);
    });
  }

  attach(link: Link): void {
    const current = this.links.get(link.environmentId);
    if (current?.link === link) return;
    if (current) this.detach(link.environmentId);
    const detach = [
      link.onPush((push) => this.onPush(push, link.environmentId)),
      link.onOpen(() => void this.refresh(link)),
    ];
    this.links.set(link.environmentId, { link, detach });
    if (link.connected) void this.refresh(link);
  }

  /** The environment is gone: its workspaces, projects, icons and defaults leave. */
  detach(environmentId: string): void {
    const current = this.links.get(environmentId);
    if (!current) return;
    for (const off of current.detach) off();
    this.links.delete(environmentId);
    const gone = new Set(this.state.workspaces.filter((w) => w.environmentId === environmentId).map((w) => w.id));
    const icons = new Map([...this.state.icons].filter(([id]) => !gone.has(id)));
    const defaults = new Map([...this.state.defaults].filter(([key]) => !key.startsWith(`${environmentId}|`)));
    this.set({
      ...this.state,
      workspaces: this.state.workspaces.filter((w) => w.environmentId !== environmentId),
      projects: this.state.projects.filter((p) => p.environmentId !== environmentId),
      icons,
      defaults,
    });
  }

  linkOf(environmentId: string): Link | undefined {
    return this.links.get(environmentId)?.link;
  }

  /** The link a workspace's requests ride on. */
  linkOfWorkspace(workspaceId: string | null | undefined): Link | undefined {
    const workspace = this.workspace(workspaceId);
    return workspace ? this.linkOf(workspace.environmentId) : undefined;
  }

  /** Test seam. */
  reset(): void {
    this.offRegistry?.();
    this.offRegistry = null;
    for (const { detach } of this.links.values()) for (const off of detach) off();
    this.links.clear();
    this.iconRequests.clear();
    this.set(EMPTY);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): WorkspaceCatalog => this.state;

  get workspaces(): WorkspaceMeta[] {
    return this.state.workspaces;
  }

  get projects(): ProjectMeta[] {
    return this.state.projects;
  }

  project(id: string | null | undefined): ProjectMeta | undefined {
    return id ? this.state.projects.find((p) => p.id === id) : undefined;
  }

  workspace(id: string | null | undefined): WorkspaceMeta | undefined {
    return id ? this.state.workspaces.find((w) => w.id === id) : undefined;
  }

  /** Paint one host's lists from the launch mirror before its socket is up;
   *  the first `refresh` replaces them. A host the mirror had nothing for
   *  leaves the catalog as it was (so `loaded` stays honest). */
  hydrate(hosts: readonly { environmentId: string; workspaces: unknown[]; projects: unknown[] }[]): void {
    for (const host of hosts) {
      if (host.workspaces.length === 0 && host.projects.length === 0) continue;
      this.merge(
        host.environmentId,
        (host.workspaces as WireWorkspaceMeta[]).map((w) => ({ ...w, environmentId: host.environmentId })),
        (host.projects as WireProjectMeta[]).map((p) => ({ ...p, environmentId: host.environmentId })),
      );
    }
  }

  /** Re-read one environment's lists, then every scope's thread defaults there. */
  async refresh(link: Link): Promise<void> {
    const environmentId = link.environmentId;
    const [workspaces, projects] = await Promise.all([
      link.request<WireWorkspaceMeta[]>("workspace.list"),
      link.request<WireProjectMeta[]>("project.list"),
    ]);
    this.merge(
      environmentId,
      workspaces.map((w) => ({ ...w, environmentId })),
      projects.map((p) => ({ ...p, environmentId })),
    );
    await Promise.all([null, ...workspaces.map((w) => w.id)].map((id) => this.loadDefaults(environmentId, id)));
  }

  /** Replace one environment's slice of the lists; the other hosts' rows stay. */
  private merge(environmentId: string, workspaces?: WorkspaceMeta[], projects?: ProjectMeta[]): void {
    this.set({
      ...this.state,
      ...(workspaces
        ? { workspaces: [...this.state.workspaces.filter((w) => w.environmentId !== environmentId), ...workspaces] }
        : {}),
      ...(projects
        ? { projects: [...this.state.projects.filter((p) => p.environmentId !== environmentId), ...projects] }
        : {}),
      loaded: true,
    });
  }

  /** The thread defaults in force for a workspace on an environment (its
   *  own override, else that host's global set); undefined while nothing
   *  has loaded. */
  defaultsFor(environmentId: string, workspaceId: string | null | undefined): ThreadDefaults | undefined {
    return (
      (workspaceId ? this.state.defaults.get(scopeKey(environmentId, workspaceId)) : undefined) ??
      this.state.defaults.get(scopeKey(environmentId, null))
    )?.defaults;
  }

  /** The scope as the server reports it: effective set + override bit. */
  defaultsAt(environmentId: string, workspaceId: string | null): DefaultsScope | undefined {
    return this.state.defaults.get(scopeKey(environmentId, workspaceId));
  }

  async loadDefaults(environmentId: string, workspaceId: string | null): Promise<DefaultsScope> {
    const link = this.linkOf(environmentId);
    if (!link) return BUILT_IN_SCOPE;
    const key = scopeKey(environmentId, workspaceId);
    const scope = await link
      .request<unknown>("defaults.get", { workspaceId })
      .then(parseDefaultsScope)
      .catch(() => this.state.defaults.get(key) ?? BUILT_IN_SCOPE);
    this.setDefaults(new Map([[key, scope]]));
    return scope;
  }

  /** Store a set at the scope, or null to clear it: a workspace falls back
   *  to the global set, the global set to the built-in one. A global change
   *  reaches every workspace without an override of its own. */
  async saveDefaults(
    environmentId: string,
    workspaceId: string | null,
    defaults: ThreadDefaults | null,
  ): Promise<void> {
    const link = this.linkOf(environmentId);
    if (!link) return;
    await link.request("defaults.set", { workspaceId, defaults });
    const next = new Map<string, DefaultsScope>();
    const globalKey = scopeKey(environmentId, null);
    if (workspaceId) {
      const inherited = this.state.defaults.get(globalKey)?.defaults ?? BUILT_IN_SCOPE.defaults;
      next.set(
        scopeKey(environmentId, workspaceId),
        defaults ? { defaults, overridden: true } : { defaults: inherited, overridden: false },
      );
    } else {
      const global = defaults ? { defaults, overridden: true } : BUILT_IN_SCOPE;
      next.set(globalKey, global);
      for (const [key, scope] of this.state.defaults) {
        if (key !== globalKey && key.startsWith(`${environmentId}|`) && !scope.overridden)
          next.set(key, { defaults: global.defaults, overridden: false });
      }
    }
    this.setDefaults(next);
  }

  private setDefaults(changes: ReadonlyMap<string, DefaultsScope>): void {
    const defaults = new Map(this.state.defaults);
    for (const [id, scope] of changes) defaults.set(id, scope);
    this.set({ ...this.state, defaults });
  }

  /** The cached icon, fetching it the first time it is asked for. */
  icon(workspaceId: string): WorkspaceIcon | undefined {
    const cached = this.state.icons.get(workspaceId);
    const link = this.linkOfWorkspace(workspaceId);
    if (cached || !link || this.iconRequests.has(workspaceId)) return cached;
    this.iconRequests.add(workspaceId);
    link
      .request<WorkspaceIcon>("workspace.icon", { workspaceId })
      .then((icon) => {
        const icons = new Map(this.state.icons);
        icons.set(workspaceId, icon);
        this.set({ ...this.state, icons });
      })
      .catch(() => this.iconRequests.delete(workspaceId));
    return undefined;
  }

  private onPush(push: ServerPush, environmentId: string): void {
    if (push.push === "workspaces") {
      this.merge(environmentId, push.workspaces.map((w) => ({ ...w, environmentId })));
    } else if (push.push === "projects") {
      this.merge(environmentId, undefined, push.projects.map((p) => ({ ...p, environmentId })));
    }
  }

  private set(next: WorkspaceCatalog): void {
    this.state = next;
    for (const l of this.listeners) l();
  }
}

export const workspaceStore = new WorkspaceStore();

export function useWorkspaceCatalog(): WorkspaceCatalog {
  return useSyncExternalStore(workspaceStore.subscribe, workspaceStore.getSnapshot);
}

export function useWorkspaces(): WorkspaceMeta[] {
  return useWorkspaceCatalog().workspaces;
}

export function useProjects(): ProjectMeta[] {
  return useWorkspaceCatalog().projects;
}

export function useWorkspaceIcon(workspaceId: string | null | undefined): WorkspaceIcon | undefined {
  const { icons } = useWorkspaceCatalog();
  useEffect(() => {
    if (workspaceId) workspaceStore.icon(workspaceId);
  }, [workspaceId]);
  return workspaceId ? icons.get(workspaceId) : undefined;
}

/** A scope's thread defaults on one environment, loading them the first time they are asked for. */
export function useThreadDefaults(
  environmentId: string,
  workspaceId: string | null | undefined,
): DefaultsScope | undefined {
  const { defaults } = useWorkspaceCatalog();
  const scope = defaults.get(scopeKey(environmentId, workspaceId));
  useEffect(() => {
    if (!scope) void workspaceStore.loadDefaults(environmentId, workspaceId ?? null);
  }, [scope, environmentId, workspaceId]);
  return scope;
}
