import { z } from 'zod'

/**
 * The workspace → project → thread hierarchy (docs/LAYOUT.md).
 * A workspace is a folder the user added. A project is a named line of work
 * inside it, bound to a worktree or the local checkout. Threads are sessions
 * (SessionMeta) carrying a projectId + threadType.
 */

export const ThreadTypeSchema = z.enum(['chat', 'planning', 'implementation', 'orchestration'])
export type ThreadType = z.infer<typeof ThreadTypeSchema>

export const ProjectModeSchema = z.enum(['worktree', 'local'])
export type ProjectMode = z.infer<typeof ProjectModeSchema>

export interface WorkspaceMeta {
  id: string
  name: string
  path: string
  /** whether the folder is a git repository (decides worktree availability) */
  git: boolean
  createdAt: number
}

export interface ProjectMeta {
  id: string
  workspaceId: string
  name: string
  mode: ProjectMode
  /** branch the project works on (tc/<slug> for worktrees; checkout branch for local) */
  branch: string | null
  /** where the project's threads run: the worktree dir, or the workspace path */
  cwd: string
  createdAt: number
}

/** One changed file in a project's working tree (git-derived). */
export interface FileChange {
  path: string
  adds: number
  dels: number
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed'
}
