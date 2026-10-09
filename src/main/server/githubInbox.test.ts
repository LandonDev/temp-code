import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { GhAuthError } from './github'
import {
  buildInboxQuery,
  chunkRepos,
  GithubInbox,
  handleGithubInbox,
  INBOX_MIN_INTERVAL_MS,
  parseInboxRepo
} from './githubInbox'
import { SessionRegistry } from './sessions'

vi.mock('./drivers', () => ({ BUILT_IN_DRIVERS: {} }))
// The token reader must never run here: every test hands its own in.
vi.mock('./github', async (orig) => {
  const real = await orig<typeof import('./github')>()
  return {
    ...real,
    ghAuthToken: () => Promise.reject(new Error('ghAuthToken must be injected')),
    forgetGhToken: () => {
      throw new Error('forgetGhToken must be injected')
    }
  }
})

// ── fixtures ──

interface Call {
  headers: Record<string, string>
  query: string
  repos: string[]
}
type Reply = { status?: number; json?: unknown; text?: string } | ((call: Call) => Promise<Response>)

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
let calls: Call[]
let replies: Reply[]
let clock: number
let logs: string[]

function reposOf(query: string): string[] {
  return [...query.matchAll(/repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)].map((m) => `${m[1]}/${m[2]}`)
}

function fetchMock(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init?.body)) as { query: string }
  const call: Call = { headers: init?.headers as Record<string, string>, query: body.query, repos: reposOf(body.query) }
  calls.push(call)
  const reply = replies.shift()
  if (!reply) throw new Error(`unexpected fetch for ${call.repos.join(',')}`)
  if (typeof reply === 'function') return reply(call)
  const text = reply.text ?? JSON.stringify(reply.json ?? {})
  return Promise.resolve(new Response(text, { status: reply.status ?? 200 }))
}

const pr = (number: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/x/pull/${number}`,
  state: 'OPEN',
  isDraft: false,
  updatedAt: `2026-10-0${number}T00:00:00Z`,
  headRefName: 'feat',
  baseRefName: 'master',
  reviewDecision: 'REVIEW_REQUIRED',
  author: { login: 'alice', avatarUrl: 'https://a/alice' },
  assignees: { nodes: [{ login: 'bob', avatarUrl: 'https://a/bob' }] },
  labels: { nodes: [{ name: 'bug', color: 'ff0000' }] },
  reviewRequests: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  ...extra
})
const issue = (number: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  number,
  title: `Issue ${number}`,
  url: `https://github.com/x/issues/${number}`,
  state: 'OPEN',
  updatedAt: `2026-09-0${number}T00:00:00Z`,
  author: { login: 'carol', avatarUrl: '' },
  assignees: { nodes: [] },
  labels: { nodes: [] },
  ...extra
})
const alias = (over: Partial<Record<'openPrs' | 'donePrs' | 'openIssues' | 'doneIssues', unknown[]>> = {}): unknown => ({
  nameWithOwner: 'x',
  openPrs: { nodes: over.openPrs ?? [] },
  donePrs: { nodes: over.donePrs ?? [] },
  openIssues: { nodes: over.openIssues ?? [] },
  doneIssues: { nodes: over.doneIssues ?? [] }
})

/** A good reply for `repos`, each with one open PR numbered by position. */
function okReply(repos: string[], cost = 2, viewer = 'me'): Reply {
  const data: Record<string, unknown> = { viewer: { login: viewer }, rateLimit: { cost, remaining: 4000, resetAt: '' } }
  repos.forEach((_, i) => {
    data[`r${i}`] = alias({ openPrs: [pr(i + 1)] })
  })
  return { json: { data } }
}

