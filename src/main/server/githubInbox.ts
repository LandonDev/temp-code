import type { ClientRequest } from '@shared/contract'
import type {
  GithubInboxAuth,
  GithubInboxChecks,
  GithubInboxItem,
  GithubInboxPerson,
  GithubInboxRefreshReason,
  GithubInboxReviewDecision,
  GithubInboxSnapshot
} from '@shared/contract-github'
import type { Store } from './db'
import { forgetGhToken, ghAuthToken, GhAuthError } from './github'
import type { SessionRegistry } from './sessions'

/**
 * The GitHub inbox snapshot. One refresh asks api.github.com for the latest
 * pull requests and issues of every GitHub workspace, four repos per
 * request and three requests in flight (GitHub cuts a single query at
 * 10 s: twelve repos in one query hit a 502 after 11 s on 2026-10-09, six
 * took 4.9 s), then stores one row per repo in SQLite. `snapshot()` reads
 * that store and nothing else, so the inbox opens at once and the rail dot
 * is right at launch. Only `refresh()` touches the network, and only the
 * open inbox view calls it; the server runs no timer of its own.
 */

export const INBOX_CHUNK_REPOS = 4
export const INBOX_PARALLEL_CHUNKS = 3
export const INBOX_REQUEST_TIMEOUT_MS = 20_000
export const INBOX_MIN_INTERVAL_MS = 15_000
export const INBOX_OPEN_PAGE = 30
export const INBOX_DONE_PAGE = 10

const GITHUB_GRAPHQL = 'https://api.github.com/graphql'
const SETTING_VIEWER = 'github.inbox.viewer'
const SETTING_FETCHED_AT = 'github.inbox.fetchedAt'
const SETTING_AUTH = 'github.inbox.auth'
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

const AUTH_OK: GithubInboxAuth = { state: 'ok', message: '' }
const AUTH_OFFLINE: GithubInboxAuth = { state: 'error', message: 'Could not reach GitHub.' }

type FetchLike = typeof fetch
type Json = Record<string, unknown>

export interface GithubInboxDeps {
  fetch?: FetchLike
  token?: () => Promise<string>
  forgetToken?: () => void
  now?: () => number
  log?: (line: string) => void
}

// ── the query ──

const FRAGMENTS = `
fragment RepoInbox on Repository {
  nameWithOwner
  openPrs: pullRequests(states: OPEN, first: ${INBOX_OPEN_PAGE}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...PrRow } }
  donePrs: pullRequests(states: [MERGED, CLOSED], first: ${INBOX_DONE_PAGE}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...PrRow } }
  openIssues: issues(states: OPEN, first: ${INBOX_OPEN_PAGE}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...IssueRow } }
  doneIssues: issues(states: CLOSED, first: ${INBOX_DONE_PAGE}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...IssueRow } }
}
fragment PrRow on PullRequest {
  number title url state isDraft updatedAt headRefName baseRefName reviewDecision
  author { login avatarUrl }
  assignees(first: 5) { nodes { login avatarUrl } }
  labels(first: 6) { nodes { name color } }
  reviewRequests(first: 5) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}
fragment IssueRow on Issue {
  number title url state updatedAt
  author { login avatarUrl }
  assignees(first: 5) { nodes { login avatarUrl } }
  labels(first: 6) { nodes { name color } }
}`

/** One query over `repos` ("owner/name", already validated): aliases r0..rN. */
export function buildInboxQuery(repos: string[]): string {
  const aliases = repos.map((slug, i) => {
    const [owner, name] = slug.split('/')
    return `  r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ...RepoInbox }`
  })
  return `query InboxSnapshot {\n  viewer { login }\n  rateLimit { cost remaining resetAt }\n${aliases.join('\n')}\n}\n${FRAGMENTS}`
}

export function chunkRepos(repos: string[], size = INBOX_CHUNK_REPOS): string[][] {
  const out: string[][] = []
  for (let i = 0; i < repos.length; i += size) out.push(repos.slice(i, i + size))
  return out
}

// ── parsing ──

