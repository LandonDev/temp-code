/**
 * The MCP endpoint end to end with the official client (plan: thread E).
 * Boots a real server on a temp database with the fixed port on an
 * ephemeral port, adds a scratch git repo, mints a bot key whose webhook
 * points at a receiver in this process, then drives `/mcp` through
 * @modelcontextprotocol/sdk over streamable HTTP: initialize, list the
 * tools, start a session that runs a real claude turn, read the
 * transcript, queue a message, list pending prompts, read the diff, stop
 * and archive — and checks that the notifier's `finished` reached both
 * the in-process listener and the signed webhook. Run: bun run script:e2e-mcp
 */
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure } from 'aliax-core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/main/server/index'
import type { Notice } from '../src/main/server/remote/notifier'

const root = mkdtempSync(join(tmpdir(), 'tc-mcp-e2e-'))
configure({
  dataDir: join(root, 'aliax'),
  fetch: async (url) => {
    throw new Error(`unexpected fetch ${url}`)
  },
  secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
  appName: 'temp-code-e2e'
})

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── a scratch repo and a webhook receiver ─────────────────────────────────
const repo = join(root, 'scratch')
execFileSync('git', ['init', '-q', '-b', 'main', repo])
writeFileSync(join(repo, 'README.md'), '# scratch\n')
execFileSync('git', ['-C', repo, 'add', '.'])
execFileSync('git', [
  '-C',
  repo,
  '-c',
  'user.name=e2e',
  '-c',
  'user.email=e2e@x',
  'commit',
  '-q',
  '-m',
  'init'
])

const received: { body: string; signature: string; delivery: string }[] = []
const receiver = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    received.push({
      body: Buffer.concat(chunks).toString('utf8'),
      signature: String(req.headers['x-hub-signature-256']),
      delivery: String(req.headers['x-hub-delivery'])
    })
    res.writeHead(204)
    res.end()
  })
})
await new Promise<void>((ok) => receiver.listen(0, '127.0.0.1', ok))
const receiverPort = (receiver.address() as { port: number }).port

// ── the server, the repo, the bot key ──────────────────────────────────────
const server = await startServer(join(root, 'app.db'), { claimShim: false, remotePort: 0 })
const base = `http://127.0.0.1:${server.remote!.port}`
const ws = await server.registry.createWorkspace(repo, 'scratch')
await server.registry.createProject(ws.id, 'main-work', 'local')
const secret = 'e2e-signing-secret'
const made = await server.remoteAuth.createKey({
  name: 'grok',
  audience: 'mcp',
  caps: ['operate'],
  createdBy: 'local',
  webhookUrl: `http://127.0.0.1:${receiverPort}/hook`,
  webhookSecret: secret,
  events: ['needs_you', 'finished', 'failed', 'stuck']
})
check(
  'bot key carries its webhook',
  made.key.webhookUrl !== null && made.key.events?.length === 4 && made.webhookSecret === undefined
)
const notices: Notice[] = []
server.notifier.onNotice((n) => {
  notices.push(n)
})

// ── the client ─────────────────────────────────────────────────────────────
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { 'x-api-key': made.token } }
})
const client = new Client({ name: 'e2e-mcp', version: '0.0.1' })
await client.connect(transport)
const info = client.getServerVersion()
check(
  'initialize negotiated with the SDK client',
  info?.name === 'temp-code',
  `${info?.name} ${info?.version}, session ${transport.sessionId ?? '(none)'}`
)
check('instructions reach the client', (client.getInstructions() ?? '').includes('start_session'))

const tools = await client.listTools()
const names = tools.tools.map((t) => t.name)
check(
  'tools/list names the eleven facade tools',
  names.length === 11 && names.includes('start_session') && names.includes('get_diff'),
  names.join(', ')
)
const start = tools.tools.find((t) => t.name === 'start_session')
check(
  'tools carry JSON schemas and hints',
  start?.inputSchema.type === 'object' &&
    (start.inputSchema.required as string[]).includes('repo') &&
    start.annotations?.readOnlyHint === false
)

const call = async (
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ ok: boolean; result: any; text: string }> => {
  const out = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[]
    structuredContent?: unknown
    isError?: boolean
  }
  const text = out.content.find((c) => c.type === 'text')?.text ?? ''
  return {
    ok: !out.isError,
    result: out.structuredContent ?? (!out.isError && text ? JSON.parse(text) : null),
    text
  }
}

const projects = await call('list_projects')
check(
  'list_projects shows the scratch repo',
  projects.ok && projects.result.repos.some((r: { name: string }) => r.name === 'scratch'),
  projects.text.slice(0, 100)
)

