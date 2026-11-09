/**
 * The Mac proof of computer sessions and tools (plan
 * .temp-code/plan-x0TRsa6H47tg.md §15): an in-process registry with the
 * computer host wired as index.ts wires it, on the real tc-computer, and real
 * claude threads driving a scratch TextEdit.
 *
 *  1. a thread in full access replaces the scratch document's text through
 *     the computer tools, found by tool search; every step ax or process;
 *     the live row names TextEdit while the turn runs and goes when it settles
 *  2. a thread in Ask me: its read raises no card, its first act raises one
 *     naming TextEdit, the window and the action; denied, then allowed
 *  3. Stop during a 20 s wait: that call and the next answer "stopped by the
 *     person", the turn settles on its own, the next turn reads again
 *  4. through the handler with no model: perform raise is refused the session
 *     tier, a killed service answers an old element stale and a read works on
 *     the new epoch, and the codex bridge lists the four tools and answers a
 *     screenshot as a line (images none) or an image part (images parts)
 *
 * The person keeps the Mac. During the spec build's fixture recording a
 * scratch TextEdit came to the front while the person typed and two of their
 * keystrokes landed in it, so this proof holds to the ax and process tiers
 * with the scratch window in the background, and every check also checks the
 * frontmost app and the pointer did not move. That check is void when the
 * person used the Mac during it: it runs again on fresh scratch content, at
 * most three times 30 s apart, and one still void is `inconclusive`, which is
 * not green. The scratch TextEdit is its own process, `open -n -g`, and every
 * TextEdit query is pinned to that pid, so the person's TextEdit is never a
 * target. It asks for no permission and removes everything but its report and
 * the service's trace under /tmp/tc-computer-e2e.
 *
 * Run on the Mac, under the installed TempCode.app so TCC answers for it:
 *   bun run script:e2e-computer        (esbuild → node: the Mac's bun has no node:sqlite)
 * TC_E2E_MODEL picks the threads' model (claude-sonnet-5-5 at low effort by default; never Haiku).
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import { setAppToolsRegistry } from '../src/main/server/apptools'
import { MacThreadTokens } from '../src/main/server/macTools'
import { computerHooks, type ComputerHost } from '../src/main/server/computer/mcp'
import { ComputerRpc } from '../src/main/server/computer/rpc'
import { ComputerService } from '../src/main/server/computer/service'
import { ComputerSessions } from '../src/main/server/computer/sessions'
import { ComputerRpcError } from '../src/main/server/computer/connection'
import { setSessionTierGate, REFUSE_SESSION_TIER } from '../src/main/server/computer/tierGate'
import { parseObservation } from '../src/shared/computer/observation'
import { COMPUTER_TOOLS, computerToolJsonSchema } from '../src/shared/computer/tools'
import type { ComputerMethod, Tier } from '../src/shared/computer/protocol'
import type { AgentEvent, EventRow } from '../src/shared/events'
import { buildTcComputer } from './lib/tcComputerBuild'

if (process.platform !== 'darwin') {
  console.log('skipped: macOS only')
  process.exit(0)
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORK = '/tmp/tc-computer-e2e'
const REPORT = join(WORK, 'report.json')
const TRACE = join(WORK, 'trace.log')
const KEEP = new Set(['report.json', 'trace.log'])
const BIN = join(ROOT, 'resources/native/tc-computer')
const PROBE = join(WORK, 'computer-proof-probe')
const MODEL = process.env.TC_E2E_MODEL || 'claude-sonnet-5-5'
const NONCE = randomBytes(4).toString('hex')
const DOC = join(WORK, `${NONCE}.txt`)
const HELLO = `Hello from TempCode ${NONCE}`
const VOID_RETRIES = 3
const VOID_WAIT_MS = 30_000

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
process.env.TEMP_CODE_COMPUTER_BIN = BIN
console.log('tiers ax and process only, TextEdit stays in the background; the session tier is refused until the scheduler exists')

// ── the report ──────────────────────────────────────────────────────────

type Outcome = 'passed' | 'failed' | 'inconclusive'
const report = {
  startedAt: new Date().toISOString(),
  finishedAt: '',
  model: MODEL,
  checks: [] as { name: string; outcome: Outcome; at: string; detail?: string }[],
  tiers: [] as { method: string; tier: Tier }[],
  errors: [] as { method: string; kind: string }[],
  toolCalls: {} as Record<string, string[]>,
  bounce: null as string | null,
  cleanup: [] as string[]
}
const check = (name: string, ok: boolean | 'inconclusive', detail = ''): void => {
  const outcome: Outcome = ok === 'inconclusive' ? 'inconclusive' : ok ? 'passed' : 'failed'
  report.checks.push({ name, outcome, at: new Date().toISOString(), ...(detail ? { detail } : {}) })
  console.log(`${outcome === 'passed' ? 'PASS' : outcome === 'failed' ? 'FAIL' : 'VOID'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const saveReport = (): void => writeFileSync(REPORT, JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2))

// ── the Mac, read from outside ──────────────────────────────────────────

const probe = <T>(command: string): T => JSON.parse(execFileSync(PROBE, [command], { encoding: 'utf8', timeout: 10_000 })) as T
const frontmost = (): { pid: number; bundleId: string | null } => probe('frontmost')
const pointer = (): { x: number; y: number } => probe('pointer')
const idleSeconds = (): number => probe<{ seconds: number }>('idle').seconds
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const textEditPids = (): number[] => {
  try {
    return execFileSync('pgrep', ['-x', 'TextEdit'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

/**
 * Runs `run`, then holds the person's frontmost app and pointer to what they
 * were. Void when the person touched the Mac during it: `run` again (it puts
 * fresh scratch content back itself), at most three more times 30 s apart.
 */
