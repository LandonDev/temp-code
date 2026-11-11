/**
 * The Mac proof of tier scheduling (plan .temp-code/plan-L2js21kH_aBe.md §12):
 * the real tc-computer, an in-process registry and ComputerSessions with the
 * scheduler wired as index.ts wires it, the tools called directly (no model
 * runs), two scratch TextEdits: A the target, B standing for the person's
 * window. A typist (the probe's `type`, its keys marked `tcpr`) stands for the
 * person typing into B.
 *
 *  1. held while someone types: a session click on A waits, says "Waiting for
 *     the Mac to be free", B stays in front and gets every key; once the typist
 *     stops and the Mac reads free, the click runs, says how long it waited,
 *     and B and the pointer come back
 *  2. a touch: a session hold_key on A, one typed key 400 ms in: the step stops
 *     interrupted, the restore after the touch puts B back
 *  3. a process-tier click: whether it moves the raw idle time (recorded)
 *  4. the clipboard: a copy, then at once a paste on A: the paste waits for a
 *     quiet clipboard, runs again, and the person's pasteboard comes back
 *  5. pause and Stop on a held step, and Stop during a session step
 *  6. the card: Run now, the lease ending on the next input, Skip, skipped
 *     earlier, and in Ask me the call's own card naming the session tier
 *
 * It runs when asked, whether or not the person is using the Mac (the person
 * accepts the scratch windows coming forward), but never on a locked or dark
 * screen, and never beside another computer proof: it waits for a running
 * e2e-computer, the computer bench (queued or running), compare-computer-words,
 * e2e-tc-computer, input, capture or AX reader proof to end. A
 * sentinel (the probe's listen-only tap) notes every input event that carries
 * neither the service's mark (`tccp`) nor the proof's (`tcpr`): a leg the
 * person touched turns its failed checks inconclusive, since their input moves
 * the very idle time the scheduler reads, and a leg that waits for the Mac to
 * read free gives up after a bound. Scratch content only; it asks for no
 * permission and removes everything but its report and the service's trace
 * under /tmp/tc-computer-schedule-e2e. Exit: 0 green, 1 a failure, 2
 * inconclusive, 3 skipped on a locked or dark screen.
 *
 * Run on the Mac, under the installed TempCode.app so TCC answers for it:
 *   bun run script:e2e-computer-schedule   (esbuild → node: the Mac's bun has no node:sqlite)
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { ComputerService } from '../src/main/server/computer/service'
import { ComputerSessions } from '../src/main/server/computer/sessions'
import { SessionScheduler } from '../src/main/server/computer/schedule'
import { setSessionTierGate, type SessionTierGate } from '../src/main/server/computer/tierGate'
import { PersonIdle } from '../src/main/personIdle'
import { staticPresence } from '../src/main/presence'
import { parseObservation } from '../src/shared/computer/observation'
import { tierVerdictSetting } from '../src/shared/computer/tools'
import { SESSION_IDLE_SETTING } from '../src/shared/computer/scheduleRules'
import type { ComputerMethod, SessionRestore, StepResult, Tier } from '../src/shared/computer/protocol'
import type { PermissionPolicy, SessionMeta } from '../src/shared/events'
import { buildTcComputer } from './lib/tcComputerBuild'
import { repoRoot } from './lib/repoRoot'
import { otherProof } from './lib/proofOrder'

if (process.platform !== 'darwin') {
  console.log('skipped: macOS only')
  process.exit(0)
}

const ROOT = repoRoot()
const WORK = '/tmp/tc-computer-schedule-e2e'
const REPORT = join(WORK, 'report.json')
const TRACE = join(WORK, 'trace.log')
const KEEP = new Set(['report.json', 'trace.log'])
const BIN = join(ROOT, 'resources/native/tc-computer')
const PROBE = join(WORK, 'computer-proof-probe')
const NONCE = randomBytes(4).toString('hex')
const SERVICE_MARK = 'tccp'
const PROOF_MARK = 'tcpr'
/** the proof's own away threshold: legs take seconds, not minutes */
const IDLE_MS = 8_000
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── the report ──────────────────────────────────────────────────────────

