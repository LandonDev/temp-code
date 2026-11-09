/**
 * The computer task benchmark (plan .temp-code/plan-bXciwrVNLfYK.md;
 * docs/computer-protocol.md "The benchmark", docs/release-gate.md "The
 * computer bench"): real desktop tasks through the computer tools and the
 * real tc-computer, one real thread per task per model, the three models side
 * by side in lanes, each end state read through the AX tree, the files or
 * `defaults` (never the model's word), every call timed, judged by BENCH_RULE
 * (scripts/lib/computerBench.ts) against the baseline in the gate dir.
 *
 * The person keeps the Mac: the background tiers only (the session tier is
 * refused, or with --session admitted only while the Mac has been idle two
 * minutes), a scratch app launched only after 5 s with no input and sent back
 * if it comes forward, every query for it pinned to its pid in its lane, and
 * System Settings left alone while it is open. Everything but the report is
 * removed, and every switch put back, on any exit.
 *
 * Run on the Mac, under the installed TempCode.app so TCC answers for it:
 *   bun run script:e2e-computer-bench -- --gate             (the gate's run)
 *   bun run script:e2e-computer-bench -- --report-only | --runs 3 | --models a,b | --tasks a,b | --session | --rebaseline
 *   bun run script:e2e-computer-bench -- --judge <report.json>   (re-judge a saved report; runs nothing)
 *   bun run script:e2e-computer-bench -- --reference codex       (Codex's own computer use, by hand)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, loadavg } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { computerHooks } from '../src/main/server/computer/mcp'
import { probeCatalogs } from '../src/main/server/drivers/catalogProbe'
import { installedCodexVersion } from '../src/main/server/drivers/codexVersion'
import { modelInfo, type ProviderId } from '../src/shared/catalog'
import type { AgentEvent, EventRow } from '../src/shared/events'
import { exec } from './lib/benchChecks'
import {
  BENCH_MODELS,
  BENCH_UNGATED_ENV,
  keepFront,
  keepReport,
  laneOrder,
  parseBenchArgs,
  readRun,
  macReady,
  runStamp,
  type BenchArgs,
  type BenchModel
} from './lib/benchRun'
import {
  BENCH_TIMING,
  EMPTY_BASELINE,
  benchOutcome,
  baselinePath,
  findBase,
  judgeBench,
  mergeBaseline,
  needsRerun,
  readBaseline,
  renderBenchTable,
  runFault,
  writeBaseline,
  type Baseline,
  type BenchReport,
  type BenchRun
} from './lib/computerBench'
import { RigStop, asProbe, repoRoot, startRig, type Rig } from './lib/computerRig'
import { otherProof } from './lib/proofOrder'
import { killGroup, startDevInstance } from './lib/devInstance'
import { COMPUTER_ONLY_LINE, COMPUTER_TASKS, gateTasks, taskById, type CallRecord, type CheckResult, type ComputerTask, type DevInstance, type TaskContext, type TaskId, type TaskStart } from './lib/computerTasks'
import { buildIsCurrent, type BuildStamp } from './lib/soakJudge'

const ROOT = repoRoot()
const clock = (): string => new Date().toTimeString().slice(0, 8)
const log = (line: string): void => console.log(`${clock()} ${line}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let args: BenchArgs
try {
  args = parseBenchArgs(process.argv.slice(2))
} catch (e) {
  console.error((e as Error).message)
  process.exit(2)
}
// gate.ts's gateDir, read here: a bundle holding gate.ts would run its CLI (import.meta.main is true inside the bundle).
const GATE_DIR = join(resolve(ROOT, execFileSync('git', ['-C', ROOT, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).trim()), 'temp-code-gate')
const BASELINE = baselinePath(GATE_DIR)

/** A missing file is no rows; one that cannot be read fails the step, unless --rebaseline writes it anew. */
function loadBaseline(): Baseline {
  try {
    return readBaseline(BASELINE)
  } catch (e) {
    if (args.rebaseline) return EMPTY_BASELINE
    console.error((e as Error).message)
    process.exit(1)
  }
}

