/**
 * The Mac proof of tc-computer, TempCode's computer-use service (plan
 * .temp-code/plan-EvYtk68iFpQT.md §12.4). It builds the binary, speaks the
 * stdio wire to `tc-computer serve` and holds every response and
 * notification to the zod in src/shared/computer/protocol.ts.
 *
 *  - the probe app (scripts/mac/computer-probe-app.swift, built here into
 *    /tmp/tc-computer-proof/TC Probe.app): launched in the background by
 *    `apps.launch`, listed with its window, found by bundle id, name and
 *    prefix, its "Ping" pressed at the ax tier; the person's frontmost app
 *    and pointer never move. A second service with every private symbol
 *    forced to miss lists the same window id.
 *  - the window actions (docs/computer-protocol.md §22) on a second TC Probe
 *    launched with `--windows`: the title-bar buttons last in every read with
 *    no sharing badge, an ignored process scroll reading none, close with its
 *    save sheet (Cancel, then Don't Save) and the next window read whole,
 *    minimize at ax and raise refused without the session tier, a window with
 *    no buttons; then a third instance's last window closed, which quits it.
 *  - a scratch TextEdit, its own process opened with `open -n -g` and
 *    targeted by that pid alone: a full read, set_value, a process-tier
 *    click, the clipboard lock and a 2,500-character paste, a screenshot,
 *    batches, an unchanged read, a cancelled wait, a crash with the button
 *    held and the restart that releases it, and a clean exit on stdin EOF.
 *    A background TextEdit ignores a left click and Command-V at the process
 *    tier (§14.8): the click and the paste record that as a finding, and the
 *    paste step still holds the lock and the clipboard's restore.
 *
 * Nothing here activates an app or takes the session tier: every action
 * runs with the `ax` and `process` tiers alone. A launched app may still come
 * in front whatever `-g` says, so the two apps run under the person's launch
 * rule: they start only once the Mac has had 5 minutes with no input, the
 * idle time is read every second while they run, and the moment the person
 * touches the Mac they are hidden and killed and that attempt's results
 * dropped; the next 5-minute gap tries again, up to 90 minutes in all, and
 * what never got a gap is reported "not run: the person was at the Mac". A
 * locked Mac or a dark display is no gap, and stops a try as input does. The
 * proof's own process-tier events move the Mac's idle time too, so input that
 * lands while a call that may post is out, or within half a second of its
 * answer, reads as the proof's, and each such call waits for one whole watch
 * interval with nothing masked first (scripts/lib/proofGate.ts). A raise at
 * launch behind that gate is noted, not failed. `TC_PROOF_UNGATED=1` drops
 * the idle wait and the abort on input for one run the person has agreed to
 * sit beside (the scratch windows may come forward and take a keystroke);
 * the screen check stays, and the report says the gate was off. The paste waits until the
 * person has not copied for 5 s, and the proof never reads the pasteboard's
 * contents itself (only its change count), so it raises no paste prompt. It
 * asks for no permission. A check that the person's pointer and app stayed
 * put reads as inconclusive, not failed, when the person used the Mac during
 * the step. Everything it made goes in the `finally`, but report.json and
 * trace.log under /tmp/tc-computer-proof.
 *
 * Run on the Mac: bun run script:e2e-tc-computer
 */
import { gateScreenSkip } from './lib/macScreen'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  type ElementLine,
  type LineFrame,
  parseObservation,
  SUBROLE_NAMES
} from '../src/shared/computer/observation'
import {
  COMPUTER_PROTOCOL,
  COMPUTER_WAIT,
  ComputerNotificationSchema,
  HostNotificationSchema,
  LOCKS,
  NotificationFrameSchema,
  RpcErrorResponseSchema,
  SHOT,
  requestFrameSchema,
  resultFrameSchema,
  type ClipboardActivity,
  type ComputerErrorKind,
  type ComputerMethod,
  type ComputerNotification,
  type ComputerParams,
  type ComputerResult,
  type CoordinateSpace,
  type Observation,
  type Permissions,
  type RpcError,
  type Shot,
  type StepResult,
  type WaitReport
} from '../src/shared/computer/protocol'
import { waitForGateBuild } from './lib/gateBuild'
import { intPoint } from './lib/computerPoint'
import { cleanupProbeApp, launchProbe } from './lib/tcProbeApp'
import { COMPUTER_PROOF_ENV, sweepComputerProofProcesses } from './lib/computerProofProcesses'
import { computerInitializeMs, computerProofMode, computerProofPolicy, LOST_TRY_LINE, lostTry, requireGateNative, waitForComputerProof } from './lib/computerProofGate'
import { OwnInput, personSince } from './lib/proofGate'
import { buildTcComputer, type TcComputerBuildResult } from './lib/tcComputerBuild'

if (process.platform !== 'darwin') {
  console.log('skipped: macOS only')
  process.exit(0)
}

const GATE = computerProofMode(process.argv).gate
if (GATE) process.env.TC_PROOF_UNGATED = '1'
let policy = computerProofPolicy(GATE, { accessibility: true, screenRecording: true })

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const screenSkip = gateScreenSkip(GATE, ROOT)
if (screenSkip) {
  console.log(screenSkip)
  process.exit(0)
}

let ownsWork = false
const WORK = '/tmp/tc-computer-proof'
const REPORT = join(WORK, 'report.json')
const TRACE = join(WORK, 'trace.log')
const KEEP = new Set(['report.json', 'trace.log'])
const BIN = join(ROOT, 'resources/native/tc-computer')
const DATA = join(WORK, 'data')
const PROBE_TOOL = join(WORK, 'computer-proof-probe')
const PROBE_APP = join(WORK, 'TC Probe.app')
const PROBE_BUNDLE_ID = 'dev.landon.tempcode.computer-probe'
const RTF = join(WORK, 'probe.rtf')
const PROBE_TEXT = 'TC probe text'
const SESSION = 'proof'
/** Quiet this long by `clipboard.state` before anything touches the pasteboard (the tier scheduling rule's recent copy). */
const QUIET_MS = 5_000
const QUIET_RETRY_MS = 10_000
const QUIET_RETRIES = 3
const PASTE_TEXT = 'tc-computer paste proof '.repeat(120).slice(0, 2_500)
const NOT_QUIET = `the clipboard was not quiet for ${QUIET_MS / 1000} s after ${QUIET_RETRIES} more tries`
/** For a run the person sits beside by their own leave: no idle wait and no abort on input; the screen check stays. */
const UNGATED = process.env.TC_PROOF_UNGATED === '1'
/** The launch rule: no input this long before an app starts, the idle time read this often while it runs. */
const LAUNCH_IDLE_S = UNGATED ? 0 : 300
const WATCH_EVERY_MS = 1_000
/** How long the proof waits in all for a gap. */
const GATE_WAIT_MS = 90 * 60_000
const NOT_RUN = 'not run: the person was at the Mac'
const ABORTED = 'aborted: the person came back'
const NOT_RUN_LOCKED = `${NOT_RUN}, and it was locked or dark when they were away`
/** Input this soon after one of the proof's own posting calls answered is its own event's echo. */
const OWN_INPUT_MARGIN_MS = 500
/** In the scratch TextEdit's arguments, so an abort finds it before `open` has told us its pid. */
const RUN_MARK = `tc-computer-proof-${process.pid}-${Date.now()}`

// ── the report ──────────────────────────────────────────────────────────

type Outcome = 'passed' | 'failed' | 'skipped'
interface StepRecord {
  name: string
  outcome: Outcome
  ms: number
  why?: string
  data?: Record<string, unknown>
}

const report = {
  startedAt: new Date().toISOString(),
  finishedAt: '',
  macos: '',
  build: null as TcComputerBuildResult | null,
  initializeMs: [] as { service: string; ms: number }[],
  permissions: null as Permissions | null,
  textEditReadMs: null as number | null,
  pastePrompt: null as Record<string, unknown> | null,
  waits: [] as { step: string; method: string; at: string; report: WaitReport }[],
  frames: { responses: 0, notifications: 0, violations: [] as string[] },
  steps: [] as StepRecord[],
  skipped: [] as { name: string; why: string }[],
  /** The idle gate was off for this run, by the person's leave (TC_PROOF_UNGATED=1). */
  ungated: UNGATED,
  /** Each try at the two apps: run whole, or aborted when the person touched the Mac. */
  gate: [] as {
    attempt: number
    at: string
    outcome: 'ran' | 'aborted'
    why?: 'input' | 'deadline' | 'locked'
    afterMs?: number
  }[],
  stopped: null as string | null,
  cleanup: [] as string[]
}

/** Thrown by a step that cannot run here; the chain goes on. */
class Skip {
  constructor(readonly why: string) {}
}
const skip = (why: string): Skip => new Skip(why)

class Check extends Error {}
const short = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s === undefined ? String(v) : s.length > 800 ? `${s.slice(0, 800)}…` : s
}
function check(ok: unknown, what: string, saw?: unknown): asserts ok {
  if (!ok) throw new Check(saw === undefined ? what : `${what}; saw ${short(saw)}`)
}

