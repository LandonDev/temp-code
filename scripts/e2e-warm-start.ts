/**
 * Send → first streamed token, and the words the wait shows, for new and
 * live threads (the warm start: keep-alive upstream pools, pre-connect, the
 * warm pool by shape of src/main/server/drivers/warm.ts, boot on focus, and
 * the phase words of plan Stability 3). The fake answers with a summarized
 * thought before its text. Five runs: warming off (every thread cold, the
 * Starting the CLI word timed); warming on with three shapes (adoption,
 * a live second turn, alternating shapes, a burst, a fourth shape retiring
 * the oldest, the pool's size, admission's count, retirement on the
 * TEMP_CODE_WARM_RETIRE_MS seam); the same data relaunched for boot on
 * focus (a boot then a send, reclaimIdle, the 30 s rule, ten asks at a
 * pinned cap); the memory floor (TEMP_CODE_E2E_MEMORY_LOW=1); and with
 * TC_WARM_REAL=1 one real low-effort Opus thread whose thought must stream.
 * Each sample reads its send span from the instance's stalls.log.
 *
 * The older account of the first two runs, kept: send → first streamed
 * token for a NEW thread, cold versus warm.
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
const fake = { sockets: 0, requests: [] as { path: string; method: string; at: number }[], thinking: [] as unknown[] }
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
    const body = JSON.parse((await readBody(req)) || '{}') as { model?: string; stream?: boolean; thinking?: unknown }
    // What the CLI asked for: its thinking config carries the display the flag set.
    if (body.thinking) fake.thinking.push(body.thinking)
    const model = body.model ?? 'claude-haiku-5-5'
    const words = ['Warm', ' start', ' measured', '.']
    // A summarized thought streams first, as Fable and Opus answer with --thinking-display summarized.
    const thought = ['The person wants', ' one word.']
    return sse(res, [
      ['message_start', { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, cache_read_input_tokens: 4_000, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
      ...thought.map((thinking): [string, unknown] => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } }]),
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fake-signature' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
      ...words.map((text): [string, unknown] => ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } }]),
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
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
function launch(name: string, extra: Record<string, string>, real = false, keepData = false): Inst {
  const data = join(OUT, `data-${name}`)
  if (!keepData) rmSync(data, { recursive: true, force: true })
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
    if (!keepData) seedVault(join(data, 'aliax'))
    env.TEMP_CODE_ALIAX_DATA_DIR = join(data, 'aliax')
    env.TEMP_CODE_FAKE_PROVIDERS = `http://127.0.0.1:${providerPort}`
    env.TEMP_CODE_GATEWAY_ROLE = 'owner'
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TEMP_CODE_CLAIM_SHIM
  const log = join(OUT, `${name}${keepData ? '-again' : ''}.log`)
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
  label: string
  /** ms from session.send to the first meta push naming a phase (Starting the CLI, Initializing, Waiting for the provider), null with none */
  phaseMs: number | null
  phase: string | null
  /** ms from session.send to the first thinking or assistant-text push */
  firstTokenMs: number
  /** the first content push's kind */
  firstKind: string | null
  /** ms from session.send to the thread's status settling */
  doneMs: number
  adopted: boolean
  /** the send span's handle note (live, warm, cold, live boot=focus) and init → model gap */
  span: { handle: string | null; modelGapMs: number | null; line: string } | null
}

const PHASE_WORDS = ['Starting the CLI', 'Initializing', 'Waiting for the provider']

type Pool = { driver: string; warm: unknown[]; adopted: number; spawned: number; misses?: Record<string, number> }
const claudePool = async (local: Local): Promise<Pool> =>
  (await local.request<Pool[]>('harness.warm')).find((s) => s.driver === 'claude') ?? { driver: 'claude', warm: [], adopted: 0, spawned: 0 }
/** The most warm Claude processes the pool held at any look. */
let maxWarm = 0
const lookAtPool = async (local: Local): Promise<Pool> => {
  const pool = await claudePool(local)
  maxWarm = Math.max(maxWarm, pool.warm.length)
  return pool
}

