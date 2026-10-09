import { z } from 'zod'

const cwdParams = z.object({ cwd: z.string() })
const fileParams = cwdParams.extend({ relative: z.string() })
const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const FsGitRequestSchemas = [
  z.object({
    id: z.string(),
    method: z.literal('github.details'),
    params: z.object({
      cwd: z.string(),
      kind: z.enum(['issue', 'pr']),
      number: z.number().int(),
      /** owner/name when the caller knows it: saves gh a repo lookup */
      repo: z.string().optional()
    })
  }),
  z.object({
    id: z.string(),
    method: z.literal('github.thread'),
    params: z.object({
      cwd: z.string(),
      kind: z.enum(['issue', 'pr']),
      number: z.number().int().positive(),
      repo: z.string().optional()
    })
  }),
  z.object({
    id: z.string(),
    method: z.literal('github.comment'),
    params: z.object({
      cwd: z.string(),
      kind: z.enum(['issue', 'pr']),
      number: z.number().int().positive(),
      body: z.string(),
      inReplyTo: z.string().optional().default('')
    })
  }),
  z.object({
    id: z.string(),
    method: z.literal('github.prDiff'),
    params: z.object({ cwd: z.string(), number: z.number().int().positive() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('github.prStatus'),
    params: z.object({ cwd: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('github.createPr'),
    params: z.object({
      cwd: z.string(),
      title: z.string(),
      body: z.string(),
      base: z.string(),
      head: z.string()
    })
  })
,
  z.object({
    id: z.string(),
    method: z.literal('fs.listPath'),
    params: z.object({ path: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('fs.projectFiles'),
    params: z.object({ cwd: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('fs.createPath'),
    params: z.object({ parent: z.string(), name: z.string(), isDir: z.boolean() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('fs.renamePath'),
    params: z.object({ path: z.string(), name: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('fs.deletePath'),
    params: z.object({ path: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('fs.copyPath'),
    params: z.object({ from: z.string(), destParent: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('fs.movePath'),
    params: z.object({ from: z.string(), destParent: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('fs.readPreview'),
    params: z.object({
      path: z.string(),
      maxLines: z.number(),
      startLine: z.number().optional()
    })
  }),
  z.object({
    id: z.string(),
    method: z.literal('fs.statFiles'),
    params: z.object({ paths: z.array(z.string()).max(64) })
  }),
  z.object({
    id: z.string(),
    method: z.literal('fs.inspectPaths'),
    params: z.object({ paths: z.array(z.string()) })
  }),
  z.object({
    id: z.string(),
    method: z.literal('fs.readBase64'),
    params: z.object({ path: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('fs.readText'),
    params: z.object({ path: z.string() })
  }),
  z.object({
    id: z.string(),
    method: z.literal('fs.writeText'),
    params: z.object({ path: z.string(), content: z.string() })
  })
,
  request('git.diffStats', cwdParams),
  request('git.diffIndex', cwdParams),
  request('git.fileDiff', fileParams.extend({ base: z.enum(['index', 'HEAD']).optional() })),
  request('git.stagedContext', cwdParams),
  request('git.rangeContext', cwdParams),
  request('git.branches', cwdParams),
  request('git.clone', z.object({ url: z.string(), parent: z.string() })),
  request('git.stageFile', fileParams),
  request('git.stageContents', fileParams.extend({ contents: z.string() })),
  request('git.unstageFile', fileParams),
  request('git.discardFile', fileParams),
  request('git.stageAll', cwdParams),
  request('git.unstageAll', cwdParams),
  request('git.commitStaged', cwdParams.extend({ message: z.string() })),
  request('git.push', cwdParams),
  request('git.pull', cwdParams),
  request('git.sync', cwdParams),
  request('git.checkout', cwdParams.extend({ name: z.string(), remote: z.string().nullish() })),
  request('git.createBranch', cwdParams.extend({ name: z.string() })),
  request('git.stash', cwdParams.extend({ message: z.string().nullish() })),
  request('git.log', cwdParams.extend({ limit: z.number().int().optional() }))
] as const

export type FsGitRequest = z.infer<(typeof FsGitRequestSchemas)[number]>

export interface GitDiffStats {
  files: number
  additions: number
  deletions: number
}
export interface GitChangedFile {
  path: string
  relative: string
  status: string
  additions: number
  deletions: number
  staged: boolean
  unstaged: boolean
}
export interface GitDiffIndex {
  branch: string | null
  files: GitChangedFile[]
  additions: number
  deletions: number
  remote: string | null
  upstream: string | null
  defaultBranch: string | null
  ahead: number
  behind: number
  aheadOfDefault: number
}
export interface GitFileDiff {
  path: string
  relative: string
  status: string
  original: string
  current: string
  binary: boolean
  tooLarge: boolean
}
export interface GitStagedContext {
  branch: string | null
  summary: string
  patch: string
}
export interface GitRangeContext {
  base: string
  head: string
  commitSummary: string
  diffSummary: string
  diffPatch: string
}
export interface GitBranchInfo {
  name: string
  current: boolean
  remote: string | null
}
export interface GitBranches {
  current: string | null
  detached: boolean
  branches: GitBranchInfo[]
}
export interface GitLogEntry {
  hash: string
  short: string
  subject: string
  author: string
  /** ISO 8601 author date. */
  date: string
}

export interface FsPathEntry {
  name: string
  path: string
  isDir: boolean
  ignored: boolean
}

export interface FsProjectFile {
  name: string
  path: string
  relative: string
}

export interface FsFileMtime {
  path: string
  mtimeMs: number | null
}

export interface FsPathInfo {
  path: string
  name: string
  size: number
  isDir: boolean
}

export interface FsPathResultMap {
  'fs.listPath': FsPathEntry[]
  'fs.projectFiles': FsProjectFile[]
  'fs.createPath': string
  'fs.renamePath': string
  'fs.deletePath': null
  'fs.copyPath': string
  'fs.movePath': string
  'fs.readPreview': string[]
  'fs.statFiles': FsFileMtime[]
  'fs.inspectPaths': FsPathInfo[]
  'fs.readBase64': string
  'fs.readText': string
  'fs.writeText': null
}

export type GitHubTaskKind = 'issue' | 'pr'

export interface GitHubLabel {
  name: string
  color: string
}

export interface GitHubAssignee {
  login: string
  avatarUrl: string
}

export interface GitHubWorkItem {
  kind: GitHubTaskKind
  number: number
  title: string
  url: string
  state: string
  updatedAt: string
  labels: GitHubLabel[]
  assignees: GitHubAssignee[]
  draft: boolean
  repo: string
}

export interface GitHubWorkItemDetails {
  body: string
  author: string
  authorAvatarUrl: string
  baseRefName: string
  headRefName: string
  reviewDecision: string
}

export interface GitHubWorkItemComment {
  id: string
  kind: string
  author: string
  authorAvatarUrl: string
  body: string
  createdAt: string
  url: string
  state: string
  path: string
  line: number | null
  resolved: boolean
  threadId: string
  replies: GitHubWorkItemComment[]
}

export interface GitHubWorkItemThread {
  comments: GitHubWorkItemComment[]
  truncated: boolean
  reviewDecision: string
  baseRefName: string
  headRefName: string
}

export interface GitHubPrFile {
  path: string
  additions: number
  deletions: number
}

export interface GitHubPrDiff {
  additions: number
  deletions: number
  files: GitHubPrFile[]
  patch: string
  truncated: boolean
}

export interface GitHubPr {
  number: number
  title: string
  url: string
  state: string
}

