/**
 * Probe an existing host with the official MCP client. Credentials come only
 * from the environment; output contains counts and verdicts, never keys or
 * transcript bodies. The default run only reads existing sessions.
 *
 * TEMP_CODE_MCP_URL, TEMP_CODE_MCP_KEY: required.
 * TEMP_CODE_MCP_CLIENT_KEY: optional app-audience key for the 403 check.
 * TEMP_CODE_MCP_LIMITS=1: send a 1 MiB body and a burst of 50 pings.
 * TEMP_CODE_MCP_TURN_REPO: opt into a real Claude turn, on loopback only;
 * point it at a scratch repo registered in an isolated dev instance.
 * TEMP_CODE_MCP_MODEL: defaults to claude-haiku-5-5.
 */
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const url = new URL(required('TEMP_CODE_MCP_URL'))
const key = required('TEMP_CODE_MCP_KEY')
const clientKey = process.env.TEMP_CODE_MCP_CLIENT_KEY
const repo = process.env.TEMP_CODE_MCP_TURN_REPO
assert(
  url.pathname === '/mcp' && !url.search && !url.username && !url.password,
  'Use the /mcp endpoint without credentials in its URL'
)
assert(
  url.protocol === 'https:' || (url.protocol === 'http:' && loopback()),
  'Use HTTPS outside loopback'
)
assert(!repo || loopback(), 'Turn probes are restricted to an isolated loopback host')

