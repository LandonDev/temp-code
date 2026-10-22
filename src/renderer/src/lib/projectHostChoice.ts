import type { EnsureLinkedArgs } from "@server/shared/projectLinks";
import type { EnsureLinkedResult } from "@server/shared/wireSchemas";
import { registry } from "./connection/registry";
import type { ProjectMeta, WorkspaceMeta } from "./tcserver/types";

/**
 * Which host a new thread starts on inside a linked project (CLAUDE.md "One
 * project across hosts": copies on several hosts share a `linkId`):
 *
 * 1. the host of the thread in the active pane, when that thread is in the
 *    project;
 * 2. else the host last used for the link (remembered per link id in
 *    localStorage), while it still has a copy;
 * 3. else this machine, when it has a copy;
 * 4. else the first connected host with one.
 *
 * A host without a copy is never the default; the composer's draft host
 * picker (chrome/DraftHostPicker.tsx) and the master board's add sheet make
 * one there with `project.ensureLinked`. A thread's host never changes once
 * sent, except through the header chip's move.
 */

const KEY = "monocode.linkHosts";

type Remembered = Record<string, string>;

export function loadLinkHosts(): Remembered {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Remembered) : {};
  } catch {
    return {};
  }
}

export function rememberLinkHost(linkId: string, environmentId: string): void {
  const next = loadLinkHosts();
  if (next[linkId] === environmentId) return;
  next[linkId] = environmentId;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // private mode / quota
  }
}

type Copy = Pick<ProjectMeta, "id" | "environmentId" | "linkId" | "archived">;

/** Every live copy of a linked project, one per host. */
export function copiesOf<P extends Copy>(projects: readonly P[], linkId: string | null | undefined): P[] {
  if (!linkId) return [];
  return projects.filter((p) => p.linkId === linkId && !p.archived);
}

/** Pure: the copy a new thread starts in (the rules above). */
export function chooseCopy<P extends Copy>(args: {
  copies: readonly P[];
  /** The active pane's thread, when there is one. */
  active?: { environmentId: string; projectId?: string | null } | null;
  remembered: string | undefined;
  primary: string;
  connected: (environmentId: string) => boolean;
}): P | undefined {
  const { copies, active, remembered, primary, connected } = args;
  const on = (env: string | undefined) => (env ? copies.find((c) => c.environmentId === env) : undefined);
  const activeCopy =
    active?.projectId ? copies.find((c) => c.id === active.projectId && c.environmentId === active.environmentId) : undefined;
  return activeCopy ?? on(remembered) ?? on(primary) ?? copies.find((c) => connected(c.environmentId));
}

/** The context a new thread in `projectId` starts in: the chosen copy's, or
 *  the given one when the project is not linked or no copy fits. */
export function newThreadContext<C extends { projectId: string | null; workspaceId: string | null; cwd: string }>(
  ctx: C,
  projects: readonly ProjectMeta[],
  active: { environmentId: string; projectId?: string | null } | null | undefined,
): C {
  const project = ctx.projectId ? projects.find((p) => p.id === ctx.projectId) : undefined;
  const copies = copiesOf(projects, project?.linkId);
  if (!project?.linkId || copies.length < 2) return ctx;
  const copy = chooseCopy({
    copies,
    active,
    remembered: loadLinkHosts()[project.linkId],
    primary: registry.primaryEnvironmentId,
    connected: (id) => registry.statusOf(id).transport === "open",
  });
  return copy ? { ...ctx, projectId: copy.id, workspaceId: copy.workspaceId, cwd: copy.cwd } : ctx;
}

/** What `project.ensureLinked` needs from the caller's copy; null when the
 *  copy or its workspace carries no link id yet (the linker has not run). */
export function ensureLinkedArgs(
  project: Pick<ProjectMeta, "linkId" | "name" | "branch" | "mode" | "cwd">,
  workspace: Pick<WorkspaceMeta, "linkId" | "path"> | undefined,
): Omit<EnsureLinkedArgs, "dryRun"> | null {
  if (!project.linkId || !workspace?.linkId) return null;
  return {
    projectLinkId: project.linkId,
    workspaceLinkId: workspace.linkId,
    name: project.name,
    branch: project.branch,
    mode: project.mode,
    callerWorkspacePath: workspace.path,
    callerProjectCwd: project.cwd,
  };
}

/** A host's answer for a project it has no copy of: whether one can be made. */
export type CopyProbe = { state: "checking" } | { state: "ready" } | { state: "none"; note: string };

/** Pure: a dry run's answer as the pickers show it. A host with no checkout
 *  (no cwd) cannot take a copy; its note says why. */
export function probeOf(result: EnsureLinkedResult): CopyProbe {
  if (result.project || result.cwd) return { state: "ready" };
  return { state: "none", note: result.note ?? "No checkout of this project" };
}

/** `project.ensureLinked` on one host: a dry run, or find-or-create. The
 *  answer's project carries the host's id. */
export async function ensureLinkedOn(
  environmentId: string,
  args: Omit<EnsureLinkedArgs, "dryRun">,
  dryRun = false,
): Promise<EnsureLinkedResult & { project: ProjectMeta | null }> {
  const result = await registry.linkOf(environmentId).request<EnsureLinkedResult>("project.ensureLinked", {
    ...args,
    ...(dryRun ? { dryRun: true } : {}),
  });
  return { ...result, project: result.project ? { ...result.project, environmentId } : null };
}
