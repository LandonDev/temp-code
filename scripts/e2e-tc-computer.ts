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
 *  - a scratch TextEdit, its own process opened with `open -n -g` and
 *    targeted by that pid alone: a full read, set_value, a process-tier
 *    click, the clipboard lock and a 2,500-character paste, a screenshot,
 *    batches, an unchanged read, a cancelled wait, a crash with the button
 *    held and the restart that releases it, and a clean exit on stdin EOF.
 *
 * Nothing here activates an app or takes the session tier: every action
 * runs with the `ax` and `process` tiers alone. A launched app may still come
 * in front whatever `-g` says, so the two apps run under the person's launch
 * rule: they start only once the Mac has had 5 minutes with no input, the
 * idle time is read every second while they run, and the moment the person
 * touches the Mac they are hidden and killed and that attempt's results
 * dropped; the next 5-minute gap tries again, up to 90 minutes in all, and
 * what never got a gap is reported "not run: the person was at the Mac". A
 * raise at launch behind that gate is noted, not failed. The paste waits until the
 * person has not copied for 5 s, and the proof never reads the pasteboard's
 * contents itself (only its change count), so it raises no paste prompt. It
 * asks for no permission. A check that the person's pointer and app stayed
 * put reads as inconclusive, not failed, when the person used the Mac during
 * the step. Everything it made goes in the `finally`, but report.json and
 * trace.log under /tmp/tc-computer-proof.
 *
 * Run on the Mac: bun run script:e2e-tc-computer
 */
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
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  type ElementLine,
  type LineFrame,
  parseObservation
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
import { buildTcComputer, type TcComputerBuildResult } from './lib/tcComputerBuild'

