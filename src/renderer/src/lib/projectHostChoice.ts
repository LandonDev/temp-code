import type { EnsureLinkedArgs } from "@server/shared/projectLinks";
import type { EnsureLinkedResult } from "@server/shared/wireSchemas";
import { DEFAULT_START_ON, type StartOn } from "@server/shared/defaults";
import { startOnHostOf } from "@server/shared/projectLinks";
import { registry } from "./connection/registry";
import { platformOf } from "./hostPlatform";
import { workspaceStore } from "./tcserver/workspaces";
import type { ProjectMeta, WorkspaceMeta } from "./tcserver/types";

/**
 * Which host a new thread starts on inside a linked project (CLAUDE.md "One
 * project across hosts": copies on several hosts share a `linkId`):
 *
 * 1. the host of the thread in the active pane, when that thread is in the
 *    project;
 * 2. else the host "New threads start on" names (the project's own setting,
 *    else Thread defaults', else the box: `startOnOf`), when it has a copy
 *    and its link is open;
 * 3. else another connected host with a copy;
 * 4. else the named host's copy, offline as it is.
 *
 * A host without a copy is never the default; the composer's draft host
 * picker (chrome/DraftHostPicker.tsx) and the master board's add sheet make
 * one there with `project.ensureLinked`. A pick there retargets that one
 * draft and is not remembered. A thread's host never changes once sent,
 * except through the header chip's move.
 */

type Copy = Pick<ProjectMeta, "id" | "environmentId" | "linkId" | "archived">;

/** Every live copy of a linked project, one per host. */
export function copiesOf<P extends Copy>(projects: readonly P[], linkId: string | null | undefined): P[] {
  if (!linkId) return [];
  return projects.filter((p) => p.linkId === linkId && !p.archived);
}

/** Pure: the value in force for a project. The copies agree once the
 *  settings follower has run; the one stamped last speaks for them. A
 *  project without its own follows `global` (Thread defaults), absent the box. */
export function startOnOf(
  copies: readonly Pick<ProjectMeta, "startOn" | "settingsUpdatedAt">[],
  global: StartOn | undefined,
): StartOn {
  const newest = [...copies].sort((a, b) => (b.settingsUpdatedAt ?? -1) - (a.settingsUpdatedAt ?? -1))[0];
  return newest?.startOn ?? global ?? DEFAULT_START_ON;
}

/** The global "New threads start on" (Thread defaults on this machine's
 *  host, whose one copy lives on the box); the box until it has loaded. */
export function globalStartOn(): StartOn | undefined {
  return workspaceStore.defaultsAt(registry.primaryEnvironmentId, null)?.defaults.startOn;
}

/** Pure: the copy a new thread starts in (the rules above). */
export function chooseCopy<P extends Copy>(args: {
  copies: readonly P[];
  /** The active pane's thread, when there is one. */
  active?: { environmentId: string; projectId?: string | null } | null;
  startOn: StartOn;
  platformOf: (environmentId: string) => string | undefined;
  connected: (environmentId: string) => boolean;
}): P | undefined {
  const { copies, active, startOn, platformOf, connected } = args;
  const activeCopy = active?.projectId
    ? copies.find((c) => c.id === active.projectId && c.environmentId === active.environmentId)
    : undefined;
  if (activeCopy) return activeCopy;
  const named = startOnHostOf(copies, platformOf, startOn);
  const namedCopy = named ? copies.find((c) => c.environmentId === named) : undefined;
  if (namedCopy && connected(namedCopy.environmentId)) return namedCopy;
  return copies.find((c) => c !== namedCopy && connected(c.environmentId)) ?? namedCopy;
}

const linkOpen = (id: string) => registry.statusOf(id).transport === "open";

/** The host a new thread of these copies starts on with nothing on screen to decide it. */
export function preferredHost(copies: readonly ProjectMeta[]): string | null {
  if (copies.length === 0) return null;
  const copy = chooseCopy({ copies, startOn: startOnOf(copies, globalStartOn()), platformOf, connected: linkOpen });
  return copy?.environmentId ?? null;
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
    startOn: startOnOf(copies, globalStartOn()),
    platformOf,
    connected: linkOpen,
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
