import type { AccountPins } from "@server/shared/accounts";
import { registry, type Link } from "../connection";
import type {
  BranchList,
  ProjectCleanup,
  ProjectMeta,
  ProjectMode,
  WireProjectMeta,
  WireWorkspaceMeta,
  WorkspaceMeta,
} from "./types";
import { workspaceByPath, workspaceStore } from "./workspaces";

/**
 * Workspace and project actions, one server call each, on the environment
 * the workspace or project lives on. The server pushes the new lists to
 * every window; the refresh after each call covers a client whose push got
 * lost and lets callers read the result at once.
 */

/** The link of a workspace the catalog knows. */
export function linkOfWorkspace(workspaceId: string): Link {
  const workspace = workspaceStore.workspace(workspaceId);
  if (!workspace) throw new Error(`unknown workspace: ${workspaceId}`);
  return registry.linkOf(workspace.environmentId);
}

/** The link of a project the catalog knows. */
export function linkOfProject(projectId: string): Link {
  const project = workspaceStore.project(projectId);
  if (!project) throw new Error(`unknown project: ${projectId}`);
  return registry.linkOf(project.environmentId);
}

export async function createWorkspace(environmentId: string, path: string): Promise<WorkspaceMeta> {
  const link = registry.linkOf(environmentId);
  const meta = await link.request<WireWorkspaceMeta>("workspace.create", { path });
  await workspaceStore.refresh(link);
  return { ...meta, environmentId };
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  const link = linkOfWorkspace(workspaceId);
  await link.request("workspace.delete", { workspaceId });
  await workspaceStore.refresh(link);
}

export async function createProject(params: {
  workspaceId: string;
  name: string;
  mode: ProjectMode;
  branch?: string;
  baseRef?: string;
}): Promise<ProjectMeta> {
  const link = linkOfWorkspace(params.workspaceId);
  const meta = await link.request<WireProjectMeta>("project.create", params);
  await workspaceStore.refresh(link);
  return { ...meta, environmentId: link.environmentId };
}

export async function renameProject(
  projectId: string,
  name: string,
): Promise<void> {
  const link = linkOfProject(projectId);
  await link.request("project.rename", { projectId, name: name.trim() });
  await workspaceStore.refresh(link);
}

export async function setProjectAccounts(
  projectId: string,
  pins: AccountPins,
): Promise<void> {
  const link = linkOfProject(projectId);
  await link.request("project.setAccounts", { projectId, pins });
  await workspaceStore.refresh(link);
}

/** The project's own preamble (null clears it: threads take the workspace default). */
export async function setProjectPreamble(
  projectId: string,
  preamble: string | null,
  enabled: boolean,
): Promise<void> {
  const link = linkOfProject(projectId);
  await link.request("project.setPreamble", { projectId, preamble, enabled });
  await workspaceStore.refresh(link);
}

/** Pin a thread as the project's master (CLAUDE.md "Master threads"); null unpins. */
export async function setProjectMaster(projectId: string, threadId: string | null): Promise<void> {
  const link = linkOfProject(projectId);
  await link.request("project.setMaster", { projectId, threadId });
  await workspaceStore.refresh(link);
}

/** The workspace's default preamble for its projects without one. */
export async function setWorkspacePreamble(
  workspaceId: string,
  preamble: string | null,
  enabled: boolean,
): Promise<void> {
  const link = linkOfWorkspace(workspaceId);
  await link.request("workspace.setPreamble", { workspaceId, preamble, enabled });
  await workspaceStore.refresh(link);
}

export async function setWorkspaceAccounts(
  workspaceId: string,
  pins: AccountPins,
): Promise<void> {
  const link = linkOfWorkspace(workspaceId);
  await link.request("workspace.setAccounts", { workspaceId, pins });
  await workspaceStore.refresh(link);
}

export async function setProjectBranch(
  projectId: string,
  branch: string,
  baseRef?: string,
): Promise<void> {
  const link = linkOfProject(projectId);
  await link.request("project.setBranch", { projectId, branch, ...(baseRef ? { baseRef } : {}) });
  await workspaceStore.refresh(link);
}

export async function archiveProject(
  projectId: string,
  archived: boolean,
  cleanup?: ProjectCleanup,
): Promise<void> {
  const link = linkOfProject(projectId);
  await link.request("project.archive", {
    projectId,
    archived,
    ...(cleanup ? { cleanup } : {}),
  });
  await workspaceStore.refresh(link);
}

export async function deleteProject(
  projectId: string,
  cleanup?: ProjectCleanup,
): Promise<void> {
  const link = linkOfProject(projectId);
  await link.request("project.delete", { projectId, ...(cleanup ? { cleanup } : {}) });
  await workspaceStore.refresh(link);
}

export function listBranches(workspaceId: string): Promise<BranchList> {
  return linkOfWorkspace(workspaceId).request<BranchList>("project.branches", { workspaceId });
}

/** The environment whose project or workspace holds `cwd`, if the catalog knows one. */
export function environmentOfCwd(cwd: string): string | undefined {
  return projectForCwd(cwd)?.environmentId ?? workspaceByPath(workspaceStore.workspaces, cwd)?.environmentId;
}

/** The host a path lives on when only the path is known: the catalog's
 *  owner of it, else this machine (a folder no host has told us about is
 *  one the user opened here). The policy for path-only call sites. */
export function hostOfCwd(cwd: string): string {
  return environmentOfCwd(cwd) ?? registry.primary().environmentId;
}

/** Trailing-slash form of a directory, for prefix tests. */
export function dirPrefix(cwd: string): string {
  return cwd.endsWith("/") ? cwd : `${cwd}/`;
}

/** The server project whose cwd is, or contains, `cwd`; deepest match wins. */
export function projectForCwd(
  cwd: string,
  projects: readonly ProjectMeta[] = workspaceStore.projects,
): ProjectMeta | undefined {
  const target = cwd.replace(/\/+$/, "");
  let best: ProjectMeta | undefined;
  for (const project of projects) {
    if (project.archived) continue;
    const root = project.cwd.replace(/\/+$/, "");
    if (target !== root && !target.startsWith(`${root}/`)) continue;
    if (!best || root.length > best.cwd.replace(/\/+$/, "").length) best = project;
  }
  return best;
}