let currentStep = ''

/** Steps that build on each other: once one fails, the rest skip. */
class Chain {
  private broken: string | null = null

  async step(name: string, fn: (data: Record<string, unknown>) => Promise<void>): Promise<void> {
    if (tryAborted) {
      record({ name, outcome: 'skipped', ms: 0, why: ABORTED })
      return
    }
    if (this.broken) {
      record({ name, outcome: 'skipped', ms: 0, why: `${this.broken} failed` })
      return
    }
    currentStep = name
    const data: Record<string, unknown> = {}
    const t0 = performance.now()
    try {
      await fn(data)
      record({ name, outcome: 'passed', ms: Math.round(performance.now() - t0), data })
    } catch (error) {
      if (error instanceof Skip) {
        record({
          name,
          outcome: 'skipped',
          ms: Math.round(performance.now() - t0),
          why: error.why,
          data
        })
        return
      }
      const why = error instanceof Error ? error.message : String(error)
      record({ name, outcome: 'failed', ms: Math.round(performance.now() - t0), why, data })
      this.broken = name
    }
  }
}

function record(step: StepRecord): void {
  if (step.data && !Object.keys(step.data).length) delete step.data
  report.steps.push(step)
}

/** Every `waited` a result carries, with where it sat. */
function noteWaits(method: string, value: unknown, path = 'result'): void {
  if (!value || typeof value !== 'object') return
  for (const [key, v] of Object.entries(value)) {
    if (key === 'waited' && v && typeof v === 'object')
      report.waits.push({
        step: currentStep,
        method,
        at: `${path}.waited`,
        report: v as WaitReport
      })
    else if (key !== 'text') noteWaits(method, v, `${path}.${key}`)
  }
}

// ── small helpers ───────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Check(`${what} took over ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, late])
  } finally {
    clearTimeout(timer)
  }
}

async function until<T>(
  fn: () => T | null | Promise<T | null>,
  ms: number,
  what: string
): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Check(`no ${what} after ${ms}ms`)
    await sleep(250)
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function pidsOf(name: string): number[] {
  try {
    return execFileSync('pgrep', ['-x', name], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}

/**
 * How long the person has not touched the keyboard, pointer or trackpad (`HIDIdleTime`, which only
 * the hardware moves). A step that took the `session` tier would first need this ≥ 120 s and
 * otherwise record `skipped: the person is active`; no step here does. The pointer and frontmost
 * checks read it to tell the person's own input from ours, and the launch rule reads it.
 */
const hidIdleSeconds = (ioreg: string): number => {
  const m = /"HIDIdleTime" = (\d+)/.exec(ioreg)
  return m ? Number(m[1]) / 1e9 : 0
}
const personIdleSeconds = (): number =>
  hidIdleSeconds(execFileSync('ioreg', ['-c', 'IOHIDSystem'], { encoding: 'utf8' }))
const execFileAsync = promisify(execFile)
const personIdleSecondsAsync = async (): Promise<number> =>
  hidIdleSeconds((await execFileAsync('ioreg', ['-c', 'IOHIDSystem'], { encoding: 'utf8' })).stdout)

/** The stretches the proof itself may have posted input (scripts/lib/proofGate.ts). */
const ownInput = new OwnInput(OWN_INPUT_MARGIN_MS)

/** A call that may post input: an action at a tier past `ax`, or `initialize`, which lets go of held input. */
function postsInput(method: ComputerMethod, params: unknown): boolean {
  if (method === 'initialize') return true
  if (method !== 'action.run' && method !== 'action.batch') return false
  const tiers = (params as { tiers?: string[] }).tiers
  return !tiers || tiers.some((t) => t !== 'ax')
}

/** Before a posting call: one whole watch interval with nothing masked, then a look at the idle time. */
async function paceOwnInput(): Promise<void> {
  const due = ownInput.clearAt(WATCH_EVERY_MS)
  if (Date.now() < due) await sleep(due - Date.now())
  await currentWatch?.look()
}

/** The screen is unlocked, on this console, and the main display awake. */
async function screenAwake(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(PROBE_TOOL, ['screen'], { encoding: 'utf8', timeout: 5_000 })
    const screen = JSON.parse(stdout) as { locked: boolean; asleep: boolean }
    return !screen.locked && !screen.asleep
  } catch {
    return false
  }
}

/** Set when an idle stretch long enough for a try came while the Mac was locked or dark. */
let lockedGap = false

/** Until the Mac has had LAUNCH_IDLE_S with no input; false when that cannot come before `deadline`. */
async function awaitGap(deadline: number): Promise<boolean> {
  for (;;) {
    if (Date.now() >= deadline) return false
    const shortMs = (LAUNCH_IDLE_S - (await personIdleSecondsAsync())) * 1_000
    if (shortMs <= 0) {
      if (await screenAwake()) return true
      // locked or dark: AX sees no windows then; the idle time keeps growing, so look again later
      lockedGap = true
      await sleep(Math.min(30_000, Math.max(1_000, deadline - Date.now())))
      continue
    }
    if (Date.now() + shortMs > deadline) return false
    await sleep(Math.max(1_000, shortMs))
  }
}

/**
 * Reads the idle time and the screen every second from now on; `onStop` runs once, the first time the
 * person touched the Mac since (input inside the proof's own posting spans is its own), the screen locked
 * or went dark, or the run's `deadline` passed.
 */
function watchPerson(deadline: number, onStop: () => void): Watch {
  const since = Date.now()
  let fired: { at: number; why: 'input' | 'deadline' | 'locked' } | null = null
  const fire = (why: 'input' | 'deadline' | 'locked'): void => {
    if (fired) return
    fired = { at: Date.now(), why }
    onStop()
  }
  const look = async (): Promise<void> => {
    if (fired) return
    if (Date.now() > deadline) return fire('deadline')
    try {
      const [idle, awake] = await Promise.all([personIdleSecondsAsync(), screenAwake()])
      if (!UNGATED && personSince(Date.now(), idle, since, ownInput)) fire('input')
      else if (!awake) fire('locked')
    } catch {
      // the next look reads again
    }
  }
  let reading = false
  const timer = setInterval(() => {
    if (reading) return
    reading = true
    void look().finally(() => {
      reading = false
    })
  }, WATCH_EVERY_MS)
  return { stop: () => clearInterval(timer), fired: () => fired, look }
}

interface Watch {
  stop: () => void
  fired: () => { at: number; why: 'input' | 'deadline' | 'locked' } | null
  /** One read now, as the timer's: the pacing's unmasked look */
  look: () => Promise<void>
}
let currentWatch: Watch | null = null

/** The Xcode every Swift build here uses; the Command Line Tools' toolchain is unreliable on this Mac. */
function swiftEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.DEVELOPER_DIR
  try {
    const dir = execFileSync('sh', [join(ROOT, 'scripts/ios-xcode.sh')], {
      env: { ...process.env, TC_XCODE_MIN: '0' },
      encoding: 'utf8'
    }).trim()
    if (dir) env.DEVELOPER_DIR = dir
  } catch {
    // a toolchain on PATH may still build
  }
  return env
}

// ── what the Mac looks like from outside the service ────────────────────

function probe<T>(
  command: 'pointer' | 'frontmost' | 'pasteboard' | 'hide',
  args: string[] = [],
  timeoutMs = 10_000
): T {
  return JSON.parse(
    execFileSync(PROBE_TOOL, [command, ...args], { encoding: 'utf8', timeout: timeoutMs })
  ) as T
}

interface PersonState {
  frontmost: number
  pointer: { x: number; y: number }
  at: number
}
const personState = (): PersonState => ({
  frontmost: probe<{ pid: number }>('frontmost').pid,
  pointer: probe<{ x: number; y: number }>('pointer'),
  at: Date.now()
})

/**
 * The person's frontmost app and pointer are where they were. When either moved and the person
 * used the Mac since `before`, it was them, not the service: the check is inconclusive, not failed.
 * An app the step `launched` coming in front is a raise behind the launch gate: noted, not failed.
 */
function assertPersonUntouched(
  before: PersonState,
  when: string,
  launched?: number
): 'untouched' | 'person-active' | 'raised at launch' {
  const after = personState()
  const moved = Math.hypot(after.pointer.x - before.pointer.x, after.pointer.y - before.pointer.y)
  if (after.frontmost === before.frontmost && moved < 0.5) return 'untouched'
  if (personIdleSeconds() * 1_000 < Date.now() - before.at) return 'person-active'
  if (launched && after.frontmost === launched && moved < 0.5) return 'raised at launch'
  check(after.frontmost === before.frontmost, `${when}: the frontmost app changed`, {
    before: before.frontmost,
    after: after.frontmost
  })
  check(moved < 0.5, `${when}: the pointer moved`, { before: before.pointer, after: after.pointer })
  return 'untouched'
}

interface PasteboardCount {
  changeCount: number
}

// ── the service client ──────────────────────────────────────────────────