type Outcome = 'passed' | 'failed' | 'inconclusive'
const report = {
  startedAt: new Date().toISOString(),
  finishedAt: '',
  legs: {} as Record<string, { checks: { name: string; outcome: Outcome; detail?: string }[]; notes: Record<string, unknown> }>,
  idle: [] as { leg: string; at: number; raw: number; person: number }[],
  stopped: null as string | null,
  cleanup: [] as string[]
}
let leg = 'setup'
const legOf = () => (report.legs[leg] ??= { checks: [], notes: {} })
const check = (name: string, ok: boolean | 'inconclusive', detail = ''): void => {
  const outcome: Outcome = ok === 'inconclusive' ? 'inconclusive' : ok ? 'passed' : 'failed'
  legOf().checks.push({ name, outcome, ...(detail ? { detail } : {}) })
  console.log(`${outcome === 'passed' ? 'PASS' : outcome === 'failed' ? 'FAIL' : 'VOID'}  [${leg}] ${name}${detail ? ` — ${detail}` : ''}`)
}
const note = (key: string, value: unknown): void => {
  legOf().notes[key] = value
}
const saveReport = (): void => writeFileSync(REPORT, JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2))

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

// ── the probe ───────────────────────────────────────────────────────────

const build = buildTcComputer({ root: ROOT, require: true })
console.log(`tc-computer: ${build.built ? `built in ${build.ms} ms` : build.skipped}`)
execFileSync('xcrun', ['swiftc', '-O', '-o', PROBE, join(ROOT, 'scripts/mac/computer-proof-probe.swift')], { stdio: 'pipe' })
const probe = <T>(...args: string[]): T => JSON.parse(execFileSync(PROBE, args, { encoding: 'utf8', timeout: 10_000 })) as T
const frontmost = (): { pid: number; bundleId: string | null } => probe('frontmost')
const pointer = (): { x: number; y: number } => probe('pointer')
const rawIdleOnce = (): number => probe<{ seconds: number }>('idle').seconds

// One computer proof on the Mac at a time: wait for an older one to end (scripts/lib/proofOrder.ts: only a proof
// that started first holds this one, so two proofs never wait on each other).
for (let said = false, other = otherProof(); other; await sleep(15_000), other = otherProof()) {
  if (!said) console.log(`waiting for another computer proof to end: ${other}`)
  said = true
}
const screen = probe<{ locked: boolean; asleep: boolean }>('screen')
if (screen.locked || screen.asleep) {
  console.log('skipped: the screen is locked or dark')
  rmSync(WORK, { recursive: true, force: true })
  process.exit(3)
}
const grants = JSON.parse(execFileSync(BIN, ['permissions'], { encoding: 'utf8' })) as { accessibility: boolean; screenRecording: boolean }
if (!grants.accessibility) {
  console.log('Accessibility is off for TempCode: turn it on under System Settings → Privacy & Security → Accessibility, then run this again')
  process.exit(1)
}

/** A child that prints one JSON line per event. */
function stream(args: string[], onLine: (v: Record<string, unknown>) => void): ChildProcess {
  const child = spawn(PROBE, args, { stdio: ['ignore', 'pipe', 'inherit'] })
  createInterface({ input: child.stdout! }).on('line', (line) => {
    try {
      onLine(JSON.parse(line) as Record<string, unknown>)
    } catch {
      /* not a line of ours */
    }
  })
  return child
}

// The raw idle time, as Electron's powerMonitor gives it: whole seconds, floored.
let rawIdle = 999
const idleStream = stream(['idle', '--every', '250'], (v) => {
  if (typeof v.seconds === 'number') rawIdle = Math.floor(v.seconds)
})
const personIdle = new PersonIdle({ getSystemIdleTime: () => rawIdle })
const sampleIdle = (): void => void report.idle.push({ leg, at: Date.now(), raw: rawIdle, person: personIdle.getSystemIdleTime() })

