import { normalizeProjectPath } from "./recents";
import type { Session } from "./session";
import type { ProjectMeta, WorkspaceMeta } from "./tcserver/types";
import { workspaceByPath } from "./tcserver/workspaces";

/**
 * Where a new session runs and which server ids it carries. Every
 * user-initiated creation path in App resolves through here, so a session
 * never ends up with a cwd but no ids.
 */

export type ResolvedContext = {
  projectId: string | null;
  workspaceId: string | null;
  cwd: string;
};

export type Catalog = {
  workspaces: readonly WorkspaceMeta[];
  projects: readonly ProjectMeta[];
};

function liveProject(projects: readonly ProjectMeta[], id: string | null | undefined) {
  return id ? projects.find((p) => p.id === id && !p.archived) : undefined;
}

/** The selected project when there is one, else a loose chat in the workspace at `workspacePath`. */
export function resolveSessionContext(
  args: Catalog & { projectId: string | null; workspacePath: string },
): ResolvedContext {
  const project = liveProject(args.projects, args.projectId);
  if (project) {
    return { projectId: project.id, workspaceId: project.workspaceId, cwd: project.cwd };
  }
  const workspace = workspaceByPath(args.workspaces, args.workspacePath);
  return {
    projectId: null,
    workspaceId: workspace?.id ?? null,
    cwd: workspace?.path ?? args.workspacePath,
  };
}

/** Context for a folder the user pointed at: the project living there
 *  (the selected one first), else the workspace, else the bare path. */
export function contextForCwd(
  args: Catalog & { cwd: string; preferProjectId?: string | null },
): ResolvedContext {
  const key = normalizeProjectPath(args.cwd);
  const preferred = liveProject(args.projects, args.preferProjectId);
  const project =
    preferred && normalizeProjectPath(preferred.cwd) === key
      ? preferred
      : args.projects.find((p) => !p.archived && normalizeProjectPath(p.cwd) === key);
  if (project) {
    return { projectId: project.id, workspaceId: project.workspaceId, cwd: project.cwd };
  }
  const workspace = workspaceByPath(args.workspaces, args.cwd);
  return { projectId: null, workspaceId: workspace?.id ?? null, cwd: args.cwd };
}

/** A copy of an existing session keeps its ids; one without any is placed by its cwd. */
export function contextOfSession(
  session: Pick<Session, "cwd" | "projectId" | "workspaceId">,
  catalog: Catalog,
): ResolvedContext {
  if (session.projectId || session.workspaceId) {
    return {
      projectId: session.projectId ?? null,
      workspaceId: session.workspaceId ?? null,
      cwd: session.cwd,
    };
  }
  return contextForCwd({ ...catalog, cwd: session.cwd });
}

/** The workspace folder a session's tab belongs to on the rail: a
 *  worktree thread lists under its workspace, not its worktree dir. */
export function workspacePathOfSession(
  session: Pick<Session, "cwd" | "projectId" | "workspaceId">,
  catalog: Catalog,
): string {
  const project = session.projectId
    ? catalog.projects.find((p) => p.id === session.projectId)
    : undefined;
  const workspaceId = project?.workspaceId ?? session.workspaceId;
  const workspace = workspaceId
    ? catalog.workspaces.find((w) => w.id === workspaceId)
    : undefined;
  return workspace?.path ?? session.cwd;
}

/** Sessions with their cwd swapped for the workspace path, for the
 *  path-keyed tab and rail helpers. */
export function rebaseToWorkspace<T extends Pick<Session, "cwd" | "projectId" | "workspaceId">>(
  sessions: T[],
  catalog: Catalog,
): T[] {
  let changed = false;
  const out = sessions.map((s) => {
    const cwd = workspacePathOfSession(s, catalog);
    if (cwd === s.cwd) return s;
    changed = true;
    return { ...s, cwd };
  });
  return changed ? out : sessions;
}

// ── selection persistence ──────────────────────────────────────────────

const SELECTED_KEY = "monocode.tc.selectedProject";

function readSelected(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SELECTED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function loadSelectedProject(workspacePath: string): string | null {
  const id = readSelected()[normalizeProjectPath(workspacePath)];
  return typeof id === "string" && id ? id : null;
}

export function saveSelectedProject(workspacePath: string, projectId: string | null): void {
  const key = normalizeProjectPath(workspacePath);
  const next = readSelected();
  if (projectId) next[key] = projectId;
  else delete next[key];
  try {
    localStorage.setItem(SELECTED_KEY, JSON.stringify(next));
  } catch {
    // private mode / quota
  }
}
