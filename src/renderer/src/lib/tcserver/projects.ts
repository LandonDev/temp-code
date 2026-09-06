import { client } from "./client";
import type { Link } from "./store";
import type {
  BranchList,
  ProjectCleanup,
  ProjectMeta,
  ProjectMode,
  WorkspaceMeta,
} from "./types";
import { workspaceStore } from "./workspaces";

/**
 * Workspace and project actions, one server call each. The server pushes
 * the new lists to every window; the refresh after each call covers a
 * client whose push got lost and lets callers read the result at once.
 */

export async function createWorkspace(path: string, link: Link = client): Promise<WorkspaceMeta> {
  const meta = await link.request<WorkspaceMeta>("workspace.create", { path });
  await workspaceStore.refresh();
  return meta;
}

export async function deleteWorkspace(workspaceId: string, link: Link = client): Promise<void> {
  await link.request("workspace.delete", { workspaceId });
  await workspaceStore.refresh();
}

export async function createProject(
  params: {
    workspaceId: string;
    name: string;
    mode: ProjectMode;
    branch?: string;
    baseRef?: string;
  },
  link: Link = client,
): Promise<ProjectMeta> {
  const meta = await link.request<ProjectMeta>("project.create", params);
  await workspaceStore.refresh();
  return meta;
}

export async function renameProject(
  projectId: string,
  name: string,
  link: Link = client,
): Promise<void> {
  await link.request("project.rename", { projectId, name: name.trim() });
  await workspaceStore.refresh();
}

export async function setProjectBranch(
  projectId: string,
  branch: string,
  baseRef?: string,
  link: Link = client,
): Promise<void> {
  await link.request("project.setBranch", { projectId, branch, ...(baseRef ? { baseRef } : {}) });
  await workspaceStore.refresh();
}

export async function archiveProject(
  projectId: string,
  archived: boolean,
  cleanup?: ProjectCleanup,
  link: Link = client,
): Promise<void> {
  await link.request("project.archive", {
    projectId,
    archived,
    ...(cleanup ? { cleanup } : {}),
  });
  await workspaceStore.refresh();
}

export async function deleteProject(
  projectId: string,
  cleanup?: ProjectCleanup,
  link: Link = client,
): Promise<void> {
  await link.request("project.delete", { projectId, ...(cleanup ? { cleanup } : {}) });
  await workspaceStore.refresh();
}

export function listBranches(workspaceId: string, link: Link = client): Promise<BranchList> {
  return link.request<BranchList>("project.branches", { workspaceId });
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