/** The typist: keys marked tcpr into whatever is frontmost (B). Resolves with how many it typed. */
let typist: ChildProcess | null = null
const typed: string[] = []
function startTypist(text: string, everyMs: number, forMs: number): Promise<number> {
  return new Promise((done) => {
    let count = 0
    typist = stream(['type', '--mark', PROOF_MARK, '--text', text, '--every', String(everyMs), '--for', String(forMs)], (v) => {
      if (typeof v.key === 'string') typed.push(v.key)
      if (typeof v.typed === 'number') count = v.typed
    })
    typist.on('exit', () => {
      typist = null
      done(count)
    })
  })
}
const stopTypist = (): void => void typist?.kill('SIGTERM')
/** One key, its time. */
const oneKey = (key: string): number => {
  const out = execFileSync(PROBE, ['type', '--mark', PROOF_MARK, '--text', key, '--every', '1', '--for', '1'], { encoding: 'utf8' })
  const first = out.split('\n').find((l) => l.includes('"key"'))
  return first ? (JSON.parse(first) as { at: number }).at : Date.now()
}

// ── cleanup, always ─────────────────────────────────────────────────────

const scratch: number[] = []
let personFront: { pid: number; bundleId: string | null } | null = null
let savedPasteboard = false
let service: ComputerService | null = null
let sentinel: ChildProcess | null = null
/** legs during which the real person touched the Mac */
const touchedLegs = new Set<string>()
let finished = false
const cleanup = async (): Promise<void> => {
  finished = true
  stopTypist()
  sentinel?.kill('SIGTERM')
  idleStream.kill('SIGTERM')
  for (const pid of scratch) {
    try {
      process.kill(pid, 'SIGKILL')
      report.cleanup.push(`killed the scratch TextEdit ${pid}`)
    } catch {
      report.cleanup.push(`the scratch TextEdit ${pid} was gone`)
    }
  }
  if (savedPasteboard) {
    try {
      probe('pasteboard', 'restore', join(WORK, 'pasteboard.json'))
      report.cleanup.push('put the pasteboard back')
    } catch (e) {
      report.cleanup.push(`the pasteboard could not be put back: ${(e as Error).message}`)
    }
  }
  if (personFront?.bundleId && frontmost().pid !== personFront.pid) {
    try {
      execFileSync('osascript', ['-e', `tell application id "${personFront.bundleId}" to activate`])
      report.cleanup.push(`brought ${personFront.bundleId} back to the front`)
    } catch {
      report.cleanup.push(`could not bring ${personFront.bundleId} back`)
    }
  }
  await service?.close().catch(() => undefined)
  saveReport()
  for (const name of readdirSync(WORK)) if (!KEEP.has(name)) rmSync(join(WORK, name), { recursive: true, force: true })
}
const stop = async (why: string, code: number): Promise<never> => {
  console.log(`STOP  ${why}`)
  report.stopped = why
  await cleanup()
  process.exit(code)
}
process.on('SIGINT', () => void stop('interrupted', 1))
process.on('uncaughtException', (e) => void stop(`crashed in ${leg}: ${e.stack ?? e}`, 1))
process.on('unhandledRejection', (e) => void stop(`crashed in ${leg}: ${(e as Error)?.stack ?? e}`, 1))

// ── setup ───────────────────────────────────────────────────────────────

personFront = frontmost()
const personPointer = pointer()
note('person', { front: personFront, pointer: personPointer })
probe('pasteboard', 'save', join(WORK, 'pasteboard.json'))
savedPasteboard = true
const savedDigest = probe<{ digest: string }>('pasteboard', 'digest').digest

