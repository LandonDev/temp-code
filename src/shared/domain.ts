import { z } from 'zod'
import type { AccountPins } from './accounts'

/**
 * The workspace → project → thread hierarchy (docs/LAYOUT.md).
 * A workspace is a folder the user added. A project is a named line of work
 * inside it, bound to a worktree or the local checkout. Threads are sessions
 * (SessionMeta) carrying a projectId + threadType.
 */

export const ThreadTypeSchema = z.enum([
  'chat',
  'planning',
  'implementation',
  'orchestration',
  'research'
])
export type ThreadType = z.infer<typeof ThreadTypeSchema>

export const ProjectModeSchema = z.enum(['worktree', 'local'])
export type ProjectMode = z.infer<typeof ProjectModeSchema>

export interface WorkspaceMeta {
  id: string
  name: string
  path: string
  /** whether the folder is a git repository (decides worktree availability) */
  git: boolean
  /** Aliax account per provider for threads under this workspace; unset means auto. */
  accountPins?: AccountPins
  /** GitHub `owner/name` from the origin remote; null when not GitHub or not yet resolved. */
  githubRepo?: string | null
  /** When `githubRepo` was last read from the git config (ms); null until the first read. */
  githubRepoCheckedAt?: number | null
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
  /** hidden from the sidebar's main list; restorable, threads kept */
  archived: boolean
  /** Aliax account per provider for this project's threads; unset inherits the workspace's. */
  accountPins?: AccountPins
  createdAt: number
}

/** Sidebar logo for a workspace: a real image (repo favicon, GitHub owner
 *  avatar) as a data URL, else the git host whose mark the renderer draws. */
export interface WorkspaceIcon {
  dataUrl: string | null
  host: 'github' | 'gitlab' | 'bitbucket' | null
}

/** What archiving/deleting a worktree project also tears down in git. */
export interface ProjectCleanup {
  worktree?: boolean
  localBranch?: boolean
  remoteBranch?: boolean
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

/** project.compare result: this checkout vs a target branch (Branch rail). */
export interface CompareResult {
  target: string
  mergeBase: string
  ahead: number
  behind: number
  /** commits only this branch has (target..HEAD), newest first, capped */
  ours: CommitInfo[]
  /** commits only the target has (HEAD..target), newest first, capped */
  theirs: CommitInfo[]
  /** files this branch changed since the merge base */
  files: FileChange[]
}

/** project.mergeFrom / project.mergeInto outcome. Conflicts never leave a
 *  half-merged tree: the operation aborts and lists the files. */
export type MergeResult =
  | {
      ok: true
      sha: string
      fastForward: boolean
      /** the checkout the merge ran in when it was not this project's own */
      where?: string
    }
  | { ok: false; conflicts: string[] }

/** project.branches result: the target-branch / create-from pickers. */
export interface BranchList {
  locals: string[]
  remotes: string[]
  current: string | null
}

/** One running language server in lsp.status (Settings visibility).
 *  'indexing' is a background warm-up job, not a servable engine. */
export interface LspStatusRow {
  serverId: string
  projectId: string
  lang: 'java' | 'web' | 'idea'
  state: 'starting' | 'downloading' | 'running' | 'error' | 'indexing'
  /** RSS of the child process, bytes (best effort) */
  memoryBytes: number | null
  /** ms since the last open surface used it */
  idleMs: number
  error?: string
}