if (process.platform !== 'darwin') {
  console.log('skipped: macOS only')
  process.exit(0)
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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
/** The launch rule: no input this long before an app starts, the idle time read this often while it runs. */
const LAUNCH_IDLE_S = 300
const WATCH_EVERY_MS = 1_000
/** How long the proof waits in all for a gap. */
const GATE_WAIT_MS = 90 * 60_000
const NOT_RUN = 'not run: the person was at the Mac'
const ABORTED = 'aborted: the person came back'
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
  /** Each try at the two apps: run whole, or aborted when the person touched the Mac. */
  gate: [] as {
    attempt: number
    at: string
    outcome: 'ran' | 'aborted'
    why?: 'input' | 'deadline'
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

/** Until the Mac has had LAUNCH_IDLE_S with no input; false when that cannot come before `deadline`. */
async function awaitGap(deadline: number): Promise<boolean> {
  for (;;) {
    if (Date.now() >= deadline) return false
    const shortMs = (LAUNCH_IDLE_S - (await personIdleSecondsAsync())) * 1_000
    if (shortMs <= 0) return true
    if (Date.now() + shortMs > deadline) return false
    await sleep(Math.max(1_000, shortMs))
  }
}

/**
 * Reads the idle time every second from now on; `onStop` runs once, the first time the person touched
 * the Mac since, or once the run's `deadline` passes.
 */
function watchPerson(
  deadline: number,
  onStop: () => void
): { stop: () => void; fired: () => { at: number; why: 'input' | 'deadline' } | null } {
  const since = Date.now()
  let fired: { at: number; why: 'input' | 'deadline' } | null = null
  let reading = false
  const fire = (why: 'input' | 'deadline'): void => {
    if (fired) return
    fired = { at: Date.now(), why }
    onStop()
  }
  const timer = setInterval(() => {
    if (reading || fired) return
    if (Date.now() > deadline) return fire('deadline')
    reading = true
    personIdleSecondsAsync()
      .then((idle) => {
        if (Date.now() - idle * 1_000 > since) fire('input')
      })
      .catch(() => {})
      .finally(() => {
        reading = false
      })
  }, WATCH_EVERY_MS)
  return { stop: () => clearInterval(timer), fired: () => fired }
}

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
      env: { ...process.env, TEMP_CODE_COMPUTER_TRACE: '1', ...env }
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
    const id = this.next++
    const frame = { jsonrpc: '2.0' as const, id, method, params }
    // the proof's own requests are held to the wire too
    requestFrameSchema(method).parse(frame)
    if (this.gone) return { id, answer: Promise.reject(new Check(this.gone)) }
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
    return { id, answer }
  }

  /** The result, or a failed check naming the error. */
  async call<M extends ComputerMethod>(
    method: M,
    params: ComputerParams<M>,
    timeoutMs?: number
  ): Promise<ComputerResult<M>> {
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
    stdio: ['ignore', 'pipe', 'ignore']
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
  const runStart = Date.now()
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  writeFileSync(TRACE, '')
  report.macos = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()

  const setup = new Chain()
  await setup.step('build tc-computer', async (data) => {
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
    mkdirSync(join(PROBE_APP, 'Contents/MacOS'), { recursive: true })
    swiftc('computer-probe-app.swift', join(PROBE_APP, 'Contents/MacOS/TC Probe'))
    writeFileSync(join(PROBE_APP, 'Contents/Info.plist'), probeInfoPlist())
    execFileSync('codesign', ['-s', '-', '--force', PROBE_APP], { stdio: 'pipe' })
  })

  const first: { svc?: Service; permissions?: Permissions } = {}
  await setup.step('initialize within 500 ms', async (data) => {
    const svc = (first.svc = new Service('first'))
    const { result, ms } = await initialize(svc, DATA)
    data.ms = ms
    data.epoch = result.epoch
    first.permissions = report.permissions = result.permissions
    check(ms <= 500, 'initialize answers within 500 ms', ms)
    await svc.call('session.open', { session: SESSION })
  })
  const a = first.svc
  const granted = first.permissions
  if (!a || !granted) return
  if (!granted.accessibility) {
    stopLine =
      'Accessibility is off for TempCode: turn it on in System Settings › Privacy & Security › Accessibility, then run this again.'
    return
  }
  const noPictures = granted.screenRecording ? null : 'Screen Recording is off for TempCode'

  // ── the two apps, under the launch rule ──
  // the first service has done its part; each try opens its own, so an aborted try leaves nothing running
  a.closeStdin()
  await within(a.exit, 2_000, 'the first service exiting')
  const deadline = runStart + GATE_WAIT_MS
  for (let attempt = 1; ; attempt++) {
    if (!(await awaitGap(deadline))) {
      record({ name: 'the probe app and TextEdit', outcome: 'skipped', ms: 0, why: NOT_RUN })
      break
    }
    const at = new Date().toISOString()
    const steps = report.steps.length
    const waits = report.waits.length
    const servicesFrom = services.length
    const t0 = Date.now()
    const abort = (): void => abortApps(servicesFrom)
    tryAborted = false
    const watch = watchPerson(deadline, abort)
    try {
      await appSections(attempt, noPictures, abort)
    } finally {
      watch.stop()
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
  await probeApp.step('state.get with no window takes the first standard window (§2.1)', async (data) => {
    // never activated, the probe window is neither main nor focused: the standard-window fallback must find it
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
  await probeApp.step('quit the probe app', async () => {
    process.kill(probePid, 'SIGTERM')
    await until(() => (alive(probePid) ? null : true), 5_000, 'probe app exit')
    probePid = 0
  })

  // ── TextEdit ──
  const te = new Chain()
  let svcNow: Service = a
  const target = () => ({ session: SESSION, app: { pid: textEditPid } })
  let epoch = ''
  let area = 0
  let frame: LineFrame = { x: 0, y: 0, w: 0, h: 0 }
  let space: CoordinateSpace = { width: 1, height: 1, scale: 1 }
  let clickPoint: [number, number] = [0, 0]

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
    clickPoint = [
      frame.x + frame.w - Math.round(24 * space.scale),
      frame.y + Math.round(10 * space.scale)
    ]
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
    check(
      r.observation?.kind === 'diff',
      'the observation is a diff',
      r.observation ?? r.observationError
    )
    findElement(
      r.observation,
      `a ~ line for [${area}] with the caret`,
      (e) =>
        e.marker === '~' && e.index === area && (e.caret !== undefined || e.selection !== undefined)
    )
  })
  await te.step('4a. a second clipboard holder is refused', async (data) => {
    if (!(await quietClipboard())) throw skip(NOT_QUIET)
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

    const lengthAfter = await areaLength()
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
      0,
      0,
      Math.min(400, step.shot.width),
      Math.min(300, step.shot.height)
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
  const done = (what: string): void => void report.cleanup.push(what)
  if (textEditPid && alive(textEditPid)) {
    process.kill(textEditPid, 'SIGKILL')
    done(`SIGKILL TextEdit ${textEditPid}`)
  }
  if (probePid && alive(probePid)) {
    process.kill(probePid, 'SIGTERM')
    done(`SIGTERM the probe app ${probePid}`)
    const deadline = Date.now() + 3_000
    while (alive(probePid) && Date.now() < deadline) await sleep(100)
    if (alive(probePid)) process.kill(probePid, 'SIGKILL')
  }
  for (const pid of hideThenKillApps()) done(`hid and killed scratch app ${pid}`)
  for (const svc of services)
    if (!svc.done) {
      svc.proc.kill('SIGKILL')
      done(`SIGKILL the ${svc.label} service`)
    }
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      done('SIGKILL a lock holder')
    }
  if (existsSync(PROBE_APP)) {
    try {
      execFileSync(
        '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
        ['-u', PROBE_APP],
        { stdio: 'ignore' }
      )
      done('unregistered the probe app from Launch Services')
    } catch {
      // nothing registered
    }
  }
  const savedState = join(
    homedir(),
    'Library/Saved Application State',
    `${PROBE_BUNDLE_ID}.savedState`
  )
  if (existsSync(savedState)) {
    rmSync(savedState, { recursive: true, force: true })
    done('removed the probe app saved state')
  }
  if (existsSync(WORK))
    for (const entry of readdirSync(WORK))
      if (!KEEP.has(entry)) rmSync(join(WORK, entry), { recursive: true, force: true })
}

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
