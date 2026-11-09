/**
 * The computer task set: the comparison's tasks (scripts/compare-computer-words.ts)
 * and the benchmark's (scripts/e2e-computer-bench.ts). Each task starts on
 * scratch content, asks in the person's words, and checks the end state
 * through the runner's own computer session, the files or `defaults`, never
 * the model's word (scripts/lib/benchChecks.ts). The Chrome tasks run on
 * src/main/server/computer/fixtures/page/bench.html, whose orders come from
 * seededOrders, the same code the page runs.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ParsedObservation, ObservationLine } from '../../src/shared/computer/observation'
import {
  SAVE_TARGET_OLD,
  SYSTEM_SETTINGS,
  checkDevAddon,
  checkSaveCopy,
  devAddonName,
  devDatabase,
  feedbackReads,
  isAppRunning,
  otherFeedback,
  readFeedbackSetting,
  saveSourceText,
  saveTargetName,
  spotlightNamed,
  straysUnder,
  writeFeedback,
  writeRtf,
  type Exec,
  DEV_ADDON_URL
} from './benchChecks'

export type TaskId = 'textedit-write' | 'chrome-read' | 'chrome-form' | 'chrome-delete' | 'devapp-form' | 'settings-toggle' | 'save-dialog'
export type TaskApp = 'TextEdit' | 'Google Chrome' | 'Electron' | 'System Settings'

export interface TaskContext {
  /** a fresh word that names the run's window */
  nonce: string
  /** bench.html's orders for this run */
  seed: number
  /** a scratch directory for the run's files */
  dir: string
  /** bench.html as a file URL */
  benchUrl: string
  writeFile(path: string, text: string): Promise<void>
  /** opens a file or URL in the app in the background, as the runner launches it; resolves once its window is listed */
  open(app: TaskApp, target: string): Promise<void>
  /** commands: defaults, textutil, osascript, mdfind */
  run: Exec
  home: string
  /** a fresh isolated TempCode preview instance, its window inactive, pinned as Electron; the bench's alone */
  devInstance?(): Promise<DevInstance | { skip: string }>
}

export interface DevInstance {
  userData: string
  /** the instance's window title */
  window: string
  stop(): Promise<void>
}

export interface TaskStart {
  app: TaskApp
  /** a part of the window's title that names it alone */
  window: string
  nonce: string
  seed: number
  /** chrome-delete: the order to delete */
  orderId?: string
  /** settings-toggle: the switch's value at the start, and the key as it was (null: never set), which teardown puts back */
  toggle?: { value: number; setting: number | null }
  /** save-dialog: the two scratch files and the source's bytes */
  saveDialog?: { source: string; target: string; sourceBytes: Buffer; home: string }
  /** devapp-form: the instance's database and its stop */
  dev?: { database: string; stop(): Promise<void> }
}

export interface TaskReader {
  /** the window's whole tree, through the runner's own computer session */
  read(app: TaskApp, window: string): Promise<ParsedObservation>
  /** one element's subtree with its values whole */
  element(app: TaskApp, window: string, index: number): Promise<ParsedObservation>
  /** the reads that are no AX tree: defaults, textutil, Spotlight */
  exec: Exec
}

/** A computer call the thread made, with the text its result carried. */
export interface CallRecord {
  name: string
  input: Record<string, unknown>
  result: string
}

export interface CheckResult {
  ok: boolean
  detail: string
}

export interface ComputerTask {
  id: TaskId
  app: TaskApp
  /** bumped whenever the start, the message or the check changes: a baseline row of another version is ignored */
  version: number
  /** 'background': doable in the ax and process tiers; 'session': needs the session tier, left out of the gate run */
  tier: 'background' | 'session'
  /** a Mac-wide app every lane shares: runs of it take the bench's lock, one at a time */
  shared?: 'system-settings' | 'dev-instance'
  /** scratch content for one run: a fresh document or a fresh page with a new seed; or why it cannot run now */
  setup(ctx: TaskContext): Promise<TaskStart | { skip: string }>
  /** the person's message, naming the window by its scratch title */
  prompt(start: TaskStart): string
  /** a second turn in the same thread: `check` runs once the first turn settles, then `message` is sent */
  then?: { check(start: TaskStart, read: TaskReader): Promise<CheckResult>; message: string }
  /** the end state after the last turn, read through the runner's own session; the reply only where the task asks for one */
  check(start: TaskStart, read: TaskReader, reply: string, calls: readonly CallRecord[]): Promise<CheckResult>
  /** what the run must have done through our tools; the Codex reference, whose tools have no such field, skips it */
  policy?(start: TaskStart, calls: readonly CallRecord[]): CheckResult
  /** always, after the check: put back what the run changed outside its scratch folder */
  teardown?(start: TaskStart, run: Exec): Promise<void>
  /** computer tool calls past which the run counts as failed, over every turn */
  stepBudget: number
  wallMs: number
}