const textEditPids = (): number[] => {
  try {
    return execFileSync('pgrep', ['-x', 'TextEdit'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}
async function openScratch(name: string): Promise<{ pid: number; title: string }> {
  const file = join(WORK, `${NONCE}-${name}.rtf`)
  writeFileSync(file, `{\\rtf1\\ansi Scratch ${NONCE} ${name}}`)
  const before = new Set(textEditPids())
  execFileSync('open', ['-n', '-g', '-a', 'TextEdit', file, '--args', '-ApplePersistenceIgnoreState', 'YES'])
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    const pid = textEditPids().find((p) => !before.has(p))
    if (pid) {
      scratch.push(pid)
      await sleep(1_000)
      return { pid, title: `${NONCE}-${name}` }
    }
  }
  return stop(`open -n gave no new TextEdit pid for ${name} within 10 s`, 1)
}
const A = await openScratch('a')
const B = await openScratch('b')

// The sentinel: from here on, any input without either mark is the person.
// The sentinel notes the person's input; it re-arms after each event, since the probe exits on the first.
const armSentinel = (): void => {
  if (finished) return
  sentinel = stream(['sentinel', '--allow-marks', `${SERVICE_MARK},${PROOF_MARK}`], (v) => {
    if (!v.person) return
    if (!touchedLegs.has(leg)) console.log(`      [${leg}] the person used the Mac`)
    touchedLegs.add(leg)
  })
  sentinel.on('exit', () => setTimeout(armSentinel, 500))
}
armSentinel()
await sleep(500)

// B in front, raised by a separate service at the session tier, which then shuts down: the measured
// service's restore record starts with B in front, not the person's app.
{
  const raiser = new ComputerService({ dataDir: join(WORK, 'raiser'), env: process.env, bin: () => BIN, log: () => undefined })
  await raiser.request('session.open', { session: 'raise' })
  const obs = await raiser.request('state.get', { session: 'raise', app: { pid: B.pid }, window: { title: B.title }, mode: 'full' })
  const win = parseObservation(obs.text).lines.find((l) => l.type === 'element' && l.role === 'window')
  if (!win || win.type !== 'element') await stop('B shows no window line', 1)
  else
    await raiser.request('action.run', {
      session: 'raise',
      app: { pid: B.pid },
      window: { title: B.title },
      epoch: obs.epoch,
      action: { action: 'perform', element: win.index, name: 'raise' },
      tiers: ['session'],
      observe: { mode: 'none' }
    })
  await raiser.close()
  await sleep(500)
  check('B is in front before the legs', frontmost().pid === B.pid, `front ${frontmost().pid}, B ${B.pid}`)
}
const pointer0 = pointer()

// ── the host, as index.ts wires it ──────────────────────────────────────

const dataDir = join(WORK, 'data')
const store = new Store(openDb(join(dataDir, 'app.db')))
const registry = new SessionRegistry(store)
store.setSetting(SESSION_IDLE_SETTING, String(IDLE_MS))
const verdict = (classes: Record<string, Tier>): void =>
  store.setSetting(tierVerdictSetting('com.apple.TextEdit'), JSON.stringify({ bundleId: 'com.apple.TextEdit', classes, misses: {}, updatedAt: Date.now(), probedAt: Date.now() }))
verdict({ click: 'session', key: 'session' })

service = new ComputerService({
  dataDir: join(dataDir, 'computer'),
  env: { ...process.env, TEMP_CODE_COMPUTER_TRACE: '1' },
  trace: true,
  bin: () => BIN,
  log: (line) => appendFileSync(TRACE, line + '\n')
})
const svc = service
// Every acting request, restore and clipboard read, straight from the wire.
const wire: { method: string; at: number; params: Record<string, unknown>; steps?: StepResult[]; result?: unknown }[] = []
const notices: { method: string; at: number; params: unknown }[] = []
const request = svc.request.bind(svc)
svc.request = (async (method: ComputerMethod, params: never, opts?: { signal?: AbortSignal; timeoutMs?: number }) => {
  const entry: (typeof wire)[number] = { method, at: Date.now(), params: params as Record<string, unknown> }
  wire.push(entry)
  const result = await request(method, params, opts)
  if (method === 'action.run') entry.steps = [(result as { step: StepResult }).step]
  if (method === 'action.batch') entry.steps = (result as { steps: StepResult[] }).steps
  if (method === 'input.restoreSession' || method === 'clipboard.state') entry.result = result
  return result
}) as typeof svc.request
svc.onNotification((n) => void notices.push({ method: n.method, at: Date.now(), params: n.params }))

const pinned = new Set(['textedit', 'com.apple.textedit'])
let gate: SessionTierGate | null = null
const sessions = new ComputerSessions({
  service: svc,
  registry: { get: (id) => registry.get(id), requestApproval: (id, req) => registry.requestApproval(id, req), awayOn: () => registry.awayOn() },
  store,
  dataDir: join(dataDir, 'computer'),
  landing: (id) => join(WORK, 'landing', id),
  resolveApp: (q) => (pinned.has(q.toLowerCase()) ? { pid: A.pid } : null),
  gate: () => gate!,
  log: (line) => appendFileSync(TRACE, line + '\n')
})
registry.onMeta((m) => sessions.onMeta(m))
const makeScheduler = (askAfterMs?: number): SessionScheduler => {
  const s = new SessionScheduler({
    service: svc,
    idle: personIdle,
    presence: staticPresence({ screen: 'unlocked', power: 'awake' }),
    awayOn: () => registry.awayOn(),
    getSetting: (k) => store.getSetting(k),
    held: (t, l) => {
      registry.setToolHold(t, l)
      sessions.setHeld(t, l)
    },
    threadOf: (s2) => sessions.threadOfServiceSession(s2),
    log: (line) => appendFileSync(TRACE, line + '\n'),
    ...(askAfterMs ? { askAfterMs } : {})
  })
  setSessionTierGate(s)
  return s
}
let scheduler = makeScheduler()
gate = scheduler

/** A thread with no harness behind it, running, so its status detail shows a hold. */
function thread(id: string, permission: PermissionPolicy = 'auto'): string {
  const now = Date.now()
  store.insertSession({
    id,
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: 'chat',
    planPath: null,
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    reasoning: 'low',
    agentType: 'implementer',
    title: id,
    cwd: WORK,
    status: 'idle',
    archived: false,
    permission,
    fast: false,
    context1m: false,
    busySince: null,
    pausedAt: null,
    frozenActiveElapsed: null,
    threadRules: null,
    nativeId: null,
    createdAt: now,
    updatedAt: now
  } as unknown as SessionMeta)
  registry.markStatusForProof(id, 'running')
  return id
}
const run = (threadId: string, tool: string, args: Record<string, unknown>, permission?: PermissionPolicy) =>
  sessions.run({ threadId, ...(permission ? { permission: () => permission } : {}) }, tool, args)

// The proof's own reads of A and B, at the ax tier, in its own session.
await svc.request('session.open', { session: 'proof' })
const read = async (w: { pid: number; title: string }) =>
  (await svc.request('state.get', { session: 'proof', app: { pid: w.pid }, window: { title: w.title }, mode: 'full' })).text
const textAreaLine = (text: string): string => text.split('\n').find((l) => l.includes('text area')) ?? ''
const textAreaOf = (text: string): number => {
  const line = parseObservation(text).lines.find((l) => l.type === 'element' && l.role === 'text area')
  if (!line || line.type !== 'element') throw new Error('the scratch window shows no text area')
  return line.index
}
/** A call that waits for the Mac to read free gives up after ms: the thread's Stop ends it, and the leg says so. */
async function within<T>(p: Promise<T>, ms: number, threadId: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), ms)))
  const first = await Promise.race([p, late])
  clearTimeout(timer)
  if (first !== 'late') return first
  note('gave up waiting', `${threadId} after ${ms / 1000} s`)
  await sessions.stop(threadId)
  return p
}
async function untilIdle(ms: number, timeoutMs = 30_000): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (personIdle.getSystemIdleTime() * 1000 >= ms) return true
    await sleep(250)
  }
  return false
}
const near = (a: { x: number; y: number }, b: { x: number; y: number }, pt: number): boolean => Math.abs(a.x - b.x) <= pt && Math.abs(a.y - b.y) <= pt
const sessionSent = (since: number): boolean => wire.some((w) => w.at >= since && /^action\./.test(w.method) && (w.params.tiers as Tier[] | undefined)?.includes('session'))