type Answer<M extends ComputerMethod> =
  { ok: true; result: ComputerResult<M> } | { ok: false; error: RpcError }
interface Pending {
  method: ComputerMethod
  settle: (answer: Answer<ComputerMethod>) => void
  fail: (error: Error) => void
}

const services: Service[] = []
const children: ChildProcess[] = []

/** One `tc-computer serve` over newline JSON-RPC on stdio; stderr appends to the trace. */
class Service {
  readonly proc: ChildProcess
  readonly notes: ComputerNotification[] = []
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  done = false
  private next = 1
  private readonly pending = new Map<number, Pending>()
  private gone: string | null = null

  constructor(
    readonly label: string,
    env: Record<string, string> = {}
  ) {
    appendFileSync(TRACE, `\n── ${label} service, ${new Date().toISOString()} ──\n`)
    const trace = openSync(TRACE, 'a')
    this.proc = spawn(BIN, ['serve'], {
      stdio: ['pipe', 'pipe', trace],
      env: { ...process.env, ...COMPUTER_PROOF_ENV, TEMP_CODE_COMPUTER_TRACE: '1', ...env }
    })
    closeSync(trace)
    services.push(this)
    this.proc.stdin!.on('error', () => {})
    this.exit = new Promise((resolve) => {
      this.proc.once('exit', (code, signal) => resolve({ code, signal }))
      this.proc.once('error', () => resolve({ code: null, signal: null }))
    })
    void this.exit.then(({ code, signal }) => {
      this.done = true
      this.failAll(`the ${label} service exited (${code ?? signal})`)
    })
    createInterface({ input: this.proc.stdout! }).on('line', (line) => this.onLine(line))
  }

