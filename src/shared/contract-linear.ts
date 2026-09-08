import { z } from 'zod'

// Linear (M11). Donor DTOs from monocode/src-tauri/src/linear.rs; the
// renderer's lib/linear.ts declares the same shapes. The token never
// appears in any result.

export interface LinearStatus {
  connected: boolean
}
export interface LinearTeam {
  id: string
  key: string
  name: string
}
export interface LinearLabel {
  name: string
  color: string
}
export interface LinearAssignee {
  login: string
  avatarUrl: string
}
export interface LinearIssue {
  provider: 'linear'
  kind: 'linear'
  id: string
  identifier: string
  number: number
  title: string
  url: string
  state: string
  stateType: string
  updatedAt: string
  labels: LinearLabel[]
  assignees: LinearAssignee[]
  draft: boolean
  repo: string
  teamId: string
  teamName: string
  projectPath: string
}
export interface LinearIssueDetails {
  body: string
  author: string
  authorAvatarUrl: string
}
export interface LinearIssueComment {
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
  replies: LinearIssueComment[]
}
export interface LinearIssueThread {
  comments: LinearIssueComment[]
  truncated: boolean
  reviewDecision: string
  baseRefName: string
  headRefName: string
}

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const LinearRequestSchemas = [
  request('linear.status', z.object({}).optional()),
  request('linear.setToken', z.object({ token: z.string() })),
  request('linear.teams', z.object({}).optional()),
  request(
    'linear.issues',
    z.object({
      assignedToMe: z.boolean(),
      state: z.enum(['open', 'all']),
      teamIds: z.array(z.string()),
      limit: z.number().int().min(1).max(100).optional()
    })
  ),
  request('linear.details', z.object({ id: z.string() })),
  request('linear.thread', z.object({ id: z.string() })),
  request(
    'linear.comment',
    z.object({ id: z.string(), body: z.string(), parentId: z.string().optional().default('') })
  )
] as const