async function personKeepsMac(name: string, run: (attempt: number) => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const app0 = frontmost()
    const p0 = pointer()
    const t0 = Date.now()
    await run(attempt)
    const elapsed = (Date.now() - t0) / 1000
    const app1 = frontmost()
    const p1 = pointer()
    if (idleSeconds() >= elapsed) {
      const same = app0.pid === app1.pid && Math.abs(p0.x - p1.x) < 0.5 && Math.abs(p0.y - p1.y) < 0.5
      check(`${name}: the frontmost app and the pointer stayed put`, same, same ? '' : `app ${app0.pid} → ${app1.pid}, pointer ${p0.x},${p0.y} → ${p1.x},${p1.y}`)
      return
    }
    if (attempt >= VOID_RETRIES) {
      check(`${name}: the frontmost app and the pointer stayed put`, 'inconclusive', 'inconclusive: the Mac was in use')
      return
    }
    console.log(`      ${name}: the Mac was in use during the check; again in ${VOID_WAIT_MS / 1000} s`)
    await sleep(VOID_WAIT_MS)
  }
}

let scratchPid = 0
let service: ComputerService | null = null
let registry: SessionRegistry | null = null
const cleanup = async (): Promise<void> => {
  if (scratchPid) {
    try {
      process.kill(scratchPid, 'SIGKILL')
      report.cleanup.push(`killed the scratch TextEdit ${scratchPid}`)
    } catch {
      report.cleanup.push('the scratch TextEdit was gone')
    }
  }
  await registry?.disposeAll().catch(() => undefined)
  await service?.close().catch(() => undefined)
  saveReport()
  for (const name of readdirSync(WORK)) if (!KEEP.has(name)) rmSync(join(WORK, name), { recursive: true, force: true })
}
const stop = async (why: string): Promise<never> => {
  console.log(`STOP  ${why}`)
  ;(report as Record<string, unknown>).stopped = why
  await cleanup()
  process.exit(1)
}

// ── setup ───────────────────────────────────────────────────────────────

const build = buildTcComputer({ root: ROOT, require: true })
console.log(`tc-computer: ${build.built ? `built in ${build.ms} ms` : build.skipped}`)
execFileSync('xcrun', ['swiftc', '-O', '-o', PROBE, join(ROOT, 'scripts/mac/computer-proof-probe.swift')], { stdio: 'pipe' })
const grants = JSON.parse(execFileSync(BIN, ['permissions'], { encoding: 'utf8' })) as { accessibility: boolean; screenRecording: boolean }
if (!grants.accessibility) await stop('Accessibility is off for TempCode: turn it on under System Settings → Privacy & Security → Accessibility, then run this again')