if (args.judge) {
  const saved = JSON.parse(readFileSync(args.judge, 'utf8')) as BenchReport
  const judged = judgeBench(saved, loadBaseline())
  process.stdout.write(renderBenchTable(saved, judged))
  process.exit(judged.ok ? 0 : 1)
}
if (process.platform !== 'darwin') {
  console.log('skipped: macOS only')
  process.exit(0)
}

// ── the run's places and its report ─────────────────────────────────────

const STARTED = Date.now()
const judged = args.mode === 'gate' || args.mode === 'report-only'
/** The script's own deadline holds for the gate's plan alone (one run a task, reruns on a breach); `--runs n` takes as long as it takes. */
const DEADLINE = judged && args.runs === null ? STARTED + BENCH_TIMING.budgetMs : Infinity
const STAMP = runStamp(STARTED)
const WORK = join('/tmp/tc-computer-bench', STAMP)
const KEEP = new Set(['report.json', 'report.md'])
const BENCH_URL = pathToFileURL(join(ROOT, 'src/main/server/computer/fixtures/page/bench.html')).href
const REFERENCE_LINE = 'Use your computer use tools for this task.'
/** The person's leave to run with no idle wait; only a locked or dark screen holds a run. */
const UNGATED = process.env[BENCH_UNGATED_ENV] === '1'
/** A lane that waited longer than this in the scheduler had its runs held by it, not by the bench's speed. */
const HELD_MS = 60_000
mkdirSync(WORK, { recursive: true })
const baseline = loadBaseline()

const git = (...a: string[]): string => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).trim()
const sh = (cmd: string, a: string[]): string => {
  try {
    return execFileSync(cmd, a, { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
const report: BenchReport = {
  version: 1,
  startedAt: STARTED,
  endedAt: 0,
  commit: git('rev-parse', 'HEAD'),
  clean: git('status', '--porcelain', '--untracked-files=no') === '',
  mode: args.mode,
  ...(UNGATED ? { ungated: true } : {}),
  host: { macos: sh('sw_vers', ['-productVersion']), chip: sh('sysctl', ['-n', 'machdep.cpu.brand_string']), load1: loadavg()[0] },
  models: [],
  runs: [],
  unrun: []
}

function writeReports(): string {
  report.endedAt = Date.now()
  const json = JSON.stringify(report, null, 2) + '\n'
  writeFileSync(join(WORK, 'report.json'), json)
  const table = renderBenchTable(report, judgeBench(report, baseline))
  writeFileSync(join(WORK, 'report.md'), table)
  if (judged) keepReport(join(GATE_DIR, 'computer-bench'), json, STAMP)
  return table
}

// ── cleanup on any exit ─────────────────────────────────────────────────

/** What a run must put back before the bench goes: a switch, a dev instance. */
const pending = new Set<() => Promise<void>>()
const devGroups = new Set<number>()
/** Threads whose computer work must stop before anything is put back. */
const liveThreads = new Set<string>()
let rig: Rig | null = null
let cleaned = false
/** Inside the 5 s the gate's kill gives between SIGTERM and SIGKILL: the dev groups first, then the threads' computer work and the scratch apps, then what runs changed. */
async function cleanup(): Promise<void> {
  if (cleaned) return
  cleaned = true
  for (const pgid of devGroups) killGroup(pgid, 'SIGKILL')
  const within = (ms: number, work: Promise<unknown>): Promise<unknown> => Promise.race([work.catch(() => undefined), sleep(ms)])
  await within(1_500, Promise.all([...liveThreads].map((id) => rig?.sessions.stop(id))))
  // A call still stopping cannot act on an app that is gone: no late act lands after the switch is put back.
  rig?.closeLanes()
  await within(2_000, Promise.all([...pending].map((undo) => undo())))
  await rig?.close().catch(() => undefined)
  for (const name of existsSync(WORK) ? readdirSync(WORK) : []) if (!KEEP.has(name)) rmSync(join(WORK, name), { recursive: true, force: true })
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log(`${sig}: cleaning up`)
    try {
      writeReports()
    } catch {
      /* the report is best effort here */
    }
    void cleanup().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143))
  })
}