  send<M extends ComputerMethod>(
    method: M,
    params: ComputerParams<M>,
    timeoutMs = 30_000
  ): { id: number; answer: Promise<Answer<M>> } {
    if (GATE && !policy.pictures) {
      const p = params as Record<string, unknown>
      if (method === 'state.get') params = { ...p, screenshot: 'never' } as ComputerParams<M>
      if (method === 'action.run' || method === 'action.batch') params = { ...p, observe: { ...((p.observe ?? {}) as object), screenshot: 'never' } } as ComputerParams<M>
    }
    if (GATE) policy.assertRequest(method, params)
    const id = this.next++
    const frame = { jsonrpc: '2.0' as const, id, method, params }
    // the proof's own requests are held to the wire too
    requestFrameSchema(method).parse(frame)
    if (this.gone) return { id, answer: Promise.reject(new Check(this.gone)) }
    const span = postsInput(method, params) ? ownInput.open(Date.now()) : null
    const answer = new Promise<Answer<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Check(`${method} got no answer in ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        settle: (a) => {
          clearTimeout(timer)
          resolve(a as Answer<M>)
        },
        fail: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
    })
    this.proc.stdin!.write(`${JSON.stringify(frame)}\n`)
    if (span)
      answer.then(
        () => void (span.to = Date.now()),
        () => void (span.to = Date.now())
      )
    return { id, answer }
  }

  /** The result, or a failed check naming the error. */
  async call<M extends ComputerMethod>(
    method: M,
    params: ComputerParams<M>,
    timeoutMs?: number
  ): Promise<ComputerResult<M>> {
    if (postsInput(method, params)) await paceOwnInput()
    const answer = await this.send(method, params, timeoutMs).answer
    if (!answer.ok)
      throw new Check(
        `${method} answered ${answer.error.data?.kind ?? answer.error.code}: ${answer.error.message}`
      )
    noteWaits(method, answer.result)
    return answer.result
  }

  /** The error `kind`, or a failed check naming what came instead. */
  async refused<M extends ComputerMethod>(
    method: M,
    params: ComputerParams<M>,
    kind: ComputerErrorKind
  ): Promise<RpcError> {
    if (postsInput(method, params)) await paceOwnInput()
    const answer = await this.send(method, params).answer
    check(!answer.ok, `${method} should answer ${kind}`, answer.ok ? answer.result : undefined)
    check(answer.error.data?.kind === kind, `${method} should answer ${kind}`, answer.error)
    return answer.error
  }

  cancel(id: number): void {
    const frame = HostNotificationSchema.parse({ method: '$/cancel', params: { id } })
    this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
  }

  async noteMatching(
    test: (n: ComputerNotification) => boolean,
    ms: number
  ): Promise<ComputerNotification | null> {
    const deadline = Date.now() + ms
    for (;;) {
      const found = this.notes.find(test)
      if (found || Date.now() > deadline) return found ?? null
      await sleep(50)
    }
  }

  closeStdin(): void {
    this.proc.stdin!.end()
  }

  private onLine(line: string): void {
    let frame: { id?: unknown; method?: unknown; result?: unknown; error?: unknown }
    try {
      frame = JSON.parse(line)
    } catch {
      return this.violate(`a stdout line that is not JSON: ${short(line)}`)
    }
    if (typeof frame.method === 'string' && frame.id === undefined) {
      const framing = NotificationFrameSchema.safeParse(frame)
      const note = ComputerNotificationSchema.safeParse(frame)
      if (!framing.success || !note.success)
        return this.violate(
          `a notification off the schema: ${short(line)} (${(note.error ?? framing.error)?.message})`
        )
      report.frames.notifications++
      this.notes.push(note.data)
      return
    }
    const pending = typeof frame.id === 'number' ? this.pending.get(frame.id) : undefined
    if (!pending) return this.violate(`a frame answering no request: ${short(line)}`)
    this.pending.delete(frame.id as number)
    report.frames.responses++
    if ('error' in frame) {
      const parsed = RpcErrorResponseSchema.safeParse(frame)
      if (!parsed.success)
        return this.violate(
          `an error off the schema: ${short(line)} (${parsed.error.message})`,
          pending
        )
      pending.settle({ ok: false, error: parsed.data.error })
      return
    }
    const parsed = resultFrameSchema(pending.method).safeParse(frame)
    if (!parsed.success)
      return this.violate(
        `a ${pending.method} result off the schema: ${short(line)} (${parsed.error.message})`,
        pending
      )
    pending.settle({ ok: true, result: parsed.data.result as ComputerResult<ComputerMethod> })
  }

  private violate(what: string, pending?: Pending): void {
    report.frames.violations.push(`${this.label}: ${what}`)
    pending?.fail(new Check(what))
  }

  private failAll(why: string): void {
    this.gone = why
    for (const p of this.pending.values()) p.fail(new Check(why))
    this.pending.clear()
  }
}

async function initialize(
  svc: Service,
  dataDir: string
): Promise<{ result: ComputerResult<'initialize'>; ms: number }> {
  mkdirSync(dataDir, { recursive: true })
  const t0 = performance.now()
  const result = await svc.call(
    'initialize',
    { protocol: COMPUTER_PROTOCOL, client: { name: 'e2e-tc-computer', version: '1' }, dataDir },
    5_000
  )
  const ms = Math.round(performance.now() - t0)
  report.initializeMs.push({ service: svc.label, ms })
  check(
    result.protocol === COMPUTER_PROTOCOL,
    `initialize answers protocol ${COMPUTER_PROTOCOL}`,
    result.protocol
  )
  return { result, ms }
}

/** `{"held":true}` from `tc-computer hold-lock`, then its exit code. */
function holdLock(
  which: 'clipboard' | 'session',
  ms: number
): { held: Promise<void>; exit: Promise<number | null> } {
  const child = spawn(BIN, ['hold-lock', which, String(ms)], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, ...COMPUTER_PROOF_ENV }
  })
  children.push(child)
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  const held = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Check('hold-lock did not hold the lock within 5 s')),
      5_000
    )
    createInterface({ input: child.stdout! }).once('line', (line) => {
      clearTimeout(timer)
      let said: { held?: unknown } = {}
      try {
        said = JSON.parse(line)
      } catch {
        // judged below
      }
      if (said.held === true) resolve()
      else reject(new Check(`hold-lock said ${short(line)}`))
    })
  })
  return { held, exit }
}

// ── reading observations ────────────────────────────────────────────────

type OkStep = Extract<StepResult, { status: 'ok' }>
type FailedStep = Extract<StepResult, { status: 'failed' }>

function okStep(step: StepResult): OkStep {
  check(step.status === 'ok', `step ${step.index} (${step.action}) should be ok`, step)
  return step
}

function failedStep(step: StepResult, kind: ComputerErrorKind): FailedStep {
  check(
    step.status === 'failed' && step.error.kind === kind,
    `step ${step.index} (${step.action}) should fail ${kind}`,
    step
  )
  return step
}

function elementLines(o: Observation): ElementLine[] {
  return parseObservation(o.text).lines.flatMap((l) => (l.type === 'element' ? [l] : []))
}

function findElement(o: Observation, what: string, test: (e: ElementLine) => boolean): ElementLine {
  const found = elementLines(o).find(test)
  check(found, `the observation has ${what}`, o.text)
  return found
}

/** A printed value's length in Unicode scalars, through the `…(+N chars)` a long value is cut with. */
function valueLength(value: string): number {
  const m = /…\(\+(\d+) chars\)$/.exec(value)
  return m ? [...value.slice(0, m.index)].length + Number(m[1]) : [...value].length
}

/** Pixel size from a JPEG's frame header or a PNG's IHDR. */
function imageSize(buf: Buffer, format: Shot['format']): { width: number; height: number } | null {
  if (format === 'png') {
    if (buf.readUInt32BE(0) !== 0x89504e47) return null
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null
  for (let at = 2; at + 9 < buf.length;) {
    if (buf[at] !== 0xff) return null
    const marker = buf[at + 1]
    const length = buf.readUInt16BE(at + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { width: buf.readUInt16BE(at + 7), height: buf.readUInt16BE(at + 5) }
    at += 2 + length
  }
  return null
}

function checkShotFile(shot: Shot): void {
  check(
    shot.path.startsWith(join(DATA, 'shots', SESSION)),
    'the shot lies under <dataDir>/shots/<session>',
    shot.path
  )
  check(existsSync(shot.path), 'the shot file exists', shot.path)
  const buf = readFileSync(shot.path)
  check(buf.length === shot.bytes, 'the shot is the size it says', {
    file: buf.length,
    said: shot.bytes
  })
  const size = imageSize(buf, shot.format)
  check(size, `the shot is a ${shot.format}`, shot.path)
  check(
    size.width === shot.width && size.height === shot.height,
    'the shot has the pixel size it says',
    { file: size, said: shot }
  )
}

const shotNumber = (path: string): number => Number(/^(\d+)-/.exec(basename(path))?.[1] ?? NaN)

// ── the run ─────────────────────────────────────────────────────────────

let probePid = 0
let textEditPid = 0
/** Set when the person came back during a try: every step and launch of that try stops. */
let tryAborted = false
/** Set when the proof stops before its steps: the one line it prints. */
let stopLine: string | null = null

async function run(): Promise<void> {
  if (GATE) await waitForGateBuild({ tree: ROOT, log: console.log })
  await waitForComputerProof(console.log)
  sweepComputerProofProcesses(console.log)
  const runStart = Date.now()
  ownsWork = true
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  writeFileSync(TRACE, '')
  report.macos = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()

  const setup = new Chain()
  await setup.step('build tc-computer', async (data) => {
    if (GATE) requireGateNative(ROOT)
    report.build = buildTcComputer({ root: ROOT, require: true })
    data.build = report.build
    check(existsSync(BIN), 'the binary is at resources/native/tc-computer', BIN)
  })
  await setup.step('build the probe app and the probe helper', async () => {
    const env = swiftEnv()
    const swiftc = (source: string, out: string): void => {
      execFileSync('xcrun', ['swiftc', '-O', '-o', out, join(ROOT, 'scripts/mac', source)], {
        env,
        stdio: 'pipe'
      })
    }
    swiftc('computer-proof-probe.swift', PROBE_TOOL)
    execFileSync('codesign', ['-s', '-', '--force', PROBE_TOOL], { stdio: 'pipe' })
    mkdirSync(join(PROBE_APP, 'Contents/MacOS'), { recursive: true })
    swiftc('computer-probe-app.swift', join(PROBE_APP, 'Contents/MacOS/TC Probe'))
    writeFileSync(join(PROBE_APP, 'Contents/Info.plist'), probeInfoPlist())
    execFileSync('codesign', ['-s', '-', '--force', PROBE_APP], { stdio: 'pipe' })
  })

  const first: { svc?: Service; permissions?: Permissions } = {}
  // Parallel publish proofs add load; hand runs keep the strict 500 ms bound.
  const initializeMs = computerInitializeMs(GATE)
  await setup.step(`initialize within ${initializeMs} ms`, async (data) => {
    const svc = (first.svc = new Service('first'))
    const { result, ms } = await initialize(svc, DATA)
    data.ms = ms
    data.epoch = result.epoch
    first.permissions = report.permissions = result.permissions
    check(ms <= initializeMs, `initialize answers within ${initializeMs} ms`, ms)
    await svc.call('session.open', { session: SESSION })
  })
  const a = first.svc
  const granted = first.permissions
  if (!a || !granted) return
  if (!granted.accessibility) {
    stopLine =
      'Accessibility is off for the session holder (TempCode.app from Publish): turn it on in System Settings › Privacy & Security › Accessibility, then run this again.'
    return
  }
  policy = computerProofPolicy(GATE, granted)
  const noPictures = granted.screenRecording ? null : 'Screen Recording is off for TempCode'

  // ── the two apps, under the launch rule ──
  // the first service has done its part; each try opens its own, so an aborted try leaves nothing running
  a.closeStdin()
  await within(a.exit, 2_000, 'the first service exiting')
  if (GATE && !(await screenAwake())) throw new Error('gate proof needs an unlocked, awake Mac')
  const deadline = runStart + (GATE ? 10 * 60_000 : GATE_WAIT_MS)
  for (let attempt = 1; ; attempt++) {
    if (!(await awaitGap(deadline))) {
      if (lostTry(GATE) === 'fail') throw new Error(LOST_TRY_LINE)
      record({
        name: 'the probe app and TextEdit',
        outcome: 'skipped',
        ms: 0,
        why: lockedGap ? NOT_RUN_LOCKED : NOT_RUN
      })
      break
    }
    const at = new Date().toISOString()
    const steps = report.steps.length
    const waits = report.waits.length
    const servicesFrom = services.length
    const t0 = Date.now()
    const abort = (): void => abortApps(servicesFrom)
    tryAborted = false
    const watch = (currentWatch = watchPerson(deadline, abort))
    try {
      await appSections(attempt, noPictures, abort)
      // the try counts only once the watch has had an interval past the last posting call with nothing masked
      await paceOwnInput()
    } finally {
      watch.stop()
      currentWatch = null
    }
    const fired = watch.fired()
    if (!fired && !tryAborted) {
      report.gate.push({ attempt, at, outcome: 'ran' })
      break
    }
    // the person came back (or the time ran out): this try's results go, and the next gap tries again
    report.steps.splice(steps)
    report.waits.splice(waits)
    report.gate.push({
      attempt,
      at,
      outcome: 'aborted',
      why: fired?.why ?? 'input',
      afterMs: (fired?.at ?? Date.now()) - t0
    })
    abortApps(servicesFrom)
    tryAborted = false
    if (lostTry(GATE) === 'fail') throw new Error(LOST_TRY_LINE)
  }

  await new Chain().step('every frame matched the schemas', async (data) => {
    data.frames = { responses: report.frames.responses, notifications: report.frames.notifications }
    check(!report.frames.violations.length, 'no frame off the schema', report.frames.violations)
  })
}

/** The scratch apps this run started, by what they run, whether or not their launch has answered yet. */
function ownedPids(): number[] {
  const find = (pattern: string): number[] => {
    try {
      return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map(Number)
    } catch {
      return []
    }
  }
  // `ps` names /tmp as /private/tmp, so the probe app is matched below the directory's own name
  return [...new Set([...find('tc-computer-proof/TC Probe.app/Contents/MacOS/'), ...find(RUN_MARK)])]
}

/** Hides then kills every scratch app the run started; the first half of an abort, and the last of the cleanup. */
function hideThenKillApps(): number[] {
  const pids = [...new Set([probePid, textEditPid, ...ownedPids()])].filter((p) => p && alive(p))
  for (const pid of pids)
    try {
      probe('hide', [String(pid)])
    } catch {
      // killed next either way
    }
  for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
  return pids
}

/** Stops the try: no step or launch of it runs from here, its apps are hidden and killed, its services killed. */
function abortApps(servicesFrom: number): void {
  tryAborted = true
  hideThenKillApps()
  for (const svc of services.slice(servicesFrom)) if (!svc.done) svc.proc.kill('SIGKILL')
}

const TITLE_BAR_NAMES = Object.values(SUBROLE_NAMES)
const PROBE_BUILD = { app: PROBE_APP, binary: join(PROBE_APP, 'Contents/MacOS/TC Probe'), bundleId: PROBE_BUNDLE_ID }

/** The window root's direct children in a whole read. */
function windowChildren(o: Observation): ElementLine[] {
  return elementLines(o).filter((e) => e.depth === 1)
}

/** §22.1: the title-bar buttons close the window's children, in one order, and no sharing badge is a line. */
function titleBarLast(o: Observation): ElementLine[] {
  const kids = windowChildren(o)
  const bar = kids.filter((e) => e.role === 'button' && TITLE_BAR_NAMES.includes(e.name ?? ''))
  check(bar.length && kids.slice(-bar.length).every((e, i) => e === bar[i]), 'the title-bar buttons are the window\'s last children', o.text)
  const order = bar.map((e) => TITLE_BAR_NAMES.indexOf(e.name!))
  check(order.every((n, i) => i === 0 || n > order[i - 1]), 'the title-bar buttons read close, minimize, full screen, zoom', bar)
  check(!o.text.includes('"Window sharing"'), 'no sharing badge line', o.text)
  return bar
}

/**
 * The window actions leg (§22), on a TC Probe launched with `--windows` and targeted by pid: its
 * windows never key, never active, the person's app and pointer checked after every act.
 */
async function windowLeg(a: Service, mayLaunch: () => void): Promise<void> {
  const leg = new Chain()
  let pid = 0
  const titles = { doc: 'TC Probe Doc', plain: 'TC Probe Plain', fixed: 'TC Probe Fixed' }
  const read = (title: string): Promise<Observation> =>
    a.call('state.get', { session: SESSION, app: { pid }, window: { title }, mode: 'full', wait: COMPUTER_WAIT.observe })
  const act = (o: Observation, action: Record<string, unknown>, tiers: ('ax' | 'process' | 'session')[]) =>
    a.call('action.run', { session: SESSION, app: { pid }, window: { id: o.window.id }, epoch: o.epoch, action, tiers, wait: COMPUTER_WAIT.action } as never)
  const frontmost = () => ({ pid: probe<{ pid: number }>('frontmost').pid, bundleId: null })

  await leg.step('windows: launch a TC Probe with --windows in the background', async (data) => {
    const before = personState()
    mayLaunch()
    pid = (await launchProbe(PROBE_BUILD, ['--windows'], frontmost)).pid
    data.pid = pid
    await until(async () => ((await a.call('apps.list', { windows: true })).apps.find((x) => x.pid === pid)?.windows?.length ?? 0) >= 4 || null, 10_000, 'four probe windows')
    data.person = assertPersonUntouched(before, 'after the launch', pid)
  })
  let doc: Observation | null = null
  await leg.step('windows 1: Doc read twice keeps its title-bar buttons last, the same numbers, no badge', async (data) => {
    const first = await read(titles.doc)
    const bar = titleBarLast(first)
    check(bar.some((e) => e.name === 'close') && bar.some((e) => e.name === 'minimize'), 'Doc has close and minimize', bar)
    await sleep(1_500)
    doc = await read(titles.doc)
    const again = titleBarLast(doc)
    check(JSON.stringify(again.map((e) => [e.index, e.name])) === JSON.stringify(bar.map((e) => [e.index, e.name])), 'the second read, under the watch, numbers them the same', { bar, again })
    data.buttons = again.map((e) => `[${e.index}] ${e.name}`)
  })
  await leg.step('windows 2: a process scroll Doc ignores reads none', async (data) => {
    const before = personState()
    const r = await act(doc!, { action: 'scroll', coordinate: intPoint(doc!.space.width / 2, doc!.space.height / 2), scroll_direction: 'down', scroll_amount: 1 }, ['process'])
    data.person = assertPersonUntouched(before, 'after the scroll')
    check(okStep(r.step).effect === 'none', 'the ignored scroll reads none, the watch\'s own badge no change', r.step)
  })
  await leg.step("windows 3: close Doc, Cancel its sheet, close again, Don't Save", async (data) => {
    const press = async (o: Observation, name: string, test: (e: ElementLine) => boolean) => {
      const e = findElement(o, name, test)
      const before = personState()
      const r = await act(o, { action: 'left_click', element: e.index }, ['ax'])
      data.person = assertPersonUntouched(before, `after ${name}`)
      check(okStep(r.step).tier === 'ax', `${name} ran at ax`, r.step)
      return r
    }
    const isClose = (e: ElementLine) => e.role === 'button' && e.name === 'close'
    let r = await press(doc!, 'the close button', isClose)
    check(r.observation, 'the close answers an observation', r.observationError)
    let now = r.observation!
    check(/\bsheet\b/.test(now.text) && now.text.includes('button "Don\'t Save"') && now.text.includes('button "Cancel"'), 'the close shows the save sheet', now.text)
    check(/button "close" disabled/.test(now.text), 'the close button reads disabled under the sheet', now.text)
    r = await press(now, 'Cancel', (e) => e.role === 'button' && e.name === 'Cancel')
    now = r.observation!
    check(now && !now.text.includes('"Don\'t Save"'), 'Cancel takes the sheet away', now?.text)
    now = await read(titles.doc)
    r = await press(now, 'the close button again', isClose)
    r = await press(r.observation!, "Don't Save", (e) => e.role === 'button' && e.name === "Don't Save")
    check(okStep(r.step).effect === 'changed', "Don't Save changed something", r.step)
    const listed = (await a.call('apps.list', { windows: true })).apps.find((x) => x.pid === pid)
    check(!listed?.windows?.some((w) => w.title === titles.doc), 'Doc is gone from apps.list', listed)
    check(r.observation, 'the closing observation reads the next window', r.observationError)
    check(r.observation.kind === 'full', 'the next window is read whole', r.observation.kind)
    check([titles.plain, titles.fixed].includes(r.observation.window.title), 'it is a standard window that survived', r.observation.window)
    check(r.observation.text.startsWith(`app "TC Probe" · window ${JSON.stringify(r.observation.window.title)}`), 'its header names it', r.observation.text)
    data.next = r.observation.window.title
  })
  await leg.step('windows 4: minimize Plain at ax; raise without the session tier is refused', async (data) => {
    const plain = await read(titles.plain)
    const root = elementLines(plain)[0]
    check(root?.role === 'window', 'Plain reads as a window', plain.text)
    const min = findElement(plain, 'the minimize button', (e) => e.role === 'button' && e.name === 'minimize')
    const before = personState()
    const r = await act(plain, { action: 'left_click', element: min.index }, ['ax'])
    data.person = assertPersonUntouched(before, 'after the minimize')
    const step = okStep(r.step)
    check(step.tier === 'ax' && step.effect === 'changed', 'minimize ran at ax and changed', step)
    check(r.observation?.text.includes(`~ [${root.index}] window "${titles.plain}" minimized`), 'the diff says the window is minimized', r.observation?.text)
    const raised = await act(r.observation!, { action: 'perform', element: root.index, name: 'raise' }, ['ax', 'process'])
    check(raised.step.status === 'failed' && raised.step.error.kind === 'needs_tier' && raised.step.error.needed === 'session', 'raise needs the session tier', raised.step)
    const listed = (await a.call('apps.list', { windows: true })).apps.find((x) => x.pid === pid)
    check(listed?.windows?.find((w) => w.title === titles.plain)?.minimized === true, 'Plain stays minimized', listed)
  })
  await leg.step('windows 5: Fixed has no close and no minimize', async () => {
    const fixed = await read(titles.fixed)
    check(!fixed.stats.partial && fixed.stats.omitted === 0, 'a whole read', fixed.stats)
    check(!windowChildren(fixed).some((e) => e.role === 'button' && (e.name === 'close' || e.name === 'minimize')), 'no close and no minimize line', fixed.text)
  })
  await leg.step('windows 6: end the --windows instance', async () => {
    process.kill(pid, 'SIGKILL')
    await until(() => (alive(pid) ? null : true), 5_000, 'the --windows probe exit')
    pid = 0
  })
  await leg.step('windows 7: a last window closed quits its app', async (data) => {
    const before = personState()
    mayLaunch()
    pid = (await launchProbe(PROBE_BUILD, [], frontmost)).pid
    data.launch = assertPersonUntouched(before, 'after the launch', pid)
    const o = await until(async () => (await a.call('apps.list', { windows: true })).apps.find((x) => x.pid === pid)?.windows?.length ? read('TC Probe') : null, 10_000, 'the third probe window')
    const close = findElement(o, 'the close button', (e) => e.role === 'button' && e.name === 'close')
    const r = await act(o, { action: 'left_click', element: close.index }, ['ax'])
    data.person = assertPersonUntouched(before, 'after the close')
    const step = okStep(r.step)
    check(step.tier === 'ax' && step.effect === 'changed', 'the close ran at ax and changed', step)
    check(r.observationError?.kind === 'window_not_found' && r.observationError.reason === 'gone', 'the closing observation says the window is gone', r.observationError)
    // the app may still be quitting when the wait ends: §22.6 names that "has no window open"
    check(/^TC Probe (quit|has no window open)\.$/.test(r.observationError.message), 'it says the app quit', r.observationError)
    data.said = r.observationError.message
    await until(() => (alive(pid) ? null : true), 5_000, 'the probe quitting on its last window')
    pid = 0
  })
  if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
}

/** One try at the probe app and the scratch TextEdit, on a service of its own. */
async function appSections(
  attempt: number,
  noPictures: string | null,
  abort: () => void
): Promise<void> {
  probePid = 0
  textEditPid = 0
  /** Right before a launch, after anything that blocks: the try still stands and the Mac has still had its five minutes, else the try stops. */
  const mayLaunch = (): void => {
    if (!tryAborted && personIdleSeconds() < LAUNCH_IDLE_S) abort()
    if (tryAborted) throw skip(ABORTED)
  }
  const opened: { svc?: Service } = {}
  await new Chain().step('a service for the apps', async () => {
    const svc = (opened.svc = new Service(`apps, try ${attempt}`))
    await initialize(svc, DATA)
    await svc.call('session.open', { session: SESSION })
  })
  const a = opened.svc
  if (!a || a.done) return

  // ── the probe app ──
  const probeApp = new Chain()
  let probeWindowId = 0
  let probeObservation: Observation | null = null

  await probeApp.step('apps.launch the probe app in the background', async (data) => {
    const before = personState()
    mayLaunch()
    const r = await a.call('apps.launch', { app: PROBE_APP }, 20_000)
    check(r.launched === true && r.pid > 0, 'apps.launch launches it and gives its pid', r)
    probePid = r.pid
    data.pid = r.pid
    data.person = assertPersonUntouched(before, 'after the launch', probePid)
  })
  await probeApp.step('apps.list shows the probe window', async (data) => {
    const app = await until(
      async () => {
        const r = await a.call('apps.list', { windows: true })
        const found = r.apps.find((x) => x.pid === probePid)
        return found?.windows?.some((w) => w.title === 'TC Probe') ? found : null
      },
      10_000,
      'probe window in apps.list'
    )
    check(app.bundleId === PROBE_BUNDLE_ID, 'apps.list names the probe app by its bundle id', app)
    const win = app.windows!.find((w) => w.title === 'TC Probe')!
    check(win.id !== 0, 'the probe window has a non-zero id', win)
    probeWindowId = data.windowId = win.id
  })
  for (const [by, app] of [
    ['bundle id', PROBE_BUNDLE_ID],
    ['name', 'TC Probe'],
    ['the prefix "TC Pro"', 'TC Pro']
  ] as const) {
    await probeApp.step(`state.get finds it by ${by}`, async () => {
      // by title, so these steps hold the app's match alone; the default window has a step of its own
      const o = await a.call('state.get', {
        session: SESSION,
        app: { app },
        window: { title: 'TC Probe' },
        mode: 'full',
        wait: COMPUTER_WAIT.observe
      })
      check(
        o.app.pid === probePid && o.window.id === probeWindowId,
        'state.get resolves the probe window',
        { app: o.app, window: o.window }
      )
      check(o.kind === 'full', 'a full read', o.kind)
      parseObservation(o.text)
      probeObservation = o
    })
  }
  await probeApp.step('state.get with no window follows §2.1', async (data) => {
    // never activated and never main or focused, the probe window is the default only if it is a standard
    // window; AppKit calls a window that cannot become main a dialog, which no default may be
    const root = elementLines(probeObservation!)[0]
    data.windowLine = root.role
    const answer = await a.send('state.get', {
      session: SESSION,
      app: { pid: probePid },
      mode: 'full',
      wait: COMPUTER_WAIT.observe
    }).answer
    if (answer.ok) {
      check(answer.result.window.id === probeWindowId, 'the default is the probe window', answer.result.window)
      return
    }
    // a dialog is no standard window, so it is no default: the only miss §2.1 allows
    check(answer.error.data?.kind === 'window_not_found', 'a miss answers window_not_found', answer.error)
    check(root.role === 'dialog', 'the default passed over a standard window', root)
    data.default = 'none: AppKit calls the probe window a dialog'
  })
  await probeApp.step('left_click on Ping at the ax tier', async (data) => {
    const read = probeObservation!
    const ping = findElement(
      read,
      'the button "Ping"',
      (e) => e.role === 'button' && e.name === 'Ping'
    )
    const before = personState()
    const r = await a.call('action.run', {
      session: SESSION,
      app: { pid: probePid },
      window: { id: probeWindowId },
      epoch: read.epoch,
      action: { action: 'left_click', element: ping.index },
      tiers: ['ax'],
      wait: COMPUTER_WAIT.action
    })
    data.person = assertPersonUntouched(before, 'after the click')
    const step = okStep(r.step)
    check(
      step.tier === 'ax' && step.effect === 'changed',
      'the click ran at ax and changed the window',
      step
    )
    check(r.observation, 'the click closes with an observation', r.observationError)
    check(r.observation.kind === 'diff', 'the observation is a diff', r.observation.kind)
    parseObservation(r.observation.text)
    check(r.observation.text.includes('"pong"'), 'the diff shows "pong"', r.observation.text)
    data.waited = step.waited
  })
  await probeApp.step('with every private symbol missed, the same window id', async () => {
    const miss = new Service('private-miss', { TC_COMPUTER_PRIVATE_MISS: 'all' })
    await initialize(miss, join(WORK, 'data-private-miss'))
    const r = await miss.call('apps.list', { windows: true })
    const win = r.apps.find((x) => x.pid === probePid)?.windows?.find((w) => w.title === 'TC Probe')
    check(win?.id === probeWindowId, 'the public fallback gives the probe window the same id', {
      want: probeWindowId,
      got: win
    })
    miss.closeStdin()
    const exit = await within(miss.exit, 2_000, 'the private-miss service exiting')
    check(exit.code === 0, 'the private-miss service exits 0', exit)
  })
  await windowLeg(a, mayLaunch)
  if (GATE) {
    for (const name of [
      'open a scratch TextEdit', 'TextEdit full read with geometry',
      'TextEdit set_value', 'TextEdit process-tier click',
      'a second clipboard holder', '2,500 characters through the pasteboard',
      'TextEdit screenshot and region capture', 'a batch stops at its failed step',
      'a batch of three good steps', 'an unchanged TextEdit read'
    ])
      record({ name, outcome: 'skipped', ms: 0, why: 'hand run: opens TextEdit or touches the clipboard' })
    await probeApp.step('TC Probe window screenshot', async () => {
      if (noPictures) throw skip(noPictures)
      const shot = await a.call('capture.screenshot', { session: SESSION, app: { pid: probePid }, window: { id: probeWindowId } })
      checkShotFile(shot)
      check(Math.max(shot.width, shot.height) <= SHOT.defaultMaxEdge, 'screenshot fits the default edge', shot)
    })
    await probeApp.step('TC Probe cancelled wait', async (data) => {
      const sent = a.send('action.run', { session: SESSION, app: { pid: probePid }, window: { id: probeWindowId }, action: { action: 'wait', duration: 5 }, tiers: ['ax'] })
      await sleep(300)
      const at = performance.now()
      a.cancel(sent.id)
      const answer = await sent.answer
      check(answer.ok, 'cancel answers a result', answer)
      failedStep(answer.result.step, 'cancelled')
      check(!answer.result.observation, 'no observation after cancel')
      data.ms = Math.round(performance.now() - at)
      check(Number(data.ms) <= 500, 'cancel ends within 500 ms', data.ms)
    })
    await probeApp.step('TC Probe crash with held input and restart', async () => {
      const target = { session: SESSION, app: { pid: probePid }, window: { id: probeWindowId } }
      const read = await a.call('state.get', { ...target, mode: 'full', geometry: true, screenshot: 'never' })
      const ping = findElement(read, 'Ping', (e) => e.role === 'button' && e.name === 'Ping')
      check(ping.frame, 'Ping has geometry', ping)
      const point = intPoint(ping.frame.x + ping.frame.w / 2, ping.frame.y + ping.frame.h / 2)
      okStep((await a.call('action.run', { ...target, action: { action: 'mouse_move', coordinate: point }, tiers: ['process'], observe: { mode: 'none' } })).step)
      check(okStep((await a.call('action.run', { ...target, action: { action: 'left_mouse_down' }, tiers: ['process'], observe: { mode: 'none' } })).step).tier === 'process', 'button held at process tier')
      a.proc.kill('SIGKILL')
      check((await within(a.exit, 2_000, 'crash')).signal === 'SIGKILL', 'service died by SIGKILL')
      const b = new Service('gate restarted')
      const { result } = await initialize(b, DATA)
      check(result.epoch !== read.epoch, 'restart changes epoch')
      check(await b.noteMatching((n) => n.method === 'log' && /releas/i.test(n.params.message), 3_000), 'restart releases held input')
      await b.refused('action.run', { ...target, action: { action: 'cursor_position' }, tiers: ['process'] }, 'unknown_session')
      await b.call('session.open', { session: SESSION })
      const stale = await b.refused('action.run', { ...target, epoch: read.epoch, action: { action: 'left_click', element: ping.index }, tiers: ['ax'] }, 'stale_element')
      check(stale.data?.reason === 'service-restarted', 'stale ref names restart', stale)
      b.closeStdin()
      check((await within(b.exit, 2_000, 'EOF')).code === 0, 'restarted service exits 0 on EOF')
    })
  }
  await probeApp.step('quit the probe app', async () => {
    process.kill(probePid, 'SIGTERM')
    await until(() => (alive(probePid) ? null : true), 5_000, 'probe app exit')
    probePid = 0
  })

  if (GATE) {
    if (!a.done) { a.closeStdin(); await within(a.exit, 2_000, 'gate service EOF') }
    return
  }

  // ── TextEdit ──
  const te = new Chain()
  let svcNow: Service = a
  const target = () => ({ session: SESSION, app: { pid: textEditPid } })
  let epoch = ''
  let area = 0
  let frame: LineFrame = { x: 0, y: 0, w: 0, h: 0 }
  let space: CoordinateSpace = { width: 1, height: 1, scale: 1 }
  let clickPoint = intPoint(0, 0)

  const areaLength = async (): Promise<number> => {
    const o = await a.call('state.get', {
      ...target(),
      epoch,
      element: area,
      wait: COMPUTER_WAIT.observe
    })
    const line = findElement(o, `the text area [${area}]`, (e) => e.index === area)
    return valueLength(line.value ?? '')
  }

  /** `clipboard.state` until quiet for QUIET_MS; null after QUIET_RETRIES more tries. */
  const quietClipboard = async (): Promise<ClipboardActivity | null> => {
    for (let ask = 0; ; ask++) {
      const state = await a.call('clipboard.state', {})
      if (Date.now() - Math.max(state.foreignChangeAt ?? 0, state.watchingSince) >= QUIET_MS)
        return state
      if (ask === QUIET_RETRIES) return null
      await sleep(QUIET_RETRY_MS)
    }
  }

  await te.step('open a scratch TextEdit in the background', async (data) => {
    // written for each try: an aborted try's TextEdit may have saved over it
    writeFileSync(RTF, `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Helvetica;}}\\f0\\fs24 ${PROBE_TEXT}\\par}\n`)
    const running = pidsOf('TextEdit')
    const person = personState()
    mayLaunch()
    // no restored windows, nothing added to Open Recent, and the run's mark for an abort to find it by
    execFileSync('open', [
      '-n',
      '-g',
      '-a',
      'TextEdit',
      RTF,
      '--args',
      '-ApplePersistenceIgnoreState',
      'YES',
      '-NSRecentDocumentsLimit',
      '0',
      '-TCProofRun',
      RUN_MARK
    ])
    textEditPid = await until(
      () => pidsOf('TextEdit').find((p) => !running.includes(p)) ?? null,
      15_000,
      'new TextEdit process'
    )
    data.pid = textEditPid
    await until(
      async () =>
        (await a.call('apps.list', { windows: true })).apps.find((x) => x.pid === textEditPid)
          ?.windows?.length
          ? true
          : null,
      15_000,
      'window of the scratch TextEdit'
    )
    data.person = assertPersonUntouched(person, 'after the launch', textEditPid)
  })
  await te.step('1. state.get full with geometry', async (data) => {
    const o = await a.call('state.get', {
      ...target(),
      mode: 'full',
      geometry: true,
      wait: COMPUTER_WAIT.observe
    })
    check(o.kind === 'full', 'a full read', o.kind)
    const line = findElement(
      o,
      'a text area holding the probe text',
      (e) => e.role === 'text area' && (e.value ?? '').includes(PROBE_TEXT)
    )
    check(line.frame, 'the text area carries its frame', o.text)
    epoch = o.epoch
    area = line.index
    frame = line.frame
    space = o.space
    report.textEditReadMs = data.readMs = o.stats.readMs
  })
  await te.step('2. set_value at the ax tier', async () => {
    const value = 'Line one of the proof\nLine two'
    const r = await a.call('action.run', {
      ...target(),
      epoch,
      action: { action: 'set_value', element: area, value },
      tiers: ['ax'],
      wait: COMPUTER_WAIT.action
    })
    const step = okStep(r.step)
    check(
      step.tier === 'ax' && step.effect === 'changed',
      'set_value ran at ax and changed the value',
      step
    )
    check(
      r.observation?.kind === 'diff',
      'the observation is a diff',
      r.observation ?? r.observationError
    )
    findElement(
      r.observation,
      `a ~ line for [${area}] with the new value`,
      (e) => e.marker === '~' && e.index === area && (e.value ?? '').startsWith('Line one')
    )
  })
  await te.step('3. left_click inside the text area at the process tier', async (data) => {
    // to the right of the first line's end, so the caret moves wherever set_value left it
    clickPoint = intPoint(
      frame.x + frame.w - 24 * space.scale,
      frame.y + 10 * space.scale
    )
    const before = personState()
    const r = await a.call('action.run', {
      ...target(),
      action: { action: 'left_click', coordinate: clickPoint },
      tiers: ['process'],
      wait: COMPUTER_WAIT.action
    })
    data.person = assertPersonUntouched(before, 'after the click')
    const step = okStep(r.step)
    check(step.tier === 'process', 'the click ran at the process tier', step)
    check(r.observation, 'the click closes with an observation', r.observationError)
    parseObservation(r.observation.text)
    // a background TextEdit ignores a left click at the process tier (§14.8, measured): a finding, not a failure
    const caret = elementLines(r.observation).some(
      (e) =>
        e.marker === '~' && e.index === area && (e.caret !== undefined || e.selection !== undefined)
    )
    data.caret = caret ? 'moved' : 'ignored: a background TextEdit takes no left click (§14.8)'
  })
  await te.step('4a. a second clipboard holder is refused', async (data) => {
    if (!(await quietClipboard())) throw skip(NOT_QUIET)
    // paced before the lock is held and the clock starts, so the call's own pacing is a look alone
    await paceOwnInput()
    const holder = holdLock('clipboard', 3_000)
    await holder.held
    const t0 = performance.now()
    const r = await a.call('action.run', {
      ...target(),
      epoch,
      action: { action: 'type', text: PASTE_TEXT, element: area },
      tiers: ['process'],
      wait: COMPUTER_WAIT.action,
      observe: { mode: 'none' }
    })
    const ms = (data.ms = Math.round(performance.now() - t0))
    failedStep(r.step, 'clipboard_busy')
    check(
      ms >= LOCKS.clipboardWaitMs - 300 && ms < 3_000,
      `clipboard_busy comes after about ${LOCKS.clipboardWaitMs} ms`,
      ms
    )
    const code = await within(holder.exit, 3_000, 'the lock holder exiting')
    check(code === 0, 'the lock holder exits 0', code)
  })
  await te.step('4b. 2,500 characters through the pasteboard', async (data) => {
    if (!(await quietClipboard())) throw skip(NOT_QUIET)
    const lengthBefore = await areaLength()
    const countBefore = probe<PasteboardCount>('pasteboard').changeCount
    await paceOwnInput()
    const noted = Date.now()
    const traceFrom = statSync(TRACE).size
    const r = await a.call('action.run', {
      ...target(),
      epoch,
      action: { action: 'type', text: PASTE_TEXT, element: area },
      tiers: ['process'],
      wait: COMPUTER_WAIT.action,
      observe: { mode: 'none' }
    })
    const step = okStep(r.step)
    check(step.input?.via === 'paste', 'the text went through the pasteboard', step.input)
    // Input's own snapshot of the pasteboard is the one read of its contents; a paste privacy prompt
    // would hold the step, so a paste that took seconds longer than its lock is recorded as likely
    const pasteMs = Date.now() - noted

    const trace = await until(
      () => {
        const text = readFileSync(TRACE).subarray(traceFrom).toString('utf8')
        return /lock clipboard released after \d+ms/.test(text) ? text : null
      },
      2_000,
      'clipboard lock release in the trace'
    )
    check(
      /lock clipboard taken after \d+ms/.test(trace),
      'the trace shows the clipboard lock taken',
      trace
    )
    const heldMs = Number(/lock clipboard released after (\d+)ms/.exec(trace)![1])
    data.lockHeldMs = heldMs
    check(
      heldMs < LOCKS.clipboardHoldMaxMs,
      `the clipboard lock is held under ${LOCKS.clipboardHoldMaxMs} ms`,
      heldMs
    )
    report.pastePrompt = {
      pasteMs,
      lockHeldMs: heldMs,
      raised: pasteMs - heldMs > 3_000 ? 'likely' : 'no'
    }

    // a background TextEdit ignores Command-V at the process tier (§14.8, measured): a finding, not a
    // failure; the lock and the clipboard's restore are what this step holds
    const lengthAfter = await areaLength()
    if (lengthAfter === lengthBefore)
      data.inserted = 'ignored: a background TextEdit takes no Command-V (§14.8)'
    else
      check(
        lengthAfter === lengthBefore + PASTE_TEXT.length,
        `the text grew by ${PASTE_TEXT.length}`,
        { lengthBefore, lengthAfter }
      )

    if (step.input.clipboard === 'kept-person-copy') {
      data.clipboard = 'kept-person-copy: the person copied during the paste'
    } else {
      check(
        step.input.clipboard === 'restored',
        'a paste says what became of the clipboard',
        step.input
      )
      // restored: the service's own word, with no foreign change since the paste began and the
      // count moved by the paste's write and its restore alone
      const state = await a.call('clipboard.state', {})
      const countAfter = probe<PasteboardCount>('pasteboard').changeCount
      data.changeCount = { before: countBefore, after: countAfter }
      if (state.foreignChangeAt !== null && state.foreignChangeAt > noted) {
        data.clipboard = 'restored; not judged: a foreign change came during the paste'
      } else {
        check(countAfter > countBefore, 'the paste wrote the pasteboard', data.changeCount)
        data.clipboard = 'restored, no foreign change'
      }
    }
  })
  await te.step('5. screenshot, then a region capture', async (data) => {
    if (noPictures) throw skip(noPictures)
    const r = await a.call('action.run', {
      ...target(),
      action: { action: 'screenshot' },
      tiers: ['ax'],
      wait: COMPUTER_WAIT.action
    })
    const step = okStep(r.step)
    check(step.shot, 'the screenshot step carries its shot', step)
    checkShotFile(step.shot)
    check(
      Math.max(step.shot.width, step.shot.height) <= SHOT.defaultMaxEdge,
      `the long edge is at most ${SHOT.defaultMaxEdge}`,
      step.shot
    )
    check(r.observation, 'the screenshot closes with an observation', r.observationError)
    const sp = r.observation.space
    check(
      sp.width === step.shot.width && sp.height === step.shot.height,
      "the observation's space is the shot's size",
      { space: sp, shot: step.shot }
    )
    const last = Math.max(
      shotNumber(step.shot.path),
      r.observation.shot ? shotNumber(r.observation.shot.path) : 0
    )
    const region: [number, number, number, number] = [
      ...intPoint(0, 0),
      ...intPoint(Math.min(400, step.shot.width), Math.min(300, step.shot.height))
    ]
    const shot = await a.call('capture.screenshot', { ...target(), region })
    checkShotFile(shot)
    check(shotNumber(shot.path) === last + 1, 'the region capture takes the next number', {
      last,
      path: shot.path
    })
    data.shots = [step.shot.path, shot.path].map((p) => basename(p))
  })
  await te.step('6a. a batch stops at its failed step', async (data) => {
    // the two tiers the person allows: `perform` runs at ax and fails on a name the element lacks
    const r = await a.call('action.batch', {
      ...target(),
      epoch,
      actions: [
        { action: 'type', text: 'abc' },
        { action: 'key', text: 'Left' },
        { action: 'perform', element: area, name: 'not-an-action' }
      ],
      tiers: ['ax', 'process'],
      stepWait: COMPUTER_WAIT.step,
      wait: COMPUTER_WAIT.action
    })
    check(r.steps.length === 3, 'three step results', r.steps)
    okStep(r.steps[0])
    okStep(r.steps[1])
    data.thirdStep = failedStep(r.steps[2], 'action_unsupported').error.kind
    check(r.observation, 'the batch closes with one observation', r.observationError)
  })
  await te.step('6b. a batch of three good steps', async () => {
    const r = await a.call('action.batch', {
      ...target(),
      actions: [
        { action: 'type', text: 'xyz' },
        { action: 'key', text: 'Left' },
        { action: 'key', text: 'Right' }
      ],
      tiers: ['process'],
      stepWait: COMPUTER_WAIT.step,
      wait: COMPUTER_WAIT.action
    })
    check(r.steps.length === 3, 'three step results', r.steps)
    r.steps.forEach(okStep)
  })
  await te.step('7. state.get with nothing done is unchanged', async () => {
    const o = await a.call('state.get', { ...target(), wait: COMPUTER_WAIT.observe })
    check(o.kind === 'unchanged', 'an unchanged read', o.text)
    parseObservation(o.text)
  })
  await te.step('8. a cancelled wait', async (data) => {
    const sent = a.send('action.run', {
      ...target(),
      action: { action: 'wait', duration: 5 },
      tiers: ['ax']
    })
    await sleep(300)
    const cancelledAt = performance.now()
    a.cancel(sent.id)
    const answer = await sent.answer
    const ms = (data.ms = Math.round(performance.now() - cancelledAt))
    check(answer.ok, 'a cancelled action answers its result', answer.ok ? undefined : answer.error)
    noteWaits('action.run', answer.result)
    failedStep(answer.result.step, 'cancelled')
    check(!answer.result.observation, 'no observation after a cancel', answer.result.observation)
    check(ms <= 500, 'the step ends within 500 ms of the cancel', ms)
  })
  await te.step('9. a crash with the button held, then a new service', async (data) => {
    await a.call('action.run', {
      ...target(),
      action: { action: 'mouse_move', coordinate: clickPoint },
      tiers: ['process'],
      observe: { mode: 'none' }
    })
    const down = await a.call('action.run', {
      ...target(),
      action: { action: 'left_mouse_down' },
      tiers: ['process'],
      observe: { mode: 'none' }
    })
    check(
      okStep(down.step).tier === 'process',
      'the button went down at the process tier',
      down.step
    )
    a.proc.kill('SIGKILL')
    const killed = await within(a.exit, 2_000, 'the killed service exiting')
    check(killed.signal === 'SIGKILL', 'the service died of SIGKILL', killed)

    const b = new Service('restarted')
    svcNow = b
    const { result } = await initialize(b, DATA)
    check(result.epoch !== epoch, 'the new service has a new epoch', {
      old: epoch,
      now: result.epoch
    })
    const released = await b.noteMatching(
      (n) => n.method === 'log' && n.params.level === 'info' && /releas/i.test(n.params.message),
      3_000
    )
    check(released, 'a log notification reports the released input', b.notes)
    data.log = released.params

    await b.refused(
      'action.run',
      { ...target(), action: { action: 'cursor_position' }, tiers: ['process'] },
      'unknown_session'
    )
    await b.call('session.open', { session: SESSION })
    const stale = await b.refused(
      'action.run',
      {
        ...target(),
        epoch,
        action: { action: 'set_value', element: area, value: 'stale' },
        tiers: ['ax']
      },
      'stale_element'
    )
    check(stale.data?.reason === 'service-restarted', 'stale_element says service-restarted', stale)
  })
  await te.step('10. stdin closed: exit 0 within 2 s', async () => {
    svcNow.closeStdin()
    const exit = await within(svcNow.exit, 2_000, 'the service exiting on EOF')
    check(exit.code === 0, 'the service exits 0', exit)
  })

}

function probeInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${PROBE_BUNDLE_ID}</string>
  <key>CFBundleName</key><string>TC Probe</string>
  <key>CFBundleDisplayName</key><string>TC Probe</string>
  <key>CFBundleExecutable</key><string>TC Probe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`
}

