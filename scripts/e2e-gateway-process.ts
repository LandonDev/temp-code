/**
 * The gateway in its own utility process, for real: an isolated headless
 * instance of the BUILT tree (electron-vite preview, fresh userData, its own
 * key-file vault) with a fake Anthropic that streams every answer slowly.
 *
 *   1. doctor.get names the gateway's process: mode `child`, its pid, port.
 *   2. A claude thread's first turn streams; the gateway process is killed
 *      (SIGKILL) while the answer is still coming.
 *   3. Main respawns it on the same port (doctor.get: a new pid, restarts 1,
 *      the port unchanged), with no new marker and no new thread URL.
 *   4. The thread's next turn streams through the new process and finishes.
 *   5. A codex request rides the child's Chromium stack (`net.fetch`, off the
 *      pools: `reused=n/a`) under the codex account the vault pins.
 *   6. TEMP_CODE_GATEWAY_TRACE lines come from the child: `[gateway:<pid>]`
 *      with the first process's pid before the kill and the second's after.
 *   7. Stopping the instance takes the gateway process with it.
 *
 * Run: bun run script:e2e-gateway-process   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app, its userData, the real
 * Aliax vault, the shim on 8787 or its marker: the instance never claims the
 * marker, ALIAX_SHIM_PORT points its shim probe at a closed port, and its
 * CLIs run on their own CLAUDE_CONFIG_DIR, so none of them reaches the
 * installed app through the shim or reads the user's sign-in. Report: /tmp/tc-gateway-process/report.json
 */
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { chromiumEncrypt, deriveChromiumKey } from 'aliax-core/vault'
import { REPO, prepareEnv, sh, sleep } from './lib/packagedApp'
import { alive, stopTree } from './lib/processTree'

prepareEnv()
const OUT = '/tmp/tc-gateway-process'
const ACCOUNT = 'fake@example.com'
const CODEX_ACCOUNT = 'codex@example.com'
/** Words per answer and the gap between them: an answer takes about three seconds to stream. */
const WORDS = 12
const GAP_MS = 250

if (!existsSync(join(REPO, 'out', 'main', 'gateway.js'))) {
  console.error('out/main/gateway.js is missing: run electron-vite build first')
  process.exit(2)
}
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)

// ── the fake provider: every answer streams a word every 250 ms ───────────────
/** Every POST with when it started and when its stream ended (Bun's server never says a client went away, so a cut shows as an end after the kill). */
const fake = { posts: [] as { at: number; done: boolean; endedAt?: number }[], codex: [] as { authorization: string; accountId: string }[] }
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((ok) => {
    let text = ''
    req.on('data', (c) => (text += c))
    req.on('end', () => ok(text))
  })
const event = (res: ServerResponse, name: string, data: unknown): boolean => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
const provider = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/v1/messages' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}') as { model?: string }
    const post: (typeof fake.posts)[number] = { at: Date.now(), done: false }
    fake.posts.push(post)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'anthropic-ratelimit-unified-status': 'allowed' })
    event(res, 'message_start', { type: 'message_start', message: { id: `msg_${fake.posts.length}`, type: 'message', role: 'assistant', model: body.model ?? 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } })
    event(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    for (let i = 0; i < WORDS; i++) {
      event(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `${i === 0 ? '' : ' '}word${i + 1}` } })
      await sleep(GAP_MS)
    }
    event(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
    event(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: WORDS } })
    event(res, 'message_stop', { type: 'message_stop' })
    post.done = true
    post.endedAt = Date.now()
    res.end()
    return
  }
  if (url.pathname === '/backend-api/codex/v1/responses' && req.method === 'POST') {
    fake.codex.push({ authorization: String(req.headers.authorization ?? ''), accountId: String(req.headers['chatgpt-account-id'] ?? '') })
    await readBody(req)
    return json(200, { ok: true })
  }
  if (url.pathname === '/v1/messages/count_tokens') return json(200, { input_tokens: 12 })
  if (url.pathname === '/api/oauth/profile') return json(200, { account: { uuid: 'u-fake', email: ACCOUNT }, organization: { uuid: 'org-fake', name: 'Fake' } })
  if (url.pathname === '/api/oauth/usage') return json(200, { limits: [] })
  json(404, { error: 'not here' })
})
await new Promise<void>((ok) => provider.listen(0, '127.0.0.1', ok))
const providerPort = (provider.address() as { port: number }).port

