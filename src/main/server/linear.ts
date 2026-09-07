import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClientRequest } from '@shared/contract'
import type {
  LinearAssignee,
  LinearIssue,
  LinearIssueComment,
  LinearIssueDetails,
  LinearIssueThread,
  LinearLabel,
  LinearStatus,
  LinearTeam
} from '@shared/contract-linear'

/**
 * Linear in the Inbox (M11). Port of monocode/src-tauri/src/linear.rs: a
 * GraphQL client with a 20 s timeout and a personal API key stored in a
 * 0600 file under userData. The key is read on every call, never cached in
 * a response, never logged, and scrubbed from any error text.
 */

const LINEAR_API = 'https://api.linear.app/graphql'
const HTTP_TIMEOUT_MS = 20_000
const DEFAULT_LIMIT = 40

const VIEWER_QUERY = 'query { viewer { id } }'
const TEAMS_QUERY = `
query {
  teams(first: 50) {
    nodes { id key name }
  }
}`
const ISSUES_QUERY = `
query InboxIssues($first: Int!, $filter: IssueFilter) {
  issues(first: $first, filter: $filter, orderBy: updatedAt) {
    nodes {
      id
      identifier
      number
      title
      url
      updatedAt
      state { name type }
      team { id key name }
      labels { nodes { name color } }
      assignee { name displayName avatarUrl }
    }
  }
}`
const ISSUE_QUERY = `
query InboxIssue($id: String!) {
  issue(id: $id) {
    description
    creator { name displayName avatarUrl }
    assignee { name displayName avatarUrl }
  }
}`
const ISSUE_COMMENTS_QUERY = `
query InboxIssueComments($id: String!) {
  issue(id: $id) {
    comments(first: 50) {
      pageInfo { hasNextPage }
      nodes {
        id
        body
        createdAt
        url
        user { name displayName avatarUrl }
        parent { id }
      }
    }
  }
}`
const COMMENT_CREATE_MUTATION = `
mutation InboxCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id url }
  }
}`

type Json = Record<string, unknown>
type FetchLike = typeof fetch

export interface LinearIssueQuery {
  assignedToMe: boolean
  state: 'open' | 'all'
  teamIds: string[]
  limit?: number
}

export class Linear {
  private readonly tokenPath: string
  private readonly fetchImpl: FetchLike

  constructor(dataDir: string, options: { fetch?: FetchLike } = {}) {
    this.tokenPath = join(dataDir, 'linear-token')
    this.fetchImpl = options.fetch ?? fetch
  }

  async status(): Promise<LinearStatus> {
    return { connected: (await this.readToken()) !== null }
  }

  /** Validates the key against `viewer`, then stores it. An empty key disconnects. */
  async setToken(token: string): Promise<LinearStatus> {
    const trimmed = token.trim()
    if (!trimmed) {
      await this.deleteToken()
      return { connected: false }
    }
    await this.graphql(trimmed, VIEWER_QUERY, {})
    await this.writeToken(trimmed)
    return { connected: true }
  }

  async teams(): Promise<LinearTeam[]> {
    const data = await this.graphql(await this.requireToken(), TEAMS_QUERY, {})
    return parseTeams(data)
  }

  /** No token gives `[]` rather than an error so the Inbox can show GitHub alone. */
  async issues(query: LinearIssueQuery): Promise<LinearIssue[]> {
    const token = await this.readToken()
    if (token === null) return []
    const limit = Math.min(100, Math.max(1, query.limit ?? DEFAULT_LIMIT))
    const data = await this.graphql(token, ISSUES_QUERY, {
      first: limit,
      filter: issueFilter(query.assignedToMe, query.state, query.teamIds)
    })
    return parseIssues(data)
  }

  async details(id: string): Promise<LinearIssueDetails> {
    const token = await this.requireToken()
    const issueId = id.trim()
    if (!issueId) throw new Error('Missing Linear issue')
    return parseDetails(await this.graphql(token, ISSUE_QUERY, { id: issueId }))
  }

