import { aliasKeys } from "./linkedRail";
import { looksLikeProject, normalizeProjectPath } from "./recents";
import type { Session } from "./session";
import type { ProjectMeta, WorkspaceMeta } from "./tcserver/types";
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

/** The key a folder is remembered under: the link's leader's path for a
 *  copy on another host (lib/linkedRail.ts), else the folder itself. */
export function folderKey(path: string, catalog: Pick<Catalog, "workspaces">): string {
  return normalizeProjectPath(aliasKeys(catalog.workspaces).path(normalizeProjectPath(path)));
}

/** Two paths name one folder: the same path, or two copies of one link. */
export function sameFolder(a: string, b: string, catalog: Pick<Catalog, "workspaces">): boolean {
  return folderKey(a, catalog) === folderKey(b, catalog);
}

/** The project picked in a folder, a linked copy's path reading the
 *  leader's memory. An entry still under a copy's own path (saved before
 *  the link) is read once and moved under the key. */
export function loadSelectedProject(
  workspacePath: string,
  catalog: Pick<Catalog, "workspaces">,
): string | null {
  const map = readMap(SELECTED_KEY);
  const key = folderKey(workspacePath, catalog);
  const raw = normalizeProjectPath(workspacePath);
  let id = map[key];
  if (!id && raw !== key && map[raw]) {
    id = map[raw];
    map[key] = id;
    delete map[raw];
    writeMap(SELECTED_KEY, map);
  }
  return typeof id === "string" && id ? id : null;
}

export function saveSelectedProject(
  workspacePath: string,
  projectId: string | null,
  catalog: Pick<Catalog, "workspaces">,
): void {
  const key = folderKey(workspacePath, catalog);
  const next = readMap(SELECTED_KEY);
  if (projectId) next[key] = projectId;
  else delete next[key];
  writeMap(SELECTED_KEY, next);
}

// ── landings ───────────────────────────────────────────────────────────

/** A scope a person comes back to (lib/projectLanding.ts `landingOf`): a
 *  project, or a workspace folder ("~" for the home). */
export type LandingScope = { projectId: string } | { workspacePath: string };

/** The rail key a session lands under: its workspace's path, or the link's
 *  leader's for a copy on another host (lib/linkedRail.ts), so a linked row
 *  reads every copy as one. */
export function landingPathOfSession(
  session: Pick<Session, "cwd" | "projectId" | "workspaceId">,
  catalog: Catalog,
): string {
  return aliasKeys(catalog.workspaces).path(workspacePathOfSession(session, catalog));
}