// ── the instance: a one-account key-file vault, headless, traced ──────────────
const data = join(OUT, 'data')
const vaultDir = join(data, 'aliax')
mkdirSync(join(vaultDir, 'secrets'), { recursive: true, mode: 0o700 })
const password = randomBytes(32).toString('hex')
writeFileSync(join(vaultDir, 'vault.key'), `${password}\n`, { mode: 0o600 })
writeFileSync(
  join(vaultDir, 'profiles.json'),
  JSON.stringify({ 'claude-code': [{ name: ACCOUNT, accountId: 'u-fake', email: ACCOUNT, color: '#5b8def', createdAt: Date.now() }], codex: [{ name: CODEX_ACCOUNT, accountId: 'acct-codex', email: CODEX_ACCOUNT, color: '#10a37f', createdAt: Date.now() }] }, null, 2)
)
// Unscoped codex traffic spends the pin.
writeFileSync(join(vaultDir, 'settings.json'), JSON.stringify({ proxyAccounts: { codex: CODEX_ACCOUNT } }))
const blob = JSON.stringify({
  keychain: JSON.stringify({ claudeAiOauth: { accessToken: 'FAKE-ACCESS', expiresAt: Date.now() + 365 * 86_400_000, scopes: ['user:inference', 'user:profile'] } }),
  oauthAccount: { accountUuid: 'u-fake', emailAddress: ACCOUNT }
})
writeFileSync(join(vaultDir, 'secrets', `claude-code__${encodeURIComponent(ACCOUNT)}.bin`), chromiumEncrypt(deriveChromiumKey(password), blob))
writeFileSync(
  join(vaultDir, 'secrets', `codex__${encodeURIComponent(CODEX_ACCOUNT)}.bin`),
  chromiumEncrypt(deriveChromiumKey(password), JSON.stringify({ tokens: { access_token: 'FAKE-CODEX', account_id: 'acct-codex' } }))
)

const logPath = join(OUT, 'instance.log')
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  TEMP_CODE_HEADLESS: '1',
  TEMP_CODE_USER_DATA: data,
  TEMP_CODE_REMOTE_PORT: '0',
  TEMP_CODE_GATEWAY_TRACE: '1',
  TEMP_CODE_WORK_ROOT: OUT,
  TEMP_CODE_WARM_HARNESS: '0',
  TEMP_CODE_ALIAX_DATA_DIR: vaultDir,
  TEMP_CODE_FAKE_PROVIDERS: `http://127.0.0.1:${providerPort}`,
  TEMP_CODE_GATEWAY_ROLE: 'owner',
  // Aliax's shim (8787) is installed on the Mac and routes to the installed app: the
  // instance must see no shim, so its CLIs get this instance's own gateway.
  ALIAX_SHIM_PORT: '1',
  // The CLI's own config, sign-in and settings live here, never in ~/.claude: the user's
  // settings.json sends every CLI to the shim and would override the gateway URL the
  // driver passes. The CLI carries a placeholder token; the gateway swaps it for the vault's.
  CLAUDE_CONFIG_DIR: join(OUT, 'claude-config'),
  ANTHROPIC_AUTH_TOKEN: 'placeholder-the-gateway-swaps-it',
  ALIAX_CREDENTIAL_BACKEND: 'file'
}
mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
delete env.ELECTRON_RUN_AS_NODE
delete env.TEMP_CODE_CLAIM_SHIM
// One append fd for both streams: two opens of one file would overwrite each other's lines.
const logFd = openSync(logPath, 'a')
const wrapper = Bun.spawn([join(REPO, 'node_modules', '.bin', 'electron-vite'), 'preview', '--skipBuild'], { cwd: REPO, env, stdout: logFd, stderr: logFd })
const logText = (): string => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '')
const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<void> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return
    await sleep(200)
  }
  throw new Error(`timed out: ${label}`)
}

// ── the local socket, as tc-local speaks it ──────────────────────────────────
type Frame = Record<string, unknown>
const pending = new Map<string, { ok: (v: unknown) => void; bad: (e: Error) => void }>()
const listeners: ((frame: Frame) => void)[] = []
let ws: WebSocket
let next = 1
/** Electron's main process, from server.json. */
let mainPid = 0
const request = <T = unknown>(method: string, params?: unknown): Promise<T> => {
  const id = `g${next++}`
  return new Promise<T>((ok, bad) => {
    pending.set(id, { ok: ok as (v: unknown) => void, bad })
    ws.send(JSON.stringify({ id, method, params: params ?? {} }))
  })
}
async function connect(): Promise<void> {
  await until('server.json', 90_000, () => existsSync(join(data, 'server.json')))
  const { port, pid } = JSON.parse(readFileSync(join(data, 'server.json'), 'utf8')) as { port: number; pid: number }
  mainPid = pid
  ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  await new Promise<void>((ok, bad) => {
    ws.addEventListener('open', () => ok())
    ws.addEventListener('error', () => bad(new Error('socket error')))
  })
  ws.addEventListener('message', (e) => {
    const frame = JSON.parse(String(e.data)) as Frame
    if (typeof frame.id === 'string' && pending.has(frame.id)) {
      const p = pending.get(frame.id)!
      pending.delete(frame.id)
      if (frame.ok) p.ok(frame.result)
      else p.bad(new Error(String(frame.error)))
      return
    }
    if (frame.push) for (const fn of listeners) fn(frame)
  })
}