  async thread(id: string): Promise<LinearIssueThread> {
    const token = await this.requireToken()
    const issueId = id.trim()
    if (!validId(issueId)) throw new Error('Missing Linear issue')
    return parseThread(await this.graphql(token, ISSUE_COMMENTS_QUERY, { id: issueId }))
  }

  /** Posts a comment (optionally as a reply) and returns its URL. */
  async comment(id: string, body: string, parentId = ''): Promise<string> {
    const token = await this.requireToken()
    const issueId = id.trim()
    if (!validId(issueId)) throw new Error('Missing Linear issue')
    const text = body.trim()
    if (!text) throw new Error('Comment cannot be empty')
    const parent = parentId.trim()
    if (parent && !validId(parent)) throw new Error('Invalid Linear comment')
    const input: Json = { issueId, body: text }
    if (parent) input.parentId = parent
    return parseCommentCreate(await this.graphql(token, COMMENT_CREATE_MUTATION, { input }))
  }

  // ── token file ──

  private async readToken(): Promise<string | null> {
    try {
      const token = (await readFile(this.tokenPath, 'utf8')).trim()
      return token || null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async requireToken(): Promise<string> {
    const token = await this.readToken()
    if (token === null) throw new Error('Connect Linear in Settings')
    return token
  }

  private async writeToken(token: string): Promise<void> {
    await mkdir(join(this.tokenPath, '..'), { recursive: true })
    // 'w' truncates; the mode applies on create. chmod after so an existing
    // file with a looser mode is tightened too.
    const handle = await open(this.tokenPath, 'w', 0o600)
    try {
      await handle.chmod(0o600)
      await handle.writeFile(token, 'utf8')
    } finally {
      await handle.close()
    }
  }

  private async deleteToken(): Promise<void> {
    try {
      await unlink(this.tokenPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  // ── HTTP ──

  private async graphql(token: string, query: string, variables: Json): Promise<Json> {
    const authorization = bareKey(token)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
    let response: Response
    try {
      response = await this.fetchImpl(LINEAR_API, {
        method: 'POST',
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
      })
    } catch {
      throw new Error('Could not reach Linear')
    } finally {
      clearTimeout(timer)
    }
    if (response.status === 401 || response.status === 403) throw new Error('Linear API key is invalid')
    let body: string
    try {
      body = await response.text()
    } catch {
      throw new Error('Linear returned an unreadable response')
    }
    try {
      if (response.status < 200 || response.status >= 300) {
        throw new Error(graphqlErrorMessage(body) ?? `Linear request failed (${response.status})`)
      }
      return parseGraphqlData(body)
    } catch (error) {
      throw new Error(scrub(error instanceof Error ? error.message : String(error), authorization))
    }
  }
}

// ── pure helpers (exported for tests) ──

/** Linear wants the raw key in Authorization; strip a pasted `Bearer ` prefix. */
export function bareKey(token: string): string {
  return token.trim().replace(/^bearer\s+/i, '').trim()
}

function scrub(message: string, secret: string): string {
  return secret ? message.split(secret).join('[redacted]') : message
}

export function issueFilter(assignedToMe: boolean, state: string, teamIds: string[]): Json {
  const filter: Json = {}
  if (assignedToMe) filter.assignee = { isMe: { eq: true } }
  const ids = teamIds.map((id) => id.trim()).filter(Boolean)
  if (ids.length) filter.team = { id: { in: ids } }
  if (state.trim().toLowerCase() !== 'all') filter.state = { type: { nin: ['completed', 'canceled'] } }
  return filter
}

function parseGraphqlData(body: string): Json {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('Linear returned invalid JSON')
  }
  const message = errorMessageOf(parsed)
  if (message) {
    const lower = message.toLowerCase()
    if (lower.includes('auth') || lower.includes('unauthor')) throw new Error('Linear API key is invalid')
    throw new Error(message)
  }
  const data = (parsed as Json | null)?.data
  if (!data || typeof data !== 'object') throw new Error('Linear returned no data')
  return data as Json
}

export function graphqlErrorMessage(body: string): string | null {
  try {
    return errorMessageOf(JSON.parse(body))
  } catch {
    return null
  }
}

function errorMessageOf(parsed: unknown): string | null {
  const errors = (parsed as Json | null)?.errors
  if (!Array.isArray(errors) || errors.length === 0) return null
  const message = (errors[0] as Json | null)?.message
  const text = typeof message === 'string' ? message.trim() : ''
  return text || null
}

const obj = (value: unknown): Json | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
const str = (value: unknown, key: string): string | null => {
  const field = obj(value)?.[key]
  return typeof field === 'string' ? field.trim() : null
}
const arr = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null)

export function parseTeams(data: Json): LinearTeam[] {
  const nodes = arr(obj(data.teams)?.nodes)
  if (!nodes) throw new Error('Linear did not return teams')
  const teams: LinearTeam[] = []
  for (const node of nodes) {
    const id = str(node, 'id')
    if (!id) continue
    const key = str(node, 'key') ?? ''
    teams.push({ id, key, name: str(node, 'name') ?? key })
  }
  return teams
}

export function parseIssues(data: Json): LinearIssue[] {
  const nodes = arr(obj(data.issues)?.nodes)
  if (!nodes) throw new Error('Linear did not return issues')
  const issues: LinearIssue[] = []
  for (const node of nodes) {
    const issue = parseIssue(node)
    if (issue) issues.push(issue)
  }
  return issues
}

function parseIssue(node: unknown): LinearIssue | null {
  const id = str(node, 'id')
  if (!id) return null
  const team = obj(node)?.team
  const state = obj(node)?.state
  const teamKey = str(team, 'key') ?? ''
  const number = obj(node)?.number
  return {
    provider: 'linear',
    kind: 'linear',
    id,
    identifier: str(node, 'identifier') ?? '',
    number: typeof number === 'number' && Number.isInteger(number) ? number : 0,
    title: str(node, 'title') ?? '',
    url: str(node, 'url') ?? '',
    state: str(state, 'name') ?? 'Open',
    stateType: str(state, 'type') ?? '',
    updatedAt: str(node, 'updatedAt') ?? '',
    labels: parseLabels(node),
    assignees: parseAssignees(node),
    draft: false,
    repo: teamKey,
    teamId: str(team, 'id') ?? '',
    teamName: str(team, 'name') ?? teamKey,
    projectPath: ''
  }
}

export function parseDetails(data: Json): LinearIssueDetails {
  const issue = obj(data.issue)
  if (!issue) throw new Error('Linear did not return that issue')
  const creator = person(issue.creator)
  const assignee = person(issue.assignee)
  const author = creator.name !== null ? creator : assignee
  return {
    body: str(issue, 'description') ?? '',
    author: author.name ?? '',
    authorAvatarUrl: author.avatarUrl
  }
}

export function parseThread(data: Json): LinearIssueThread {
  const issue = obj(data.issue)
  if (!issue) throw new Error('Linear did not return that issue')
  const comments = obj(issue.comments)
  const nodes = comments && arr(comments.nodes)
  if (!comments || !nodes) throw new Error('Linear did not return comments')
  const rows: ParsedComment[] = []
  for (const node of nodes) {
    const row = parseComment(node)
    if (row) rows.push(row)
  }
  return {
    comments: nestComments(rows),
    truncated: obj(comments.pageInfo)?.hasNextPage === true,
    reviewDecision: '',
    baseRefName: '',
    headRefName: ''
  }
}

interface ParsedComment {
  parentId: string
  comment: LinearIssueComment
}

function parseComment(node: unknown): ParsedComment | null {
  const id = str(node, 'id')
  if (!id) return null
  const author = person(obj(node)?.user)
  return {
    parentId: str(obj(node)?.parent, 'id') ?? '',
    comment: {
      id,
      kind: 'comment',
      author: author.name ?? '',
      authorAvatarUrl: author.avatarUrl,
      body: str(node, 'body') ?? '',
      createdAt: str(node, 'createdAt') ?? '',
      url: str(node, 'url') ?? '',
      state: '',
      path: '',
      line: null,
      resolved: false,
      threadId: '',
      replies: []
    }
  }
}

/** Oldest first; every reply hangs off its root comment (one level deep). */
function nestComments(rows: ParsedComment[]): LinearIssueComment[] {
  rows.sort((a, b) => a.comment.createdAt.localeCompare(b.comment.createdAt))
  const ids = new Set(rows.map((row) => row.comment.id))
  const parentOf = new Map<string, string>()
  for (const row of rows) if (row.parentId && ids.has(row.parentId)) parentOf.set(row.comment.id, row.parentId)
  const rootOf = (id: string): string => {
    const seen = new Set<string>()
    let current = id
    for (let parent = parentOf.get(current); parent !== undefined; parent = parentOf.get(current)) {
      if (seen.has(current)) break
      seen.add(current)
      current = parent
    }
    return current
  }
  const top: LinearIssueComment[] = []
  const replies = new Map<string, LinearIssueComment[]>()
  for (const { comment } of rows) {
    const root = rootOf(comment.id)
    if (root === comment.id) top.push(comment)
    else replies.set(root, [...(replies.get(root) ?? []), comment])
  }
  for (const comment of top) comment.replies = replies.get(comment.id) ?? []
  return top
}

export function parseCommentCreate(data: Json): string {
  const payload = obj(data.commentCreate)
  if (!payload) throw new Error('Linear did not return a comment')
  if (payload.success !== true) throw new Error('Could not post Linear comment')
  return str(payload.comment, 'url') ?? ''
}

export function validId(id: string): boolean {
  const trimmed = id.trim()
  return trimmed.length > 0 && trimmed.length < 128 && /^[A-Za-z0-9_-]+$/.test(trimmed)
}

function parseLabels(node: unknown): LinearLabel[] {
  const nodes = arr(obj(obj(node)?.labels)?.nodes) ?? []
  const labels: LinearLabel[] = []
  for (const label of nodes) {
    const name = str(label, 'name')
    if (name === null) continue
    labels.push({ name, color: (str(label, 'color') ?? '').replace(/^#+/, '') })
  }
  return labels
}

function parseAssignees(node: unknown): LinearAssignee[] {
  const assignee = person(obj(node)?.assignee)
  return assignee.name === null ? [] : [{ login: assignee.name, avatarUrl: assignee.avatarUrl }]
}

function person(node: unknown): { name: string | null; avatarUrl: string } {
  if (!obj(node)) return { name: null, avatarUrl: '' }
  return { name: str(node, 'displayName') || str(node, 'name') || null, avatarUrl: str(node, 'avatarUrl') ?? '' }
}

// ── WS dispatch ──

type Handled = { handled: true; result: unknown } | { handled: false }
const result = (value: unknown): Handled => ({ handled: true, result: value ?? null })

export async function handleLinear(req: ClientRequest, linear: Linear): Promise<Handled> {
  switch (req.method) {
    case 'linear.status': return result(await linear.status())
    case 'linear.setToken': return result(await linear.setToken(req.params.token))
    case 'linear.teams': return result(await linear.teams())
    case 'linear.issues': return result(await linear.issues(req.params))
    case 'linear.details': return result(await linear.details(req.params.id))
    case 'linear.thread': return result(await linear.thread(req.params.id))
    case 'linear.comment': return result(await linear.comment(req.params.id, req.params.body, req.params.parentId))
    default: return { handled: false }
  }
}
