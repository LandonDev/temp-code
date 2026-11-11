/**
 * The Mac proof of computer sessions and tools (plan
 * .temp-code/plan-x0TRsa6H47tg.md §15): an in-process registry with the
 * computer host wired as index.ts wires it, on the real tc-computer, and real
 * claude threads driving a scratch app of the proof's own, "TC Probe"
 * (scripts/mac/computer-probe-app.swift: one inert window with a text field, a
 * Ping button and a label).
 *
 *  1. a thread in full access replaces the field's text through the computer
 *     tools, found by tool search; every step ax or process; the live row
 *     names TC Probe while the turn runs and goes when it settles
 *  2. a thread in Ask me: its read raises no card, its first act raises one
 *     naming the app, the window and the action; denied, then allowed
 *  3. Stop during a 20 s wait: that call and the next answer "stopped by the
 *     person", the turn settles on its own, the next turn reads again
 *  4. through the handler with no model: perform raise is refused the session
 *     tier, a killed service answers an old element stale and a read works on
 *     the new epoch, and the codex bridge lists the four tools and answers a
 *     screenshot as a line (images none) or an image part (images parts)
 *
 * The person keeps the Mac. During the spec build's fixture recording a
 * scratch TextEdit came to the front while the person typed and two of their
 * keystrokes landed in it. So the proof drives no app of the person's: TC
 * Probe never activates, its window can never be key or main and takes no
 * click, it keeps no saved state and leaves no recent-document entry. Every
 * action runs at the ax and process tiers, and every step also checks the
 * person's frontmost app and pointer did not move. A try starts only after 5
 * minutes with no input on an unlocked, awake screen (AX sees no window on a
 * locked one); a watch reads the idle time and the screen every second, and
 * the person's input (anything outside a second after the proof's own action
 * calls, whose process-tier events move the idle time too) or a lock ends the
 * try at once: TC Probe hidden and ended, the threads interrupted, its checks
 * set aside as void. Another gap is awaited, 90 minutes in all; none is "not
 * run", which is not green. TC_PROOF_UNGATED=1, for a run the person has
 * agreed to sit beside (the scratch windows may come forward), drops the idle
 * wait and the abort on input, as the shell's proof does: a try starts once
 * the screen is awake, a lock or a dark display still ends it, and a step
 * during which the person used the Mac skips its frontmost-and-pointer check;
 * the report says `ungated: true`. One proof on the Mac at a time: whoever
 * starts this checks that no other computer proof runs first. It asks for no
 * permission and removes everything but its report and the service's trace
 * under /tmp/tc-computer-e2e.
 *
 * Run on the Mac, under the installed TempCode.app so TCC answers for it:
 *   bun run script:e2e-computer        (esbuild → node: the Mac's bun has no node:sqlite)
 * TC_E2E_MODEL picks the threads' model (claude-sonnet-5-5 at low effort by default; never Haiku).
 */
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { homedir } from 'node:os'
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
import { computerToolJsonSchema, computerToolSpecs } from '../src/shared/computer/tools'
import type { ComputerMethod, Tier } from '../src/shared/computer/protocol'
import type { AgentEvent, EventRow } from '../src/shared/events'
import { buildTcComputer } from './lib/tcComputerBuild'
import { repoRoot } from './lib/repoRoot'

if (process.platform !== 'darwin') {
  console.log('skipped: macOS only')
  process.exit(0)
}

// the checkout, wherever this file runs from: bundled, it sits in scripts/.out/
const ROOT = repoRoot()
const WORK = '/tmp/tc-computer-e2e'
const REPORT = join(WORK, 'report.json')
const TRACE = join(WORK, 'trace.log')
const KEEP = new Set(['report.json', 'trace.log'])
const BIN = join(ROOT, 'resources/native/tc-computer')
const PROBE = join(WORK, 'computer-proof-probe')
const MODEL = process.env.TC_E2E_MODEL || 'claude-sonnet-5-5'
const NONCE = randomBytes(4).toString('hex')
const APP = 'TC Probe'
const PROBE_APP = join(WORK, `${APP}.app`)
const PROBE_BUNDLE_ID = 'dev.landon.tempcode.computer-e2e-probe'
/** The idle gate off, by the person's leave: they sit beside the run. */
const UNGATED = process.env.TC_PROOF_UNGATED === '1'
/** A launch starts only after this long with no input (the person's rule for proofs that launch an app). */
const LAUNCH_IDLE_S = UNGATED ? 0 : 300
/** How long the tries may wait for a gap. */
const LAUNCH_WAIT_MS = 90 * 60_000
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const HELLO = `Hello from TempCode ${NONCE}`
const NOT_RUN = UNGATED ? 'not run: the Mac was locked or its display dark for 90 minutes' : 'not run: the person was at the Mac'
const NOT_RUN_LOCKED = `${NOT_RUN}, and it was locked or dark when they were away`
/** Input this soon after one of the proof's own posting calls answered is its own event's echo. */
const OWN_INPUT_TAIL_MS = 1_000

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
process.env.TEMP_CODE_COMPUTER_BIN = BIN
console.log('tiers ax and process only, TC Probe stays in the background; the session tier is refused until the scheduler exists')

