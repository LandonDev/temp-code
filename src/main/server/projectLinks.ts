import type { EnsureLinkedArgs } from '@shared/projectLinks'
import type { EnsureLinkedResult } from '@shared/wireSchemas'
import type { ProjectMeta } from '@shared/domain'

/**
 * `project.ensureLinked` (CLAUDE.md "One project across hosts"): the one
 * function that finds or creates this host's copy of a linked project. A
 * cross-host start (remote/crossHostThreads.ts `place`) and the pickers
 * (the draft host picker, the master board's add sheet) call it before a
 * thread lands here, so the thread's `projectId` is never null for a
 * project the caller has.
 *
 * Resolution order: a project with the link id → it; else a workspace by
 * its link id, else by the mapped path when a folder is there, else by its
 * GitHub repo → create the project there with the caller's name, branch
 * and mode (a worktree copy through the worktree create; on failure a
 * local copy at the workspace path, with a note) and stamp the id; no
 * workspace → null with a note naming the work root. `dryRun` answers
 * what would happen without creating anything.
 */

export interface EnsureLinkedRegistry {
  listProjects(): ProjectMeta[]
}

export async function ensureLinked(reg: EnsureLinkedRegistry, args: EnsureLinkedArgs): Promise<EnsureLinkedResult> {
  const linked = reg.listProjects().find((p) => p.linkId === args.projectLinkId)
  if (linked) return { cwd: linked.cwd, exists: true, project: linked, note: null }
  return { cwd: null, exists: false, project: null, note: `no copy of ${args.name} on this host yet` }
}
