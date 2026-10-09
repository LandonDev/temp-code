import { z } from 'zod'

// The GitHub inbox snapshot: one GraphQL pass over every GitHub workspace,
// stored in SQLite by the main process. `github.inbox` reads the store
// only; `github.inboxRefresh` is the sole path to the network, and only the
// open inbox view calls it. The gh token never appears in any result.

export interface GithubInboxAuth {
  state: 'ok' | 'missing-gh' | 'logged-out' | 'error'
  message: string
}
export interface GithubInboxPerson {
  login: string
  avatarUrl: string
}
export type GithubInboxChecks = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED' | null
export type GithubInboxReviewDecision = '' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'
export interface GithubInboxItem {
  kind: 'issue' | 'pr'
  repo: string
  number: number
  title: string
  url: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  updatedAt: string
  author: GithubInboxPerson | null
  assignees: GithubInboxPerson[]
  labels: { name: string; color: string }[]
  reviewDecision: GithubInboxReviewDecision
  headRefName: string
  baseRefName: string
  /** The latest commit's statusCheckRollup state (PRs only). */
  checks: GithubInboxChecks
  /** User logins and team slugs asked to review (PRs only). */
  reviewRequested: string[]
}
export interface GithubInboxRepo {
  repo: string
  fetchedAt: number
  /** The last error for this repo; null when its last fetch succeeded. */
  error: string | null
  items: GithubInboxItem[]
}
export interface GithubInboxSnapshot {
  /** The token's login, for "mine". */
  viewer: string | null
  auth: GithubInboxAuth
  /** The last refresh that reached GitHub (ms). */
  fetchedAt: number | null
  refreshing: boolean
  /** One per distinct github_repo across workspaces. */
  repos: GithubInboxRepo[]
}

export type GithubInboxRefreshReason = 'open' | 'manual' | 'interval'

const request = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ id: z.string(), method: z.literal(method), params })

export const GithubRequestSchemas = [
  request('github.inbox', z.object({}).optional()),
  request('github.inboxRefresh', z.object({ reason: z.enum(['open', 'manual', 'interval']) }))
] as const