const obj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (o: Json, k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')
const nodesOf = (o: Json, k: string): Json[] => {
  const c = o[k]
  if (!obj(c) || !Array.isArray(c.nodes)) return []
  return (c.nodes as unknown[]).filter(obj)
}

function person(v: unknown): GithubInboxPerson | null {
  if (!obj(v) || typeof v.login !== 'string') return null
  return { login: v.login, avatarUrl: str(v, 'avatarUrl') }
}

function itemState(v: string): GithubInboxItem['state'] {
  const s = v.toLowerCase()
  return s === 'merged' || s === 'closed' ? s : 'open'
}

function reviewDecision(v: string): GithubInboxReviewDecision {
  return v === 'APPROVED' || v === 'CHANGES_REQUESTED' || v === 'REVIEW_REQUIRED' ? v : ''
}

function checks(node: Json): GithubInboxChecks {
  const [commitNode] = nodesOf(node, 'commits')
  const commit = commitNode?.commit
  const rollup = obj(commit) ? commit.statusCheckRollup : null
  const state = obj(rollup) ? str(rollup, 'state') : ''
  return state === 'SUCCESS' || state === 'FAILURE' || state === 'PENDING' || state === 'ERROR' || state === 'EXPECTED'
    ? state
    : null
}

function reviewRequested(node: Json): string[] {
  return nodesOf(node, 'reviewRequests')
    .map((r) => (obj(r.requestedReviewer) ? r.requestedReviewer : null))
    .filter((r): r is Json => r !== null)
    .map((r) => str(r, 'login') || str(r, 'slug'))
    .filter(Boolean)
}

function row(node: Json, kind: 'issue' | 'pr', repo: string): GithubInboxItem | null {
  if (!Number.isSafeInteger(node.number)) return null
  return {
    kind,
    repo,
    number: node.number as number,
    title: str(node, 'title'),
    url: str(node, 'url'),
    state: itemState(str(node, 'state')),
    draft: node.isDraft === true,
    updatedAt: str(node, 'updatedAt'),
    author: person(node.author),
    assignees: nodesOf(node, 'assignees').map(person).filter((p): p is GithubInboxPerson => p !== null),
    labels: nodesOf(node, 'labels').map((l) => ({ name: str(l, 'name'), color: str(l, 'color') })),
    reviewDecision: kind === 'pr' ? reviewDecision(str(node, 'reviewDecision')) : '',
    headRefName: str(node, 'headRefName'),
    baseRefName: str(node, 'baseRefName'),
    checks: kind === 'pr' ? checks(node) : null,
    reviewRequested: kind === 'pr' ? reviewRequested(node) : []
  }
}

/** The items of one repository alias, newest update first. */
export function parseInboxRepo(alias: unknown, repo: string): GithubInboxItem[] {
  if (!obj(alias)) return []
  const items = [
    ...nodesOf(alias, 'openPrs').map((n) => row(n, 'pr', repo)),
    ...nodesOf(alias, 'donePrs').map((n) => row(n, 'pr', repo)),
    ...nodesOf(alias, 'openIssues').map((n) => row(n, 'issue', repo)),
    ...nodesOf(alias, 'doneIssues').map((n) => row(n, 'issue', repo))
  ].filter((i): i is GithubInboxItem => i !== null)
  return items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
}

// ── the fetch ──

/** The outcome of one GraphQL request over a chunk of repos. */
interface ChunkResult {
  viewer: string | null
  cost: number
  remaining: number | null
  /** alias result per repo: items, or an error message */
  repos: Map<string, { items: GithubInboxItem[] } | { error: string }>
}

class Unauthorized extends Error {}
/** Anything that means "try this chunk again, one repo at a time". */
class ChunkFailed extends Error {}
/** The network itself failed (DNS, offline): keep every row, say so once. */
class Unreachable extends Error {}

export class GithubInbox {
  private readonly fetchImpl: FetchLike
  private readonly token: () => Promise<string>
  private readonly forgetToken: () => void
  private readonly now: () => number
  private readonly log: (line: string) => void
  private inflight: Promise<GithubInboxSnapshot> | null = null

  constructor(
    private readonly store: Store,
    private readonly registry: SessionRegistry,
    deps: GithubInboxDeps = {}
  ) {
    this.fetchImpl = deps.fetch ?? fetch
    this.token = deps.token ?? ghAuthToken
    this.forgetToken = deps.forgetToken ?? forgetGhToken
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((line) => console.log(line))
  }

  /** The stored snapshot: SQLite only, never the network, never gh. */
  snapshot(): GithubInboxSnapshot {
    const fetchedAt = Number(this.store.getSetting(SETTING_FETCHED_AT))
    let auth: GithubInboxAuth = AUTH_OK
    try {
      const raw = this.store.getSetting(SETTING_AUTH)
      if (raw) auth = JSON.parse(raw) as GithubInboxAuth
    } catch {
      // a bad row reads as ok; the next refresh rewrites it
    }
    return {
      viewer: this.store.getSetting(SETTING_VIEWER),
      auth,
      fetchedAt: fetchedAt > 0 ? fetchedAt : null,
      refreshing: this.inflight !== null,
      repos: this.store.listGithubInboxRepos()
    }
  }

  /** Fetches every GitHub workspace. Concurrent calls share one pass; a
   *  non-manual call inside the 15 s floor returns the store as is. */
  refresh(reason: GithubInboxRefreshReason): Promise<GithubInboxSnapshot> {
    if (this.inflight) return this.inflight
    const last = Number(this.store.getSetting(SETTING_FETCHED_AT)) || 0
    if (reason !== 'manual' && this.now() - last < INBOX_MIN_INTERVAL_MS) {
      return Promise.resolve(this.snapshot())
    }
    this.inflight = this.run(reason)
      .then((snap) => ({ ...snap, refreshing: false }))
      .finally(() => {
        this.inflight = null
      })
    return this.inflight
  }

  private async run(reason: GithubInboxRefreshReason): Promise<GithubInboxSnapshot> {
    const startedAt = this.now()
    const workspaces = await this.registry.refreshWorkspaceRepos()
    const repos = [...new Set(workspaces.filter((w) => w.git && w.githubRepo).map((w) => w.githubRepo as string))]
      .filter((slug) => SLUG.test(slug))
    this.store.deleteGithubInboxRepos(repos)
    if (repos.length === 0) {
      this.setAuth(AUTH_OK)
      return this.snapshot()
    }

    let token: string
    try {
      token = await this.token()
    } catch (err) {
      const auth: GithubInboxAuth =
        err instanceof GhAuthError
          ? { state: err.state, message: err.message }
          : { state: 'logged-out', message: 'Run gh auth login to connect GitHub.' }
      this.setAuth(auth)
      return this.snapshot()
    }

    let pass
    try {
      pass = await this.fetchAll(repos, token)
    } catch (err) {
      if (err instanceof Unauthorized) {
        // The cached token went stale: read it again once.
        this.forgetToken()
        try {
          pass = await this.fetchAll(repos, await this.token())
        } catch (again) {
          this.setAuth(
            again instanceof GhAuthError
              ? { state: again.state, message: again.message }
              : again instanceof Unreachable
                ? AUTH_OFFLINE
                : { state: 'logged-out', message: 'Run gh auth login to connect GitHub.' }
          )
          return this.snapshot()
        }
      } else if (err instanceof Unreachable) {
        this.setAuth(AUTH_OFFLINE)
        return this.snapshot()
      } else {
        throw err
      }
    }

    const fetchedAt = this.now()
    const previous = new Map(this.store.listGithubInboxRepos().map((r) => [r.repo, r]))
    for (const repo of repos) {
      const outcome = pass.repos.get(repo)
      if (!outcome) continue
      if ('items' in outcome) {
        this.store.putGithubInboxRepo({ repo, fetchedAt, error: null, items: outcome.items })
      } else {
        const old = previous.get(repo)
        this.store.putGithubInboxRepo({
          repo,
          fetchedAt: old?.fetchedAt ?? fetchedAt,
          error: outcome.error,
          items: old?.items ?? []
        })
      }
    }
    if (pass.viewer) this.store.setSetting(SETTING_VIEWER, pass.viewer)
    this.store.setSetting(SETTING_FETCHED_AT, String(fetchedAt))
    this.setAuth(AUTH_OK)
    this.log(
      `[github-inbox] refresh ${reason}: ${repos.length} repos, ${pass.cost} points, ${this.now() - startedAt} ms` +
        (pass.remaining === null ? '' : ` (${pass.remaining} remaining)`)
    )
    return this.snapshot()
  }

  private setAuth(auth: GithubInboxAuth): void {
    this.store.setSetting(SETTING_AUTH, JSON.stringify(auth))
  }

  /** Every chunk, three at a time; a failed chunk is retried one repo at a time. */
  private async fetchAll(repos: string[], token: string): Promise<ChunkResult> {
    const merged: ChunkResult = { viewer: null, cost: 0, remaining: null, repos: new Map() }
    const queue = chunkRepos(repos)
    let unreachable: Unreachable | null = null
    const worker = async (): Promise<void> => {
      for (let chunk = queue.shift(); chunk; chunk = queue.shift()) {
        let result: ChunkResult
        try {
          result = await this.fetchChunk(chunk, token)
        } catch (err) {
          if (err instanceof Unauthorized) throw err
          if (err instanceof Unreachable) {
            unreachable = err
            continue
          }
          if (chunk.length === 1) {
            merged.repos.set(chunk[0], { error: (err as Error).message })
            continue
          }
          // A 5xx or a timeout on a chunk: a big repo may be sinking its
          // neighbours, so each repo gets its own request once.
          for (const repo of chunk) {
            try {
              result = await this.fetchChunk([repo], token)
            } catch (single) {
              if (single instanceof Unauthorized) throw single
              if (single instanceof Unreachable) {
                unreachable = single
                continue
              }
              merged.repos.set(repo, { error: (single as Error).message })
              continue
            }
            mergeInto(merged, result)
          }
          continue
        }
        mergeInto(merged, result)
      }
    }
    await Promise.all(Array.from({ length: Math.min(INBOX_PARALLEL_CHUNKS, queue.length) }, worker))
    if (unreachable && merged.repos.size === 0) throw unreachable
    return merged
  }

  private async fetchChunk(repos: string[], token: string): Promise<ChunkResult> {
    let response: Response
    try {
      response = await this.fetchImpl(GITHUB_GRAPHQL, {
        method: 'POST',
        headers: {
          Authorization: `bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'temp-code'
        },
        body: JSON.stringify({ query: buildInboxQuery(repos) }),
        signal: AbortSignal.timeout(INBOX_REQUEST_TIMEOUT_MS)
      })
    } catch (err) {
      if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError') {
        throw new ChunkFailed(`GitHub took longer than ${INBOX_REQUEST_TIMEOUT_MS / 1000} s`)
      }
      throw new Unreachable((err as Error).message)
    }
    if (response.status === 401) throw new Unauthorized('GitHub rejected the token')
    if (response.status >= 500 || response.status === 429) {
      throw new ChunkFailed(`GitHub answered ${response.status}`)
    }
    const text = await response.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new ChunkFailed(`GitHub answered ${response.status} with no JSON`)
    }
    if (!obj(body)) throw new ChunkFailed('GitHub answered with no body')
    if (!response.ok) {
      throw new ChunkFailed(str(body, 'message') || `GitHub answered ${response.status}`)
    }
    const data = obj(body.data) ? body.data : {}
    const errors = Array.isArray(body.errors) ? (body.errors as unknown[]).filter(obj) : []
    const viewer = obj(data.viewer) ? str(data.viewer, 'login') || null : null
    const rate = obj(data.rateLimit) ? data.rateLimit : {}
    const result: ChunkResult = {
      viewer,
      cost: typeof rate.cost === 'number' ? rate.cost : 0,
      remaining: typeof rate.remaining === 'number' ? rate.remaining : null,
      repos: new Map()
    }
    repos.forEach((repo, i) => {
      const alias = data[`r${i}`]
      if (obj(alias)) {
        result.repos.set(repo, { items: parseInboxRepo(alias, repo) })
        return
      }
      // A null alias: the repo moved, went private, or the token lacks it.
      const error = errors.find((e) => Array.isArray(e.path) && (e.path as unknown[])[0] === `r${i}`)
      result.repos.set(repo, { error: error ? str(error, 'message') || 'GitHub could not read this repository' : 'GitHub returned nothing for this repository' })
    })
    if (result.repos.size === 0 && errors.length) {
      throw new ChunkFailed(str(errors[0], 'message') || 'GitHub returned an error')
    }
    return result
  }
}

function mergeInto(into: ChunkResult, from: ChunkResult): void {
  into.viewer ??= from.viewer
  into.cost += from.cost
  into.remaining = from.remaining ?? into.remaining
  for (const [repo, outcome] of from.repos) into.repos.set(repo, outcome)
}

// ── WS dispatch ──

type Handled = { handled: true; result: unknown } | { handled: false }

export async function handleGithubInbox(req: ClientRequest, inbox: GithubInbox): Promise<Handled> {
  switch (req.method) {
    case 'github.inbox':
      return { handled: true, result: inbox.snapshot() }
    case 'github.inboxRefresh':
      return { handled: true, result: await inbox.refresh(req.params.reason) }
    default:
      return { handled: false }
  }
}