/** Every message ends with it: the comparison measures the computer tools and nothing else. */
export const COMPUTER_ONLY_LINE = 'Use only the computer tools for this task.'
export const TASK_WALL_MS = 360_000
export const BENCH_ORDERS = 60

// ── bench.html's orders ─────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** The page's 60 orders for a seed, in list order. */
export function seededOrders(seed: number): { id: string; price: string }[] {
  const r = mulberry32(seed)
  const out: { id: string; price: string }[] = []
  const seen = new Set<string>()
  while (out.length < BENCH_ORDERS) {
    let id = ''
    for (let i = 0; i < 4; i++) id += ID_ALPHABET[Math.floor(r() * ID_ALPHABET.length)]
    const price = ((100 + Math.floor(r() * 9900)) / 100).toFixed(2)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, price })
  }
  return out
}

export const benchWindow = (nonce: string): string => `TempCode bench ${nonce}`
export const benchUrl = (base: string, seed: number, nonce: string): string => `${base}#seed=${seed}&name=${nonce}`
/** chrome-delete's order: one in the first half of the list, by the seed. */
export const deleteTarget = (seed: number): string => seededOrders(seed)[12 + (seed % 20)].id
export const FORM_STATUS = 'Submitted: Ana Ruiz, ana@example.com, L, gift, express'

// ── reading the end state ───────────────────────────────────────────────

type Element = Extract<ObservationLine, { type: 'element' }>
const elements = (o: ParsedObservation): Element[] => o.lines.filter((l): l is Element => l.type === 'element')

/** The page's status line: the status element's name or value, else the text right under it. */
export function statusText(o: ParsedObservation): string | null {
  const lines = o.lines
  const i = lines.findIndex((l) => l.type === 'element' && l.role === 'status')
  if (i < 0) return null
  const s = lines[i] as Element
  const own = s.value ?? s.name
  if (own) return own
  const child = lines[i + 1]
  return child?.type === 'element' && child.depth > s.depth ? (child.name ?? child.value ?? '') : ''
}

/** How many orders the page lists, from its own count line ("60 orders"). */
export function orderCount(o: ParsedObservation): number | null {
  for (const e of elements(o)) {
    const m = /^(\d+) orders$/.exec(e.name ?? e.value ?? '')
    if (m) return Number(m[1])
  }
  return null
}

const hasOrder = (o: ParsedObservation, id: string): boolean => elements(o).some((e) => (e.name ?? '').includes(`order ${id}`) || (e.name ?? '').includes(`Order ${id}`))

/** Did a call before the row went, or the one that took it, carry confirm.kind "delete"? */
export function flaggedBeforeDelete(calls: readonly CallRecord[], orderId: string): CheckResult {
  const flagged = (c: CallRecord): boolean => (c.input.confirm as { kind?: string } | undefined)?.kind === 'delete'
  const went = calls.findIndex((c) => c.result.includes(`Deleted ${orderId}`))
  const upTo = went < 0 ? calls : calls.slice(0, went + 1)
  if (upTo.some(flagged)) return { ok: true, detail: 'flagged delete' }
  return { ok: false, detail: went < 0 ? 'no call carried confirm.kind "delete"' : `the delete ran unflagged (call ${went + 1})` }
}

// ── the tasks ───────────────────────────────────────────────────────────

const withRule = (message: string): string => `${message} ${COMPUTER_ONLY_LINE}`

const chromeSetup = async (ctx: TaskContext): Promise<TaskStart> => {
  await ctx.open('Google Chrome', benchUrl(ctx.benchUrl, ctx.seed, ctx.nonce))
  return { app: 'Google Chrome', window: benchWindow(ctx.nonce), nonce: ctx.nonce, seed: ctx.seed }
}

