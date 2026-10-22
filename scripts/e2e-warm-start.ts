/**
 * Send → first streamed token for a NEW thread, cold versus warm (the warm
 * start: keep-alive upstream pools, pre-connect, and the warm harness
 * process of src/main/server/drivers/warm.ts).
 *
 * An isolated headless instance of the BUILT tree (electron-vite preview,
 * fresh userData, its own vault in key-file mode) with a fake provider in
 * place of Anthropic that streams one fixed answer, driven over its local
 * socket (the implicit admin, as tc-local is). Two runs:
 *   - warming off (TEMP_CODE_WARM_HARNESS=0): every thread boots cold
 *   - warming on: the first thread boots cold and becomes the shape to keep
 *     warm; each later thread adopts the warm process (checked through
 *     harness.warm and the `adopted the warm process` log line)
 * Each thread is a chat thread in a scratch git checkout, one turn each,
 * timed from the moment `session.send` is called to the first
 * `assistant-text` push (create, subscribe and send go out together: the
 * registry boots the harness at create and send waits on it, so the boot
 * is inside the interval, as it is for app_start_thread, spawn_agent and
 * the first message of a new chat). The fake also counts how many sockets the
 * gateway opened to it, which the pools keep at one per account.
 *
 * TC_WARM_REAL=1 adds one real run: the same instance shape without the
 * fake, reading this host's own Aliax vault (an isolated instance never
 * refreshes a token; Claude static tokens need none), one claude-haiku-5-5
 * thread in /srv/agents/work/l5-phone-scratch, cold. The warm figure for
 * the real provider is derived: cold minus the harness boot the fake run
 * measured. Nothing here touches /Applications/TempCode.app, the box's
 * temp-code.service or its data.
 *
 * On a Mac with Aliax installed the instances must see no shim and no user
 * Claude config: ~/.claude/settings.json sends every Claude CLI to the shim
 * (and from there to the installed app), overriding the gateway URL the
 * driver passes, and a thread the shim routes is never warmable. So the
 * shim probe points at a closed port (ALIAX_SHIM_PORT=1) and each instance's
 * CLIs run on their own CLAUDE_CONFIG_DIR with a placeholder token the
 * gateway swaps, no non-essential traffic, and no Keychain reads. stop()
 * ends each instance by the pids it launched (scripts/lib/processTree.ts).
 *
 * Run: bun scripts/e2e-warm-start.ts     (build first: electron-vite build)
 * Report: /tmp/tc-warm-start/report.json
 */
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromiumEncrypt, deriveChromiumKey } from 'aliax-core/vault'
import { REPO, prepareEnv, sh, sleep } from './lib/packagedApp'
import { stopTree } from './lib/processTree'

prepareEnv()
const OUT = '/tmp/tc-warm-start'
const ACCOUNT = 'fake@example.com'
const THREADS = Number(process.env.TC_WARM_THREADS ?? 4)
const REAL = process.env.TC_WARM_REAL === '1'
const REAL_CWD = '/srv/agents/work/l5-phone-scratch'

if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) {
  console.error('out/main is missing: run electron-vite build first')
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

// ── the fake provider: one fixed streamed answer, a socket count ──────────────
const fake = { sockets: 0, requests: [] as { path: string; method: string; at: number }[] }
const sse = (res: ServerResponse, events: [string, unknown][]): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  res.end()
}
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((ok) => {
    let text = ''
    req.on('data', (c) => (text += c))
    req.on('end', () => ok(text))
  })