// The thread reads A once, so its clicks name A's text area.
const reader = thread('reader')
await run(reader, 'computer_observe', { app: 'TextEdit', window: A.title, full: true })
const areaA = textAreaOf(await read(A))

// ── 1. held while someone types ─────────────────────────────────────────
leg = '1 held while someone types'
console.log(`\n[${leg}]`)
{
  const t = thread('t1')
  await run(t, 'computer_observe', { app: 'TextEdit', window: A.title, full: true })
  const typing = startTypist('x', 300, 12_000)
  await sleep(1_000)
  const started = Date.now()
  const call = run(t, 'computer_act', { app: 'TextEdit', window: A.title, action: 'left_click', element: areaA })
  let heldSeen = false
  let rowSeen = false
  let frontMoved = false
  let pointerMoved = false
  const sampler = setInterval(() => {
    sampleIdle()
    if (!typist) return
    heldSeen ||= registry.get(t)?.statusDetail === 'Waiting for the Mac to be free'
    rowSeen ||= sessions.rows().some((r) => r.threadId === t && r.running?.words === 'Waiting for the Mac to be free')
    frontMoved ||= frontmost().pid !== B.pid
    pointerMoved ||= !near(pointer(), pointer0, 0.5)
  }, 250)
  const count = await typing
  const o = await within(call, 60_000, t)
  clearInterval(sampler)
  const ran = Date.now()
  check('the thread said "Waiting for the Mac to be free"', heldSeen)
  check('its computer row said it too', rowSeen)
  check('B stayed in front and the pointer stayed put while the typist ran', !frontMoved && !pointerMoved)
  const bText = textAreaLine(await read(B))
  check('every typed key is in B', (bText.match(/x/g) ?? []).length >= count, `${count} typed; ${bText.slice(0, 120)}`)
  check('the click ran at the session tier', / · session · /.test(o.steps.join('\n')), o.steps.join(' | '))
  check('the result opens with how long it waited', /^waited [0-9hms ]+ for the Mac to be free\n/.test(o.steps[0] ?? ''), o.steps[0] ?? '')
  await sleep(1_000)
  check('B is in front again within 1 s', frontmost().pid === B.pid)
  check('the pointer is back within 2 pt', near(pointer(), pointer0, 2), JSON.stringify(pointer()))
  note('waitedMs', ran - started)
}

