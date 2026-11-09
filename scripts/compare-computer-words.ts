/**
 * The computer words comparison (plan .temp-code/plan-0yqEr_cKljNd.md §8):
 * the same facts in two word shapes, Anthropic's and cua's, on Opus 5.5,
 * GPT-6.1 Sol and Muse Wonder 1.0, plus one tool per verb on Opus, three
 * tasks, two runs a cell, then the policy check on each model's kept words.
 * Every thread runs at medium effort in full access, so a card comes only
 * from a flag or the password rule; the runner answers Allow and counts it.
 *
 * Each scratch app is its own process (`open -n -g`), every query pinned to
 * its pid, so the person's own TextEdit and Chrome are never a target; the
 * person accepts the scratch windows coming forward. A run starts only on an
 * unlocked, lit screen and with no other computer proof running on the Mac
 * (one proof at a time). The session tier is refused for every arm, and the
 * tier verdicts of both apps are deleted before every run, so no arm learns
 * for the next.
 *
 * Run on the Mac, under the installed TempCode.app so TCC answers for it:
 *   bun run script:compare-computer-words [-- --arms A,C,AV,CV --tasks textedit-write,chrome-read,chrome-form --runs 2 --models claude-opus-5-5,gpt-6.1-sol,muse-wonder-1.0 --policy | --report-only]
 * The report lands in /tmp/tc-words-cmp/report.{json,md}; nothing else is left behind.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import { configure } from 'aliax-core'
import { startServer, type RunningServer } from '../src/main/server/index'
import { computerHooks } from '../src/main/server/computer/mcp'
import { ComputerRpcError } from '../src/main/server/computer/connection'
import { renderComputerMechanics, setComputerWordsOverride } from '../src/main/server/computer/prompts'
import { REFUSE_SESSION_TIER, setSessionTierGate } from '../src/main/server/computer/tierGate'
import { parseObservation, type ParsedObservation } from '../src/shared/computer/observation'
import type { AppRef, ComputerMethod, ComputerParams, ComputerResult, StepResult } from '../src/shared/computer/protocol'
import { computerToolSpecs, tierVerdictSetting } from '../src/shared/computer/tools'
import type { AgentEvent, EventRow } from '../src/shared/events'
import { COMPARISON_TASKS, POLICY_TASK, taskById, type CallRecord, type TaskApp, type TaskId, type TaskReader, type TaskStart } from './lib/computerTasks'
import { ARMS, decide, runPlan, type Arm, type ModelUnderTest, type RunRecord, type RunStatus } from './lib/computerWordsJudge'
import { buildTcComputer } from './lib/tcComputerBuild'

if (process.platform !== 'darwin') {
  console.log('skipped: macOS only')
  process.exit(0)
}

// the bundle runs from scripts/.out (package.json's script), the source from scripts/
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, HERE.endsWith('/.out') ? '../..' : '..')
const WORK = '/tmp/tc-words-cmp'
const REPORT_JSON = join(WORK, 'report.json')
const REPORT_MD = join(WORK, 'report.md')
const KEEP = new Set(['report.json', 'report.md'])
const BIN = join(ROOT, 'resources/native/tc-computer')
const PROBE = join(WORK, 'computer-proof-probe')
const BENCH = pathToFileURL(join(ROOT, 'src/main/server/computer/fixtures/page/bench.html')).href
const BUNDLES: Record<TaskApp, string> = { TextEdit: 'com.apple.TextEdit', 'Google Chrome': 'com.google.Chrome' }
const TURN_POLL_MS = 30_000
const TURN_GIVE_UP_MS = 30 * 60_000
/** The other computer proofs: one proof on the Mac at a time. */
const OTHER_PROOFS = ['scripts/.out/e2e-computer.mjs', 'e2e-tc-computer', 'tc-computer-proof/', 'ax-reader-proof', 'input-proof', 'capture-proof']
const OFF_ROUTE_OK = /(^|__|\.)(ToolSearch|tool_search|update_notes)$/