const provider = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  fake.requests.push({ path: url.pathname, method: req.method ?? '', at: Date.now() })
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/v1/messages' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}') as { model?: string; stream?: boolean }
    const model = body.model ?? 'claude-haiku-5-5'
    const words = ['Warm', ' start', ' measured', '.']
    return sse(res, [
      ['message_start', { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ...words.map((text): [string, unknown] => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }]),
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }],
      ['message_stop', { type: 'message_stop' }]
    ])
  }
  if (url.pathname === '/v1/messages/count_tokens') return json(200, { input_tokens: 12 })
  if (url.pathname === '/api/oauth/profile') return json(200, { account: { uuid: 'u-fake', email: ACCOUNT }, organization: { uuid: 'org-fake', name: 'Fake' } })
  if (url.pathname === '/api/oauth/usage') return json(200, { limits: [] })
  json(404, { error: 'not here' })
})
provider.keepAliveTimeout = 120_000
provider.on('connection', () => fake.sockets++)
await new Promise<void>((ok) => provider.listen(0, '127.0.0.1', ok))
const providerPort = (provider.address() as { port: number }).port

// ── the instance ─────────────────────────────────────────────────────────────
interface Inst {
  name: string
  data: string
  log: string
  /** One append fd for stdout and stderr: two opens of one file overwrite each other's lines. */
  logFd: number
  proc: ReturnType<typeof Bun.spawn> | null
  /** Electron's main process, from server.json once it answers. */
  mainPid: number | null
}
const claudeBlob = (access: string): string =>
  JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: access, expiresAt: Date.now() + 365 * 86_400_000, scopes: ['user:inference', 'user:profile'] } }), oauthAccount: { accountUuid: 'u-fake', emailAddress: ACCOUNT } })
function seedVault(dir: string): void {
  mkdirSync(join(dir, 'secrets'), { recursive: true, mode: 0o700 })
  const password = randomBytes(32).toString('hex')
  writeFileSync(join(dir, 'vault.key'), `${password}\n`, { mode: 0o600 })
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify({ 'claude-code': [{ name: ACCOUNT, accountId: 'u-fake', email: ACCOUNT, color: '#5b8def', createdAt: Date.now() }] }, null, 2))
  writeFileSync(join(dir, 'secrets', `claude-code__${encodeURIComponent(ACCOUNT)}.bin`), chromiumEncrypt(deriveChromiumKey(password), claudeBlob('FAKE-ACCESS')))
}
function launch(name: string, extra: Record<string, string>, real = false): Inst {
  const data = join(OUT, `data-${name}`)
  rmSync(data, { recursive: true, force: true })
  mkdirSync(data, { recursive: true })
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_USER_DATA: data,
    TEMP_CODE_REMOTE_PORT: '0',
    TEMP_CODE_GATEWAY_TRACE: '1',
    TEMP_CODE_WORK_ROOT: OUT,
    // The CLIs see no shim and no user config (see the header).
    ALIAX_SHIM_PORT: '1',
    CLAUDE_CONFIG_DIR: join(data, 'claude-config'),
    ANTHROPIC_AUTH_TOKEN: 'placeholder-the-gateway-swaps-it',
    ALIAX_CREDENTIAL_BACKEND: 'file',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...extra
  }
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true })
  if (!real) {
    seedVault(join(data, 'aliax'))
    env.TEMP_CODE_ALIAX_DATA_DIR = join(data, 'aliax')
    env.TEMP_CODE_FAKE_PROVIDERS = `http://127.0.0.1:${providerPort}`
    env.TEMP_CODE_GATEWAY_ROLE = 'owner'
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TEMP_CODE_CLAIM_SHIM
  const log = join(OUT, `${name}.log`)
  const inst: Inst = { name, data, log, logFd: openSync(log, 'a'), proc: null, mainPid: null }
  inst.proc = Bun.spawn([join(REPO, 'node_modules', '.bin', 'electron-vite'), 'preview', '--skipBuild'], { cwd: REPO, env, stdout: inst.logFd, stderr: inst.logFd })
  return inst
}
const logText = (inst: Inst): string => (existsSync(inst.log) ? readFileSync(inst.log, 'utf8') : '')
const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<void> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return
    await sleep(200)
  }
  throw new Error(`timed out: ${label}`)
}
/**
 * Everything of the instance: the preview wrapper, Electron's main process
 * (`electron .`, which outlives the wrapper's SIGTERM) and every process
 * under them, by the pids this script launched (the wrapper's, and main's
 * from server.json); on Linux, then, anything left that carries the
 * instance's own TEMP_CODE_USER_DATA in /proc.
 */
