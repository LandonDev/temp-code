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

/** A slash reference the provider's harness understands — skill, custom
 *  command, prompt, or an addon (plugin / MCP server) it has configured. */
export interface SlashCommand {
  name: string
  description: string
  source: 'skill' | 'command' | 'prompt' | 'plugin' | 'mcp'
  scope: 'user' | 'project'
  /** absolute path of the defining file (server-side use: expansion) */
  path?: string
}

/** One changed file in a project's working tree (git-derived). */
export interface FileChange {
  path: string
  adds: number
  dels: number
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed'
}

/** One directory entry from fs.list (a single level; trees fetch lazily). */
export interface FsEntry {
  name: string
  kind: 'file' | 'dir'
  size: number
}

/** fs.read result. tooLarge (>2 MB or binary) ships no content — the
 *  viewer shows a stub instead of the buffer. */
export interface FsReadResult {
  content: string
  mtimeMs: number
  tooLarge?: boolean
}

/** One commit in project.log — the Changes rail's history list. */
export interface CommitInfo {
  sha: string
  subject: string
  authoredAt: number
}

/** project.branches result: pickers for baseRef / existingBranch. */
export interface BranchList {
  locals: string[]
  remotes: string[]
  current: string | null
}

/** One running language server in lsp.status (Settings visibility). */
export interface LspStatusRow {
  serverId: string
  projectId: string
  lang: 'java' | 'web' | 'idea'
  state: 'starting' | 'downloading' | 'running' | 'error'
  /** RSS of the child process, bytes (best effort) */
  memoryBytes: number | null
  /** ms since the last open surface used it */
  idleMs: number
  error?: string
}