// ── the rig ─────────────────────────────────────────────────────────────

try {
  rig = await startRig({ root: ROOT, work: WORK, sessionTier: args.session ? 'scheduled' : 'refused', proofSession: 'bench-proof', log })
} catch (e) {
  if (!(e instanceof RigStop)) throw e
  console.log(`STOP  ${e.message}`)
  await cleanup()
  process.exit(1)
}
const R: Rig = rig
const registry = R.server.registry
const probe = asProbe(R.mac)

log(args.session ? "session tier: the host's own scheduler (the person away: no input for 120 s, or Away)" : 'tiers ax and process only; the session tier is refused')
if (UNGATED) log(`${BENCH_UNGATED_ENV}=1: no idle wait before a launch; only a locked or dark screen holds a run`)

// ── lanes and tasks ─────────────────────────────────────────────────────

await Promise.all([probeCatalogs(), installedCodexVersion()])
const wanted: BenchModel[] =
  args.mode === 'reference' ? [BENCH_MODELS.find((m) => m.provider === 'codex')!] : BENCH_MODELS.filter((m) => !args.models || args.models.includes(m.model))
for (const name of args.models ?? []) if (!BENCH_MODELS.some((m) => m.model === name)) throw new Error(`no bench model ${name} (models: ${BENCH_MODELS.map((m) => m.model).join(', ')})`)
const lanes = wanted.flatMap((m, index) => {
  if (modelInfo(m.provider as ProviderId, m.model)) {
    report.models.push({ model: m.model })
    return [{ model: m, index, name: m.provider, queuedMs: 0 }]
  }
  const skipped =
    m.provider === 'muse' ? `${m.model} is not in this host's Muse catalog (no login, or an empty catalog)` : `the installed ${m.provider} CLI cannot run ${m.model}`
  report.models.push({ model: m.model, skipped })
  log(`skip ${m.model}: ${skipped}`)
  return []
})
type Lane = (typeof lanes)[number]

const asked: ComputerTask[] = args.tasks ? args.tasks.map((id) => taskById(id as TaskId)) : COMPUTER_TASKS
const runnable = args.session ? asked : gateTasks(asked)
const needsSession = asked.filter((t) => !runnable.includes(t))

// ── the dev instance (devapp-form) ──────────────────────────────────────

let outReady: Promise<string | null> | null = null
/** null once out/ is HEAD's clean build; else why it is not. The gate's run never builds: its own build may be writing out/. */
function waitForOut(): Promise<string | null> {
  outReady ??= (async () => {
    const done = process.env.TEMP_CODE_SOAK_BUILD_DONE
    const until = Date.now() + 10 * 60_000
    if (done) {
      while (!existsSync(done)) {
        if (Date.now() > until) return 'the publish build never finished: no build.done within 10 minutes'
        await sleep(1_000)
      }
      return null
    }
    const current = (): boolean => {
      let stamp: BuildStamp = null
      try {
        stamp = (JSON.parse(readFileSync(join(ROOT, 'out', 'bundle-map.json'), 'utf8')) as { head?: BuildStamp }).head ?? null
      } catch {
        /* no build yet */
      }
      return buildIsCurrent(stamp, git('rev-parse', 'HEAD'), git('status', '--porcelain', '--untracked-files=no') === '')
    }
    if (current()) return null
    if (!judged) {
      log("out/ is not HEAD's build: building first")
      execFileSync(join(ROOT, 'node_modules', '.bin', 'electron-vite'), ['build'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] })
      return current() ? null : "out/ is still not HEAD's clean build after building"
    }
    while (!current()) {
      if (Date.now() > until) return "out/ is not HEAD's clean build"
      await sleep(5_000)
    }
    return null
  })()
  return outReady
}

/**
 * The run's dev instance (scripts/lib/devInstance.ts), once out/ is HEAD's
 * build and the Mac has been quiet 5 s, its main process pinned as Electron
 * in the lane and the person's app kept in front.
 */