// ── 2. a touch ──────────────────────────────────────────────────────────
leg = '2 a touch'
console.log(`\n[${leg}]`)
{
  check('the Mac reads free first', await untilIdle(IDLE_MS))
  const t = thread('t2')
  const since = Date.now()
  const call = run(t, 'computer_act', { app: 'TextEdit', window: A.title, action: 'hold_key', text: 'shift', duration: 4 })
  const end = Date.now() + 10_000
  while (!sessionSent(since) && Date.now() < end) await sleep(20)
  await sleep(400)
  const keyAt = oneKey('y')
  const o = await within(call, 60_000, t)
  const interrupted = notices.find((n) => n.method === 'session/interrupted' && n.at >= since)
  check('the step stopped interrupted', /interrupted|took over/i.test(o.steps.join(' ')), o.steps.join(' | '))
  check('the service said so within 100 ms of the key', !!interrupted && interrupted.at - keyAt <= 100, interrupted ? `${interrupted.at - keyAt} ms` : 'no notice')
  const restore = wire.find((w) => w.method === 'input.restoreSession' && w.at >= since)
  check('input.restoreSession { afterInterrupt: true } put the front app back', !!restore && restore.params.afterInterrupt === true && (restore.result as { frontmost?: string })?.frontmost === 'restored', JSON.stringify(restore?.result ?? null))
  await sleep(1_000)
  check('B is in front within 1 s', frontmost().pid === B.pid)
  check('the typist key did not land in A', !textAreaLine(await read(A)).includes('y'))
  check('the typist key did not land in B', !textAreaLine(await read(B)).includes('y'))
  const guard = (restore?.result as SessionRestore | undefined)?.personGuard
  note('personGuard', guard ?? null)
  check('the person guard was active', guard?.mode === 'active', JSON.stringify(guard ?? null))
  check('the person guard dropped the key', (guard?.dropped ?? 0) >= 1, JSON.stringify(guard ?? null))
  check('the return key was not replayed', guard?.replayed === 0, JSON.stringify(guard ?? null))
}

// ── 3. a process-tier click ─────────────────────────────────────────────
leg = '3 a process-tier click'
console.log(`\n[${leg}]`)
{
  verdict({ click: 'process', key: 'process' })
  await untilIdle(IDLE_MS)
  const t = thread('t3')
  const before = rawIdleOnce()
  const o = await run(t, 'computer_act', { app: 'TextEdit', window: A.title, action: 'left_click', element: areaA })
  await sleep(300)
  const after = rawIdleOnce()
  note('steps', o.steps)
  note('raw idle before and after', { before, after, moved: after < before - 0.5 })
  check('the click ran below the session tier', !/ · session · /.test(o.steps.join('\n')), o.steps.join(' | '))
}