const MODELS: ModelUnderTest[] = [
  { model: 'claude-opus-5-5', provider: 'claude', perVerb: true },
  { model: 'gpt-6.1-sol', provider: 'codex', perVerb: false },
  { model: 'muse-wonder-1.0', provider: 'muse', perVerb: false }
]

// ── flags ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const list = <T extends string>(name: string, all: readonly T[]): T[] => (flag(name)?.split(',').filter(Boolean) as T[] | undefined) ?? [...all]
const arms = list<Arm>('arms', ['A', 'C', 'AV', 'CV'])
const tasks = list<TaskId>('tasks', COMPARISON_TASKS)
const runs = Number(flag('runs') ?? 2)
const models = MODELS.filter((m) => list('models', MODELS.map((x) => x.model)).includes(m.model))
const policyOnly = argv.includes('--policy')
const reportOnly = argv.includes('--report-only')

// ── the report ──────────────────────────────────────────────────────────

interface RunDetail extends RunRecord {
  provider: string
  calls: Record<string, number>
  readsReturned: number
  screenshots: number
  errorKinds: Record<string, number>
  cards: string[]
  turns: number
  inputTokens?: number
  outputTokens?: number
}
interface PolicyCheck {
  model: string
  arm: Arm
  status: RunStatus
  detail?: string
}
interface Report {
  startedAt: string
  finishedAt: string
  runs: RunDetail[]
  skipped: string[]
  policy: PolicyCheck[]
  textLength: Partial<Record<Arm, number>>
}
const report: Report =
  reportOnly && existsSync(REPORT_JSON)
    ? (JSON.parse(readFileSync(REPORT_JSON, 'utf8')) as Report)
    : { startedAt: new Date().toISOString(), finishedAt: '', runs: [], skipped: [], policy: [], textLength: {} }

/** An arm's words, for the rule's last tie-break: the section a claude thread reads and the tools' descriptions. */
for (const arm of Object.keys(ARMS) as Arm[]) {
  const { shape, tools } = ARMS[arm]
  report.textLength[arm] =
    renderComputerMechanics({ shape, tools, search: true, provenance: 'person' }).length + computerToolSpecs(shape, tools).reduce((n, t) => n + t.description.length, 0)
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : Number.NaN
}

function writeReports(): void {
  report.finishedAt = new Date().toISOString()
  writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2))
  const md: string[] = [`# Computer words comparison`, '', `${report.startedAt} to ${report.finishedAt}`, '']
  for (const m of MODELS) {
    const mine = report.runs.filter((r) => r.model === m.model)
    if (!mine.length) continue
    md.push(`## ${m.model}`, '', '| Arm | Runs | Passed | Off-route | Median calls | Median steps | Median failed steps | Median wall s | Cards |', '|---|---|---|---|---|---|---|---|---|')
    for (const arm of Object.keys(ARMS) as Arm[]) {
      const r = mine.filter((x) => x.arm === arm && x.status !== 'skipped' && x.status !== 'inconclusive')
      if (!r.length) continue
      md.push(
        `| ${arm} | ${r.length} | ${r.filter((x) => x.status === 'ok').length} | ${r.filter((x) => x.status === 'off-route').length} | ${median(r.map((x) => x.computerCalls))} | ${median(r.map((x) => x.steps))} | ${median(r.map((x) => x.failedSteps))} | ${Math.round(median(r.map((x) => x.wallMs)) / 1000)} | ${r.reduce((n, x) => n + x.cards.length, 0)} |`
      )
    }
    const d = decide(report.runs, m, report.textLength)
    md.push('', `Words: ${d.words.winner ?? 'none'} (${d.words.reason})${d.tools ? `; tools: ${d.tools.winner ?? 'none'} (${d.tools.reason})` : ''}; ships ${d.ship ? `${d.ship.shape}/${d.ship.tools}` : 'nothing (skipped)'}`, '')
  }
  if (report.policy.length) md.push('## Policy check', '', ...report.policy.map((p) => `- ${p.model} on ${p.arm}: ${p.status}${p.detail ? `, ${p.detail}` : ''}`), '')
  if (report.skipped.length) md.push('## Skipped', '', ...report.skipped.map((s) => `- ${s}`), '')
  writeFileSync(REPORT_MD, md.join('\n'))
}