const personBefore = frontmost()
writeFileSync(DOC, `Scratch ${NONCE}\n`)
const pidsBefore = new Set(textEditPids())
execFileSync('open', ['-n', '-g', '-a', 'TextEdit', DOC, '--args', '-ApplePersistenceIgnoreState', 'YES'])
for (let i = 0; i < 40 && !scratchPid; i++) {
  await sleep(250)
  scratchPid = textEditPids().find((p) => !pidsBefore.has(p)) ?? 0
}
if (!scratchPid) await stop('open -n gave no new TextEdit pid within 10 s')
await sleep(1_000)
if (frontmost().pid === scratchPid) {
  report.bounce = 'the scratch TextEdit came to the front at launch'
  if (personBefore.bundleId) execFileSync('osascript', ['-e', `tell application id "${personBefore.bundleId}" to activate`])
  await sleep(500)
  if (frontmost().pid === scratchPid) await stop('the scratch TextEdit took the front at launch and the person\'s app could not be put back')
  report.bounce += `; ${personBefore.bundleId} put back in front`
}

const dataDir = join(WORK, 'data')
const store = new Store(openDb(join(dataDir, 'app.db')))
registry = new SessionRegistry(store)
setOrchestrationRegistry(registry)
setAppToolsRegistry(registry)
registry.hostName = () => 'e2e-host'
const reg = registry

service = new ComputerService({
  dataDir: join(dataDir, 'computer'),
  env: { ...process.env, TEMP_CODE_COMPUTER_TRACE: '1' },
  trace: true,
  bin: () => BIN,
  log: (line) => appendFileSync(TRACE, line + '\n')
})
const svc = service
// What every step ran at, and every refusal, straight from the wire.
const request = svc.request.bind(svc)
svc.request = (async (method: ComputerMethod, params: never, opts?: { signal?: AbortSignal; timeoutMs?: number }) => {
  try {
    const result = await request(method, params, opts)
    const steps = method === 'action.run' ? [(result as { step: { status: string; tier?: Tier | null } }).step] : method === 'action.batch' ? (result as { steps: { status: string; tier?: Tier | null }[] }).steps : []
    for (const s of steps) if (s.status === 'ok' && s.tier) report.tiers.push({ method, tier: s.tier })
    return result
  } catch (e) {
    if (e instanceof ComputerRpcError && e.data) report.errors.push({ method, kind: e.data.kind })
    throw e
  }
}) as typeof svc.request
const pinned = new Set(['textedit', 'com.apple.textedit'])
setSessionTierGate(REFUSE_SESSION_TIER)
const sessions = new ComputerSessions({
  service: svc,
  registry: { get: (id) => reg.get(id), requestApproval: (id, req) => reg.requestApproval(id, req), awayOn: () => reg.awayOn() },
  store,
  dataDir: join(dataDir, 'computer'),
  landing: (id) => join(WORK, 'landing', id),
  resolveApp: (q) => (pinned.has(q.toLowerCase()) ? { pid: scratchPid } : null),
  log: (line) => appendFileSync(TRACE, line + '\n')
})
const tokens = new MacThreadTokens(null, 'computer')
const host: ComputerHost = { available: () => true, sessions, service: svc, tokens }
computerHooks.current = host
reg.onMeta((m) => sessions.onMeta(m))
const rpc = new ComputerRpc(host)

// The proof's own session: reads and the fresh content, at the ax tier only.
await svc.request('session.open', { session: 'proof' })
const proofRead = async (): Promise<string> => (await svc.request('state.get', { session: 'proof', app: { pid: scratchPid }, window: { title: NONCE }, mode: 'full' })).text
const textAreaOf = (text: string): number => {
  const line = parseObservation(text).lines.find((l) => l.type === 'element' && l.role === 'text area')
  if (!line || line.type !== 'element') throw new Error('the scratch window shows no text area')
  return line.index
}
const freshContent = async (): Promise<void> => {
  const obs = await svc.request('state.get', { session: 'proof', app: { pid: scratchPid }, window: { title: NONCE }, mode: 'full' })
  await svc.request('action.run', {
    session: 'proof',
    app: { pid: scratchPid },
    window: { title: NONCE },
    epoch: obs.epoch,
    action: { action: 'set_value', element: textAreaOf(obs.text), value: `Scratch ${NONCE}` },
    tiers: ['ax'],
    observe: { mode: 'none' }
  })
}

// ── threads ─────────────────────────────────────────────────────────────