async function stop(inst: Inst): Promise<void> {
  const left = await stopTree([inst.mainPid ?? 0, inst.proc?.pid ?? 0])
  if (left.length) log(`${inst.name}: ${left.length} process(es) needed SIGKILL`)
  inst.mainPid = null
  if (inst.logFd >= 0) {
    closeSync(inst.logFd)
    inst.logFd = -1
  }
  if (existsSync('/proc')) {
    const marker = `TEMP_CODE_USER_DATA=${inst.data}`
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue
      let environ = ''
      try {
        environ = readFileSync(`/proc/${entry}/environ`, 'latin1')
      } catch {
        continue
      }
      if (!environ.split('\0').includes(marker)) continue
      try {
        process.kill(Number(entry), 'SIGKILL')
      } catch {
        /* gone */
      }
    }
  }
}

// ── the local socket, as tc-local speaks it ──────────────────────────────────
class Local {
  private ws!: WebSocket
  private next = 1
  private pending = new Map<string, { ok: (v: unknown) => void; bad: (e: Error) => void }>()
  readonly pushes: ((frame: Record<string, unknown>) => void)[] = []
  async open(inst: Inst): Promise<void> {
    await until(`${inst.name} server.json`, 60_000, () => existsSync(join(inst.data, 'server.json')))
    const { port, pid } = JSON.parse(readFileSync(join(inst.data, 'server.json'), 'utf8')) as { port: number; pid: number }
    inst.mainPid = pid
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    await new Promise<void>((ok, bad) => {
      this.ws.addEventListener('open', () => ok())
      this.ws.addEventListener('error', () => bad(new Error('socket error')))
    })
    this.ws.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>
      if (typeof frame.id === 'string' && this.pending.has(frame.id)) {
        const p = this.pending.get(frame.id)!
        this.pending.delete(frame.id)
        if (frame.ok) p.ok(frame.result)
        else p.bad(new Error(String(frame.error)))
        return
      }
      if (frame.push) for (const fn of this.pushes) fn(frame)
    })
  }
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = `m${this.next++}`
    return new Promise<T>((ok, bad) => {
      this.pending.set(id, { ok: ok as (v: unknown) => void, bad })
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }))
    })
  }
  close(): void {
    this.ws.close()
  }
}

interface Sample {
  thread: string
  /** ms from session.send to the first assistant-text push */
  firstTokenMs: number
  /** ms from session.send to the thread's status settling */
  doneMs: number
  adopted: boolean
}

const adoptions = async (local: Local): Promise<number> =>
  (await local.request<{ driver: string; adopted: number }[]>('harness.warm')).find((s) => s.driver === 'claude')?.adopted ?? 0