// ── 4. the clipboard ────────────────────────────────────────────────────
leg = '4 the clipboard'
console.log(`\n[${leg}]`)
{
  const t = thread('t4')
  await run(t, 'computer_observe', { app: 'TextEdit', window: A.title, full: true })
  const pasted = `tier proof ${NONCE} 0123456789`.slice(0, 30)
  probe('pasteboard', 'copy', `the person's copy ${NONCE}`)
  const copied = probe<{ digest: string }>('pasteboard', 'digest').digest
  const since = Date.now()
  let saidClipboard = false
  const sampler = setInterval(() => (saidClipboard ||= registry.get(t)?.statusDetail === 'Waiting for the clipboard'), 100)
  const o = await run(t, 'computer_batch', { app: 'TextEdit', window: A.title, actions: [{ action: 'left_click', element: areaA }, { action: 'paste', text: pasted, element: areaA }] })
  clearInterval(sampler)
  const batches = wire.filter((w) => w.method === 'action.batch' && w.at >= since)
  const refused = batches[0]?.steps?.[1]
  check('the paste came back recent-copy first', refused?.status === 'failed' && refused.error.reason === 'recent-copy', JSON.stringify(refused ?? null))
  check('the pasteboard was not touched by the refused paste', probe<{ digest: string }>('pasteboard', 'digest').digest === copied)
  check('the thread said "Waiting for the clipboard"', saidClipboard)
  const second = batches[1]
  const rerun = second?.steps?.[0]
  check('the call ran again from the paste alone', (second?.params.actions as { action: string }[] | undefined)?.map((a) => a.action).join() === 'paste')
  check('the paste went in by paste and put the clipboard back', rerun?.status === 'ok' && rerun.input?.via === 'paste' && rerun.input.clipboard === 'restored', JSON.stringify(rerun ?? null))
  check("the result says it waited for the person's copy", /waited \d+s for the clipboard, the person had just copied/.test(o.steps.join('\n')), o.steps.join(' | '))
  probe('pasteboard', 'restore', join(WORK, 'pasteboard.json'))
  check("the person's pasteboard came back", probe<{ digest: string }>('pasteboard', 'digest').digest === savedDigest)
}

// ── 5. pause and Stop ───────────────────────────────────────────────────
leg = '5 pause and Stop'
console.log(`\n[${leg}]`)
{
  verdict({ click: 'session', key: 'session' })
  const typing = startTypist('z', 300, 30_000)
  await sleep(1_000)
  const p = thread('t5a')
  const paused = run(p, 'computer_act', { app: 'TextEdit', window: A.title, action: 'left_click', element: areaA })
  for (let i = 0; i < 40 && registry.get(p)?.statusDetail !== 'Waiting for the Mac to be free'; i++) await sleep(100)
  sessions.cancel(p, 'paused')
  const po = await paused
  check('a pause while held answers cancelled: the thread was paused', po.body === 'cancelled: the thread was paused', po.body ?? '')
  check('nothing was raised', frontmost().pid === B.pid)
  const s = thread('t5b')
  const stopped = run(s, 'computer_act', { app: 'TextEdit', window: A.title, action: 'left_click', element: areaA })
  for (let i = 0; i < 40 && registry.get(s)?.statusDetail !== 'Waiting for the Mac to be free'; i++) await sleep(100)
  await sessions.stop(s)
  check('Stop while held answers stopped by the person', ((await stopped).body ?? '').startsWith('stopped by the person'))
  stopTypist()
  await typing
  check('the Mac reads free again', await untilIdle(IDLE_MS))
  const r = thread('t5c')
  const since = Date.now()
  const held = run(r, 'computer_act', { app: 'TextEdit', window: A.title, action: 'hold_key', text: 'shift', duration: 4 })
  const end = Date.now() + 10_000
  while (!sessionSent(since) && Date.now() < end) await sleep(20)
  await sleep(1_000)
  await sessions.stop(r)
  const ro = await within(held, 60_000, r)
  check('Stop during a session step ends it', ro.isError && /stopped by the person/.test(ro.body ?? ''), ro.body ?? '')
  check('and restores', wire.some((w) => w.method === 'input.restoreSession' && w.at >= since))
  await sleep(1_000)
  check('B is in front', frontmost().pid === B.pid)
}

