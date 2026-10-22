import { existsSync, statSync } from 'node:fs'
import { projectMatchKey, type EnsureLinkedArgs } from '@shared/projectLinks'
import type { EnsureLinkedResult } from '@shared/wireSchemas'
import type { ProjectMeta, ProjectMode, WorkspaceMeta } from '@shared/domain'
import { stripSlash, type HistoryMapping } from './pathMap'
import { hostPathFor } from './remote/crossHostThreads'

/**
 * `project.ensureLinked` (docs/box.md "One project across hosts: a far
 * start lands in the linked project"): the one function that finds or
 * creates this host's copy of a linked project. A cross-host start
 * (remote/crossHostThreads.ts `place`) and the pickers (the draft host
 * picker, the master board's add sheet) call it before a thread lands here,
 * so the thread's `projectId` is never null for a project the caller has.
 *
 * Resolution order:
 *  1. a project with the link id → it;
 *  2. the workspace: by its link id, else by the caller's workspace folder
 *     mapped onto this host (`hostPathFor`; a folder with no row gets one),
 *     else by its GitHub repo;
 *  3. in that workspace, an unlinked project of the same name is adopted
 *     (the linker's own rule, shared/projectLinks.ts), else the project is
 *     created with the caller's name, branch and mode: a worktree copy
 *     adopts the branch when this host has it, and a failed worktree falls
 *     back to a local copy at the workspace path, with a note;
 *  4. no workspace → no cwd, and a note naming the folder that is missing.
 * Every row it finds unlinked or creates carries the caller's ids. `dryRun`
 * answers what would happen and changes nothing.
 */

export interface EnsureLinkedDeps {
  listProjects(): ProjectMeta[]
  listWorkspaces(): WorkspaceMeta[]
  /** The registry's create (sessions.ts createWorkspace), born with the link id. */
  createWorkspace(path: string, opts: { linkId: string }): Promise<WorkspaceMeta>
  /** The registry's create (sessions.ts createProject; a worktree through addProjectWorktree), born with the link id. */
  createProject(workspaceId: string, name: string, mode: ProjectMode, opts: { branch?: string; linkId: string }): Promise<ProjectMeta>
  /** Stamp ids on rows that exist (sessions.ts linkCatalog: it pushes the catalog). */
  linkCatalog(args: { workspaces: { id: string; linkId: string }[]; projects: { id: string; linkId: string }[] }): void
  /** This host's path map (remote/harnessSync.ts pathMap). */
  pathMap(): HistoryMapping
  /** Where this host's checkouts live (workRoot.ts). */
  workRoot(): string
  /** Whether a folder is there; tests pass their own. */
  exists?(path: string): boolean
}

const isDir = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

const oldest = <T extends { createdAt: number; id: string }>(rows: readonly T[]): T | null =>
  rows.reduce<T | null>((a, b) => (!a || b.createdAt < a.createdAt || (b.createdAt === a.createdAt && b.id < a.id) ? b : a), null)

const folderName = (path: string): string => stripSlash(path).split('/').pop() || path

interface WorkspaceFound {
  /** the row, when one is here */
  row: WorkspaceMeta | null
  /** a folder with no row yet: where one would be made */
  createAt: string | null
  /** the folder the caller's workspace maps to here, whether or not it exists */
  lookedFor: string | null
}

function findWorkspace(deps: EnsureLinkedDeps, args: EnsureLinkedArgs): WorkspaceFound {
  const workspaces = deps.listWorkspaces()
  const byLink = oldest(workspaces.filter((w) => w.linkId === args.workspaceLinkId))
  if (byLink) return { row: byLink, createAt: null, lookedFor: null }
  const exists = deps.exists ?? isDir
  const mapped = hostPathFor(args.callerWorkspacePath, deps.pathMap(), stripSlash(deps.workRoot()), args.callerWorkRoot, exists)
  if (mapped?.exists) {
    const row = oldest(workspaces.filter((w) => stripSlash(w.path) === mapped.path))
    return { row, createAt: row ? null : mapped.path, lookedFor: mapped.path }
  }
  const repo = args.workspaceGithubRepo?.trim().toLowerCase()
  const byRepo = repo ? oldest(workspaces.filter((w) => w.githubRepo?.trim().toLowerCase() === repo)) : null
  return { row: byRepo, createAt: null, lookedFor: mapped?.path ?? null }
}

export async function ensureLinked(deps: EnsureLinkedDeps, args: EnsureLinkedArgs): Promise<EnsureLinkedResult> {
  const projects = deps.listProjects()
  const linked = oldest(projects.filter((p) => p.linkId === args.projectLinkId))
  if (linked) return { cwd: linked.cwd, exists: true, project: linked, note: null }

  const ws = findWorkspace(deps, args)
  if (!ws.row && !ws.createAt) {
    const looked = ws.lookedFor ? ` (looked for ${ws.lookedFor})` : ''
    const where = args.dryRun ? '' : `; the thread starts in its work root ${stripSlash(deps.workRoot())}`
    return { cwd: null, exists: false, project: null, note: `no checkout of ${folderName(args.callerWorkspacePath)} on this host${looked}${where}` }
  }

  // The linker's own rule: an unlinked project of the same name in this workspace is this copy.
  const key = projectMatchKey(args.name)
  const same = ws.row ? oldest(projects.filter((p) => p.workspaceId === ws.row!.id && !p.linkId && projectMatchKey(p.name) === key)) : null
  const stampWorkspace = ws.row && !ws.row.linkId ? [{ id: ws.row.id, linkId: args.workspaceLinkId }] : []
  if (same) {
    if (!args.dryRun) deps.linkCatalog({ workspaces: stampWorkspace, projects: [{ id: same.id, linkId: args.projectLinkId }] })
    const project = { ...same, linkId: args.projectLinkId }
    return { cwd: project.cwd, exists: true, project, note: null }
  }

  if (args.dryRun) {
    const local = args.mode === 'worktree' && ws.row && !ws.row.git
    return {
      cwd: ws.row?.path ?? ws.createAt,
      exists: false,
      project: null,
      note: local ? `a local copy at ${ws.row!.path}: it is not a git repository` : null
    }
  }

  const workspace = ws.row ?? (await deps.createWorkspace(ws.createAt!, { linkId: args.workspaceLinkId }))
  if (stampWorkspace.length) deps.linkCatalog({ workspaces: stampWorkspace, projects: [] })
  if (args.mode === 'worktree') {
    try {
      const project = await deps.createProject(workspace.id, args.name, 'worktree', {
        ...(args.branch ? { branch: args.branch } : {}),
        linkId: args.projectLinkId
      })
      return { cwd: project.cwd, exists: false, project, note: null }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      const project = await deps.createProject(workspace.id, args.name, 'local', { linkId: args.projectLinkId })
      return { cwd: project.cwd, exists: false, project, note: `a local copy at ${workspace.path}: the worktree failed (${why})` }
    }
  }
  const project = await deps.createProject(workspace.id, args.name, 'local', { linkId: args.projectLinkId })
  return { cwd: project.cwd, exists: false, project, note: null }
}