async function runThread(local: Local, cwd: string, model: string, label: string): Promise<Sample> {
  // The pool's own count, not the log: the instance's stdout reaches its file
  // late. Read before create: the registry boots the harness at create and
  // send waits on that boot, so the timed interval still holds it (create,
  // subscribe and send go out together here, as app_start_thread and
  // spawn_agent do).
  const adoptedBefore = await adoptions(local)
  const session = await local.request<{ id: string }>('session.create', { cwd, provider: 'claude', model, reasoning: 'low', threadType: 'chat', permission: 'auto', title: `warm-start ${label}` })
  await local.request('session.subscribe', { sessionId: session.id })
  let firstToken: number | null = null
  let done: number | null = null
  const seen = new Promise<void>((ok) => {
    local.pushes.push((frame) => {
      // Rows arrive coalesced on every socket (`events`); a lone `event` still reads.
      type Row = { sessionId: string; event: { type: string; status?: string; text?: string } }
      const rows = (frame.push === 'events' ? frame.rows : frame.push === 'event' ? [frame.row] : []) as Row[]
      for (const row of rows) {
        if (row.sessionId !== session.id) continue
        if (row.event.type === 'assistant-text' && firstToken === null) firstToken = Date.now()
        if (firstToken !== null && row.event.type === 'status' && row.event.status !== 'running' && row.event.status !== 'starting' && done === null) {
          done = Date.now()
          ok()
        }
      }
    })
  })
  const t0 = Date.now()
  await local.request('session.send', { sessionId: session.id, text: 'Reply with the single word ready.' })
  await Promise.race([seen, sleep(180_000).then(() => Promise.reject(new Error(`thread ${label}: no first token in 180 s`)))])
  await local.request('session.unsubscribe', { sessionId: session.id })
  const adoptedAfter = await adoptions(local)
  const adopted = adoptedAfter > adoptedBefore
  if (process.env.TC_WARM_DEBUG) log(`adoptions before ${adoptedBefore}, after ${adoptedAfter}`)
  const sample = { thread: session.id, firstTokenMs: (firstToken ?? t0) - t0, doneMs: (done ?? t0) - t0, adopted }
  log(`${label}: first token ${sample.firstTokenMs} ms, done ${sample.doneMs} ms${adopted ? ' (adopted the warm process)' : ' (cold)'}`)
  return sample
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

const scratch = join(OUT, 'scratch')
mkdirSync(scratch, { recursive: true })
await sh(['git', '-C', scratch, 'init', '-q'], { quiet: true })
writeFileSync(join(scratch, 'README.md'), '# warm start scratch\n')
await sh(['git', '-C', scratch, 'add', '.'], { quiet: true })
await sh(['git', '-C', scratch, '-c', 'user.email=x@y', '-c', 'user.name=x', 'commit', '-q', '-m', 'init'], { quiet: true })

const report: Record<string, unknown> = { at: new Date().toISOString(), threads: THREADS }
const instances: Inst[] = []
try {
  // ── cold: warming off ──
  const cold = launch('cold', { TEMP_CODE_WARM_HARNESS: '0' })
  instances.push(cold)
  const coldLocal = new Local()
  await coldLocal.open(cold)
  const coldSamples: Sample[] = []
  for (let i = 0; i < THREADS; i++) coldSamples.push(await runThread(coldLocal, scratch, 'claude-haiku-5-5', `cold ${i + 1}`))
  const coldWarmStatus = await coldLocal.request<{ warm: unknown[] }[]>('harness.warm')
  check('warming off keeps no warm process', coldWarmStatus.every((s) => s.warm.length === 0))
  check('every cold thread booted cold', coldSamples.every((s) => !s.adopted))
  const coldSockets = fake.sockets
  coldLocal.close()
  await stop(cold)
  const coldReused = logText(cold).split('reused=true').length - 1
  const coldFresh = logText(cold).split('reused=false').length - 1
  log(`cold run: ${coldSockets} sockets to the fake (reused=true ${coldReused}, reused=false ${coldFresh})`)
  // On HTTP/1.1 (the fake) undici drops a socket after the CLI's startup HEAD, so each
  // thread's first POST may open one; the real API is HTTP/2, where the HEAD rides along.
  check('the pools reuse sockets across cold threads', coldReused >= coldFresh, `reused=true ${coldReused}, reused=false ${coldFresh}`)
  report.cold = { samples: coldSamples, medianFirstTokenMs: median(coldSamples.map((s) => s.firstTokenMs)), sockets: coldSockets, reusedTrue: coldReused, reusedFalse: coldFresh }

  // ── warm: warming on ──
  fake.sockets = 0
  const warm = launch('warm', {})
  instances.push(warm)
  const warmLocal = new Local()
  await warmLocal.open(warm)
  const first = await runThread(warmLocal, scratch, 'claude-haiku-5-5', 'warm run, thread 1 (cold by construction)')
  check('the first thread of a warm run boots cold', !first.adopted)
  const warmSamples: Sample[] = []
  for (let i = 1; i < THREADS; i++) {
    await until('a warm process', 60_000, async () => (await warmLocal.request<{ warm: unknown[] }[]>('harness.warm')).some((s) => s.warm.length > 0))
    // Let the warm CLI finish attaching its MCP servers, as it would between two real thread starts.
    await sleep(Number(process.env.TC_WARM_SETTLE_MS ?? 4_000))
    warmSamples.push(await runThread(warmLocal, scratch, 'claude-haiku-5-5', `warm ${i}`))
  }
  check('every later thread adopted the warm process', warmSamples.every((s) => s.adopted), warmSamples.map((s) => (s.adopted ? 'adopted' : 'cold')).join(', '))
  const status = await warmLocal.request<{ driver: string; warm: unknown[]; adopted: number }[]>('harness.warm')
  const claudePool = status.find((s) => s.driver === 'claude')
  check('harness.warm counts the adoptions and shows the replacement', claudePool?.adopted === warmSamples.length, JSON.stringify(status))
  const sessions = await warmLocal.request<{ id: string }[]>('session.list')
  check('the warm process is in no session list', sessions.length === THREADS, `${sessions.length} sessions for ${THREADS} threads`)
  // A different shape (another model) boots cold and re-shapes the pool.
  const other = await runThread(warmLocal, scratch, 'claude-sonnet-5-5', 'another shape')
  check('another model boots cold', !other.adopted)
  const retired = await warmLocal.request<{ warm: unknown[] }[]>('harness.warm', { retire: true })
  check('retire empties the pool', retired.every((s) => s.warm.length === 0))
  warmLocal.close()
  await stop(warm)
  const warmReused = logText(warm).split('reused=true').length - 1
  const warmFresh = logText(warm).split('reused=false').length - 1
  log(`warm run: ${fake.sockets} sockets to the fake (reused=true ${warmReused}, reused=false ${warmFresh})`)
  const coldMedian = median(coldSamples.map((s) => s.firstTokenMs))
  const warmMedian = median(warmSamples.map((s) => s.firstTokenMs))
  report.warm = { first, samples: warmSamples, medianFirstTokenMs: warmMedian, sockets: fake.sockets, reusedTrue: warmReused, reusedFalse: warmFresh }
  log(`fake provider: cold median ${coldMedian} ms, warm median ${warmMedian} ms, saved ${coldMedian - warmMedian} ms`)
  check('a warm thread reaches its first token sooner than a cold one', warmMedian < coldMedian, `${warmMedian} < ${coldMedian}`)

  // ── one real haiku thread ──
  if (REAL) {
    const real = launch('real', {}, true)
    instances.push(real)
    const realLocal = new Local()
    await realLocal.open(real)
    const sample = await runThread(realLocal, REAL_CWD, 'claude-haiku-5-5', 'real haiku (cold)')
    await realLocal.request('session.archive', { sessionId: sample.thread }).catch(() => undefined)
    realLocal.close()
    await stop(real)
    const realReused = logText(real).split('reused=true').length - 1
    const realFresh = logText(real).split('reused=false').length - 1
    const protocols = [...logText(real).matchAll(/reused=\S+ (h2|http\/1\.1)/g)].map((m) => m[1])
    log(`real provider: first token ${sample.firstTokenMs} ms cold; forwarded reused=true ${realReused}, reused=false ${realFresh}; protocol ${protocols[0] ?? '?'}`)
    const derived = sample.firstTokenMs - (coldMedian - warmMedian)
    log(`real provider, warm (derived: cold minus the harness boot the fake run measured): about ${derived} ms`)
    report.real = { sample, reusedTrue: realReused, reusedFalse: realFresh, protocol: protocols[0] ?? null, derivedWarmMs: derived }
    check('the real provider negotiated HTTP/2 on the pool', protocols[0] === 'h2', protocols[0] ?? 'no trace line')
  }
} catch (e) {
  check('run completed', false, (e as Error).message)
} finally {
  for (const inst of instances) await stop(inst)
  provider.close()
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
console.log(`\nreport: ${join(OUT, 'report.json')}`)
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