interface GatewayDoctor {
  mode: 'child' | 'in-process'
  pid: number
  restarts: number
  port: number
}
const doctor = async (): Promise<GatewayDoctor | undefined> => (await request<{ gateway?: GatewayDoctor }>('doctor.get')).gateway

/** One turn: send, the first streamed text, the settle. `onFirstText` runs once the answer is streaming. */
async function turn(sessionId: string, text: string, onFirstText?: () => void | Promise<void>): Promise<{ firstTextMs: number | null; status: string; ms: number; error: string | null }> {
  let first: number | null = null
  let error: string | null = null
  let settled: (status: string) => void = () => {}
  const done = new Promise<string>((ok) => (settled = ok))
  const fn = (frame: Frame): void => {
    if (frame.push !== 'event') return
    const row = frame.row as { sessionId: string; event: { type: string; status?: string; text?: string; message?: string } }
    if (row.sessionId !== sessionId) return
    if (row.event.type === 'assistant-text' && first === null) {
      first = Date.now()
      void onFirstText?.()
    }
    if (row.event.type === 'error') error = row.event.message ?? row.event.text ?? 'error'
    if (row.event.type === 'status' && first !== null && !['running', 'starting'].includes(row.event.status ?? '')) settled(row.event.status ?? '')
    if (row.event.type === 'status' && row.event.status === 'error') settled('error')
  }
  listeners.push(fn)
  const t0 = Date.now()
  await request('session.send', { sessionId, text })
  const status = await Promise.race([done, sleep(150_000).then(() => 'timeout')])
  listeners.splice(listeners.indexOf(fn), 1)
  return { firstTextMs: first === null ? null : first - t0, status, ms: Date.now() - t0, error }
}