// ── the report ──────────────────────────────────────────────────────────

/** skipped: a check the person's own use of the Mac made unjudgeable; it neither fails nor holds green back. */
type Outcome = 'passed' | 'failed' | 'inconclusive' | 'skipped'
const report = {
  startedAt: new Date().toISOString(),
  finishedAt: '',
  model: MODEL,
  /** The idle gate was off for this run, by the person's leave (TC_PROOF_UNGATED=1). */
  ungated: UNGATED,
  checks: [] as { name: string; outcome: Outcome; at: string; detail?: string }[],
  tiers: [] as { method: string; tier: Tier }[],
  errors: [] as { method: string; kind: string }[],
  toolCalls: {} as Record<string, string[]>,
  bounce: null as string | null,
  tries: [] as { at: string; outcome: 'clean' | 'input' | 'locked'; voided?: { name: string; outcome: Outcome }[] }[],
  cleanup: [] as string[]
}
const check = (name: string, ok: boolean | 'inconclusive' | 'skipped', detail = ''): void => {
  const outcome: Outcome = ok === 'inconclusive' || ok === 'skipped' ? ok : ok ? 'passed' : 'failed'
  report.checks.push({ name, outcome, at: new Date().toISOString(), ...(detail ? { detail } : {}) })
  console.log(`${{ passed: 'PASS', failed: 'FAIL', inconclusive: 'VOID', skipped: 'SKIP' }[outcome]}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const saveReport = (): void => writeFileSync(REPORT, JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2))

// ── the Mac, read from outside ──────────────────────────────────────────

const probe = <T>(command: string): T => JSON.parse(execFileSync(PROBE, command.split(' '), { encoding: 'utf8', timeout: 10_000 })) as T
const frontmost = (): { pid: number; bundleId: string | null } => probe('frontmost')
const pointer = (): { x: number; y: number } => probe('pointer')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const probeAsync = async <T>(command: string): Promise<T> =>
  JSON.parse((await promisify(execFile)(PROBE, command.split(' '), { encoding: 'utf8', timeout: 5_000 })).stdout) as T

/** The screen is unlocked, on this console, and the main display awake: AX sees no window otherwise. */
const screenAwake = async (): Promise<boolean> => {
  try {
    const screen = await probeAsync<{ locked: boolean; asleep: boolean }>('screen')
    return !screen.locked && !screen.asleep
  } catch {
    return false
  }
}

/**
 * The stretches the proof itself may have posted input: from each action or probe call going out to
 * OWN_INPUT_TAIL_MS after its answer. A process-tier click moves the Mac's idle time as a hand would.
 */
const ownInput = {
  spans: [] as { from: number; to: number | null }[],
  open(): { from: number; to: number | null } {
    const span = { from: Date.now(), to: null as number | null }
    this.spans.push(span)
    return span
  },
  covers(at: number): boolean {
    return this.spans.some((span) => at >= span.from - 100 && at <= (span.to ?? Infinity) + OWN_INPUT_TAIL_MS)
  }
}

/** Set when an idle stretch long enough for a try came while the Mac was locked or dark. */
let lockedGap = false

/** Waits for LAUNCH_IDLE_S with no input on an unlocked, awake screen; false once the deadline passes. */
async function waitForGap(deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    const idle = UNGATED ? 0 : await probeAsync<{ seconds: number }>('idle').then((r) => r.seconds, () => 0)
    if (idle >= LAUNCH_IDLE_S) {
      if (await screenAwake()) return true
      lockedGap = true
      await sleep(10_000)
      continue
    }
    await sleep(Math.min(30_000, Math.max(1_000, (LAUNCH_IDLE_S - idle) * 1_000)))
  }
  return false
}

/** When the person last touched the Mac outside the proof's own posting spans, as the watch saw it. */
let personInputAt = 0

/**
 * Every second from `since`: notes the person's input, which fires `onFire` once unless ungated; a
 * locked or dark screen fires it either way.
 */
function startWatch(since: number, onFire: () => void): { stop: () => void; fired: () => 'input' | 'locked' | null } {
  let fired: 'input' | 'locked' | null = null
  const fire = (why: 'input' | 'locked'): void => {
    if (fired) return
    fired = why
    onFire()
  }
  const timer = setInterval(() => {
    void Promise.all([probeAsync<{ seconds: number }>('idle'), screenAwake()]).then(
      ([{ seconds }, awake]) => {
        const lastInput = Date.now() - seconds * 1_000
        const person = lastInput > since && !ownInput.covers(lastInput)
        if (person) personInputAt = Math.max(personInputAt, lastInput)
        if (person && !UNGATED) fire('input')
        else if (!awake) fire('locked')
      },
      () => undefined
    )
  }, 1_000)
  return { stop: () => clearInterval(timer), fired: () => fired }
}

/** Holds the person's frontmost app and pointer to what they were across `run`. */
async function personKeepsMac(name: string, run: () => Promise<void>): Promise<void> {
  const t0 = Date.now()
  const app0 = frontmost()
  const p0 = pointer()
  await run()
  const app1 = frontmost()
  const p1 = pointer()
  if (personInputAt >= t0) return check(`${name}: the frontmost app and the pointer stayed put`, 'skipped', 'the person used the Mac during it')
  const same = app0.pid === app1.pid && Math.abs(p0.x - p1.x) < 0.5 && Math.abs(p0.y - p1.y) < 0.5
  check(`${name}: the frontmost app and the pointer stayed put`, same, same ? '' : `app ${app0.pid} → ${app1.pid}, pointer ${p0.x},${p0.y} → ${p1.x},${p1.y}`)
}

let scratchPid = 0
const killProbeApp = (): void => {
  if (!scratchPid) return
  try {
    process.kill(scratchPid, 'SIGTERM')
    report.cleanup.push(`ended TC Probe ${scratchPid}`)
  } catch {
    report.cleanup.push('TC Probe was gone')
  }
  scratchPid = 0
}
let service: ComputerService | null = null
let registry: SessionRegistry | null = null
const cleanup = async (): Promise<void> => {
  killProbeApp()
  try {
    execFileSync(LSREGISTER, ['-u', PROBE_APP], { stdio: 'ignore' })
    report.cleanup.push('unregistered TC Probe from Launch Services')
  } catch {
    // nothing registered
  }
  rmSync(join(homedir(), 'Library/Saved Application State', `${PROBE_BUNDLE_ID}.savedState`), { recursive: true, force: true })
  await registry?.close().catch(() => undefined)
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

/** Everything but the verdict: a check that throws is a failed run, and the cleanup always runs. */
async function run(): Promise<void> {
  // ── setup ───────────────────────────────────────────────────────────────

  const build = buildTcComputer({ root: ROOT, require: true })
  console.log(`tc-computer: ${build.built ? `built in ${build.ms} ms` : build.skipped}`)
  execFileSync('xcrun', ['swiftc', '-O', '-o', PROBE, join(ROOT, 'scripts/mac/computer-proof-probe.swift')], { stdio: 'pipe' })
  const grants = JSON.parse(execFileSync(BIN, ['permissions'], { encoding: 'utf8' })) as { accessibility: boolean; screenRecording: boolean }
  if (!grants.accessibility) await stop('Accessibility is off for TempCode: turn it on under System Settings → Privacy & Security → Accessibility, then run this again')

  mkdirSync(join(PROBE_APP, 'Contents/MacOS'), { recursive: true })
  execFileSync('xcrun', ['swiftc', '-O', '-o', join(PROBE_APP, 'Contents/MacOS', APP), join(ROOT, 'scripts/mac/computer-probe-app.swift')], { stdio: 'pipe' })
  writeFileSync(
    join(PROBE_APP, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
    <key>CFBundleIdentifier</key><string>${PROBE_BUNDLE_ID}</string>
    <key>CFBundleName</key><string>${APP}</string>
    <key>CFBundleExecutable</key><string>${APP}</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>NSHighResolutionCapable</key><true/>
  </dict>
  </plist>
  `
  )
  execFileSync('codesign', ['-s', '-', '--force', PROBE_APP], { stdio: 'pipe' })

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
    const span = method === 'action.run' || method === 'action.batch' || method === 'input.probe' ? ownInput.open() : null
    try {
      const result = await request(method, params, opts)
      const steps = method === 'action.run' ? [(result as { step: { status: string; tier?: Tier | null } }).step] : method === 'action.batch' ? (result as { steps: { status: string; tier?: Tier | null }[] }).steps : []
      for (const s of steps) if (s.status === 'ok' && s.tier) report.tiers.push({ method, tier: s.tier })
      return result
    } catch (e) {
      if (e instanceof ComputerRpcError && e.data) report.errors.push({ method, kind: e.data.kind })
      throw e
    } finally {
      if (span) span.to = Date.now()
    }
  }) as typeof svc.request
  const pinned = new Set([APP.toLowerCase(), PROBE_BUNDLE_ID])
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

  // The proof's own session: the launch, reads and the fresh content, at the ax tier only.
  await svc.request('session.open', { session: 'proof' })

  const proofRead = async (): Promise<string> => (await svc.request('state.get', { session: 'proof', app: { pid: scratchPid }, window: { title: APP }, mode: 'full' })).text
  const fieldOf = (text: string): number => {
    const line = parseObservation(text).lines.find((l) => l.type === 'element' && l.role === 'input')
    if (!line || line.type !== 'element') throw new Error('the scratch window shows no text field')
    return line.index
  }
  const freshContent = async (): Promise<void> => {
    const obs = await svc.request('state.get', { session: 'proof', app: { pid: scratchPid }, window: { title: APP }, mode: 'full' })
    await svc.request('action.run', {
      session: 'proof',
      app: { pid: scratchPid },
      window: { title: APP },
      epoch: obs.epoch,
      action: { action: 'set_value', element: fieldOf(obs.text), value: `Scratch ${NONCE}` },
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
  const liveThreads = new Set<string>()
  let tries = 0
  const newThread = async (permission: 'auto' | 'safe'): Promise<string> => {
    const id = (await reg.create({ provider: 'claude', model: MODEL, reasoning: 'low', agentType: 'implementer', permission, cwd, threadType: 'chat', parentId: null })).id
    liveThreads.add(id)
    return id
  }

  const where = `the window "${APP}" of the app "${APP}"`

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
  /** TC Probe in the background, its window listed; a raise at launch behind the gap is noted and undone. */
  async function launch(): Promise<void> {
    const before = frontmost()
    scratchPid = (await svc.request('apps.launch', { app: PROBE_APP })).pid
    await sleep(1_000)
    if (frontmost().pid === scratchPid) {
      report.bounce = 'TC Probe came to the front at launch'
      if (before.bundleId) execFileSync('osascript', ['-e', `tell application id "${before.bundleId}" to activate`])
      await sleep(500)
      if (frontmost().pid === scratchPid) throw new Error("TC Probe took the front at launch and the person's app could not be put back")
      report.bounce += `; ${before.bundleId} put back in front`
    }
    // the window server lists a new window a moment after the app starts; reads resolve windows from that list
    const shownBy = Date.now() + 15_000
    for (;;) {
      const { apps } = await svc.request('apps.list', { windows: true })
      if (apps.some((x) => x.pid === scratchPid && (x.windows ?? []).some((w) => w.title === APP))) return
      if (Date.now() > shownBy) throw new Error("TC Probe's window did not show in apps.list within 15 s")
      await sleep(250)
    }
  }

  /** One try: TC Probe launched, every step, the bridge's screenshot; TC Probe ended. */
  async function oneTry(): Promise<void> {
    await launch()
    await freshContent()
    // 1. Claude drives TC Probe in full access
    console.log("\n[1] a thread in full access replaces the field's text")
    const a = await newThread('auto')
    await personKeepsMac('the full-access turn', async () => {
      const after = lastSeq(a)
      let liveRow = false
      const poll = setInterval(() => {
        liveRow ||= sessions.rows().some((r) => r.threadId === a && r.apps.some((x) => x.name === APP && x.window === APP))
      }, 200)
      await reg.send(a, `Use the computer tools. In ${where}, replace the text field's text with exactly: ${HELLO}\nRead the window first, then act on the field. Then stop.`)
      await waitFor(a, settled, after, 600_000)
      clearInterval(poll)
      const calls = toolCalls(a, after)
      report.toolCalls[`full access, try ${tries}`] = calls.map((c) => c.name)
      const firstComputer = calls.findIndex((c) => isComputer(c.name))
      const search = calls.findIndex((c) => c.name === 'ToolSearch')
      check('tool search came before the first computer call (deferred)', search >= 0 && firstComputer > search, calls.map((c) => c.name).join(', '))
      check('at least one observe and one act or batch', calls.some((c) => c.name === 'mcp__app__computer_observe') && calls.some((c) => /computer_(act|batch)$/.test(c.name)))
      check('every step ran at ax or process', report.tiers.length > 0 && report.tiers.every((t) => t.tier !== 'session'), [...new Set(report.tiers.map((t) => t.tier))].join(', '))
      const text = await proofRead()
      check('the field holds the line', text.includes(HELLO), text.split('\n').find((l) => l.includes('input')) ?? '')
      check('a live row named TC Probe and its window while the turn ran', liveRow)
      await sleep(500)
      check('no row once the turn settled', !sessions.rows().some((r) => r.threadId === a))
    })

    // 2. The card, in Ask me
    console.log('\n[2] a thread in Ask me: a read raises no card, an act raises one')
    await personKeepsMac('the Ask me turn', async () => {
      await freshContent()
      const b = await newThread('safe')
      await reg.send(b, `Use the computer tools. First read ${where}. Then press its Ping button. If an action is denied, try the same action once more. Then stop.`)
      const observe = await waitFor(b, (e) => e.type === 'tool-call' && !e.partial && e.name === 'mcp__app__computer_observe')
      const observed = await waitFor(b, (e) => e.type === 'tool-result' && observe.event.type === 'tool-call' && e.callId === observe.event.callId)
      check('the read raised no card', !rows(b, 0).some((r) => r.event.type === 'approval-request' && r.seq < observed.seq))
      const ask = await waitFor(b, (e) => e.type === 'approval-request', observed.seq)
      const title = ask.event.type === 'approval-request' ? (ask.event.title ?? '') : ''
      check('the first act raised one card naming the app, the window and the action', title.includes(`in ${APP}, window "${APP}"`) && /^[A-Z][a-z-]+ /.test(title), title)
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
        check('the label reads pong', (await proofRead()).includes('"pong"'))
      } else check('the allowed call acted', false, 'the model did not try again')
      await waitFor(b, settled, ask.seq)
      report.toolCalls[`Ask me, try ${tries}`] = toolCalls(b).map((c) => c.name)
    })

    // 3. Stop during a wait
    console.log('\n[3] Stop on the live row during a 20 s wait')
    await personKeepsMac('the Stop turn', async () => {
      const after = lastSeq(a)
      await reg.send(a, `Use the computer tools. Call computer_act on ${where} with action "wait" and duration 20. Then type the word later into its text field with computer_act. Then stop.`)
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
      const obs = await sessions.run(direct, 'computer_observe', { app: APP, window: APP, full: true })
      const parsed = parseObservation(obs.body ?? '')
      // the window's own line, at depth 0: TC Probe's reads as a dialog
      const win = parsed.lines.find((l) => l.type === 'element' && l.depth === 0)
      const raise = win && win.type === 'element' ? await sessions.run(direct, 'computer_act', { app: APP, window: APP, action: 'perform', element: win.index, name: 'raise' }) : null
      check('perform raise is refused the session tier (no-scheduler)', !!raise && /needs the session tier.*nothing schedules it yet/.test(raise.steps[0] ?? ''), raise?.steps[0] ?? 'no window line')
      const epoch0 = svc.state().epoch
      const pid = svc.state().pid
      if (pid) process.kill(pid, 'SIGKILL')
      const until = Date.now() + 5_000
      while (svc.state().state === 'up' && Date.now() < until) await sleep(50)
      const field = fieldOf(obs.body ?? '')
      const stale = await sessions.run(direct, 'computer_act', { app: APP, window: APP, action: 'set_value', element: field, value: 'x' })
      check('an old element answers stale_element after the kill', stale.isError && report.errors.some((e) => e.kind === 'stale_element'), stale.body ?? '')
      const again = await sessions.run(direct, 'computer_observe', { app: APP, window: APP })
      check('a read works on the new epoch', !again.isError && !!svc.state().epoch && svc.state().epoch !== epoch0, `${epoch0} → ${svc.state().epoch}`)
    })

    const none = await bridge('none')
    const listed = (await none.listTools()).tools.filter((t) => t.name.startsWith('computer_'))
    check(
      'the bridge lists the four tools and computer_result with the schemas tools.ts gives',
      JSON.stringify(listed.map((t) => [t.name, t.inputSchema])) === JSON.stringify(computerToolSpecs('anthropic', 'act', { result: true }).map((t) => [t.name, computerToolJsonSchema(t.input)])),
      listed.map((t) => t.name).join(', ')
    )
    if (!grants.screenRecording) check('screenshots over the bridge', 'inconclusive', 'Screen Recording is off for TempCode; the proof asks for nothing')
    else {
      const lineOnly = (await none.callTool({ name: 'computer_observe', arguments: { app: APP, window: APP, screenshot: true } })) as { content: { type: string; text?: string }[] }
      const shotLine = /screenshot 1 \(observation\): (\S+) /.exec(lineOnly.content[0]?.text ?? '')
      check('images none: a text part naming the file, no image part', !!shotLine && lineOnly.content.every((c) => c.type === 'text'), lineOnly.content.map((c) => c.type).join(', '))
      const parts = await bridge('parts')
      const withImage = (await parts.callTool({ name: 'computer_observe', arguments: { app: APP, window: APP, screenshot: true } })) as { content: { type: string; text?: string; data?: string }[] }
      const path = /screenshot 1 \(observation\): (\S+) /.exec(withImage.content[0]?.text ?? '')?.[1]
      const image = withImage.content.find((c) => c.type === 'image')
      check('images parts: an image part whose bytes equal the file', !!path && !!image && existsSync(path) && Buffer.from(image.data!, 'base64').equals(readFileSync(path)))
      await parts.close()
    }
    await none.close()
  }

  // One try per quiet gap: the person's input (unless ungated) or a lock or dark display during a try
  // (AX sees no window then) hides and ends TC Probe, interrupts the threads and voids the try's checks;
  // another gap is awaited, up to 90 minutes in all.
  const deadline = Date.now() + LAUNCH_WAIT_MS
  if (UNGATED) console.log('ungated (TC_PROOF_UNGATED=1): no idle wait, the person\'s input ends nothing')
  for (;;) {
    if (!(await waitForGap(deadline))) {
      check(UNGATED ? 'a try on an awake screen' : 'a try in a quiet gap', 'inconclusive', lockedGap && !UNGATED ? NOT_RUN_LOCKED : NOT_RUN)
      break
    }
    tries++
    const mark = report.checks.length
    const at = new Date().toISOString()
    const watch = startWatch(Date.now(), () => {
      if (scratchPid) probeAsync(`hide ${scratchPid}`).catch(() => undefined)
      killProbeApp()
      for (const id of liveThreads) void reg.interrupt(id).catch(() => undefined)
    })
    try {
      await oneTry()
    } catch (e) {
      if (!watch.fired()) check('the try finished', false, ((e as Error).stack ?? String(e)).split('\n').slice(0, 4).join(' '))
    }
    watch.stop()
    killProbeApp()
    const why = watch.fired()
    if (!why) {
      report.tries.push({ at, outcome: 'clean' })
      break
    }
    report.tries.push({ at, outcome: why, voided: report.checks.splice(mark).map((c) => ({ name: c.name, outcome: c.outcome })) })
    console.log(`      try ${tries} ended: ${why === 'input' ? 'the person used the Mac' : 'the screen locked or went dark'}; waiting for another gap`)
  }

  wss.close()
  http.close()
}

try {
  await run()
} catch (e) {
  check('the run finished', false, ((e as Error).stack ?? String(e)).split('\n').slice(0, 4).join(' '))
}
console.log(`\n${report.tiers.length} steps ran, at ${[...new Set(report.tiers.map((t) => t.tier))].join(' and ') || 'no tier'}`)
await cleanup()
const failed = report.checks.filter((c) => c.outcome === 'failed').length
const voided = report.checks.filter((c) => c.outcome === 'inconclusive').length
console.log(failed ? `\n${failed} FAILED` : voided ? `\n${voided} INCONCLUSIVE: run again when the Mac is idle` : '\nALL PASS')
process.exit(failed ? 1 : voided ? 2 : 0)
