/**
 * M11 e2e: the seven linear.* WS methods against a running server.
 * With LINEAR_API_KEY in the environment it talks to the real API (lists
 * teams and issues, opens one, posts one clearly-labelled comment on an
 * issue assigned to you and prints its URL). Without a key it exercises the
 * disconnected paths only and says so. Either way it asserts that no frame
 * the server sends ever contains the key and that the token file is 0600.
 *
 *   LINEAR_API_KEY=... bun run script:e2e-m11
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { startServer, type RunningServer } from '../src/main/server'
import type { ClientRequest } from '../src/shared/contract'
import type { LinearIssue, LinearIssueThread, LinearStatus, LinearTeam } from '../src/shared/contract-linear'

class Client {
  readonly ws: WebSocket
  readonly incoming: string[] = []
  readonly outgoing: string[] = []
  private sequence = 0
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`)
    this.ws.on('message', (data) => {
      const text = String(data)
      this.incoming.push(text)
      const frame = JSON.parse(text) as { id?: string; ok?: boolean; result?: unknown; error?: string }
      if (!frame.id || typeof frame.ok !== 'boolean') return
      const waiter = this.pending.get(frame.id)
      if (!waiter) return
      this.pending.delete(frame.id)
      if (frame.ok) waiter.resolve(frame.result)
      else waiter.reject(new Error(frame.error))
    })
  }
  async ready(): Promise<void> {
    await once(this.ws, 'open')
  }
  request<T = unknown>(method: ClientRequest['method'], params?: unknown): Promise<T> {
    const id = String(++this.sequence)
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      const text = JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })
      this.outgoing.push(text)
      this.ws.send(text)
    })
  }
  async close(): Promise<void> {
    this.ws.close()
    await once(this.ws, 'close')
  }
}

const key = process.env.LINEAR_API_KEY?.trim() ?? ''
const root = await mkdtemp(join(tmpdir(), 'tc-m11-'))
const tokenPath = join(root, 'linear-token')
let server: RunningServer | undefined
let client: Client | undefined
const step = async (label: string, run: () => Promise<void>): Promise<void> => {
  await run()
  console.log(`PASS  ${label}`)
}

try {
  server = await startServer(join(root, 'temp-code.db'), { dataDir: root })
  client = new Client(server.port)
  await client.ready()
  const c = client

  await step('linear.status is disconnected on a fresh userData', async () => {
    assert.deepEqual(await c.request<LinearStatus>('linear.status'), { connected: false })
  })
  await step('linear.issues without a token is [] and the rest ask for Settings', async () => {
    assert.deepEqual(await c.request('linear.issues', { assignedToMe: true, state: 'open', teamIds: [] }), [])
    await assert.rejects(c.request('linear.teams'), /Connect Linear in Settings/)
    await assert.rejects(c.request('linear.details', { id: 'x' }), /Connect Linear in Settings/)
    await assert.rejects(c.request('linear.comment', { id: 'x', body: 'y' }), /Connect Linear in Settings/)
  })
  await step('linear.setToken with an invalid key is rejected and stores nothing', async () => {
    await assert.rejects(c.request('linear.setToken', { token: 'lin_api_not_a_real_key' }), /Linear API key is invalid|Could not reach Linear/)
    assert.ok(!existsSync(tokenPath))
  })
  await step('bad request shapes are rejected by the contract', async () => {
    await assert.rejects(c.request('linear.issues', { assignedToMe: 'yes' }), /bad request/)
    await assert.rejects(c.request('linear.issues', { assignedToMe: true, state: 'open', teamIds: [], limit: 1000 }), /bad request/)
  })

  if (!key) {
    console.log('SKIP  real-API half: no LINEAR_API_KEY in the environment (mocked coverage is in linear.test.ts)')
  } else {
    let teams: LinearTeam[] = []
    let issues: LinearIssue[] = []
    await step('linear.setToken validates the real key and writes a 0600 file', async () => {
      assert.deepEqual(await c.request<LinearStatus>('linear.setToken', { token: `  ${key}  ` }), { connected: true })
      assert.equal((await stat(tokenPath)).mode & 0o777, 0o600)
      assert.deepEqual(await c.request<LinearStatus>('linear.status'), { connected: true })
    })
    await step('linear.teams lists at least one team', async () => {
      teams = await c.request<LinearTeam[]>('linear.teams')
      assert.ok(teams.length > 0)
      for (const team of teams) assert.ok(team.id && team.key && team.name)
      console.log(`      ${teams.length} teams: ${teams.map((t) => t.key).join(', ')}`)
    })
    await step("linear.issues lists the first team's open issues with donor shapes", async () => {
      issues = await c.request<LinearIssue[]>('linear.issues', { assignedToMe: false, state: 'open', teamIds: [teams[0].id], limit: 10 })
      for (const issue of issues) {
        assert.equal(issue.provider, 'linear')
        assert.equal(issue.kind, 'linear')
        assert.equal(issue.teamId, teams[0].id)
        assert.ok(issue.id && issue.identifier && issue.url.startsWith('https://'))
        assert.notEqual(issue.stateType, 'completed')
        assert.notEqual(issue.stateType, 'canceled')
      }
      console.log(`      ${issues.length} open issues in ${teams[0].key}`)
    })
    const mine = await c.request<LinearIssue[]>('linear.issues', { assignedToMe: true, state: 'open', teamIds: [], limit: 5 })
    const target = mine[0] ?? issues[0]
    if (!target) {
      console.log('SKIP  details/thread/comment: no open issue to open')
    } else {
      await step(`linear.details opens ${target.identifier}`, async () => {
        const details = await c.request<{ body: string; author: string; authorAvatarUrl: string }>('linear.details', { id: target.id })
        assert.equal(typeof details.body, 'string')
        assert.ok(details.author.length > 0)
      })
      let before = 0
      await step(`linear.thread reads ${target.identifier}'s comments`, async () => {
        const thread = await c.request<LinearIssueThread>('linear.thread', { id: target.id })
        assert.equal(typeof thread.truncated, 'boolean')
        assert.deepEqual([thread.reviewDecision, thread.baseRefName, thread.headRefName], ['', '', ''])
        before = thread.comments.length
        for (const comment of thread.comments) assert.equal(comment.kind, 'comment')
      })
      await step(`linear.comment posts on ${target.identifier} and the thread shows it`, async () => {
        const body = `temp-code M11 e2e: comment round-trip check ${new Date().toISOString()} (safe to delete)`
        const url = await c.request<string>('linear.comment', { id: target.id, body })
        assert.ok(url.startsWith('https://'), url)
        console.log(`      posted ${url}`)
        const thread = await c.request<LinearIssueThread>('linear.thread', { id: target.id })
        const all = thread.comments.flatMap((comment) => [comment, ...comment.replies])
        assert.ok(all.some((comment) => comment.body === body))
        assert.ok(thread.comments.length >= before)
        await assert.rejects(c.request('linear.comment', { id: target.id, body: '   ' }), /Comment cannot be empty/)
      })
    }
    await step('linear.setToken with an empty key disconnects and deletes the file', async () => {
      assert.deepEqual(await c.request<LinearStatus>('linear.setToken', { token: '' }), { connected: false })
      assert.ok(!existsSync(tokenPath))
      assert.deepEqual(await c.request<LinearStatus>('linear.status'), { connected: false })
    })
  }

  await step('the key never appears in any frame the server sent', async () => {
    assert.ok(c.incoming.length > 0)
    if (key) {
      for (const frame of c.incoming) assert.ok(!frame.includes(key), 'server frame contains the key')
      assert.equal(c.outgoing.filter((frame) => frame.includes(key)).length, 1, 'only the setToken request carries the key')
    }
  })
  console.log('ALL PASS')
} finally {
  await client?.close()
  await server?.close()
  await rm(root, { recursive: true, force: true })
}