/** A workspace row whose .git/config names `repo` on github.com (or GitLab when null and git). */
async function workspace(name: string, repo: string | null, git = true): Promise<void> {
  const dir = join(root, name)
  await mkdir(join(dir, '.git'), { recursive: true })
  if (git) {
    const url = repo ? `git@github.com:${repo}.git` : 'https://gitlab.com/o/n.git'
    await writeFile(join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`)
  }
  store.insertWorkspace({ id: name, name, path: dir, git, githubRepo: repo, githubRepoCheckedAt: Date.now() + 60_000, createdAt: 1 })
}

let tokens: string[]
let forgets: number
function inbox(overrides: Partial<ConstructorParameters<typeof GithubInbox>[2]> = {}): GithubInbox {
  return new GithubInbox(store, registry, {
    fetch: fetchMock as typeof fetch,
    // Models the real reader: the same token until forgotten, then the next one.
    token: async () => {
      if (!tokens.length) throw new GhAuthError('logged-out', 'Run gh auth login to connect GitHub.')
      return tokens[0]
    },
    forgetToken: () => {
      forgets += 1
      tokens.shift()
    },
    now: () => clock,
    log: (line) => logs.push(line),
    ...overrides
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-ghinbox-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  calls = []
  replies = []
  logs = []
  clock = 1_000_000
  tokens = ['gho_one']
  forgets = 0
})
afterEach(async () => {
  expect(replies).toEqual([])
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

// ── pure helpers ──

describe('buildInboxQuery', () => {
  it('aliases every repo with owner and name inlined and the shared fragments', () => {
    const q = buildInboxQuery(['LandonDev/aliax', 'o/n.x'])
    expect(q).toContain('r0: repository(owner: "LandonDev", name: "aliax") { ...RepoInbox }')
    expect(q).toContain('r1: repository(owner: "o", name: "n.x") { ...RepoInbox }')
    expect(q).toContain('viewer { login }')
    expect(q).toContain('rateLimit { cost remaining resetAt }')
    expect(q).toContain('openPrs: pullRequests(states: OPEN, first: 30')
    expect(q).toContain('donePrs: pullRequests(states: [MERGED, CLOSED], first: 10')
    expect(q).toContain('doneIssues: issues(states: CLOSED, first: 10')
    expect(q.match(/fragment /g)).toHaveLength(3)
  })

  it('chunks four repos at a time', () => {
    expect(chunkRepos(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])).toEqual([
      ['a', 'b', 'c', 'd'],
      ['e', 'f', 'g', 'h'],
      ['i']
    ])
    expect(chunkRepos([])).toEqual([])
  })
})

describe('parseInboxRepo', () => {
  it('maps PRs and issues, lowercases state, and reads draft, decision, checks and requests', () => {
    const items = parseInboxRepo(
      alias({
        openPrs: [
          pr(3, {
            isDraft: true,
            reviewDecision: 'CHANGES_REQUESTED',
            reviewRequests: {
              nodes: [
                { requestedReviewer: { __typename: 'User', login: 'dave' } },
                { requestedReviewer: { __typename: 'Team', slug: 'core' } },
                { requestedReviewer: null }
              ]
            },
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] }
          })
        ],
        donePrs: [pr(2, { state: 'MERGED', commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })],
        openIssues: [issue(1, { author: null })],
        doneIssues: [issue(2, { state: 'CLOSED' })]
      }),
      'o/n'
    )
    expect(items.map((i) => [i.kind, i.number, i.state])).toEqual([
      ['pr', 3, 'open'],
      ['pr', 2, 'merged'],
      ['issue', 2, 'closed'],
      ['issue', 1, 'open']
    ])
    expect(items[0]).toMatchObject({
      repo: 'o/n',
      draft: true,
      reviewDecision: 'CHANGES_REQUESTED',
      checks: 'FAILURE',
      reviewRequested: ['dave', 'core'],
      author: { login: 'alice', avatarUrl: 'https://a/alice' },
      assignees: [{ login: 'bob', avatarUrl: 'https://a/bob' }],
      labels: [{ name: 'bug', color: 'ff0000' }],
      headRefName: 'feat',
      baseRefName: 'master'
    })
    expect(items[1].checks).toBeNull()
    expect(items[3]).toMatchObject({ author: null, reviewDecision: '', checks: null, reviewRequested: [], headRefName: '' })
  })

  it('tolerates a null alias and rows without a number', () => {
    expect(parseInboxRepo(null, 'o/n')).toEqual([])
    expect(parseInboxRepo(alias({ openPrs: [{ title: 'no number' }] }), 'o/n')).toEqual([])
  })
})

// ── the service ──

describe('GithubInbox.snapshot', () => {
  it('reads SQLite only: no fetch, no token, defaults before the first refresh', async () => {
    await workspace('a', 'o/a')
    const api = inbox({ token: () => Promise.reject(new Error('snapshot must not read the token')) })
    expect(api.snapshot()).toEqual({ viewer: null, auth: { state: 'ok', message: '' }, fetchedAt: null, refreshing: false, repos: [] })
    store.putGithubInboxRepo({ repo: 'o/a', fetchedAt: 5, error: null, items: [] })
    store.setSetting('github.inbox.viewer', 'me')
    store.setSetting('github.inbox.fetchedAt', '5')
    expect(api.snapshot()).toMatchObject({ viewer: 'me', fetchedAt: 5, repos: [{ repo: 'o/a' }] })
    expect(calls).toEqual([])
  })
})

describe('GithubInbox.refresh', () => {
  it('fetches every GitHub workspace once, stores rows, viewer, fetchedAt, auth, and logs one line', async () => {
    await workspace('a', 'o/a')
    await workspace('b', 'o/b')
    await workspace('b2', 'o/b') // a second checkout of the same repo
    await workspace('gl', null) // GitLab
    await workspace('plain', null, false)
    replies.push(okReply(['o/a', 'o/b'], 7))
    const snap = await inbox().refresh('open')
    expect(calls).toHaveLength(1)
    expect(calls[0].repos).toEqual(['o/a', 'o/b'])
    expect(calls[0].headers).toMatchObject({ Authorization: 'bearer gho_one', 'User-Agent': 'temp-code' })
    expect(snap).toMatchObject({ viewer: 'me', auth: { state: 'ok' }, fetchedAt: clock, refreshing: false })
    expect(snap.repos.map((r) => [r.repo, r.error, r.items.map((i) => i.number)])).toEqual([
      ['o/a', null, [1]],
      ['o/b', null, [2]]
    ])
    expect(inbox().snapshot()).toEqual(snap) // the store round-trips it
    expect(logs).toEqual(['[github-inbox] refresh open: 2 repos, 7 points, 0 ms (4000 remaining)'])
    expect(JSON.stringify(snap)).not.toContain('gho_one')
  })

  it('stores an ok empty snapshot when no workspace is on GitHub, without a token or a fetch', async () => {
    await workspace('gl', null)
    const api = inbox({ token: () => Promise.reject(new Error('no token needed')) })
    expect(await api.refresh('manual')).toMatchObject({ auth: { state: 'ok' }, repos: [] })
    expect(calls).toEqual([])
  })

  it('coalesces concurrent refreshes and throttles a non-manual one inside 15 s', async () => {
    await workspace('a', 'o/a')
    let release: (r: Response) => void = () => {}
    replies.push(() => new Promise<Response>((r) => (release = r)))
    const api = inbox()
    const first = api.refresh('open')
    const second = api.refresh('interval')
    expect(api.snapshot().refreshing).toBe(true)
    while (calls.length === 0) await new Promise((r) => setTimeout(r, 1))
    release(new Response(JSON.stringify((okReply(['o/a']) as { json: unknown }).json), { status: 200 }))
    expect(await second).toBe(await first)
    expect(calls).toHaveLength(1)

    clock += INBOX_MIN_INTERVAL_MS - 1
    expect((await api.refresh('interval')).fetchedAt).toBe(1_000_000)
    expect((await api.refresh('open')).fetchedAt).toBe(1_000_000)
    expect(calls).toHaveLength(1)

    replies.push(okReply(['o/a']))
    expect((await api.refresh('manual')).fetchedAt).toBe(clock) // manual ignores the floor
    expect(calls).toHaveLength(2)

    clock += INBOX_MIN_INTERVAL_MS
    replies.push(okReply(['o/a']))
    await api.refresh('interval')
    expect(calls).toHaveLength(3)
  })

  it('splits repos into chunks of four, at most three in flight', async () => {
    const repos = Array.from({ length: 9 }, (_, i) => `o/r${i}`)
    for (const r of repos) await workspace(r.replace('/', '-'), r)
    let inFlight = 0
    let peak = 0
    for (let i = 0; i < 3; i++) {
      replies.push(async (call) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight -= 1
        return new Response(JSON.stringify((okReply(call.repos, 3) as { json: unknown }).json), { status: 200 })
      })
    }
    const snap = await inbox().refresh('manual')
    expect(calls.map((c) => c.repos.length)).toEqual([4, 4, 1])
    expect(peak).toBe(3)
    expect(snap.repos).toHaveLength(9)
    expect(logs[0]).toContain('9 repos, 9 points')
  })

  it('on 401 forgets the token, retries once with a fresh one, and stores logged-out on a second 401', async () => {
    await workspace('a', 'o/a')
    tokens = ['stale', 'fresh']
    replies.push({ status: 401, json: { message: 'Bad credentials' } }, okReply(['o/a']))
    const api = inbox()
    expect(await api.refresh('manual')).toMatchObject({ auth: { state: 'ok' }, repos: [{ repo: 'o/a' }] })
    expect(forgets).toBe(1)
    expect(calls.map((c) => c.headers.Authorization)).toEqual(['bearer stale', 'bearer fresh'])

    tokens = ['stale', 'stale2']
    replies.push({ status: 401 }, { status: 401 })
    const snap = await api.refresh('manual')
    expect(snap.auth).toEqual({ state: 'logged-out', message: 'Run gh auth login to connect GitHub.' })
    expect(snap.repos.map((r) => r.repo)).toEqual(['o/a']) // rows kept
    expect(forgets).toBe(2)
  })

  it('a failed chunk is retried one repo at a time; a repo that still fails keeps its old row with an error', async () => {
    await workspace('a', 'o/a')
    await workspace('b', 'o/b')
    store.putGithubInboxRepo({ repo: 'o/b', fetchedAt: 500, error: null, items: [{ ...(parseInboxRepo(alias({ openPrs: [pr(9)] }), 'o/b')[0]) }] })
    replies.push({ status: 502, text: 'Bad Gateway' }, okReply(['o/a']), { status: 502, text: '<html>' })
    const snap = await inbox().refresh('manual')
    expect(calls.map((c) => c.repos)).toEqual([['o/a', 'o/b'], ['o/a'], ['o/b']])
    expect(snap.repos).toEqual([
      expect.objectContaining({ repo: 'o/a', error: null, fetchedAt: clock }),
      expect.objectContaining({ repo: 'o/b', error: 'GitHub answered 502', fetchedAt: 500 })
    ])
    expect(snap.repos[1].items.map((i) => i.number)).toEqual([9])
    expect(snap.auth.state).toBe('ok')
  })

  it('a timeout counts as a failed chunk', async () => {
    await workspace('a', 'o/a')
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    replies.push(() => Promise.reject(timeout)) // a single-repo chunk has nothing smaller to retry as
    const snap = await inbox().refresh('manual')
    expect(snap.repos[0].error).toBe('GitHub took longer than 20 s')
    expect(snap.auth.state).toBe('ok')
  })

  it('a NOT_FOUND alias stores an empty row with the message', async () => {
    await workspace('a', 'o/a')
    await workspace('gone', 'o/gone')
    replies.push({
      json: {
        data: { viewer: { login: 'me' }, rateLimit: { cost: 1, remaining: 1 }, r0: alias({ openIssues: [issue(1)] }), r1: null },
        errors: [{ type: 'NOT_FOUND', path: ['r1'], message: "Could not resolve to a Repository with the name 'o/gone'." }]
      }
    })
    const snap = await inbox().refresh('manual')
    expect(snap.repos).toEqual([
      expect.objectContaining({ repo: 'o/a', error: null }),
      expect.objectContaining({ repo: 'o/gone', error: "Could not resolve to a Repository with the name 'o/gone'.", items: [] })
    ])
  })

  it('missing gh and logged-out leave the stored rows intact and set the auth state', async () => {
    await workspace('a', 'o/a')
    store.putGithubInboxRepo({ repo: 'o/a', fetchedAt: 5, error: null, items: [] })
    tokens = []
    let snap = await inbox().refresh('manual')
    expect(snap.auth).toEqual({ state: 'logged-out', message: 'Run gh auth login to connect GitHub.' })
    expect(snap.repos).toHaveLength(1)
    const missing = inbox({ token: () => Promise.reject(new GhAuthError('missing-gh', 'Install the GitHub CLI (gh) and run gh auth login to see pull requests and issues.')) })
    snap = await missing.refresh('manual')
    expect(snap.auth.state).toBe('missing-gh')
    expect(snap.repos).toHaveLength(1)
    expect(calls).toEqual([])
    expect(logs).toEqual([])
  })

  it('an unreachable network keeps every row and reports an error once', async () => {
    await workspace('a', 'o/a')
    store.putGithubInboxRepo({ repo: 'o/a', fetchedAt: 5, error: null, items: [] })
    replies.push(() => Promise.reject(new TypeError('fetch failed')))
    const snap = await inbox().refresh('manual')
    expect(snap.auth).toEqual({ state: 'error', message: 'Could not reach GitHub.' })
    expect(snap.repos).toEqual([expect.objectContaining({ repo: 'o/a', fetchedAt: 5 })])
    expect(snap.fetchedAt).toBeNull()
  })

  it('prunes rows for repos no workspace uses', async () => {
    store.putGithubInboxRepo({ repo: 'o/old', fetchedAt: 5, error: null, items: [] })
    await workspace('a', 'o/a')
    replies.push(okReply(['o/a']))
    const snap = await inbox().refresh('manual')
    expect(snap.repos.map((r) => r.repo)).toEqual(['o/a'])
  })
})

describe('handleGithubInbox', () => {
  it('serves github.inbox from the store and github.inboxRefresh through refresh', async () => {
    await workspace('a', 'o/a')
    const api = inbox()
    const read = await handleGithubInbox({ id: '1', method: 'github.inbox', params: {} }, api)
    expect(read).toEqual({ handled: true, result: expect.objectContaining({ repos: [] }) })
    expect(calls).toEqual([])
    replies.push(okReply(['o/a']))
    const refreshed = await handleGithubInbox({ id: '2', method: 'github.inboxRefresh', params: { reason: 'open' } }, api)
    expect(refreshed).toEqual({ handled: true, result: expect.objectContaining({ repos: [expect.objectContaining({ repo: 'o/a' })] }) })
    expect(await handleGithubInbox({ id: '3', method: 'workspace.list' } as never, api)).toEqual({ handled: false })
  })
})
