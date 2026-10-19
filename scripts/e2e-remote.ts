/**
 * Remote access exit test (plan 5jtfkIC45Cbr): the bearer path end to end
 * against a real server on a temp database with the fixed-port listener on
 * an ephemeral port. An admin creates a pairing; the scripted client pairs
 * for a key, checks hello, mints a ticket, upgrades /ws, sees the hello
 * frame first, creates a chat and sends one message, watches the event
 * push arrive, is refused session.approve, and is cut off when the admin
 * revokes its key. Run: bun run script:e2e-remote
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure } from 'aliax-core'
import { WebSocket } from 'ws'
import { startServer } from '../src/main/server/index'
import type { ServerFrame } from '../src/shared/contract'

const root = mkdtempSync(join(tmpdir(), 'tc-remote-'))
// A throwaway vault: no accounts, so claude runs on the CLI's own login and
// never the user's live gateway shim.
configure({
  dataDir: join(root, 'aliax'),
  fetch: async (url) => {
    throw new Error(`unexpected fetch ${url}`)
  },
  secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
  appName: 'temp-code-e2e'
})
const server = await startServer(join(root, 'app.db'), { claimShim: false, remotePort: 0 })
const base = `http://127.0.0.1:${server.remote!.port}`

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function api(method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined
  })
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) }
  } catch {
    return { status: res.status, body: text }
  }
}

// ── the admin side (the desktop pane, or an admin key over http) ──────────
const admin = (await server.remoteAuth.createKey({ name: 'desk', audience: 'client', caps: ['admin'], createdBy: 'local' })).token
const pairing = await api('POST', '/api/pairings', { headers: { Authorization: `Bearer ${admin}` }, body: { name: 'iphone', audience: 'client', caps: ['operate'] } })
check('admin creates a pairing', pairing.status === 200 && /^[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(pairing.body.code), JSON.stringify(pairing.body).slice(0, 120))

// ── the client side ────────────────────────────────────────────────────────
const hello0 = await api('GET', '/api/hello')
check('public hello names the environment', hello0.status === 200 && hello0.body.environmentId === server.environmentId, hello0.body.environmentId)
const paired = await api('POST', '/api/pair', { body: { code: pairing.body.code, kind: 'key', caps: ['operate'] } })
check('pair exchanges the code for a key', paired.status === 200 && typeof paired.body.key === 'string' && paired.body.key.startsWith('tc_'), `caps ${JSON.stringify(paired.body.caps)}`)
const key: string = paired.body.key
const bearer = { Authorization: `Bearer ${key}` }
const reused = await api('POST', '/api/pair', { body: { code: pairing.body.code, kind: 'key' } })
check('the code is single use', reused.status === 401, `status ${reused.status}`)
const hello = await api('GET', '/api/hello', { headers: bearer })
check('hello with the key reports it', hello.body.key?.name === 'iphone' && hello.body.key?.caps.join() === 'operate,read', JSON.stringify(hello.body.key))
const ticket = await api('POST', '/api/ticket', { headers: bearer })
check('ticket minted', ticket.status === 200 && ticket.body.expiresIn === 30)

const frames: ServerFrame[] = []
const waiters: ((f: ServerFrame) => void)[] = []
const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?ticket=${ticket.body.ticket}`)
ws.on('message', (d) => {
  const frame = JSON.parse(String(d)) as ServerFrame
  frames.push(frame)
  for (const w of waiters.splice(0)) w(frame)
})
const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: String(reason) })))
await new Promise<void>((ok, bad) => {
  ws.on('open', () => ok())
  ws.on('error', bad)
})
await sleep(100)
const first = frames[0] as { push?: string; caps?: string[]; key?: { name: string } }
check('hello is the first frame on the socket', first?.push === 'hello' && first.key?.name === 'iphone', JSON.stringify(first))
let nextId = 1
const request = (method: string, params: unknown = {}): Promise<any> =>
  new Promise((resolve) => {
    const id = String(nextId++)
    const on = (f: ServerFrame): void => {
      if ('id' in f && f.id === id) resolve(f)
      else waiters.push(on)
    }
    waiters.push(on)
    ws.send(JSON.stringify({ id, method, params }))
  })
const waitPush = (pred: (f: ServerFrame) => boolean, timeoutMs: number): Promise<ServerFrame | null> =>
  new Promise((resolve) => {
    const prior = frames.find(pred)
    if (prior) return resolve(prior)
    const timer = setTimeout(() => resolve(null), timeoutMs)
    const on = (f: ServerFrame): void => {
      if (pred(f)) {
        clearTimeout(timer)
        resolve(f)
      } else waiters.push(on)
    }
    waiters.push(on)
  })

check('reused ticket is refused', await new Promise<number>((r) => {
  const again = new WebSocket(`${base.replace('http', 'ws')}/ws?ticket=${ticket.body.ticket}`)
  again.on('unexpected-response', (_q, res) => r(res.statusCode ?? 0))
  again.on('open', () => r(101))
  again.on('error', () => {})
}) === 401)

const wsDir = mkdtempSync(join(tmpdir(), 'tc-remote-ws-'))
const workspace = await request('workspace.create', { path: wsDir, name: 'remote-ws' })
check('workspace.create (operate) allowed', workspace.ok === true, workspace.error)
const created = await request('session.create', { provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'low', agentType: 'implementer', permission: 'edits', workspaceId: workspace.result.id, threadType: 'chat', title: 'remote chat' })
check('session.create (operate) makes a chat', created.ok === true && typeof created.result?.id === 'string', created.error ?? created.result?.id)
const sessionId: string = created.result.id
const subscribed = await request('session.subscribe', { sessionId })
check('session.subscribe', subscribed.ok === true, subscribed.error)
const sent = await request('session.send', { sessionId, text: 'Reply with exactly: REMOTE-OK' })
check('session.send accepted', sent.ok === true, sent.error)
const userRow = await waitPush((f) => 'push' in f && f.push === 'event' && f.row.sessionId === sessionId && f.row.event.type === 'user-text', 10_000)
check('event push arrives for the sent message', userRow !== null)
const done = await waitPush(
  (f) => 'push' in f && f.push === 'event' && f.row.sessionId === sessionId && (f.row.event.type === 'turn-complete' || f.row.event.type === 'error'),
  180_000
)
const text = frames
  .filter((f) => 'push' in f && f.push === 'event' && f.row.sessionId === sessionId && f.row.event.type === 'assistant-text' && !(f.row.event as { delta?: boolean }).delta)
  .map((f) => ((f as { row: { event: { text: string } } }).row.event.text))
  .join(' ')
check('the reply streams back over the remote socket', done !== null && (done as { row: { event: { type: string } } }).row.event.type === 'turn-complete' && text.includes('REMOTE-OK'), text.slice(0, 80) || JSON.stringify(done)?.slice(0, 120))

const approve = await request('session.approve', { sessionId, requestId: 'x', allow: true })
check('session.approve is forbidden for an operate key', approve.ok === false && approve.error === 'forbidden: session.approve needs approve', approve.error)
const local = await request('app.listThreads', { sessionId })
check('app.* is local-only', local.ok === false && local.error === 'forbidden: app.listThreads is local-only', local.error)
const auto = await request('session.create', { permission: 'auto', cwd: wsDir })
check('an auto thread needs approve', auto.error === 'forbidden: session.create needs approve', auto.error)
const adminCall = await request('remote.keys.list')
check('remote.* needs admin', adminCall.error === 'forbidden: remote.keys.list needs admin', adminCall.error)

// ── revoke from the admin side ────────────────────────────────────────────
const keyId = paired.body.keyId as string
const revoked = await api('DELETE', `/api/keys/${keyId}`, { headers: { Authorization: `Bearer ${admin}` } })
check('admin revokes the key', revoked.status === 200 && revoked.body.ok === true)
const end = await Promise.race([closed, sleep(5000).then(() => null)])
check('revoke closes the live socket', end !== null && end.code === 4001, JSON.stringify(end))
const after = await api('POST', '/api/ticket', { headers: bearer })
check('the revoked key cannot mint tickets', after.status === 401, `status ${after.status}`)

await server.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