const cwd = join(WORK, 'cwd')
mkdirSync(cwd, { recursive: true })
const rows = (id: string, after = 0): EventRow[] => reg.eventsAfter(id, after)
const lastSeq = (id: string): number => rows(id).at(-1)?.seq ?? 0
function waitFor(id: string, pred: (e: AgentEvent, row: EventRow) => boolean, after = 0, timeoutMs = 300_000): Promise<EventRow> {
  return new Promise((resolve, reject) => {
    const prior = rows(id, after).find((r) => pred(r.event, r))
    if (prior) return resolve(prior)
    const timer = setTimeout(() => {
      off()
      reject(new Error(`timeout waiting on ${id}`))
    }, timeoutMs)
    const off = reg.subscribe(id, (row: EventRow) => {
      if (row.seq > after && pred(row.event, row)) {
        clearTimeout(timer)
        off()
        resolve(row)
      }
    })
  })
}
const settled = (e: AgentEvent): boolean => e.type === 'turn-complete' || (e.type === 'status' && (e.status === 'error' || e.status === 'idle'))
const isComputer = (name: string): boolean => /^mcp__app__computer_/.test(name)
const toolCalls = (id: string, after = 0) =>
  rows(id, after).flatMap((r) => (r.event.type === 'tool-call' && !r.event.partial ? [{ seq: r.seq, ...r.event }] : []))
const resultOf = (id: string, callId: string): { text: string; isError: boolean } | null => {
  const row = rows(id).find((r) => r.event.type === 'tool-result' && r.event.callId === callId)
  if (!row || row.event.type !== 'tool-result') return null
  const out = row.event.output
  return { text: typeof out === 'string' ? out : JSON.stringify(out), isError: !!row.event.isError }
}
const newThread = async (permission: 'auto' | 'safe') =>
  (await reg.create({ provider: 'claude', model: MODEL, reasoning: 'low', agentType: 'implementer', permission, cwd, threadType: 'chat', parentId: null })).id

const where = `the TextEdit window whose title contains "${NONCE}"`

// 1. Claude drives TextEdit in full access
console.log('\n[1] a thread in full access replaces the document\'s text')
const a = await newThread('auto')
await personKeepsMac('the full-access turn', async (attempt) => {
  if (attempt) await freshContent()
  const after = lastSeq(a)
  let liveRow = false
  const poll = setInterval(() => {
    liveRow ||= sessions.rows().some((r) => r.threadId === a && r.apps.some((x) => x.name === 'TextEdit' && (x.window ?? '').includes(NONCE)))
  }, 200)
  await reg.send(a, `Use the computer tools. In ${where}, replace all of the document's text with exactly: ${HELLO}\nRead the window first, then act on its text area. Then stop.`)
  await waitFor(a, settled, after, 600_000)
  clearInterval(poll)
  const calls = toolCalls(a, after)
  report.toolCalls[`full access, attempt ${attempt + 1}`] = calls.map((c) => c.name)
  const firstComputer = calls.findIndex((c) => isComputer(c.name))
  const search = calls.findIndex((c) => c.name === 'ToolSearch')
  check('tool search came before the first computer call (deferred)', search >= 0 && firstComputer > search, calls.map((c) => c.name).join(', '))
  check('at least one observe and one act or batch', calls.some((c) => c.name === 'mcp__app__computer_observe') && calls.some((c) => /computer_(act|batch)$/.test(c.name)))
  check('every step ran at ax or process', report.tiers.length > 0 && report.tiers.every((t) => t.tier !== 'session'), [...new Set(report.tiers.map((t) => t.tier))].join(', '))
  const text = await proofRead()
  check('the text area holds the line', text.includes(HELLO), text.split('\n').find((l) => l.includes('text area')) ?? '')
  check('a live row named TextEdit and the window while the turn ran', liveRow)
  await sleep(500)
  check('no row once the turn settled', !sessions.rows().some((r) => r.threadId === a))
})

