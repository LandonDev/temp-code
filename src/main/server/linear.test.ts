import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Linear, bareKey, issueFilter, validId } from './linear'

const TOKEN = 'lin_api_SECRETSECRET'

interface Call {
  url: string
  headers: Record<string, string>
  signal: AbortSignal
  body: { query: string; variables: Record<string, unknown> }
}
type Reply = { status?: number; json?: unknown; text?: string } | ((call: Call) => Promise<Response>)

let dir: string
let calls: Call[]
let replies: Reply[]

function fetchMock(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const call: Call = {
    url: String(input),
    headers: init?.headers as Record<string, string>,
    signal: init?.signal as AbortSignal,
    body: JSON.parse(String(init?.body))
  }
  calls.push(call)
  const reply = replies.shift()
  if (!reply) throw new Error('unexpected fetch')
  if (typeof reply === 'function') return reply(call)
  const text = reply.text ?? JSON.stringify(reply.json ?? {})
  return Promise.resolve(new Response(text, { status: reply.status ?? 200 }))
}

const linear = (): Linear => new Linear(dir, { fetch: fetchMock as typeof fetch })
const reply = (json: unknown, status = 200): void => {
  replies.push({ json, status })
}
const tokenPath = (): string => join(dir, 'linear-token')
const connect = async (): Promise<Linear> => {
  const api = linear()
  reply({ data: { viewer: { id: 'me' } } })
  await api.setToken(TOKEN)
  return api
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tc-linear-'))
  calls = []
  replies = []
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('token file', () => {
  it('status is disconnected without a file and after an empty token', async () => {
    const api = linear()
    expect(await api.status()).toEqual({ connected: false })
    await writeFile(tokenPath(), '   \n')
    expect(await api.status()).toEqual({ connected: false })
    expect(calls).toHaveLength(0)
  })

  it('setToken validates viewer, writes a 0600 file, and reports connected only', async () => {
    const api = linear()
    reply({ data: { viewer: { id: 'me' } } })
    const status = await api.setToken(`  ${TOKEN}\n`)
    expect(status).toEqual({ connected: true })
    expect(JSON.stringify(status)).not.toContain(TOKEN)
    expect(calls[0].headers.Authorization).toBe(TOKEN)
    expect(calls[0].body.query).toContain('viewer')
    expect(await readFile(tokenPath(), 'utf8')).toBe(TOKEN)
    expect((await stat(tokenPath())).mode & 0o777).toBe(0o600)
    expect(await api.status()).toEqual({ connected: true })
  })

  it('tightens an existing loose file mode on rewrite', async () => {
    await writeFile(tokenPath(), 'old', { mode: 0o644 })
    expect((await stat(tokenPath())).mode & 0o777).toBe(0o644)
    await connect()
    expect((await stat(tokenPath())).mode & 0o777).toBe(0o600)
    expect(await readFile(tokenPath(), 'utf8')).toBe(TOKEN)
  })

  it('rejects an invalid key without writing a file', async () => {
    const api = linear()
    reply({}, 401)
    await expect(api.setToken(TOKEN)).rejects.toThrow('Linear API key is invalid')
    expect(existsSync(tokenPath())).toBe(false)
    reply({ errors: [{ message: 'Authentication required' }] })
    await expect(api.setToken(TOKEN)).rejects.toThrow('Linear API key is invalid')
    expect(existsSync(tokenPath())).toBe(false)
  })

  it('an empty token deletes the file, twice is fine', async () => {
    const api = await connect()
    expect(await api.setToken('')).toEqual({ connected: false })
    expect(existsSync(tokenPath())).toBe(false)
    expect(await api.setToken('  ')).toEqual({ connected: false })
    expect(calls).toHaveLength(1)
  })

  it('strips a pasted Bearer prefix for the Authorization header', async () => {
    const api = linear()
    reply({ data: { viewer: { id: 'me' } } })
    await api.setToken(`Bearer ${TOKEN}`)
    expect(calls[0].headers.Authorization).toBe(TOKEN)
    expect(bareKey(' bearer  abc ')).toBe('abc')
  })

  it('methods that need a token fail with the Settings hint', async () => {
    const api = linear()
    await expect(api.teams()).rejects.toThrow('Connect Linear in Settings')
    await expect(api.details('x')).rejects.toThrow('Connect Linear in Settings')
    await expect(api.thread('x')).rejects.toThrow('Connect Linear in Settings')
    await expect(api.comment('x', 'hi')).rejects.toThrow('Connect Linear in Settings')
    expect(calls).toHaveLength(0)
  })
})

describe('HTTP', () => {
  it('sends POST JSON to the GraphQL endpoint and gives up after 20 s', async () => {
    const api = await connect()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      replies.push(
        (call) =>
          new Promise((_, rejectFetch) => {
            expect(call.url).toBe('https://api.linear.app/graphql')
            expect(call.headers['Content-Type']).toBe('application/json')
            // Never answers; only the abort signal ends it.
            call.signal.addEventListener('abort', () => rejectFetch(new Error('aborted')))
          })
      )
      const pending = api.teams()
      const failed = expect(pending).rejects.toThrow('Could not reach Linear')
      while (calls.length < 2) await new Promise((r) => setImmediate(r))
      await vi.advanceTimersByTimeAsync(19_999)
      expect(calls[1].signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(2)
      await failed
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps HTTP failures, GraphQL errors and bad JSON to donor messages', async () => {
    const api = await connect()
    reply({}, 403)
    await expect(api.teams()).rejects.toThrow('Linear API key is invalid')
    reply({ errors: [{ message: 'Rate limited' }] }, 429)
    await expect(api.teams()).rejects.toThrow('Rate limited')
    replies.push({ text: 'oops', status: 500 })
    await expect(api.teams()).rejects.toThrow('Linear request failed (500)')
    reply({ errors: [{ message: 'Entity not found' }] })
    await expect(api.teams()).rejects.toThrow('Entity not found')
    replies.push({ text: '<html>' })
    await expect(api.teams()).rejects.toThrow('Linear returned invalid JSON')
    reply({ nothing: true })
    await expect(api.teams()).rejects.toThrow('Linear returned no data')
    replies.push(() => Promise.reject(new Error('ECONNRESET')))
    await expect(api.teams()).rejects.toThrow('Could not reach Linear')
  })

  it('never leaks the token into results or error text', async () => {
    const api = await connect()
    reply({ errors: [{ message: `bad key ${TOKEN} rejected` }] }, 400)
    await expect(api.teams()).rejects.toThrow('bad key [redacted] rejected')
    reply({ data: { teams: { nodes: [{ id: 't1', key: 'ENG', name: TOKEN }] } } })
    // A value Linear returns is data, not our secret; only our own outputs are checked.
    const teams = await api.teams()
    expect(teams[0].name).toBe(TOKEN)
    reply({ data: { teams: { nodes: [] } } })
    reply({ data: { issues: { nodes: [] } } })
    for (const value of [await api.status(), await api.teams(), await api.issues({ assignedToMe: false, state: 'all', teamIds: [] })]) {
      expect(JSON.stringify(value)).not.toContain(TOKEN)
    }
  })
})

describe('teams and issues', () => {
  it('teams parses nodes and skips blank ids', async () => {
    const api = await connect()
    reply({ data: { teams: { nodes: [{ id: 't1', key: 'ENG', name: 'Engineering' }, { id: '', key: 'X' }, { id: 't2', key: 'OPS' }] } } })
    expect(await api.teams()).toEqual([
      { id: 't1', key: 'ENG', name: 'Engineering' },
      { id: 't2', key: 'OPS', name: 'OPS' }
    ])
    reply({ data: {} })
    await expect(api.teams()).rejects.toThrow('Linear did not return teams')
  })

  it('issues returns [] without a token and no request', async () => {
    const api = linear()
    expect(await api.issues({ assignedToMe: true, state: 'open', teamIds: ['t'] })).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('issues sends the donor filter, clamps the limit, maps fields', async () => {
    const api = await connect()
    reply({
      data: {
        issues: {
          nodes: [
            {
              id: 'issue-1',
              identifier: 'ENG-9',
              number: 9,
              title: 'Fix auth',
              url: 'https://linear.app/acme/issue/ENG-9',
              updatedAt: '2026-08-27T10:00:00.000Z',
              state: { name: 'In Progress', type: 'started' },
              team: { id: 't1', key: 'ENG', name: 'Engineering' },
              labels: { nodes: [{ name: 'bug', color: '#eb5757' }] },
              assignee: { displayName: 'Maya', name: 'maya', avatarUrl: 'https://uploads.linear.app/maya.png' }
            },
            { id: 'issue-2', title: 'Bare' },
            { title: 'no id' }
          ]
        }
      }
    })
    const items = await api.issues({ assignedToMe: true, state: 'open', teamIds: [' t1 ', '', 't2'], limit: 500 })
    expect(calls[1].body.variables).toEqual({
      first: 100,
      filter: {
        assignee: { isMe: { eq: true } },
        team: { id: { in: ['t1', 't2'] } },
        state: { type: { nin: ['completed', 'canceled'] } }
      }
    })
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({
      provider: 'linear',
      kind: 'linear',
      id: 'issue-1',
      identifier: 'ENG-9',
      number: 9,
      title: 'Fix auth',
      url: 'https://linear.app/acme/issue/ENG-9',
      state: 'In Progress',
      stateType: 'started',
      updatedAt: '2026-08-27T10:00:00.000Z',
      labels: [{ name: 'bug', color: 'eb5757' }],
      assignees: [{ login: 'Maya', avatarUrl: 'https://uploads.linear.app/maya.png' }],
      draft: false,
      repo: 'ENG',
      teamId: 't1',
      teamName: 'Engineering',
      projectPath: ''
    })
    expect(items[1]).toMatchObject({ id: 'issue-2', number: 0, state: 'Open', labels: [], assignees: [], repo: '', teamName: '' })

    reply({ data: { issues: { nodes: [] } } })
    await api.issues({ assignedToMe: false, state: 'all', teamIds: [], limit: 0 })
    expect(calls[2].body.variables).toEqual({ first: 1, filter: {} })
    reply({ data: { issues: { nodes: [] } } })
    await api.issues({ assignedToMe: false, state: 'all', teamIds: [] })
    expect(calls[3].body.variables).toEqual({ first: 40, filter: {} })
  })

  it('issueFilter matches the donor', () => {
    expect(issueFilter(false, 'ALL', [])).toEqual({})
    expect(issueFilter(false, 'open', [])).toEqual({ state: { type: { nin: ['completed', 'canceled'] } } })
  })
})

describe('details, thread, comment', () => {
  it('details prefers the creator over the assignee and requires an id', async () => {
    const api = await connect()
    reply({
      data: {
        issue: {
          description: 'Steps to reproduce',
          creator: { name: 'Ada', avatarUrl: 'https://uploads.linear.app/ada.png' },
          assignee: { displayName: 'Maya' }
        }
      }
    })
    expect(await api.details(' issue-1 ')).toEqual({ body: 'Steps to reproduce', author: 'Ada', authorAvatarUrl: 'https://uploads.linear.app/ada.png' })
    expect(calls[1].body.variables).toEqual({ id: 'issue-1' })
    reply({ data: { issue: { assignee: { displayName: 'Maya' } } } })
    expect(await api.details('issue-1')).toEqual({ body: '', author: 'Maya', authorAvatarUrl: '' })
    reply({ data: { issue: null } })
    await expect(api.details('issue-1')).rejects.toThrow('Linear did not return that issue')
    await expect(api.details('  ')).rejects.toThrow('Missing Linear issue')
  })

  it('thread nests replies under their root oldest-first and reports truncation', async () => {
    const api = await connect()
    reply({
      data: {
        issue: {
          comments: {
            pageInfo: { hasNextPage: true },
            nodes: [
              { id: 'c2', body: 'Reply', createdAt: '2026-08-31T11:00:00.000Z', url: 'u2', user: { displayName: 'Maya' }, parent: { id: 'c1' } },
              { id: 'c1', body: 'Root', createdAt: '2026-08-31T10:00:00.000Z', url: 'u1', user: { name: 'Ada', avatarUrl: 'a.png' } },
              { id: 'c3', body: 'Nested reply', createdAt: '2026-08-31T11:30:00.000Z', user: { displayName: 'Lin' }, parent: { id: 'c2' } },
              { id: 'c4', body: 'Orphan', createdAt: '2026-08-31T12:00:00.000Z', parent: { id: 'gone' } },
              { body: 'no id' }
            ]
          }
        }
      }
    })
    const thread = await api.thread('issue-1')
    expect(thread.truncated).toBe(true)
    expect(thread.reviewDecision).toBe('')
    expect(thread.comments.map((c) => c.id)).toEqual(['c1', 'c4'])
    expect(thread.comments[0]).toMatchObject({ kind: 'comment', author: 'Ada', authorAvatarUrl: 'a.png', body: 'Root', url: 'u1', line: null, resolved: false })
    expect(thread.comments[0].replies.map((c) => c.body)).toEqual(['Reply', 'Nested reply'])
    expect(thread.comments[1].replies).toEqual([])
    await expect(api.thread('bad id')).rejects.toThrow('Missing Linear issue')
    reply({ data: { issue: {} } })
    await expect(api.thread('issue-1')).rejects.toThrow('Linear did not return comments')
  })

  it('comment validates input, sends parentId only when given, returns the URL', async () => {
    const api = await connect()
    reply({ data: { commentCreate: { success: true, comment: { id: 'c9', url: 'https://linear.app/acme/issue/ENG-9#comment-c9' } } } })
    expect(await api.comment('issue-1', '  Looks good  ')).toBe('https://linear.app/acme/issue/ENG-9#comment-c9')
    expect(calls[1].body.variables).toEqual({ input: { issueId: 'issue-1', body: 'Looks good' } })
    reply({ data: { commentCreate: { success: true, comment: { id: 'c10' } } } })
    expect(await api.comment('issue-1', 'Reply', 'c9')).toBe('')
    expect(calls[2].body.variables).toEqual({ input: { issueId: 'issue-1', body: 'Reply', parentId: 'c9' } })
    reply({ data: { commentCreate: { success: false } } })
    await expect(api.comment('issue-1', 'x')).rejects.toThrow('Could not post Linear comment')
    await expect(api.comment('issue-1', '   ')).rejects.toThrow('Comment cannot be empty')
    await expect(api.comment('', 'x')).rejects.toThrow('Missing Linear issue')
    await expect(api.comment('issue-1', 'x', 'has space')).rejects.toThrow('Invalid Linear comment')
    expect(calls).toHaveLength(4)
  })

  it('validId allows uuids and rejects junk', () => {
    expect(validId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true)
    expect(validId('')).toBe(false)
    expect(validId('id with space')).toBe(false)
    expect(validId('x'.repeat(128))).toBe(false)
  })
})