// ── 6. the card ─────────────────────────────────────────────────────────
leg = '6 the card'
console.log(`\n[${leg}]`)
{
  store.setSetting(SESSION_IDLE_SETTING, '3600000')
  scheduler.dispose()
  scheduler = makeScheduler(5_000)
  gate = scheduler
  const t = thread('t6')
  const cardsOf = () => registry.eventsAfter(t, 0).flatMap((r) => (r.event.type === 'approval-request' ? [r.event] : []))
  const untilCards = async (n: number, ms = 15_000): Promise<boolean> => {
    const end = Date.now() + ms
    while (cardsOf().length < n && Date.now() < end) await sleep(100)
    return cardsOf().length >= n
  }
  let typing = startTypist('w', 300, 60_000)
  await sleep(1_000)
  const first = run(t, 'computer_act', { app: 'TextEdit', window: A.title, action: 'left_click', element: areaA })
  check('after 5 s one card', await untilCards(1))
  const card = cardsOf()[0]
  check(
    'it offers Run now and Skip, naming TextEdit, A and the click',
    card?.choices === 'run-skip' && /TextEdit/.test(card.title ?? '') && (card.title ?? '').includes(A.title) && /click/.test(card.title ?? ''),
    card?.title ?? ''
  )
  stopTypist()
  await typing
  if (!card) {
    await sessions.stop(t)
    await first
    await stop('no card came up; the rest of the card leg cannot run', 1)
  }
  await registry.approve(t, card.requestId, true)
  const fo = await within(first, 60_000, t)
  check('Run now: the click ran at the session tier', / · session · /.test(fo.steps.join('\n')), fo.steps.join(' | '))
  await sleep(2_000)
  oneKey('w') // the person's next input ends the lease
  typing = startTypist('w', 300, 60_000)
  await sleep(1_000)
  const second = run(t, 'computer_act', { app: 'TextEdit', window: A.title, action: 'left_click', element: areaA })
  check('a second card once the lease ended', await untilCards(2))
  const skipCard = cardsOf()[1]
  if (!skipCard) {
    await sessions.stop(t)
    await second
    await stop('no second card came up', 1)
  }
  await registry.approve(t, skipCard.requestId, false)
  const so = await second
  check('Skip: refused skipped', /the person did not choose Run now$/.test(so.steps[0] ?? ''), so.steps[0] ?? '')
  const third = await run(t, 'computer_act', { app: 'TextEdit', window: A.title, action: 'left_click', element: areaA })
  check('then skipped earlier with no card', /earlier in this turn/.test(third.steps[0] ?? '') && cardsOf().length === 2, third.steps[0] ?? '')
  stopTypist()
  await typing
  await scheduler.settle(t, 'turn-end')
  const safe = run(t, 'computer_act', { app: 'TextEdit', window: A.title, action: 'left_click', element: areaA }, 'safe')
  check("in Ask me, the call's own card", await untilCards(3))
  const own = cardsOf()[2]
  check('names the session tier', (own?.title ?? '').endsWith(', using your pointer and keyboard') && own?.choices === undefined, own?.title ?? '')
  if (!own) {
    await sessions.stop(t)
    await safe
    await stop("the call's own card did not come up", 1)
  }
  await registry.approve(t, own.requestId, true)
  const ao = await within(safe, 60_000, t)
  check('Allow: the click ran at the session tier with no second card', / · session · /.test(ao.steps.join('\n')) && cardsOf().length === 3, ao.steps.join(' | '))
}

for (const name of touchedLegs) {
  const l = report.legs[name]
  if (!l) continue
  l.notes.personUsedTheMac = true
  for (const c of l.checks) if (c.outcome === 'failed') Object.assign(c, { outcome: 'inconclusive', detail: `${c.detail ?? ''} (the person used the Mac during this leg)`.trim() })
}
leg = 'end'
scheduler.dispose()
setSessionTierGate(null)
await registry.close().catch(() => undefined)
await cleanup()
const all = Object.values(report.legs).flatMap((l) => l.checks)
const failed = all.filter((c) => c.outcome === 'failed').length
const voided = all.filter((c) => c.outcome === 'inconclusive').length
console.log(failed ? `\n${failed} FAILED` : voided ? `\n${voided} INCONCLUSIVE` : '\nALL PASS')
process.exit(failed ? 1 : voided ? 2 : 0)