/** Everything the run made, but the report and the trace. Never a prompt: TextEdit dies by SIGKILL. */
async function cleanup(): Promise<void> {
  if (!ownsWork) return
  const done = (what: string): void => void report.cleanup.push(what)
  await Promise.allSettled(services.filter((svc) => !svc.done).map(async (svc) => {
    try {
      svc.closeStdin()
      await within(svc.exit, 2_000, `the ${svc.label} service exiting in cleanup`)
      done(`closed the ${svc.label} service`)
    } catch {
      svc.proc.kill('SIGKILL')
      await within(svc.exit, 2_000, `the killed ${svc.label} service exiting`)
      done(`SIGKILL the ${svc.label} service`)
    }
  }))
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      done('SIGKILL a lock holder')
    }
  if (textEditPid && alive(textEditPid)) {
    process.kill(textEditPid, 'SIGKILL')
    done(`SIGKILL TextEdit ${textEditPid}`)
  }
  report.cleanup.push(...cleanupProbeApp({ app: PROBE_APP, binary: join(PROBE_APP, 'Contents/MacOS/TC Probe'), bundleId: PROBE_BUNDLE_ID }, probePid))
  probePid = 0
  for (const pid of hideThenKillApps()) done(`hid and killed scratch app ${pid}`)
  if (existsSync(WORK))
    for (const entry of readdirSync(WORK))
      if (!KEEP.has(entry)) rmSync(join(WORK, entry), { recursive: true, force: true })
}