async function devInstance(lane: Lane, dir: string, onBounce: () => void): Promise<DevInstance | { skip: string }> {
  const notReady = await waitForOut()
  if (notReady) return { skip: notReady }
  const held = await macReady(probe, UNGATED)
  if (held) return { skip: held }
  const personFront = R.mac.frontmost()
  const dev = await startDevInstance({ root: ROOT, dir, groups: devGroups })
  R.pins.pin(lane.name, 'Electron', dev.pid)
  const front = await keepFront(probe, dev.pid, personFront)
  if (front === 'took' && !UNGATED) {
    await dev.stop()
    throw new FailRun('took the front')
  }
  if (front === 'bounced') onBounce()
  return { userData: dev.userData, window: dev.window, stop: dev.stop }
}

// ── one run ─────────────────────────────────────────────────────────────

class SkipRun extends Error {}
class FailRun extends Error {}

/** Mac-wide apps every lane shares: one run at a time, the wait outside the run's clock. */
const locks = new Map<string, Promise<void>>()
async function withLock<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn()
  const prev = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  locks.set(key, prev.then(() => new Promise<void>((r) => (release = r))))
  await prev
  try {
    return await fn()
  } finally {
    release()
  }
}

type Settle = { kind: 'settled' | 'question' | 'timeout'; at: number }
const isSettle = (e: AgentEvent): boolean => e.type === 'turn-complete' || (e.type === 'status' && (e.status === 'idle' || e.status === 'error' || e.status === 'stopped'))

/** The thread's next settle after `afterSeq`, a question it asks, or the wall time. */
function nextSettle(id: string, afterSeq: number, timeoutMs: number): Promise<Settle> {
  return new Promise((resolveSettle) => {
    const done = (kind: Settle['kind']): void => {
      clearTimeout(timer)
      off()
      resolveSettle({ kind, at: Date.now() })
    }
    const timer = setTimeout(() => done('timeout'), Math.max(0, timeoutMs))
    const off = registry.subscribe(id, (row: EventRow) => {
      if (row.seq <= afterSeq) return
      if (isSettle(row.event)) done('settled')
      else if (row.event.type === 'question-request') done('question')
    })
    const earlier = registry.eventsAfter(id, afterSeq).find((r) => isSettle(r.event) || r.event.type === 'question-request')
    if (earlier) done(earlier.event.type === 'question-request' ? 'question' : 'settled')
  })
}

/**
 * The thread's first `running` (or a settle before it), and how long it sat
 * `queued` first; null when the scheduler still holds it past
 * BENCH_TIMING.queueSkipMs.
 */
async function firstRunning(id: string, afterSeq: number): Promise<{ from: number; queuedMs: number } | null> {
  const until = Date.now() + BENCH_TIMING.queueSkipMs
  for (;;) {
    const rows = registry.eventsAfter(id, afterSeq)
    const row = rows.find((r) => (r.event.type === 'status' && r.event.status === 'running') || isSettle(r.event))
    if (row) {
      const statuses = rows.filter((r) => r.event.type === 'status')
      const queued = statuses.find((r) => r.event.type === 'status' && r.event.status === 'queued')
      const left = queued && statuses.find((r) => r.seq > queued.seq && r.event.type === 'status' && r.event.status !== 'queued')
      return { from: row.ts, queuedMs: queued && left ? left.ts - queued.ts : 0 }
    }
    if (Date.now() > until && registry.get(id)?.status === 'queued') return null
    await sleep(200)
  }
}

const lastSeq = (id: string): number => registry.eventsAfter(id, 0).at(-1)?.seq ?? 0
const replyOf = (rows: readonly EventRow[]): string =>
  rows.flatMap((r) => (r.event.type === 'assistant-text' && !r.event.delta ? [r.event.text] : [])).join('\n')