// 2. The card, in Ask me
console.log('\n[2] a thread in Ask me: a read raises no card, an act raises one')
await personKeepsMac('the Ask me turn', async (attempt) => {
  await freshContent()
  const b = await newThread('safe')
  await reg.send(b, `Use the computer tools. First read ${where}. Then add the word "again" at the end of its text. If an action is denied, try the same action once more. Then stop.`)
  const observe = await waitFor(b, (e) => e.type === 'tool-call' && !e.partial && e.name === 'mcp__app__computer_observe')
  const observed = await waitFor(b, (e) => e.type === 'tool-result' && observe.event.type === 'tool-call' && e.callId === observe.event.callId)
  check('the read raised no card', !rows(b, 0).some((r) => r.event.type === 'approval-request' && r.seq < observed.seq))
  const ask = await waitFor(b, (e) => e.type === 'approval-request', observed.seq)
  const title = ask.event.type === 'approval-request' ? (ask.event.title ?? '') : ''
  check('the first act raised one card naming TextEdit, the window and the action', /TextEdit/.test(title) && title.includes(NONCE) && /^[A-Z][a-z-]+ /.test(title), title)
  if (ask.event.type !== 'approval-request') return
  await reg.approve(b, ask.event.requestId, false)
  const callId = ask.event.callId
  const denied = callId ? await waitFor(b, (e) => e.type === 'tool-result' && e.callId === callId, ask.seq).catch(() => null) : null
  check('the denied call answered denied', !!denied && /denied/.test(resultOf(b, callId!)?.text ?? ''), resultOf(b, callId ?? '')?.text.slice(0, 120) ?? 'no result')
  const again = await waitFor(b, (e) => e.type === 'approval-request' || settled(e), ask.seq + 1)
  if (again.event.type === 'approval-request') {
    await reg.approve(b, again.event.requestId, true)
    const id2 = again.event.callId
    const acted = id2 ? await waitFor(b, (e) => e.type === 'tool-result' && e.callId === id2, again.seq) : null
    check('the allowed call acted', !!acted && !resultOf(b, id2!)?.isError, resultOf(b, id2 ?? '')?.text.slice(0, 120) ?? '')
  } else check('the allowed call acted', false, 'the model did not try again')
  await waitFor(b, settled, ask.seq)
  report.toolCalls[`Ask me, attempt ${attempt + 1}`] = toolCalls(b).map((c) => c.name)
})

// 3. Stop during a wait
console.log('\n[3] Stop on the live row during a 20 s wait')
await personKeepsMac('the Stop turn', async (attempt) => {
  if (attempt) await freshContent()
  const after = lastSeq(a)
  await reg.send(a, `Use the computer tools. Call computer_act on ${where} with action "wait" and duration 20. Then type the word later into its text area with computer_act. Then stop.`)
  const wait = await waitFor(a, (e) => e.type === 'tool-call' && !e.partial && isComputer(e.name) && (e.input as { action?: string } | undefined)?.action === 'wait', after)
  const end = Date.now() + 10_000
  while (!sessions.rows().find((r) => r.threadId === a)?.running && Date.now() < end) await sleep(100)
  check('computer.stop answered stopped', (await rpc.stop(a)).stopped)
  const waitId = wait.event.type === 'tool-call' ? wait.event.callId : ''
  await waitFor(a, (e) => e.type === 'tool-result' && e.callId === waitId, wait.seq)
  check('the wait answered stopped by the person', /stopped by the person/.test(resultOf(a, waitId)?.text ?? ''), resultOf(a, waitId)?.text.slice(0, 120) ?? '')
  const done = await waitFor(a, settled, wait.seq, 300_000)
  check('the turn settled on its own', done.event.type === 'turn-complete', done.event.type)
  const later = toolCalls(a, wait.seq).filter((c) => isComputer(c.name))
  check('every later computer call that turn answered stopped', later.every((c) => /stopped by the person/.test(resultOf(a, c.callId)?.text ?? '')), `${later.length} later calls`)
  const next = lastSeq(a)
  await reg.send(a, `Use computer_observe once on ${where} and tell me its text. Then stop.`)
  await waitFor(a, settled, next, 300_000)
  const read = toolCalls(a, next).find((c) => c.name === 'mcp__app__computer_observe')
  check('the next turn\'s read worked', !!read && !resultOf(a, read.callId)?.isError)
})

// 4. Through the handler, no model
console.log('\n[4] the handler with no model')
const direct = { threadId: 'proof-direct', permission: () => 'auto' as const }
await personKeepsMac('the direct calls', async () => {
  const obs = await sessions.run(direct, 'computer_observe', { app: 'TextEdit', window: NONCE, full: true })
  const parsed = parseObservation(obs.body ?? '')
  const win = parsed.lines.find((l) => l.type === 'element' && l.role === 'window')
  const raise = win && win.type === 'element' ? await sessions.run(direct, 'computer_act', { app: 'TextEdit', window: NONCE, action: 'perform', element: win.index, name: 'raise' }) : null
  check('perform raise is refused the session tier (no-scheduler)', !!raise && /needs the session tier.*nothing schedules it yet/.test(raise.steps[0] ?? ''), raise?.steps[0] ?? 'no window line')
  const epoch0 = svc.state().epoch
  const pid = svc.state().pid
  if (pid) process.kill(pid, 'SIGKILL')
  const until = Date.now() + 5_000
  while (svc.state().state === 'up' && Date.now() < until) await sleep(50)
  const area = textAreaOf(obs.body ?? '')
  const stale = await sessions.run(direct, 'computer_act', { app: 'TextEdit', window: NONCE, action: 'set_value', element: area, value: 'x' })
  check('an old element answers stale_element after the kill', stale.isError && report.errors.some((e) => e.kind === 'stale_element'), stale.body ?? '')
  const again = await sessions.run(direct, 'computer_observe', { app: 'TextEdit', window: NONCE })
  check('a read works on the new epoch', !again.isError && !!svc.state().epoch && svc.state().epoch !== epoch0, `${epoch0} → ${svc.state().epoch}`)
})