if (reportOnly) {
  writeReports()
  console.log(readFileSync(REPORT_MD, 'utf8'))
  process.exit(0)
}

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

// ── the Mac, read from outside ──────────────────────────────────────────

execFileSync('xcrun', ['swiftc', '-O', '-o', PROBE, join(ROOT, 'scripts/mac/computer-proof-probe.swift')], { stdio: 'pipe' })
const probe = <T>(command: string): T => JSON.parse(execFileSync(PROBE, [command], { encoding: 'utf8', timeout: 10_000 })) as T
const screenReady = (): boolean => {
  const screen = probe<{ locked: boolean; asleep: boolean }>('screen')
  return !screen.locked && !screen.asleep
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const pids = (name: string): Set<number> => {
  try {
    return new Set(execFileSync('pgrep', ['-x', name], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number))
  } catch {
    return new Set()
  }
}

/** Another computer proof running on this Mac, by its command line. */
const otherProof = (): string | null => {
  for (const pattern of OTHER_PROOFS) {
    try {
      const found = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)
      if (found.some((pid) => pid !== process.pid)) return pattern
    } catch {
      /* none */
    }
  }
  return null
}

/** Before every launch: no other computer proof running, and an unlocked, lit screen (AX sees no windows otherwise); polled every 30 s for at most 30 minutes. */
async function waitForTurn(): Promise<string | null> {
  const giveUp = Date.now() + TURN_GIVE_UP_MS
  for (;;) {
    const other = otherProof()
    const why = other ? `another computer proof is running (${other})` : screenReady() ? null : 'the screen is locked or dark'
    if (!why) return null
    if (Date.now() > giveUp) return why
    await sleep(TURN_POLL_MS)
  }
}

// ── the server, as index.ts wires it on a Mac ───────────────────────────

const build = buildTcComputer({ root: ROOT, require: true })
console.log(`tc-computer: ${build.built ? `built in ${build.ms} ms` : build.skipped}`)
process.env.TEMP_CODE_COMPUTER_BIN = BIN
const grants = JSON.parse(execFileSync(BIN, ['permissions'], { encoding: 'utf8' })) as { accessibility: boolean }
if (!grants.accessibility) {
  console.log('STOP  Accessibility is off for TempCode: turn it on under System Settings → Privacy & Security → Accessibility')
  process.exit(1)
}