const callRecords = (rows: readonly EventRow[]): CallRecord[] =>
  rows.flatMap((r) => {
    if (r.event.type !== 'tool-call' || r.event.partial) return []
    const callId = r.event.callId
    const result = rows.find((x) => x.event.type === 'tool-result' && x.event.callId === callId)
    return [{ name: r.event.name, input: (r.event.input ?? {}) as Record<string, unknown>, result: result?.event.type === 'tool-result' ? result.event.output : '' }]
  })
const isCua = (name: string): boolean => /(?:^|__|\.)cua_repl$/.test(name)
const promptOf = (text: string): string => (args.mode === 'reference' ? text.replace(COMPUTER_ONLY_LINE, REFERENCE_LINE) : text)

async function oneRun(lane: Lane, task: ComputerTask, attempt: number): Promise<BenchRun> {
  const run: BenchRun = {
    model: lane.model.model,
    provider: lane.model.provider,
    task: task.id,
    taskVersion: task.version,
    attempt,
    outcome: 'skipped',
    stepBudget: task.stepBudget,
    queuedMs: 0,
    wallMs: 0,
    thinkMs: 0,
    calls: [],
    otherTools: [],
    cards: [],
    front: { before: '', after: '', bounced: false, personActive: false, benchInFront: false }
  }
  // One proof on the Mac at a time: an older computer proof holds this run, at most 30 minutes and never past what
  // the gate's budget leaves for the task. The wait counts as held, like the scheduler's.
  const heldFrom = Date.now()
  for (const until = Math.min(heldFrom + 30 * 60_000, DEADLINE - task.wallMs); ; ) {
    const other = otherProof()
    if (!other) break
    if (Date.now() > until) {
      lane.queuedMs += Date.now() - heldFrom
      return { ...run, reason: `another computer proof is running (${other})` }
    }
    await sleep(30_000)
  }
  lane.queuedMs += Date.now() - heldFrom
  // Codex's own computer use may take the pointer or the front: the reference waits for the Mac to be idle 2 minutes.
  if (args.mode === 'reference') {
    const held = await macReady(probe, UNGATED, { quietMs: 120_000, everyMs: 30_000, maxMs: 30 * 60_000, skip: 'the person is active' })
    if (held) return { ...run, reason: held }
  }
  return withLock(task.shared, async () => {
    const nonce = randomBytes(4).toString('hex')
    const dir = join(WORK, 'runs', `${lane.name}-${task.id}-${nonce}`)
    mkdirSync(dir, { recursive: true })
    const ctx: TaskContext = {
      nonce,
      seed: 1 + (randomBytes(2).readUInt16BE(0) % 9000),
      dir,
      benchUrl: BENCH_URL,
      writeFile: async (p, t) => writeFileSync(p, t),
      run: exec,
      home: homedir(),
      open: async (app, target) => {
        const held = await macReady(probe, UNGATED)
        if (held) throw new SkipRun(held)
        const { front } = await R.launch(lane.name, app, target)
        // Ungated, the person accepts the scratch windows coming forward: the front is not judged.
        if (front === 'took' && !UNGATED) throw new FailRun('took the front')
        if (front !== 'kept') run.front.bounced = true
      },
      devInstance: () => devInstance(lane, dir, () => (run.front.bounced = true))
    }
    let start: TaskStart | null = null
    const undo = async (): Promise<void> => {
      if (start) await task.teardown?.(start, exec)
    }
    pending.add(undo)
    let thread: string | null = null
    try {
      const s = await task.setup(ctx)
      if ('skip' in s) return { ...run, reason: s.skip }
      start = s
      return await drive(lane, task, start, run, (id) => (thread = id))
    } catch (e) {
      if (e instanceof SkipRun) return { ...run, reason: e.message }
      if (e instanceof FailRun) return { ...run, outcome: 'failed', reason: e.message, front: { ...run.front, benchInFront: e.message === 'took the front' } }
      return { ...run, outcome: 'failed', reason: `${start ? 'run' : 'setup'}: ${(e as Error).message}` }
    } finally {
      // No computer call may still be running when the run puts things back: a stopped turn's last act could land after.
      if (thread) await R.sessions.stop(thread).catch(() => undefined)
      await undo().catch((e: Error) => log(`teardown ${task.id}: ${e.message}`))
      pending.delete(undo)
      if (thread) {
        liveThreads.delete(thread)
        R.pins.unbind(thread)
        await registry.setArchived(thread, true).catch(() => undefined)
      }
      R.closeLane(lane.name)
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

/** The thread's turns, then the checks, read through the rig and never through the thread. */
async function drive(lane: Lane, task: ComputerTask, start: TaskStart, run: BenchRun, made: (id: string) => void): Promise<BenchRun> {
  const before = R.mac.frontmost()
  const t0 = Date.now()
  const id = (await registry.create({ provider: lane.model.provider as never, model: lane.model.model, reasoning: lane.model.effort, permission: 'auto', cwd: join(WORK, 'cwd'), threadType: 'chat' })).id
  made(id)
  liveThreads.add(id)
  R.pins.bind(id, lane.name)
  // Every card is answered Allow, but the tier scheduler's own (Run now or Skip): Skip, since Run now would take the
  // person's pointer and keyboard while they are there. Its kind and title are in the rows. The card's row is
  // emitted before requestApproval sets its resolver, so the answer goes after this job.
  const offCards = registry.subscribe(id, (row: EventRow) => {
    if (row.event.type !== 'approval-request') return
    const requestId = row.event.requestId
    const allow = row.event.choices !== 'run-skip'
    queueMicrotask(() => void registry.approve(id, requestId, allow))
  })
  try {
    let after = lastSeq(id)
    const sent = Date.now()
    await registry.send(id, promptOf(task.prompt(start)))
    const began = await firstRunning(id, after)
    if (began === null) {
      const waited = Date.now() - sent
      lane.queuedMs += waited
      return { ...run, queuedMs: waited, reason: `queued past 5 minutes: ${registry.get(id)?.statusDetail ?? 'the scheduler held it'}` }
    }
    const from = began.from
    run.queuedMs = began.queuedMs
    lane.queuedMs += began.queuedMs
    const wallEnd = from + task.wallMs
    let settle = await nextSettle(id, after, wallEnd - Date.now())
    let check: CheckResult | null = null
    if (settle.kind === 'settled' && task.then) {
      const first = await task.then.check(start, R.reader(lane.name)).catch((e: Error) => ({ ok: false, detail: `check: ${e.message}` }))
      if (!first.ok) check = { ok: false, detail: `after turn one: ${first.detail}` }
      else {
        after = lastSeq(id)
        await registry.send(id, promptOf(task.then.message))
        settle = await nextSettle(id, after, wallEnd - Date.now())
      }
    }
    if (settle.kind === 'timeout') await registry.interrupt(id).catch(() => undefined)
    const rows = registry.eventsAfter(id, 0)
    const facts = readRun(rows, R.calls(id), from, settle.at, args.mode === 'reference' ? isCua : undefined)
    if (settle.kind === 'timeout') check = { ok: false, detail: 'timed out' }
    else if (settle.kind === 'question') check = { ok: false, detail: 'asked the person a question' }
    else if (!check) {
      const records = callRecords(rows)
      const c = await task.check(start, R.reader(lane.name), replyOf(rows), records).catch((e: Error) => ({ ok: false, detail: `check: ${e.message}` }))
      check = c.ok && task.policy && args.mode !== 'reference' ? task.policy(start, records) : c
    }
    const after1 = R.mac.frontmost()
    const benchInFront = !UNGATED && R.pins.pids(lane.name).includes(after1.pid)
    if (benchInFront && before.bundleId) {
      try {
        R.mac.activate(before.bundleId)
      } catch {
        /* the run fails as having taken the front either way */
      }
    }
    const done: BenchRun = {
      ...run,
      outcome: 'passed',
      wallMs: facts.wallMs,
      thinkMs: facts.thinkMs,
      calls: facts.calls,
      otherTools: facts.otherTools,
      cards: facts.cards,
      ...(facts.tokens ? { tokens: facts.tokens } : {}),
      front: {
        before: before.bundleId ?? String(before.pid),
        after: after1.bundleId ?? String(after1.pid),
        bounced: run.front.bounced,
        personActive: R.mac.idleSeconds() < (Date.now() - t0) / 1000,
        benchInFront
      }
    }
    const fault = args.mode === 'reference' ? null : runFault(done)
    return check.ok && !fault ? done : { ...done, outcome: 'failed', reason: fault ?? check.detail }
  } finally {
    offCards()
  }
}


// ── the lanes, side by side ─────────────────────────────────────────────

async function runLane(lane: Lane): Promise<void> {
  for (const t of needsSession) report.runs.push(skippedRun(lane, t, 'needs the session tier: hand run with --session'))
  const plan: { task: ComputerTask; attempt: number }[] = laneOrder(runnable, lane.index).flatMap((task) =>
    Array.from({ length: args.runs ?? 1 }, (_, i) => ({ task, attempt: i + 1 }))
  )
  for (let i = 0; i < plan.length; i++) {
    const { task, attempt } = plan[i]
    if (Date.now() + task.wallMs > DEADLINE) {
      const left = [...new Set(plan.slice(i).map((p) => p.task.id))]
      const cause = lane.queuedMs > HELD_MS ? 'scheduler' : 'budget'
      for (const t of left) report.unrun.push({ model: lane.model.model, task: t, cause })
      log(`${lane.model.model}: the bench's budget ran out before ${left.join(', ')} (${cause})`)
      return
    }
    const r = await oneRun(lane, task, attempt)
    report.runs.push(r)
    const host = r.calls.filter((c) => c.hostMs !== null)
    log(
      `${lane.model.model} ${task.id} #${attempt}: ${r.outcome}${r.reason ? `, ${r.reason}` : ''} · ${r.calls.length} calls, ${Math.round(r.wallMs / 1000)} s` +
        (host.length ? `, host ${Math.round(host.reduce((n, c) => n + c.hostMs!, 0) / host.length)} ms a call` : '')
    )
    if (judged && attempt === 1 && args.runs === null && needsRerun(r, findBase(baseline, r.model, r.task, r.taskVersion)))
      plan.push({ task, attempt: 2 }, { task, attempt: 3 })
  }
}

function skippedRun(lane: Lane, task: ComputerTask, reason: string): BenchRun {
  return {
    model: lane.model.model,
    provider: lane.model.provider,
    task: task.id,
    taskVersion: task.version,
    attempt: 1,
    outcome: 'skipped',
    reason,
    stepBudget: task.stepBudget,
    queuedMs: 0,
    wallMs: 0,
    thinkMs: 0,
    calls: [],
    otherTools: [],
    cards: [],
    front: { before: '', after: '', bounced: false, personActive: false, benchInFront: false }
  }
}

// ── the run ─────────────────────────────────────────────────────────────

mkdirSync(join(WORK, 'cwd'), { recursive: true })
// The reference pass offers no computer_* tool: Codex's own computer use is the one in the thread.
const hooks = computerHooks.current
if (args.mode === 'reference') computerHooks.current = null
let exitCode = 0
try {
  log(`${args.mode}: ${lanes.map((l) => l.model.model).join(', ') || 'no lane'} on ${runnable.map((t) => t.id).join(', ')}`)
  await Promise.all(lanes.map(runLane))
} finally {
  computerHooks.current = hooks
  const table = writeReports()
  console.log(table)
  const verdict = judgeBench(report, baseline)
  const outcome = benchOutcome({ mode: args.mode, ok: verdict.ok, rebaseline: args.rebaseline, baselineRows: baseline.rows.length })
  if (outcome.note) log(outcome.note)
  if (outcome.write) {
    const next = mergeBaseline(baseline, report, { replace: args.rebaseline })
    if (JSON.stringify(next) !== JSON.stringify(baseline)) {
      writeBaseline(BASELINE, next)
      log(`baseline: ${next.rows.length} rows in ${BASELINE}`)
    }
  }
  exitCode = outcome.fail ? 1 : 0
  log(`report: ${join(WORK, 'report.json')}`)
  await cleanup()
}
process.exit(exitCode)