/** The send span of a thread from the instance's stalls.log (sendSpans.ts), the newest first. */
function spanOf(inst: Inst, thread: string): Sample['span'] {
  const file = join(inst.data, 'logs', 'stalls.log')
  if (!existsSync(file)) return null
  const line = readFileSync(file, 'utf8').split('\n').filter((l) => l.includes(` send session=${thread} `)).at(-1)
  if (!line) return null
  const at = (phase: string): number | null => {
    const m = line.match(new RegExp(`\\b${phase}=(\\d+)`))
    return m ? Number(m[1]) : null
  }
  const handle = line.match(/\bhandle=\d+\(([^)]*)\)/)?.[1] ?? null
  const from = at('init') ?? at('delivered')
  const model = at('model')
  return { handle, modelGapMs: from !== null && model !== null ? model - from : null, line: line.replace(/^\S+ /, '').replace(/ inflight=.*$/, '') }
}

interface ThreadOpts {
  model?: string
  permission?: 'safe' | 'edits' | 'auto'
  reasoning?: string
  text?: string
  /** An existing thread to send into (a second turn, a focus-booted one). */
  thread?: string
}

async function runThread(inst: Inst, local: Local, cwd: string, label: string, opts: ThreadOpts = {}): Promise<Sample> {
  // The pool's own count, not the log: the instance's stdout reaches its file late.
  const adoptedBefore = (await lookAtPool(local)).adopted
  const id =
    opts.thread ??
    (
      await local.request<{ id: string }>('session.create', {
        cwd,
        provider: 'claude',
        model: opts.model ?? 'claude-haiku-5-5',
        reasoning: opts.reasoning ?? 'low',
        threadType: 'chat',
        permission: opts.permission ?? 'auto',
        title: `warm-start ${label}`
      })
    ).id
  await local.request('session.subscribe', { sessionId: id })
  let t0 = 0
  let phase: { at: number; word: string } | null = null
  let first: { at: number; kind: string } | null = null
  let done: number | null = null
  const seen = new Promise<void>((ok) => {
    local.pushes.push((frame) => {
      if (!t0) return
      if (frame.push === 'session' || frame.push === 'sessions') {
        const metas = (frame.push === 'session' ? [frame.session] : frame.sessions) as { id: string; activity?: string | null }[]
        for (const meta of metas) {
          if (meta.id === id && !phase && meta.activity && PHASE_WORDS.some((w) => meta.activity!.startsWith(w))) phase = { at: Date.now(), word: meta.activity }
        }
        return
      }
      // Rows arrive coalesced on every socket (`events`); a lone `event` still reads.
      type Row = { sessionId: string; event: { type: string; status?: string; text?: string } }
      const rows = (frame.push === 'events' ? frame.rows : frame.push === 'event' ? [frame.row] : []) as Row[]
      for (const row of rows) {
        if (row.sessionId !== id) continue
        if ((row.event.type === 'assistant-text' || (row.event.type === 'thinking' && row.event.text)) && !first) first = { at: Date.now(), kind: row.event.type }
        if (first && row.event.type === 'status' && row.event.status !== 'running' && row.event.status !== 'starting' && done === null) {
          done = Date.now()
          ok()
        }
      }
    })
  })
  t0 = Date.now()
  await local.request('session.send', { sessionId: id, text: opts.text ?? 'Reply with the single word ready.' })
  await Promise.race([seen, sleep(180_000).then(() => Promise.reject(new Error(`thread ${label}: no first token in 180 s`)))])
  await local.request('session.unsubscribe', { sessionId: id })
  const adopted = (await lookAtPool(local)).adopted > adoptedBefore
  // The span is written at first content; the file lands a moment later.
  await sleep(300)
  const p = phase as { at: number; word: string } | null
  const f = first as { at: number; kind: string } | null
  const sample: Sample = {
    thread: id,
    label,
    phaseMs: p ? p.at - t0 : null,
    phase: p?.word ?? null,
    firstTokenMs: (f?.at ?? t0) - t0,
    firstKind: f?.kind ?? null,
    doneMs: (done ?? t0) - t0,
    adopted,
    span: spanOf(inst, id)
  }
  log(
    `${label}: ${sample.phase ? `"${sample.phase}" at ${sample.phaseMs} ms, ` : ''}first ${sample.firstKind ?? '?'} ${sample.firstTokenMs} ms, done ${sample.doneMs} ms, ${adopted ? 'adopted' : 'not adopted'}; span ${sample.span?.handle ?? '-'}${sample.span?.modelGapMs != null ? ` init→model ${sample.span.modelGapMs} ms` : ''}`
  )
  return sample
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}
/** Until the pool holds a warm process again (a refill), plus the settle a real gap between thread starts gives its MCP servers. */
const warmAgain = async (local: Local, count = 1): Promise<void> => {
  await until(`${count} warm`, 60_000, async () => (await lookAtPool(local)).warm.length >= count)
  await sleep(Number(process.env.TC_WARM_SETTLE_MS ?? 3_000))
}
const running = async (local: Local): Promise<number> => (await local.request<{ running: number }>('admission.get')).running

