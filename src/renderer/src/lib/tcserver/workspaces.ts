import { useEffect, useSyncExternalStore } from "react";
import { normalizeProjectPath } from "../recents";
import { client } from "./client";
import type { Link } from "./store";
import type { ProjectMeta, ServerPush, ThreadDefaults, WorkspaceIcon, WorkspaceMeta } from "./types";
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
  private link: Link | null = null;
  private detach: (() => void)[] = [];
  private iconRequests = new Set<string>();

  connect(link: Link = client): void {
    if (this.link === link) return;
    for (const off of this.detach) off();
    this.link = link;
    this.detach = [
      link.onPush((push) => this.onPush(push)),
      link.onOpen(() => void this.refresh()),
    ];
    if (link.connected) void this.refresh();
  }

  /** Test seam. */
  reset(): void {
    for (const off of this.detach) off();
    this.detach = [];
    this.link = null;
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

  /** Re-read both lists from the server, then every scope's thread defaults. */
  async refresh(): Promise<void> {
    if (!this.link) return;
    const [workspaces, projects] = await Promise.all([
      this.link.request<WorkspaceMeta[]>("workspace.list"),
      this.link.request<ProjectMeta[]>("project.list"),
    ]);
    this.set({ ...this.state, workspaces, projects, loaded: true });
    await Promise.all([null, ...workspaces.map((w) => w.id)].map((id) => this.loadDefaults(id)));
  }

  /** The thread defaults in force for a workspace (its own override, else
   *  the global set); undefined while nothing has loaded. */
  defaultsFor(workspaceId: string | null | undefined): ThreadDefaults | undefined {
    return (
      (workspaceId ? this.state.defaults.get(workspaceId) : undefined) ??
      this.state.defaults.get(GLOBAL)
    )?.defaults;
  }

  /** The scope as the server reports it: effective set + override bit. */
  defaultsAt(workspaceId: string | null): DefaultsScope | undefined {
    return this.state.defaults.get(workspaceId ?? GLOBAL);
  }

  async loadDefaults(workspaceId: string | null): Promise<DefaultsScope> {
    if (!this.link) return BUILT_IN_SCOPE;
    const scope = await this.link
      .request<unknown>("defaults.get", { workspaceId })
      .then(parseDefaultsScope)
      .catch(() => this.state.defaults.get(workspaceId ?? GLOBAL) ?? BUILT_IN_SCOPE);
    this.setDefaults(new Map([[workspaceId ?? GLOBAL, scope]]));
    return scope;
  }

  /** Store a set at the scope, or null to clear it: a workspace falls back
   *  to the global set, the global set to the built-in one. A global change
   *  reaches every workspace without an override of its own. */
  async saveDefaults(workspaceId: string | null, defaults: ThreadDefaults | null): Promise<void> {
    if (!this.link) return;
    await this.link.request("defaults.set", { workspaceId, defaults });
    const next = new Map<string, DefaultsScope>();
    if (workspaceId) {
      const inherited = this.state.defaults.get(GLOBAL)?.defaults ?? BUILT_IN_SCOPE.defaults;
      next.set(workspaceId, defaults ? { defaults, overridden: true } : { defaults: inherited, overridden: false });
    } else {
      const global = defaults ? { defaults, overridden: true } : BUILT_IN_SCOPE;
      next.set(GLOBAL, global);
      for (const [id, scope] of this.state.defaults) {
        if (id !== GLOBAL && !scope.overridden) next.set(id, { defaults: global.defaults, overridden: false });
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
    if (cached || !this.link || this.iconRequests.has(workspaceId)) return cached;
    this.iconRequests.add(workspaceId);
    this.link
      .request<WorkspaceIcon>("workspace.icon", { workspaceId })
      .then((icon) => {
        const icons = new Map(this.state.icons);
        icons.set(workspaceId, icon);
        this.set({ ...this.state, icons });
      })
      .catch(() => this.iconRequests.delete(workspaceId));
    return undefined;
  }

  private onPush(push: ServerPush): void {
    if (push.push === "workspaces") {
      this.set({ ...this.state, workspaces: push.workspaces, loaded: true });
    } else if (push.push === "projects") {
      this.set({ ...this.state, projects: push.projects, loaded: true });
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

/** A scope's thread defaults, loading them the first time they are asked for. */
export function useThreadDefaults(workspaceId: string | null | undefined): DefaultsScope | undefined {
  const { defaults } = useWorkspaceCatalog();
  const key = workspaceId ?? GLOBAL;
  const scope = defaults.get(key);
  useEffect(() => {
    if (!scope) void workspaceStore.loadDefaults(workspaceId ?? null);
  }, [scope, workspaceId]);
  return scope;
}