const report: Record<string, unknown> = { at: new Date().toISOString() }
const gatewayPids: number[] = []
try {
  await connect()
  const scratch = join(OUT, 'scratch')
  mkdirSync(scratch, { recursive: true })
  await sh(['git', '-C', scratch, 'init', '-q'], { quiet: true })
  writeFileSync(join(scratch, 'README.md'), '# gateway process scratch\n')
  await sh(['git', '-C', scratch, 'add', '.'], { quiet: true })
  await sh(['git', '-C', scratch, '-c', 'user.email=x@y', '-c', 'user.name=x', 'commit', '-q', '-m', 'init'], { quiet: true })

  // 1. The gateway runs in a process of its own.
  const before = await doctor()
  report.before = before
  check('doctor.get names the gateway process', before?.mode === 'child' && before.pid > 0 && before.port > 0, JSON.stringify(before))
  if (!before || before.mode !== 'child') throw new Error('the gateway is not in its own process')
  gatewayPids.push(before.pid)
  const parent = Number((await sh(['ps', '-o', 'ppid=', '-p', String(before.pid)], { quiet: true })).trim())
  check("the gateway process is the instance's child, not the instance", parent === mainPid && mainPid !== before.pid && alive(before.pid), `gateway ${before.pid}, its parent ${parent}, main ${mainPid}`)

  // 2. A turn streams; the gateway process dies mid-answer.
  const session = await request<{ id: string }>('session.create', { cwd: scratch, provider: 'claude', model: 'claude-haiku-5-5', reasoning: 'low', threadType: 'chat', permission: 'auto', title: 'gateway process' })
  await request('session.subscribe', { sessionId: session.id })
  let killedAt = 0
  const postsBeforeKill = (): number => fake.posts.length
  let postsAtKill = 0
  const first = await turn(session.id, 'Reply with twelve words.', async () => {
    await sleep(500)
    postsAtKill = postsBeforeKill()
    killedAt = Date.now()
    process.kill(before.pid, 'SIGKILL')
    log(`killed the gateway process ${before.pid} while turn 1 streamed`)
  })
  // Relative to the kill: a request that started before it and was still streaming after it rode the dead process.
  const timeline = fake.posts.map((p) => ({ startMs: p.at - killedAt, endedMs: p.endedAt ? p.endedAt - killedAt : null }))
  const inFlight = timeline.filter((p) => p.startMs < 0 && (p.endedMs === null || p.endedMs > 0)).length
  report.firstTurn = { ...first, killedAt, posts: timeline }
  log(`turn 1: first text ${first.firstTextMs} ms, settled ${first.status} after ${first.ms} ms${first.error ? `, error: ${first.error.slice(0, 200)}` : ''}`)
  check('the answer was streaming through the gateway when it died', killedAt > 0 && inFlight >= 1, `${inFlight} request(s) mid-stream at the kill`)
  // Whether the CLI retried the cut request is the CLI's business; the proof only reports it.
  log(`the CLI sent ${fake.posts.length - postsAtKill} request(s) after the kill; turn 1 ${first.status === 'idle' && !first.error ? 'finished on its retry' : 'ended on the cut'}`)

  // 3. Respawned on the same port.
  await until('a respawned gateway', 30_000, async () => {
    const d = await doctor()
    return !!d && d.restarts >= 1 && d.pid !== before.pid && d.pid > 0
  })
  const after = (await doctor())!
  report.after = after
  gatewayPids.push(after.pid)
  check('the gateway came back in a new process on the same port', after.mode === 'child' && after.pid !== before.pid && after.port === before.port && after.restarts === 1, `pid ${before.pid} → ${after.pid}, port ${before.port} → ${after.port}, restarts ${after.restarts}`)
  check('the dead process is gone', !alive(before.pid))

  // 4. The next turn succeeds.
  const postsBefore = fake.posts.length
  const second = await turn(session.id, 'Reply with twelve words again.')
  report.secondTurn = second
  log(`turn 2: first text ${second.firstTextMs} ms, settled ${second.status} after ${second.ms} ms`)
  check('the next turn streams and finishes', second.firstTextMs !== null && second.status === 'idle', `${second.status}${second.error ? `: ${second.error.slice(0, 200)}` : ''}`)
  check('the next turn went upstream', fake.posts.length > postsBefore && fake.posts.slice(postsBefore).some((p) => p.done))

  // 5. Codex rides the child's Chromium stack.
  const codex = await fetch(`http://127.0.0.1:${after.port}/codex/v1/responses`, { method: 'POST', headers: { authorization: 'Bearer CLI', 'content-type': 'application/json' }, body: '{"model":"gpt-6-sol"}' })
  check('a codex request answers through the child', codex.status === 200 && fake.codex.length === 1, `status ${codex.status}`)
  check("it carried the pinned codex account's token, not the caller's", fake.codex[0]?.authorization === 'Bearer FAKE-CODEX' && fake.codex[0]?.accountId === 'acct-codex', JSON.stringify(fake.codex[0] ?? null))

  // 6. The trace lines come from the child processes.
  await sleep(1_000)
  const text = logText()
  const traced = (pid: number): number => text.split('\n').filter((l) => new RegExp(`\\[gateway:${pid}\\] [A-Z]+ /claude/`).test(l)).length
  const tracedIn = { [before.pid]: traced(before.pid), [after.pid]: traced(after.pid) }
  report.trace = tracedIn
  check('trace lines from the first gateway process before the kill', traced(before.pid) >= 1, `${traced(before.pid)} line(s)`)
  check('trace lines from the respawned process after it', traced(after.pid) >= 1, `${traced(after.pid)} line(s)`)
  check('no trace line from the main process', !/^\[gateway\] [A-Z]+ \/claude\//m.test(text))
  const sample = text.split('\n').find((l) => l.includes(`[gateway:${after.pid}] POST /claude/`))
  if (sample) log(`trace: ${sample.trim().slice(0, 200)}`)
  check('main logged the respawn on the same port', text.includes(`respawning on :${before.port}`))
  check("the codex request rode Chromium's stack in the child", new RegExp(`\\[gateway:${after.pid}\\] POST /codex/v1/responses → 200 reused=n/a`).test(text))
  await request('session.archive', { sessionId: session.id }).catch(() => undefined)
} catch (e) {
  check('run completed', false, (e as Error).message)
} finally {
  ws?.close()
  // The instance by the pids this script launched: Electron's main (server.json) and the
  // preview wrapper get SIGTERM, and whatever of their tree outlives the grace gets SIGKILL.
  const left = await stopTree([mainPid, wrapper.pid ?? 0], 15_000)
  // 7. The gateway process goes with main, without the SIGKILL.
  const outlived = gatewayPids.filter((p) => left.includes(p))
  check('stopping the instance took the gateway process with it', gatewayPids.length > 0 && outlived.length === 0, outlived.length ? `outlived main: ${outlived.join(', ')}` : '')
  if (left.length) log(`${left.length} process(es) of the instance needed SIGKILL`)
  provider.closeAllConnections()
  provider.close()
  closeSync(logFd)
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
console.log(`\nreport: ${join(OUT, 'report.json')}  log: ${logPath}`)
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
