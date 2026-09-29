import { looksLikeProject, normalizeProjectPath } from "./recents";
import type { Session } from "./session";
import type { ProjectMeta, SessionMeta, WorkspaceMeta } from "./tcserver/types";
import { projectOf, workspaceByPath, workspaceIndex } from "./tcserver/workspaces";

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
/** The rail key for a folder: a workspace path as itself, anything else
 *  (the home directory, a stray folder) as the "~" home where loose chats
 *  live. */
export function homeOrWorkspacePath(path: string): string {
  return looksLikeProject(path) ? normalizeProjectPath(path) : "~";
}

export function workspacePathOfSession(
  session: Pick<Session, "cwd" | "projectId" | "workspaceId">,
  catalog: Catalog,
): string {
  const project = projectOf(catalog.projects, session);
  const workspaceId = project?.workspaceId ?? session.workspaceId;
  const workspace = workspaceId
    ? workspaceIndex(catalog.workspaces).byId.get(workspaceId)
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
const LAST_SESSION_KEY = "monocode.tc.lastSession";

function readMap(storageKey: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeMap(storageKey: string, map: Record<string, string>): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(map));
  } catch {
    // private mode / quota
  }
}

export function loadSelectedProject(workspacePath: string): string | null {
  const id = readMap(SELECTED_KEY)[normalizeProjectPath(workspacePath)];
  return typeof id === "string" && id ? id : null;
}

export function saveSelectedProject(workspacePath: string, projectId: string | null): void {
  const key = normalizeProjectPath(workspacePath);
  const next = readMap(SELECTED_KEY);
  if (projectId) next[key] = projectId;
  else delete next[key];
  writeMap(SELECTED_KEY, next);
}

// ── the last thread per project / workspace ────────────────────────────

/** Where a landing is remembered: a project, or a workspace folder. */
export type LandingScope = { projectId: string } | { workspacePath: string };

const scopeKey = (scope: LandingScope): string =>
  "projectId" in scope
    ? `proj:${scope.projectId}`
    : `ws:${homeOrWorkspacePath(scope.workspacePath)}`;

export function loadLastSession(scope: LandingScope): string | null {
  const id = readMap(LAST_SESSION_KEY)[scopeKey(scope)];
  return typeof id === "string" && id ? id : null;
}

export function saveLastSession(scope: LandingScope, sessionId: string): void {
  const key = scopeKey(scope);
  const next = readMap(LAST_SESSION_KEY);
  if (next[key] === sessionId) return;
  next[key] = sessionId;
  writeMap(LAST_SESSION_KEY, next);
}

/** Every scope that remembered this thread lets it go (delete, archive). */
export function forgetLastSession(sessionId: string): void {
  const map = readMap(LAST_SESSION_KEY);
  const keys = Object.keys(map).filter((key) => map[key] === sessionId);
  if (keys.length === 0) return;
  for (const key of keys) delete map[key];
  writeMap(LAST_SESSION_KEY, map);
}

/** The thread a scope lands on: the remembered one while it still exists,
 *  is not archived and still belongs to the scope (a moved workspace or a
 *  thread moved out of its project forgets). Null means seed a blank one. */
export function resolveLanding(
  scope: LandingScope,
  metas: readonly SessionMeta[],
  catalog: Catalog,
): string | null {
  const id = loadLastSession(scope);
  if (!id) return null;
  const meta = metas.find((m) => m.id === id);
  // A subagent renders on its parent's board and is never a landing.
  if (!meta || meta.archived || meta.parentId) return null;
  if ("projectId" in scope) return meta.projectId === scope.projectId ? id : null;
  const here = homeOrWorkspacePath(scope.workspacePath);
  return homeOrWorkspacePath(workspacePathOfSession(meta, catalog)) === here ? id : null;
}
