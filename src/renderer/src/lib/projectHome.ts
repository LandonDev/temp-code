import { useMemo } from "react";
import { settingsHomeOf } from "@server/shared/projectLinks";
import { LOCAL_ENVIRONMENT_ID, registry } from "./connection/registry";
import { useEnvironmentStatuses } from "./connection/status";
import { archiveProject, deleteProject, renameProject } from "./tcserver/projects";
import { useWorkspaceCatalog, workspaceStore } from "./tcserver/workspaces";
import type { ProjectCleanup, ProjectMeta, WorkspaceMeta } from "./tcserver/types";

/**
 * The settings home of a linked project (CLAUDE.md "One project across
 * hosts"): a project row whose `linkId` another host's row shares keeps its
 * settings on one copy, the box's (`settingsHomeOf`). The project dialogs
 * read from that copy and write to it over its host's link, so a Mac whose
 * own copy has not pulled the box's last edit yet never shows the old
 * values. An unlinked project is its own home.
 */

/** What the resolution needs to know about the registry slots the copies sit on. */
export interface HostFacts {
  /** The host's own id (its hello's), which `settingsHomeOf` sorts and reads platforms by. */
  hostIdOf(slot: string): string;
  /** The host's hello `build.platform`; undefined until heard. */
  platformOf(slot: string): string | undefined;
  /** The host by name, for a sentence: "box", "this Mac". */
  nameOf(slot: string): string;
  /** The host's link is open now. */
  isOpen(slot: string): boolean;
}

export interface ProjectHome {
  /** The copy every settings read and write goes to; the project itself when unlinked. */
  home: ProjectMeta;
  /** Every copy of the link the catalog holds, the project itself first. */
  copies: ProjectMeta[];
  /** Another host holds a copy. */
  linked: boolean;
  /** The home's host by name. */
  hostName: string;
  /** The home's link is open (always true for an unlinked project). */
  open: boolean;
  /** Why the home cannot take a write now ("box is offline"); null when it can. */
  blocked: string | null;
}

/** The pure half: the copies of `project` in `projects` and the one that holds the settings. */
export function resolveProjectHome(project: ProjectMeta, projects: readonly ProjectMeta[], facts: HostFacts): ProjectHome {
  const self = projects.find((p) => p.id === project.id && p.environmentId === project.environmentId) ?? project;
  const others = self.linkId
    ? projects.filter((p) => p.linkId === self.linkId && p.environmentId !== self.environmentId)
    : [];
  const copies = [self, ...others];
  if (others.length === 0) {
    return { home: self, copies, linked: false, hostName: facts.nameOf(self.environmentId), open: true, blocked: null };
  }
  const slotOfHost = new Map(copies.map((c) => [facts.hostIdOf(c.environmentId), c.environmentId]));
  const homeHost = settingsHomeOf(
    copies.map((c) => ({ environmentId: facts.hostIdOf(c.environmentId) })),
    (hostId) => facts.platformOf(slotOfHost.get(hostId) ?? hostId),
  );
  const home = copies.find((c) => facts.hostIdOf(c.environmentId) === homeHost) ?? self;
  const hostName = facts.nameOf(home.environmentId);
  const open = facts.isOpen(home.environmentId);
  return { home, copies, linked: true, hostName, open, blocked: open ? null : `${hostName} is offline` };
}

/** The registry as HostFacts: hellos for ids and platforms, the saved names, the transport. */
export const liveHostFacts: HostFacts = {
  hostIdOf: (slot) => registry.statusOf(slot).lastHello?.environmentId ?? slot,
  platformOf: (slot) => registry.statusOf(slot).lastHello?.build?.platform,
  nameOf: (slot) => (slot === LOCAL_ENVIRONMENT_ID ? "this Mac" : (registry.environment(slot)?.name ?? slot)),
  isOpen: (slot) => registry.statusOf(slot).transport === "open",
};

/** The home of `project` now, from the catalog and the registry. */
export function projectHomeNow(project: ProjectMeta): ProjectHome {
  return resolveProjectHome(project, workspaceStore.projects, liveHostFacts);
}

/** The home of `project` and its workspace, following the catalog and every host's link. */
export function useProjectHome(project: ProjectMeta): ProjectHome & { workspace: WorkspaceMeta | undefined } {
  const catalog = useWorkspaceCatalog();
  const statuses = useEnvironmentStatuses();
  return useMemo(() => {
    const resolved = resolveProjectHome(project, catalog.projects, liveHostFacts);
    const workspace = catalog.workspaces.find(
      (w) => w.id === resolved.home.workspaceId && w.environmentId === resolved.home.environmentId,
    );
    return { ...resolved, workspace };
    // statuses: the facts read the registry, which changes with them.
  }, [project, catalog, statuses]);
}

// ── actions on a link ──────────────────────────────────────────────────

/** Rename a project: on its settings home, whose copies follow. */
export async function renameLinked(projectId: string, name: string): Promise<void> {
  const project = workspaceStore.project(projectId);
  if (!project) return renameProject(projectId, name);
  const { home, blocked } = projectHomeNow(project);
  if (blocked) throw new Error(blocked);
  await renameProject(home.id, name);
}

/**
 * Archive (or restore) a project and every copy of its link, the home
 * first: a home out of reach refuses before anything changes. The cleanup
 * (worktree, branches) is the clicked copy's alone; a copy whose host is
 * offline follows from the home once it is back.
 */
export async function archiveLinked(project: ProjectMeta, archived: boolean, cleanup?: ProjectCleanup): Promise<void> {
  const { home, copies, blocked } = projectHomeNow(project);
  if (blocked) throw new Error(blocked);
  const cleanupOf = (copy: ProjectMeta) => (copy.id === project.id ? cleanup : undefined);
  await archiveProject(home.id, archived, cleanupOf(home));
  const rest = copies.filter((c) => c.id !== home.id && liveHostFacts.isOpen(c.environmentId));
  await Promise.allSettled(rest.map((c) => archiveProject(c.id, archived, cleanupOf(c))));
}

/** Delete a project, and the other copies the person picked (`alsoIds`). */
export async function deleteLinked(project: ProjectMeta, alsoIds: readonly string[], cleanup?: ProjectCleanup): Promise<void> {
  await deleteProject(project.id, cleanup);
  for (const id of alsoIds) await deleteProject(id);
}