const scratch = join(OUT, 'scratch')
mkdirSync(scratch, { recursive: true })
await sh(['git', '-C', scratch, 'init', '-q'], { quiet: true })
writeFileSync(join(scratch, 'README.md'), '# warm start scratch\n')
await sh(['git', '-C', scratch, 'add', '.'], { quiet: true })
await sh(['git', '-C', scratch, '-c', 'user.email=x@y', '-c', 'user.name=x', 'commit', '-q', '-m', 'init'], { quiet: true })

const RETIRE_MS = 60_000
const report: Record<string, unknown> = { at: new Date().toISOString(), threads: THREADS }
const instances: Inst[] = []
try {
  // ── 1. cold: warming off ──
  const cold = launch('cold', { TEMP_CODE_WARM_HARNESS: '0' })
  instances.push(cold)
  const coldLocal = new Local()
  await coldLocal.open(cold)
  const coldSamples: Sample[] = []
  for (let i = 0; i < THREADS; i++) coldSamples.push(await runThread(cold, coldLocal, scratch, `cold ${i + 1}`))
  check('warming off keeps no warm process', (await claudePool(coldLocal)).warm.length === 0)
  check('every cold thread booted cold', coldSamples.every((s) => !s.adopted && s.span?.handle === 'cold'), coldSamples.map((s) => s.span?.handle).join(', '))
  const coldPhase = coldSamples.map((s) => s.phaseMs ?? Infinity)
  check('a cold spawn says Starting the CLI within 200 ms of the send', coldSamples.every((s) => s.phase === 'Starting the CLI') && median(coldPhase) <= 200, coldSamples.map((s) => `${s.phase} ${s.phaseMs}`).join(', '))
  check('the thought streams first', coldSamples.every((s) => s.firstKind === 'thinking'))
  log(`the CLI's thinking config on its requests: ${JSON.stringify([...new Set(fake.thinking.map((t) => JSON.stringify(t)))])}`)
  check('every span has its model mark with the cache', coldSamples.every((s) => /model=\d+\(hit\)/.test(s.span?.line ?? '')), coldSamples[0]?.span?.line)
  coldLocal.close()
  await stop(cold)
  report.cold = { samples: coldSamples, medianPhaseMs: median(coldPhase), medianFirstTokenMs: median(coldSamples.map((s) => s.firstTokenMs)) }

  // ── 2. warm: the pool by shape ──
  const warm = launch('warm', { TEMP_CODE_WARM_RETIRE_MS: String(RETIRE_MS) })
  instances.push(warm)
  const warmLocal = new Local()
  await warmLocal.open(warm)
  const A = { permission: 'auto' as const }
  const B = { permission: 'edits' as const }
  const C = { permission: 'auto' as const, model: 'claude-sonnet-5-5' }
  const D = { permission: 'safe' as const }
  // Case 1: warm adopted, after one cold start of the shape.
  const first = await runThread(warm, warmLocal, scratch, 'A first (cold by construction)', A)
  check('the first thread of a shape boots cold', !first.adopted)
  const warmSamples: Sample[] = []
  for (let i = 1; i < THREADS; i++) {
    await warmAgain(warmLocal)
    warmSamples.push(await runThread(warm, warmLocal, scratch, `A warm ${i}`, A))
  }
  check('every later thread of the shape adopted', warmSamples.every((s) => s.adopted && s.span?.handle === 'warm'), warmSamples.map((s) => s.span?.handle).join(', '))
  const warmMedian = median(warmSamples.map((s) => s.firstTokenMs))
  check('a warm thread reaches its first token in 0.5 s (median)', warmMedian <= 500, `${warmMedian} ms`)
  // Case 6: a live handle's second turn.
  const live = await runThread(warm, warmLocal, scratch, 'A second turn (live)', { ...A, thread: warmSamples[0].thread })
  // The fake answers in milliseconds, so the push window may fold the word away; a wait that short never paints anyway.
  check("a live handle's turn reads live, its only word the provider's", live.span?.handle === 'live' && (live.phase === null || live.phase === 'Waiting for the provider'), `${live.span?.handle}, ${live.phase}`)
  // Case 2: three shapes alternating; each adopts after its own first start.
  const firsts = [await runThread(warm, warmLocal, scratch, 'B first', B), await runThread(warm, warmLocal, scratch, 'C first', C)]
  check('a new shape boots cold', firsts.every((s) => !s.adopted))
  await warmAgain(warmLocal, 3)
  const alternating: Sample[] = []
  for (const [name, shape] of [['A', A], ['B', B], ['C', C], ['A', A], ['B', B], ['C', C]] as const) {
    alternating.push(await runThread(warm, warmLocal, scratch, `${name} alternating`, shape))
    await warmAgain(warmLocal, 3)
  }
  check('alternating shapes: every start after the shape\'s first adopts', alternating.every((s) => s.adopted), alternating.map((s) => `${s.label} ${s.adopted ? 'adopted' : 'cold'}`).join(', '))
  // Case 3: a burst of three starts of one shape, a second apart.
  const burst = await Promise.all([0, 1, 2].map(async (i) => {
    await sleep(i * 1_000)
    return runThread(warm, warmLocal, scratch, `B burst ${i + 1}`, B)
  }))
  check('a burst of three starts of one shape all adopt', burst.every((s) => s.span?.handle === 'warm'), burst.map((s) => s.span?.handle).join(', '))
  report.burstAdoptions = (await claudePool(warmLocal)).adopted
  await warmAgain(warmLocal, 3)
  // Case 4: a fourth shape retires the one that started longest ago (A: B burst, C, A came last as A, B, C).
  const missesBefore = (await claudePool(warmLocal)).misses ?? {}
  const fourth = await runThread(warm, warmLocal, scratch, 'D first (a fourth shape)', D)
  await warmAgain(warmLocal, 3)
  const afterFourth = await lookAtPool(warmLocal)
  const aAgain = await runThread(warm, warmLocal, scratch, 'A after the fourth shape', A)
  check('a fourth shape boots cold and retires the oldest: A misses', !fourth.adopted && !aAgain.adopted && afterFourth.warm.length === 3, `D ${fourth.span?.handle}, A ${aAgain.span?.handle}, ${afterFourth.warm.length} warm`)
  const missesAfter = (await claudePool(warmLocal)).misses ?? {}
  log(`misses before the fourth shape ${JSON.stringify(missesBefore)}, after ${JSON.stringify(missesAfter)}`)
  check('the pool never held more than 3 processes', maxWarm <= 3, `${maxWarm} at most`)
  // Warm processes take no running slot.
  const sessions = (await warmLocal.request<{ id: string; archived?: boolean }[]>('session.list')).filter((s) => !s.archived)
  const slots = await running(warmLocal)
  const pool = await lookAtPool(warmLocal)
  check("warm processes are not in admission.get's running count", pool.warm.length > 0 && slots <= sessions.length, `${slots} running for ${sessions.length} threads, ${pool.warm.length} warm`)
  // Case 5: each shape retires RETIRE_MS after its own last start (the seam's scaled ten minutes).
  await sleep(RETIRE_MS + 2_000)
  check(`every shape retired ${RETIRE_MS / 1000} s after its last start`, (await lookAtPool(warmLocal)).warm.length === 0)
  report.warm = {
    first,
    samples: warmSamples,
    medianFirstTokenMs: warmMedian,
    live,
    alternating,
    burst,
    fourth,
    aAgain,
    maxWarm,
    misses: missesAfter
  }
  warmLocal.close()
  await stop(warm)

  // ── 3. boot on focus: the same data relaunched, so every thread is idle with no harness ──
  const focus = launch('warm', { TEMP_CODE_WARM_RETIRE_MS: String(RETIRE_MS) }, false, true)
  instances.push(focus)
  const focusLocal = new Local()
  await focusLocal.open(focus)
  await sleep(3_000)
  const idle = (await focusLocal.request<{ id: string; status: string; archived?: boolean }[]>('session.list')).filter((s) => !s.archived && (s.status === 'idle' || s.status === 'done'))
  check('after a restart the threads are idle with no harness', idle.length >= 13 && (await running(focusLocal)) === 0, `${idle.length} idle, ${await running(focusLocal)} running`)
  const [t1, t2, ...rest] = idle.map((s) => s.id)
  // Case 7: a focus boot, then a send: the send finds the harness live.
  await focusLocal.request('session.preconnect', { sessionId: t1, boot: true })
  await until('the focus boot', 30_000, async () => (await running(focusLocal)) === 1)
  await sleep(2_000)
  const booted = await runThread(focus, focusLocal, scratch, 'focus-booted, then sent', { thread: t1 })
  check('a focus-booted thread\'s next send reads live', booted.span?.handle === 'live boot=focus', booted.span?.handle ?? 'no span')
  // The booted handle is ordinary: with the cap full and a row waiting, reclaimIdle puts it down.
  await focusLocal.request('session.preconnect', { sessionId: t2, boot: true })
  await until('the second focus boot', 30_000, async () => (await running(focusLocal)) === 2)
  await focusLocal.request('admission.set', { cap: 2 })
  const waiting = await runThread(focus, focusLocal, scratch, 'a thread queued at a full cap', A)
  check('the queued thread ran: an idle handle gave its slot', waiting.firstTokenMs > 0 && (await running(focusLocal)) <= 2)
  // t2's handle (never used) went first: a boot ask inside its 30 s boots nothing.
  await focusLocal.request('admission.set', { cap: null })
  const before = await running(focusLocal)
  await focusLocal.request('session.preconnect', { sessionId: t2, boot: true })
  await sleep(3_000)
  check('a second focus boot of a thread inside 30 s boots nothing', (await running(focusLocal)) === before, `${before} → ${await running(focusLocal)}`)
  // Case 8: ten asks at a pinned cap boot nothing.
  const full = await running(focusLocal)
  await focusLocal.request('admission.set', { cap: Math.max(1, full) })
  for (const id of rest.slice(0, 10)) await focusLocal.request('session.preconnect', { sessionId: id, boot: true })
  await sleep(4_000)
  check('ten focus asks at the cap boot nothing', (await running(focusLocal)) === full, `${full} → ${await running(focusLocal)}`)
  await focusLocal.request('admission.set', { cap: null })
  report.focus = { booted, waiting }
  focusLocal.close()
  await stop(focus)

  // ── 4. the memory floor: no warm spawn while it holds ──
  const low = launch('lowmem', { TEMP_CODE_E2E_MEMORY_LOW: '1' })
  instances.push(low)
  const lowLocal = new Local()
  await lowLocal.open(low)
  await runThread(low, lowLocal, scratch, 'under the memory floor', A)
  await runThread(low, lowLocal, scratch, 'under the memory floor, again', A)
  await sleep(5_000)
  const lowPool = await claudePool(lowLocal)
  check('no warm spawn under the memory floor', lowPool.spawned === 0 && lowPool.warm.length === 0 && (lowPool.misses?.memory ?? 0) >= 1, JSON.stringify(lowPool))
  lowLocal.close()
  await stop(low)

  // ── 5. one real low-effort Opus thread: the thought streams ──
  if (REAL) {
    const real = launch('real', {}, true)
    instances.push(real)
    const realLocal = new Local()
    await realLocal.open(real)
    const sample = await runThread(real, realLocal, REAL_CWD, 'real opus (cold)', {
      model: 'claude-opus-5-5',
      reasoning: 'low',
      text: 'Find the smallest positive integer n for which n*n + n + 41 is not prime. Reason it out, then reply with n alone.'
    })
    const meta = (await realLocal.request<{ id: string; nativeId?: string | null }[]>('session.list')).find((s) => s.id === sample.thread)
    await realLocal.request('session.archive', { sessionId: sample.thread }).catch(() => undefined)
    realLocal.close()
    await stop(real)
    // The CLI's own transcript: its thinking block carries text now.
    const projects = join(real.data, 'claude-config', 'projects')
    const jsonl = existsSync(projects)
      ? readdirSync(projects).flatMap((d) => readdirSync(join(projects, d)).filter((f) => f.startsWith(meta?.nativeId ?? '\0')).map((f) => join(projects, d, f)))
      : []
    const thoughts = jsonl.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          const m = JSON.parse(l) as { message?: { content?: { type: string; thinking?: string }[] } }
          return Array.isArray(m.message?.content) ? m.message.content.filter((b) => b.type === 'thinking') : []
        })
    )
    log(`real opus: ${thoughts.length} thinking block(s), ${thoughts.filter((t) => t.thinking).length} with text; span ${sample.span?.line ?? '-'}`)
    check('the real thread\'s thinking block has text', thoughts.some((t) => !!t.thinking?.trim()))
    check('its first content was the thought', sample.firstKind === 'thinking' && /first-content=\d+/.test(sample.span?.line ?? ''))
    report.real = { sample, thinkingBlocks: thoughts.length, withText: thoughts.filter((t) => t.thinking).length }
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