export const COMPUTER_TASKS: ComputerTask[] = [
  {
    id: 'textedit-write',
    version: 1,
    tier: 'background',
    app: 'TextEdit',
    stepBudget: 6,
    wallMs: TASK_WALL_MS,
    async setup(ctx) {
      const path = `${ctx.dir}/${ctx.nonce}.rtf`
      await ctx.writeFile(path, '{\\rtf1\\ansi Probe line one\\par Probe line two\\par}')
      await ctx.open('TextEdit', path)
      return { app: 'TextEdit', window: ctx.nonce, nonce: ctx.nonce, seed: ctx.seed }
    },
    prompt: (s) => withRule(`Replace the whole text of TextEdit's window "${s.window}" with: Hello from TempCode ${s.nonce}`),
    async check(s, read) {
      const tree = await read.read('TextEdit', s.window)
      const area = elements(tree).find((e) => e.role === 'text area')
      if (!area) return { ok: false, detail: 'no text area in the window' }
      const whole = elements(await read.element('TextEdit', s.window, area.index)).find((e) => e.index === area.index)
      const value = (whole?.value ?? '').replace(/\n$/, '')
      const want = `Hello from TempCode ${s.nonce}`
      return value === want ? { ok: true, detail: 'text replaced' } : { ok: false, detail: `the text area holds ${JSON.stringify(value.slice(0, 80))}` }
    }
  },
  {
    id: 'chrome-read',
    version: 1,
    tier: 'background',
    app: 'Google Chrome',
    stepBudget: 8,
    wallMs: TASK_WALL_MS,
    setup: chromeSetup,
    prompt: (s) =>
      withRule(`In Chrome's window "${s.window}", what is the price of the 47th order in the Past orders list? Answer with the price alone.`),
    async check(s, read, reply) {
      const price = seededOrders(s.seed)[46].price
      if (!reply.includes(price)) return { ok: false, detail: `the reply lacks ${price}` }
      const tree = await read.read('Google Chrome', s.window)
      const status = statusText(tree)
      const count = orderCount(tree)
      return status || count !== BENCH_ORDERS ? { ok: false, detail: `the page changed: ${status ?? ''} ${count ?? '?'} orders` } : { ok: true, detail: price }
    }
  },
  {
    id: 'chrome-form',
    version: 1,
    tier: 'background',
    app: 'Google Chrome',
    stepBudget: 10,
    wallMs: TASK_WALL_MS,
    setup: chromeSetup,
    prompt: (s) =>
      withRule(
        `Fill the order form in Chrome's window "${s.window}": name Ana Ruiz, email ana@example.com, size Large, gift wrap on, delivery Express, then submit. It is a local test page; submitting sends nothing.`
      ),
    async check(s, read) {
      const status = statusText(await read.read('Google Chrome', s.window))
      return status === FORM_STATUS ? { ok: true, detail: 'submitted' } : { ok: false, detail: `status ${JSON.stringify(status)}` }
    }
  },
  {
    id: 'chrome-delete',
    version: 1,
    tier: 'background',
    app: 'Google Chrome',
    stepBudget: 6,
    wallMs: TASK_WALL_MS,
    async setup(ctx) {
      return { ...(await chromeSetup(ctx)), orderId: deleteTarget(ctx.seed) }
    },
    prompt: (s) => withRule(`Delete order ${s.orderId} from the Past orders list in Chrome's window "${s.window}".`),
    async check(s, read) {
      const id = s.orderId!
      const tree = await read.read('Google Chrome', s.window)
      const status = statusText(tree)
      if (status !== `Deleted ${id}`) return { ok: false, detail: `status ${JSON.stringify(status)}` }
      if (hasOrder(tree, id) || orderCount(tree) !== BENCH_ORDERS - 1) return { ok: false, detail: 'the row is still listed, or another went' }
      return { ok: true, detail: `deleted ${id}` }
    },
    policy: (s, calls) => flaggedBeforeDelete(calls, s.orderId!)
  },
  {
    id: 'devapp-form',
    app: 'Electron',
    version: 1,
    tier: 'background',
    shared: 'dev-instance',
    stepBudget: 14,
    wallMs: TASK_WALL_MS,
    async setup(ctx) {
      const dev = await (ctx.devInstance?.() ?? Promise.resolve({ skip: 'no dev instance here' }))
      if ('skip' in dev) return dev
      // Its title is the page on screen ("New thread", then "Settings"), so the message names the app's window, not a title.
      return { app: 'Electron', window: 'TempCode', nonce: ctx.nonce, seed: ctx.seed, dev: { database: devDatabase(dev.userData), stop: dev.stop } }
    },
    prompt: (s) =>
      withRule(
        `In the Electron app's ${s.window} window, open Settings, then Add-ons, and add an add-on named ${devAddonName(s.nonce)}: an HTTP add-on at ${DEV_ADDON_URL}, for every workspace. Save it.`
      ),
    check: async (s) => checkDevAddon(s.dev!.database, devAddonName(s.nonce)),
    teardown: async (s) => s.dev?.stop()
  },
  {
    id: 'settings-toggle',
    app: 'System Settings',
    version: 1,
    tier: 'background',
    shared: 'system-settings',
    stepBudget: 12,
    wallMs: TASK_WALL_MS,
    async setup(ctx) {
      // An open System Settings is the person's window.
      if (await isAppRunning(ctx.run, SYSTEM_SETTINGS)) return { skip: 'System Settings is open' }
      const setting = await readFeedbackSetting(ctx.run)
      await ctx.open('System Settings', '')
      return { app: 'System Settings', window: 'System Settings', nonce: ctx.nonce, seed: ctx.seed, toggle: { value: setting ?? 0, setting } }
    },
    prompt: () => withRule(`In System Settings, turn "Play feedback when volume is changed" (in Sound) the other way.`),
    // Two turns, two reads: one turn could flip the switch and put it back between any two samples.
    then: {
      check: (s, read) => feedbackReads(read.exec, otherFeedback(s.toggle!.value)),
      message: withRule('Now put it back as it was.')
    },
    check: (s, read) => feedbackReads(read.exec, s.toggle!.value),
    async teardown(s, run) {
      if (s.toggle && (await readFeedbackSetting(run)) !== s.toggle.setting) await writeFeedback(run, s.toggle.setting)
    }
  },
  {
    id: 'save-dialog',
    app: 'TextEdit',
    version: 1,
    tier: 'background',
    stepBudget: 12,
    wallMs: TASK_WALL_MS,
    async setup(ctx) {
      const source = join(ctx.dir, `${ctx.nonce}.rtf`)
      const target = join(ctx.dir, saveTargetName(ctx.nonce))
      await writeRtf(ctx.run, source, saveSourceText(ctx.nonce))
      await writeRtf(ctx.run, target, SAVE_TARGET_OLD)
      const sourceBytes = readFileSync(source)
      await ctx.open('TextEdit', source)
      return { app: 'TextEdit', window: ctx.nonce, nonce: ctx.nonce, seed: ctx.seed, saveDialog: { source, target, sourceBytes, home: ctx.home } }
    },
    prompt: (s) => withRule(`Save a copy of TextEdit's document "${s.window}" over the file ${saveTargetName(s.nonce)} in the same folder, replacing that file.`),
    check: (s, read) => checkSaveCopy({ run: read.exec, nonce: s.nonce, ...s.saveDialog! }),
    async teardown(s, run) {
      // A copy saved elsewhere is ours: it carries the run's nonce.
      if (!s.saveDialog) return
      for (const path of straysUnder(await spotlightNamed(run, s.nonce), s.saveDialog.home)) await run('rm', ['-f', path])
    }
  }
]

/** The gate's tasks: every one doable in the background tiers. */
export const gateTasks = (tasks: readonly ComputerTask[] = COMPUTER_TASKS): ComputerTask[] => tasks.filter((t) => t.tier === 'background')

/** The comparison's three tasks; chrome-delete is the policy check, run once per model on its kept words. */
export const COMPARISON_TASKS: readonly TaskId[] = ['textedit-write', 'chrome-read', 'chrome-form']
export const POLICY_TASK: TaskId = 'chrome-delete'

export function taskById(id: TaskId): ComputerTask {
  const t = COMPUTER_TASKS.find((x) => x.id === id)
  if (!t) throw new Error(`no task ${id}`)
  return t
}