const started = await call('start_session', {
  repo: 'scratch',
  prompt: 'Reply with exactly: MCP-OK',
  model: 'claude',
  type: 'chat',
  title: 'mcp e2e'
})
check(
  'start_session returns the new row',
  started.ok && typeof started.result.id === 'string' && started.result.repo === 'scratch',
  started.text.slice(0, 160)
)
const session: string = started.result.id

let detail: any = null
for (let i = 0; i < 180; i++) {
  await sleep(1000)
  detail = (await call('get_session', { session })).result
  if (detail.status === 'done' || detail.status === 'failed' || detail.status === 'waiting') break
}
check(
  'the session ran its turn',
  detail?.status === 'done',
  `status ${detail?.status} state ${detail?.state} error ${detail?.error ?? '-'}`
)
check(
  'get_session shows what it last said',
  typeof detail?.lastSaid === 'string' && detail.lastSaid.includes('MCP-OK'),
  String(detail?.lastSaid).slice(0, 80)
)

const transcript = await call('get_transcript', { session })
check(
  'get_transcript renders the turn as lines',
  transcript.ok &&
    transcript.result.text.includes('user: Reply with exactly: MCP-OK') &&
    /assistant: .*MCP-OK/.test(transcript.result.text),
  transcript.result?.text?.split('\n').slice(-3).join(' | ')
)
const older = await call('get_transcript', {
  session,
  before: transcript.result.firstSeq,
  limit: 5
})
check(
  'paging older past the start is empty',
  older.ok && older.result.text === '' && older.result.moreBefore === false
)

const sessions = await call('list_sessions', { repo: 'scratch' })
check(
  'list_sessions lists it with status done',
  sessions.ok &&
    sessions.result.sessions.some(
      (s: { id: string; status: string }) => s.id === session && s.status === 'done'
    )
)
const pending = await call('list_pending', {})
check('list_pending is empty', pending.ok && pending.result.pending.length === 0)

writeFileSync(join(repo, 'README.md'), '# scratch\n\nchanged by the e2e\n')
const diff = await call('get_diff', { session, path: 'README.md' })
check(
  'get_diff shows the branch and the file diff',
  diff.ok &&
    diff.result.branch === 'main' &&
    diff.result.files.length === 1 &&
    String(diff.result.diff).includes('+changed by the e2e'),
  `${diff.result?.branch} ${diff.result?.totals ? JSON.stringify(diff.result.totals) : ''}`
)

// ── the notifier and the webhook: the turn settled idle, so one `finished` is due ─
for (let i = 0; i < 40 && !notices.some((n) => n.event === 'finished' && n.threadId === session); i++) await sleep(250)
const finished = notices.find((n) => n.event === 'finished' && n.threadId === session)
check('the notifier reported finished for the session', finished !== undefined, notices.map((n) => `${n.event}:${n.threadId}`).join(', '))
for (let i = 0; i < 40 && received.length === 0; i++) await sleep(250)
const hook = received.find((r) => JSON.parse(r.body).threadId === session && JSON.parse(r.body).event === 'finished')
check('the key webhook received the finished payload', hook !== undefined, received.map((r) => r.body.slice(0, 80)).join(' | '))
if (hook) {
  const expected = `sha256=${createHmac('sha256', secret).update(hook.body).digest('hex')}`
  check('x-hub-signature-256 verifies with the key secret', hook.signature === expected, hook.signature.slice(0, 24))
  check('x-hub-delivery is a UUID', /^[0-9a-f-]{36}$/.test(hook.delivery))
  const payload = JSON.parse(hook.body)
  check('the payload is the hub body shape', payload.hostId === server.environmentId && payload.title === 'mcp e2e' && typeof payload.ts === 'number', hook.body.slice(0, 160))
}

const queued = await call('send_message', { session, text: 'Reply with exactly: MCP-TWO' })
check(
  'send_message after the turn is accepted',
  queued.ok && (queued.result.delivered === 'sent' || queued.result.delivered === 'queued'),
  queued.text.slice(0, 120)
)
await sleep(1500)
const stopped = await call('stop_session', { session })
check(
  'stop_session settles the session',
  stopped.ok && stopped.result.ok === true,
  stopped.text.slice(0, 120)
)

const refused = await call('respond', { session, requestId: 'nope', allow: true })
check(
  'respond on a missing prompt explains itself',
  !refused.ok && refused.text.includes('no pending prompt'),
  refused.text.slice(0, 120)
)

const archived = await call('archive_session', { session })
check('archive_session archives it', archived.ok && archived.result.archived === true)
const gone = await call('list_sessions', { repo: 'scratch' })
check(
  'an archived session leaves the live list',
  gone.ok && !gone.result.sessions.some((s: { id: string }) => s.id === session)
)

const badKey = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-api-key': 'tc_x.y'
  },
  body: '{"jsonrpc":"2.0","id":1,"method":"ping"}'
})
check('a bad key is 401', badKey.status === 401)

await client.close()
await server.close()
receiver.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