// The codex bridge, spawned as codex spawns it, against a socket that answers as index.ts does.
const http = createServer()
const wss = new WebSocketServer({ server: http })
wss.on('connection', (ws) => {
  const socket = rpc.socket()
  ws.on('close', () => socket.close())
  ws.on('message', async (data) => {
    const req = JSON.parse(String(data)) as { id: string; method: string; params: never }
    try {
      const result =
        req.method === 'app.computer' ? await socket.call(req.params) : req.method === 'app.computerCancel' ? socket.cancel(req.params) : req.method === 'app.computerTools' ? socket.tools(req.params) : null
      ws.send(JSON.stringify({ id: req.id, ok: true, result }))
    } catch (e) {
      ws.send(JSON.stringify({ id: req.id, ok: false, error: (e as Error).message }))
    }
  })
})
await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
const port = (http.address() as { port: number }).port
async function bridge(images: 'parts' | 'none'): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'scripts/app-mcp-bridge.mjs')],
    env: { ...(process.env as Record<string, string>), TEMP_CODE_PORT: String(port), TEMP_CODE_SESSION: 'proof-bridge', TEMP_CODE_COMPUTER_TOKEN: tokens.tokenFor('proof-bridge'), TEMP_CODE_COMPUTER_IMAGES: images }
  })
  const client = new Client({ name: 'e2e-computer', version: '1' })
  await client.connect(transport)
  return client
}
const none = await bridge('none')
const listed = (await none.listTools()).tools.filter((t) => t.name.startsWith('computer_'))
check(
  'the bridge lists the four tools with the schemas tools.ts gives',
  JSON.stringify(listed.map((t) => [t.name, t.inputSchema])) === JSON.stringify(COMPUTER_TOOLS.map((t) => [t.name, computerToolJsonSchema(t.input)])),
  listed.map((t) => t.name).join(', ')
)
if (!grants.screenRecording) check('screenshots over the bridge', 'inconclusive', 'Screen Recording is off for TempCode; the proof asks for nothing')
else {
  const lineOnly = (await none.callTool({ name: 'computer_observe', arguments: { app: 'TextEdit', window: NONCE, screenshot: true } })) as { content: { type: string; text?: string }[] }
  const shotLine = /screenshot 1 \(observation\): (\S+) /.exec(lineOnly.content[0]?.text ?? '')
  check('images none: a text part naming the file, no image part', !!shotLine && lineOnly.content.every((c) => c.type === 'text'), lineOnly.content.map((c) => c.type).join(', '))
  const parts = await bridge('parts')
  const withImage = (await parts.callTool({ name: 'computer_observe', arguments: { app: 'TextEdit', window: NONCE, screenshot: true } })) as { content: { type: string; text?: string; data?: string }[] }
  const path = /screenshot 1 \(observation\): (\S+) /.exec(withImage.content[0]?.text ?? '')?.[1]
  const image = withImage.content.find((c) => c.type === 'image')
  check('images parts: an image part whose bytes equal the file', !!path && !!image && existsSync(path) && Buffer.from(image.data!, 'base64').equals(readFileSync(path)))
  await parts.close()
}
await none.close()
wss.close()
http.close()

console.log(`\n${report.tiers.length} steps ran, at ${[...new Set(report.tiers.map((t) => t.tier))].join(' and ') || 'no tier'}`)
await cleanup()
const failed = report.checks.filter((c) => c.outcome === 'failed').length
const voided = report.checks.filter((c) => c.outcome === 'inconclusive').length
console.log(failed ? `\n${failed} FAILED` : voided ? `\n${voided} INCONCLUSIVE: run again when the Mac is idle` : '\nALL PASS')
process.exit(failed ? 1 : voided ? 2 : 0)
