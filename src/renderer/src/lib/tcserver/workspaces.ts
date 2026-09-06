import { useEffect, useSyncExternalStore } from "react";
import { normalizeProjectPath } from "../recents";
import { client } from "./client";
import type { Link } from "./store";
import type { ProjectMeta, ServerPush, ThreadDefaults, WorkspaceIcon, WorkspaceMeta } from "./types";

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
  /** Thread defaults per workspace id ("" = global); null = not set at that scope. */
  defaults: ReadonlyMap<string, ThreadDefaults | null>;
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

export function workspaceByPath(
  workspaces: readonly WorkspaceMeta[],
  path: string | null | undefined,
): WorkspaceMeta | undefined {
  if (!path || path === "~") return undefined;
  const key = normalizeProjectPath(path);
  return workspaces.find((w) => normalizeProjectPath(w.path) === key);
}

export function projectOf(
  projects: readonly ProjectMeta[],
  session: Pick<SessionLike, "projectId">,
): ProjectMeta | undefined {
  return session.projectId ? projects.find((p) => p.id === session.projectId) : undefined;
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

  /** The thread defaults that apply to a workspace: its own override, else
   *  the global set, else undefined while neither has loaded. */
  defaultsFor(workspaceId: string | null | undefined): ThreadDefaults | null | undefined {
    const own = workspaceId ? this.state.defaults.get(workspaceId) : undefined;
    if (own) return own;
    return this.state.defaults.get(GLOBAL);
  }

  /** The override stored at exactly this scope (null when unset). */
  defaultsAt(workspaceId: string | null): ThreadDefaults | null | undefined {
    return this.state.defaults.get(workspaceId ?? GLOBAL);
  }

  async loadDefaults(workspaceId: string | null): Promise<ThreadDefaults | null> {
    if (!this.link) return null;
    const value = await this.link
      .request<ThreadDefaults | null>("defaults.get", { workspaceId })
      .catch(() => null);
    this.setDefaults(workspaceId, value);
    return value;
  }

  async saveDefaults(workspaceId: string | null, defaults: ThreadDefaults | null): Promise<void> {
    if (!this.link) return;
    await this.link.request("defaults.set", { workspaceId, defaults });
    this.setDefaults(workspaceId, defaults);
  }

  private setDefaults(workspaceId: string | null, value: ThreadDefaults | null): void {
    const defaults = new Map(this.state.defaults);
    defaults.set(workspaceId ?? GLOBAL, value);
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