const expected = [
  'list_projects',
  'list_sessions',
  'start_session',
  'send_message',
  'get_session',
  'get_transcript',
  'list_pending',
  'respond',
  'stop_session',
  'archive_session',
  'get_diff'
].sort()
const exercised = new Set<string>()
let failures = 0
let skips = 0
const secrets = [key, clientKey].filter((s): s is string => !!s)
function safe(text: string): string {
  for (const secret of secrets) text = text.replaceAll(secret, '[redacted]')
  return text.replace(/tc_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
}
function check(name: string, ok: boolean, detail = ''): void {
  console.log(safe(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`))
  if (!ok) failures++
}
function skip(name: string): void {
  skips++
  console.log(`SKIP ${name}`)
}
function required(name: string): string {
  const value = process.env[name]
  assert(value, `${name} is required`)
  return value
}
function loopback(): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const client = new Client({ name: 'temp-code-remote-proof', version: '1.0.0' })
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { 'x-api-key': key }, redirect: 'error' }
})
type Prompt = { kind: string; session: string; requestId: string }
interface ProbeValue {
  id?: string
  repos?: unknown[]
  sessions?: { id: string }[]
  pending?: Prompt[]
  status?: string
  lastSaid?: string
  error?: string | null
  text?: string
  firstSeq?: number | null
  moreBefore?: boolean
  files?: unknown[]
  ok?: boolean
  archived?: boolean
}
type Result = { ok: boolean; value: ProbeValue; text: string }
async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  exercised.add(name)
  const out = await client.callTool({ name, arguments: args })
  const content = out.content as { type: string; text?: string }[]
  const text = content.find((c) => c.type === 'text')?.text ?? ''
  return {
    ok: !out.isError,
    value: (out.structuredContent ?? (!out.isError && text ? JSON.parse(text) : {})) as ProbeValue,
    text
  }
}
async function post(
  token: string,
  body = '{"jsonrpc":"2.0","id":1,"method":"ping"}'
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { 'x-api-key': token, 'content-type': 'application/json', accept: 'application/json' },
    body
  })
}
async function waitForTurn(session: string): Promise<ProbeValue> {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    await sleep(2000)
    const row = await call('get_session', { session })
    assert(row.ok, 'get_session failed while waiting for a turn')
    if (['done', 'failed', 'waiting'].includes(row.value.status ?? '')) return row.value
  }
  throw new Error('Turn did not settle within 180 seconds')
}
async function refusePermission(pending: Prompt[]): Promise<boolean> {
  const prompt = pending.find((p) => p.kind === 'permission')
  if (!prompt) return false
  const refusal = await call('respond', {
    session: prompt.session,
    requestId: prompt.requestId,
    allow: true
  })
  check(
    'respond refuses a real permission prompt',
    !refusal.ok && /cannot approve permission prompts/i.test(refusal.text),
    refusal.ok ? 'unexpected approval' : refusal.text
  )
  return true
}

let ownedSession: string | undefined
try {
  await client.connect(transport)
  check(
    'SDK initialize with x-api-key',
    client.getServerVersion()?.name === 'temp-code',
    `server ${client.getServerVersion()?.version}`
  )
  const tools = (await client.listTools()).tools.map((t) => t.name).sort()
  check(
    'tools/list contains exactly eleven tools',
    JSON.stringify(tools) === JSON.stringify(expected),
    tools.join(', ')
  )
  const projects = await call('list_projects')
  check(
    'list_projects',
    projects.ok && Array.isArray(projects.value?.repos),
    `${projects.value?.repos?.length ?? '?'} repos`
  )
  const sessions = await call('list_sessions')
  check(
    'list_sessions',
    sessions.ok && Array.isArray(sessions.value?.sessions),
    `${sessions.value?.sessions?.length ?? '?'} sessions`
  )
  const existing = sessions.value?.sessions?.[0]
  if (existing) {
    const detail = await call('get_session', { session: existing.id })
    check(
      'get_session on an existing session',
      detail.ok && detail.value?.id === existing.id,
      `status ${detail.value?.status}`
    )
    const transcript = await call('get_transcript', { session: existing.id })
    check(
      'get_transcript on an existing session',
      transcript.ok && typeof transcript.value?.text === 'string',
      `${transcript.value?.text?.length ?? '?'} chars`
    )
  } else skip('get_session/get_transcript: no existing session in the live list')
  const pending = await call('list_pending')
  check(
    'list_pending',
    pending.ok && Array.isArray(pending.value?.pending),
    `${pending.value?.pending?.length ?? '?'} prompts`
  )
  const permissionTested = await refusePermission(pending.value?.pending ?? [])

  const bad = await post('tc_invalid.invalid')
  await bad.text()
  check('wrong key is refused', bad.status === 401, `HTTP ${bad.status}`)
  if (clientKey) {
    const response = await post(clientKey)
    const text = await response.text()
    check(
      'client-audience key is refused',
      response.status === 403 && text.includes('audience client'),
      `HTTP ${response.status}`
    )
  } else skip('client-audience rejection: TEMP_CODE_MCP_CLIENT_KEY not provided')

  if (repo) {
    const started = await call('start_session', {
      repo,
      type: 'chat',
      title: 'MCP onboarding proof',
      permission: 'safe',
      model: process.env.TEMP_CODE_MCP_MODEL ?? 'claude-haiku-5-5',
      reasoning: 'low',
      prompt: 'Do not use tools. Reply with exactly MCP-REMOTE-ONE.'
    })
    check('start_session', started.ok && typeof started.value?.id === 'string')
    assert(started.ok && started.value?.id, 'start_session failed')
    ownedSession = started.value.id
    const first = await waitForTurn(ownedSession!)
    check(
      'real Claude turn finished',
      first.status === 'done' && !!first.lastSaid?.includes('MCP-REMOTE-ONE'),
      `status ${first.status}${first.error ? `; ${first.error}` : ''}`
    )
    assert(first.status === 'done', 'First turn did not finish')
    const sent = await call('send_message', {
      session: ownedSession,
      text: 'Do not use tools. Reply with exactly MCP-REMOTE-TWO.'
    })
    check('send_message', sent.ok)
    const second = await waitForTurn(ownedSession!)
    check(
      'second real turn finished',
      second.status === 'done' && !!second.lastSaid?.includes('MCP-REMOTE-TWO'),
      `status ${second.status}`
    )
    const transcript = await call('get_transcript', { session: ownedSession })
    check(
      'get_transcript contains both real replies',
      transcript.ok &&
        /assistant: .*MCP-REMOTE-ONE/.test(transcript.value?.text ?? '') &&
        /assistant: .*MCP-REMOTE-TWO/.test(transcript.value?.text ?? '')
    )
    const older = await call('get_transcript', {
      session: ownedSession,
      before: transcript.value.firstSeq,
      limit: 5
    })
    check(
      'transcript paging before the first row',
      older.ok && older.value.text === '' && older.value.moreBefore === false
    )
    const diff = await call('get_diff', { session: ownedSession })
    check(
      'get_diff',
      diff.ok && Array.isArray(diff.value?.files),
      `${diff.value?.files?.length ?? '?'} changed files`
    )
    if (!permissionTested) {
      await call('send_message', {
        session: ownedSession,
        text: 'Use the Bash tool to run exactly: printf MCP-PERMISSION-PROBE. Do not substitute another tool. Wait for permission if asked.'
      })
      const row = await waitForTurn(ownedSession!)
      const prompts = await call('list_pending', { session: ownedSession })
      if (!(await refusePermission(prompts.value?.pending ?? []))) {
        skip(`permission refusal: no permission prompt available (status ${row.status})`)
        const missing = await call('respond', {
          session: ownedSession,
          requestId: 'mcp-proof-missing-prompt',
          allow: true
        })
        check(
          'respond explains a missing prompt',
          !missing.ok && missing.text.includes('no pending prompt')
        )
      }
    }
    const stopped = await call('stop_session', { session: ownedSession })
    check('stop_session', stopped.ok && stopped.value?.ok === true)
    const archived = await call('archive_session', { session: ownedSession })
    check('archive_session', archived.ok && archived.value?.archived === true)
    if (archived.ok) ownedSession = undefined
  } else if (!permissionTested)
    skip('respond permission refusal: no permission prompt available; no turn requested')

  if (process.env.TEMP_CODE_MCP_LIMITS === '1') {
    const oversized = await post(key, ' '.repeat(1024 * 1024))
    const body = await oversized.text()
    check(
      '1 MiB body is refused',
      oversized.status === 413 && body.includes('262144'),
      `HTTP ${oversized.status}; ${body}`
    )
    const start = Date.now()
    const burst = await Promise.all(
      Array.from({ length: 50 }, async () => {
        const res = await post(key)
        const retry = res.headers.get('retry-after')
        await res.text()
        return { status: res.status, retry }
      })
    )
    const counts: Record<string, number> = {}
    for (const item of burst) counts[item.status] = (counts[item.status] ?? 0) + 1
    check(
      '50-request burst returns only success or rate limits',
      burst.every((r) => r.status === 200 || (r.status === 429 && !!r.retry)),
      `${Date.now() - start}ms; ${JSON.stringify(counts)}; Retry-After ${burst.find((r) => r.retry)?.retry ?? '(none)'}; bucket 120/min, refill 2/s`
    )
  }
} catch (err) {
  check('probe completed', false, err instanceof Error ? err.message : String(err))
} finally {
  if (ownedSession) {
    try {
      await call('stop_session', { session: ownedSession })
      await call('archive_session', { session: ownedSession })
    } catch {
      check('clean up owned probe session', false)
    }
  }
  await client.close().catch(() => {})
}
console.log(`TOOLS EXERCISED ${[...exercised].sort().join(', ')}`)
console.log(`${failures ? 'FAILED' : 'ALL PASS'} (${failures} failures, ${skips} skips)`)
process.exitCode = failures ? 1 : 0