const pinned: Partial<Record<TaskApp, number>> = {}
const QUERIES: Record<TaskApp, string[]> = { TextEdit: ['textedit', 'com.apple.textedit'], 'Google Chrome': ['google chrome', 'chrome', 'com.google.chrome'] }
const resolveApp = (q: string): AppRef | null => {
  for (const app of Object.keys(QUERIES) as TaskApp[]) if (QUERIES[app].includes(q.toLowerCase()) && pinned[app]) return { pid: pinned[app]! }
  return null
}
// an empty vault routes nothing: every thread passes its CLI's own login through to the provider, never the person's live shim
const ALIAX = join(WORK, 'data', 'aliax')
mkdirSync(join(ALIAX, 'secrets'), { recursive: true, mode: 0o700 })
writeFileSync(join(ALIAX, 'vault.key'), `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
writeFileSync(join(ALIAX, 'profiles.json'), '{}\n')
configure({ dataDir: ALIAX, fetch: (url, init) => fetch(url, init), secrets: { mode: 'fileKey', path: join(ALIAX, 'vault.key') }, appName: 'temp-code-words-cmp' })
const server: RunningServer = await startServer(join(WORK, 'data', 'app.db'), { dataDir: join(WORK, 'data'), claimShim: false, remotePort: 0, computerResolveApp: resolveApp })
const registry = server.registry
const host = computerHooks.current
if (!host?.available()) {
  console.log('STOP  computer use is unavailable in this server')
  process.exit(1)
}
setSessionTierGate(REFUSE_SESSION_TIER)

// What each run's steps did, from the wire.
const wire = { steps: 0, failed: 0, kinds: {} as Record<string, number> }
const request = host.service.request.bind(host.service)
host.service.request = (async (method: ComputerMethod, params: never, opts?: { signal?: AbortSignal; timeoutMs?: number }) => {
  try {
    const result = await request(method, params, opts)
    const steps: StepResult[] =
      method === 'action.run' ? [(result as { step: StepResult }).step] : method === 'action.batch' ? (result as { steps: StepResult[] }).steps : []
    if ((params as { session?: string }).session !== 'cmp-proof')
      for (const s of steps) {
        if (s.status === 'not-run') continue
        wire.steps++
        if (s.status === 'failed') {
          wire.failed++
          wire.kinds[s.error.kind] = (wire.kinds[s.error.kind] ?? 0) + 1
        }
      }
    return result
  } catch (e) {
    if (e instanceof ComputerRpcError && e.data) wire.kinds[e.data.kind] = (wire.kinds[e.data.kind] ?? 0) + 1
    throw e
  }
}) as typeof host.service.request

// The runner's own session: the checks read the end state through it, never the model's word.
const proofCall = async <M extends ComputerMethod>(method: M, params: ComputerParams<M>): Promise<ComputerResult<M>> => {
  try {
    return await request(method, params)
  } catch (e) {
    if (!(e instanceof ComputerRpcError) || e.data?.kind !== 'unknown_session') throw e
    await request('session.open', { session: 'cmp-proof' })
    return await request(method, params)
  }
}
await request('session.open', { session: 'cmp-proof' })
const reader: TaskReader = {
  read: async (app, window): Promise<ParsedObservation> =>
    parseObservation((await proofCall('state.get', { session: 'cmp-proof', app: { pid: pinned[app]! }, window: { title: window }, mode: 'full' })).text),
  element: async (app, window, index): Promise<ParsedObservation> =>
    parseObservation((await proofCall('state.get', { session: 'cmp-proof', app: { pid: pinned[app]! }, window: { title: window }, element: index })).text)
}

// ── the scratch apps ────────────────────────────────────────────────────

const CHROME_PROFILE = join(WORK, 'chrome')
async function open(app: TaskApp, target: string): Promise<void> {
  const name = app === 'TextEdit' ? 'TextEdit' : 'Google Chrome'
  const before = pids(name)
  const args =
    app === 'TextEdit'
      ? ['-n', '-g', '-a', 'TextEdit', target, '--args', '-ApplePersistenceIgnoreState', 'YES']
      : ['-n', '-g', '-a', 'Google Chrome', '--args', `--user-data-dir=${CHROME_PROFILE}`, '--no-first-run', '--no-default-browser-check', target]
  execFileSync('open', args)
  for (let i = 0; i < 60 && !pinned[app]; i++) {
    await sleep(250)
    pinned[app] = [...pids(name)].find((p) => !before.has(p))
  }
  if (!pinned[app]) throw new Error(`open -n gave no new ${name} pid`)
  await sleep(app === 'TextEdit' ? 1_000 : 3_000)
}
function closeScratch(): void {
  for (const app of Object.keys(pinned) as TaskApp[]) {
    try {
      process.kill(pinned[app]!, 'SIGKILL')
    } catch {
      /* gone already */
    }
    delete pinned[app]
  }
  rmSync(CHROME_PROFILE, { recursive: true, force: true })
}

// ── one run ─────────────────────────────────────────────────────────────

const settled = (e: AgentEvent): boolean => e.type === 'turn-complete' || (e.type === 'status' && (e.status === 'error' || e.status === 'idle'))
const computerName = (name: string): string | null => /(?:^|__|\.)(computer_[a-z_]+)$/.exec(name)?.[1] ?? null

async function oneRun(model: ModelUnderTest, taskId: TaskId, arm: Arm, run: number): Promise<RunDetail> {
  const task = taskById(taskId)
  const base: RunDetail = {
    model: model.model,
    provider: model.provider,
    task: taskId,
    arm,
    run,
    status: 'inconclusive',
    computerCalls: 0,
    otherCalls: 0,
    steps: 0,
    failedSteps: 0,
    wallMs: 0,
    calls: {},
    readsReturned: 0,
    screenshots: 0,
    errorKinds: {},
    cards: [],
    turns: 0
  }
  const wait = await waitForTurn()
  if (wait) return { ...base, status: 'skipped', detail: wait }
  for (const b of Object.values(BUNDLES)) server.store.setSetting(tierVerdictSetting(b), null)
  setComputerWordsOverride(ARMS[arm])
  const nonce = randomBytes(4).toString('hex')
  const seed = 1 + (randomBytes(2).readUInt16BE(0) % 9000)
  const dir = join(WORK, 'runs', nonce)
  mkdirSync(dir, { recursive: true })
  let start: TaskStart
  try {
    start = await task.setup({ nonce, seed, dir, benchUrl: BENCH, writeFile: async (p, t) => writeFileSync(p, t), open })
  } catch (e) {
    closeScratch()
    return { ...base, status: 'failed', detail: `setup: ${(e as Error).message}` }
  }
  const thread = await registry.create({ provider: model.provider as never, model: model.model, reasoning: 'medium', permission: 'auto', cwd: dir, threadType: 'chat' })
  const id = thread.id
  const cards: string[] = []
  const off = registry.subscribe(id, (row: EventRow) => {
    if (row.event.type !== 'approval-request') return
    const kind = ((row.event.input as { confirm?: { kind?: string } } | undefined)?.confirm?.kind ?? 'none') as string
    cards.push(kind)
    // the card's row is emitted before requestApproval sets its resolver: Allow after this job
    const requestId = row.event.requestId
    queueMicrotask(() => void registry.approve(id, requestId, true))
  })
  Object.assign(wire, { steps: 0, failed: 0, kinds: {} })
  const t0 = Date.now()
  await registry.send(id, task.prompt(start))
  const done = await new Promise<boolean>((resolveDone) => {
    const timer = setTimeout(() => (stop(), resolveDone(false)), task.wallMs)
    const stop = registry.subscribe(id, (row: EventRow) => {
      if (!settled(row.event)) return
      clearTimeout(timer)
      stop()
      resolveDone(true)
    })
  })
  if (!done) await registry.interrupt(id).catch(() => undefined)
  const wallMs = Date.now() - t0
  off()
  const rows = registry.eventsAfter(id, 0)
  const calls: CallRecord[] = []
  const byTool: Record<string, number> = {}
  let other = 0
  for (const r of rows) {
    if (r.event.type !== 'tool-call' || r.event.partial) continue
    const call = r.event
    const name = computerName(call.name)
    if (!name) {
      if (!OFF_ROUTE_OK.test(call.name)) other++
      continue
    }
    byTool[name] = (byTool[name] ?? 0) + 1
    const result = rows.find((x) => x.event.type === 'tool-result' && x.event.callId === call.callId)
    const out = result?.event.type === 'tool-result' ? result.event.output : ''
    calls.push({ name, input: (call.input ?? {}) as Record<string, unknown>, result: typeof out === 'string' ? out : JSON.stringify(out) })
  }
  const reply = rows
    .filter((r) => r.event.type === 'assistant-text' && !(r.event as { delta?: boolean }).delta)
    .map((r) => (r.event as { text: string }).text)
    .join('\n')
  const usage = rows.filter((r) => r.event.type === 'usage').map((r) => r.event as { inputTokens?: number; outputTokens?: number })
  const detail: RunDetail = {
    ...base,
    computerCalls: calls.length,
    otherCalls: other,
    steps: wire.steps,
    failedSteps: wire.failed,
    wallMs,
    calls: byTool,
    readsReturned: byTool.computer_observe ?? 0,
    screenshots: calls.reduce((n, c) => n + (c.result.match(/^screenshot \d+ \(/gm)?.length ?? 0), 0),
    errorKinds: { ...wire.kinds },
    cards,
    turns: rows.filter((r) => r.event.type === 'turn-complete').length,
    ...(usage.length ? { inputTokens: usage.reduce((n, u) => n + (u.inputTokens ?? 0), 0), outputTokens: usage.reduce((n, u) => n + (u.outputTokens ?? 0), 0) } : {})
  }
  let verdict: { status: RunStatus; detail: string }
  if (!done) verdict = { status: 'failed', detail: 'past the wall time' }
  else if (other) verdict = { status: 'off-route', detail: `${other} calls of other tools` }
  else if (calls.length > task.stepBudget) verdict = { status: 'failed', detail: `${calls.length} computer calls, over ${task.stepBudget}` }
  else {
    const c = await task.check(start, reader, reply, calls).catch((e: Error) => ({ ok: false, detail: `check: ${e.message}` }))
    verdict = { status: c.ok ? 'ok' : 'failed', detail: c.detail }
  }
  await registry.setArchived(id, true).catch(() => undefined)
  closeScratch()
  return { ...detail, ...verdict }
}

const cleanup = async (): Promise<void> => {
  closeScratch()
  setComputerWordsOverride(null)
  await registry.disposeAll().catch(() => undefined)
  writeReports()
  for (const name of readdirSync(WORK)) if (!KEEP.has(name)) rmSync(join(WORK, name), { recursive: true, force: true })
}

// ── the runs ────────────────────────────────────────────────────────────

/** A model whose harness cannot answer one turn here (no login, an empty catalog) is skipped with one line. */
async function reachable(m: ModelUnderTest): Promise<boolean> {
  const t = await registry.create({ provider: m.provider as never, model: m.model, reasoning: 'low', permission: 'safe', cwd: WORK, threadType: 'chat' })
  await registry.send(t.id, 'Reply with the word ready and nothing else.')
  const ok = await new Promise<boolean>((resolveOk) => {
    const timer = setTimeout(() => (stop(), resolveOk(false)), 180_000)
    const stop = registry.subscribe(t.id, (row: EventRow) => {
      if (row.event.type === 'turn-complete') (clearTimeout(timer), stop(), resolveOk(true))
      else if (row.event.type === 'status' && row.event.status === 'error') (clearTimeout(timer), stop(), resolveOk(false))
    })
  })
  await registry.setArchived(t.id, true).catch(() => undefined)
  return ok
}

try {
  const live: ModelUnderTest[] = []
  for (const m of models) {
    if (await reachable(m)) live.push(m)
    else report.skipped.push(`${m.model}: its harness did not answer a turn on this Mac (no login, or a catalog without it); its cells are skipped`)
  }
  if (!policyOnly) {
    const plan = runPlan(tasks, arms, runs, live)
    console.log(`${plan.length} runs`)
    for (const [i, p] of plan.entries()) {
      const m = live.find((x) => x.model === p.model)!
      const r = await oneRun(m, p.task, p.arm, p.run)
      report.runs.push(r)
      console.log(`[${i + 1}/${plan.length}] ${p.model} ${p.task} ${p.arm} run ${p.run}: ${r.status}${r.detail ? `, ${r.detail}` : ''} · ${r.computerCalls} calls, ${r.steps} steps, ${Math.round(r.wallMs / 1000)} s`)
      writeReports()
      if (r.status === 'skipped') break
    }
  }
  // the policy check, once per model on the words it keeps
  for (const m of live) {
    const d = decide(report.runs, m, report.textLength)
    const ship = d.ship ?? { shape: 'anthropic', tools: 'act' }
    const arm = (Object.keys(ARMS) as Arm[]).find((a) => ARMS[a].shape === ship.shape && ARMS[a].tools === ship.tools)!
    const r = await oneRun(m, POLICY_TASK, arm, 1)
    report.runs.push(r)
    report.policy.push({ model: m.model, arm, status: r.status, ...(r.detail ? { detail: r.detail } : {}) })
    console.log(`policy ${m.model} on ${arm}: ${r.status}${r.detail ? `, ${r.detail}` : ''}`)
    writeReports()
  }
} finally {
  await cleanup()
}
console.log(readFileSync(REPORT_MD, 'utf8'))
process.exit(0)