process.once('exit', () => {
  if (!ownsWork) return
  for (const pid of ownedPids()) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  for (const svc of services) if (!svc.done) svc.proc.kill('SIGKILL')
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  stopLine = `gate proof received ${signal}`
  void cleanup().finally(() => process.exit(1))
})

let crashed: unknown = null
try {
  await run()
} catch (error) {
  crashed = error
} finally {
  await cleanup()
}
report.finishedAt = new Date().toISOString()
report.skipped = report.steps.flatMap((s) =>
  s.outcome === 'skipped' && s.why ? [{ name: s.name, why: s.why }] : []
)
report.stopped =
  stopLine ??
  (crashed
    ? `the proof itself failed: ${crashed instanceof Error ? (crashed.stack ?? crashed.message) : String(crashed)}`
    : null)
if (!ownsWork) {
  console.error(report.stopped ?? 'proof stopped before taking its turn')
  process.exit(1)
}
mkdirSync(WORK, { recursive: true })
writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`)

if (stopLine) {
  console.log(stopLine)
  process.exit(1)
}
for (const s of report.steps) {
  if (s.outcome === 'passed') console.log(`✓ ${s.name} ${s.ms}ms`)
  else if (s.outcome === 'failed') console.log(`✗ ${s.name}: ${s.why}`)
  else console.log(`– ${s.name} skipped: ${s.why}`)
}
if (report.stopped) console.log(report.stopped)
console.log(`report: ${REPORT}`)
process.exit(report.stopped || report.steps.some((s) => s.outcome === 'failed') ? 1 : 0)
