/**
 * The field task set (`--set field` of scripts/e2e-computer-bench.ts, hand run
 * only; docs/computer-protocol.md §21.7): the six tasks of the 2026-11-10
 * field test (.temp-code/findings/computer-field-test-2026-11-10.md) as bench
 * tasks, plus the classes that test and its fix threads touched — window
 * closes over an unsaved-changes sheet, a below-the-fold table row, a tab
 * switch, an app launched by the model, a menu command by its shortcut.
 *
 * Every end state is read from the disk or the app's own state through the
 * rig, never the model's word: the field test's false successes (a Finder
 * rename shown in the list but not on disk, a TextEdit save the autosave
 * made) are exactly what the checks must catch. Scratch content only, under
 * the run's dir; teardowns close what a run opened and remove what strayed
 * (the trashed file, an autosave copy).
 *
 * A task whose commits needed the session tier in the field test is marked
 * `tier: 'session'`, but the field set runs every task: the tier is whatever
 * the host's scheduler grants (the person away, or their TC_BENCH_UNGATED
 * leave).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ParsedObservation } from '../../src/shared/computer/observation'
import { isAppRunning, rtfText, straysUnder, type Exec } from './benchChecks'
import {
  COMPUTER_ONLY_LINE,
  TASK_WALL_MS,
  elements,
  mulberry32,
  type CheckResult,
  type ComputerTask,
  type TaskApp,
  type TaskContext,
  type TaskReader,
  type TaskStart
} from './computerTasks'

// ── seeded scratch content ──────────────────────────────────────────────

/** suite.py's city list: 40 rows, so the table's tail sits below the fold. */
export const FIELD_CITIES: readonly string[] = [
  'Lisbon', 'Osaka', 'Tulsa', 'Leeds', 'Quito', 'Perth', 'Turin', 'Dakar', 'Hanoi', 'Minsk', 'Salem', 'Cusco',
  'Basel', 'Kyoto', 'Porto', 'Lagos', 'Miami', 'Delhi', 'Sofia', 'Tampa', 'Accra', 'Dubai', 'Essen', 'Fargo',
  'Genoa', 'Haifa', 'Izmir', 'Jaipur', 'Kazan', 'Lyon', 'Malmo', 'Nantes', 'Omaha', 'Pune', 'Reno', 'Split',
  'Tunis', 'Ulsan', 'Vigo', 'Wuhan'
]

export interface FieldRow {
  city: string
  revenue: number
}

/** The report's 40 rows for a seed: a shuffle of the cities, each with a revenue no model can guess. */
export function fieldRows(seed: number): FieldRow[] {
  const r = mulberry32(seed || 1)
  const cities = [...FIELD_CITIES]
  for (let i = cities.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[cities[i], cities[j]] = [cities[j], cities[i]]
  }
  const revenues = new Set<number>()
  while (revenues.size < cities.length) revenues.add(120_000 + Math.floor(r() * 860_000))
  return [...revenues].map((revenue, i) => ({ city: cities[i], revenue }))
}

/** The row with the highest revenue: the whole table must be read to find it. */
export const topRow = (seed: number): FieldRow => fieldRows(seed).reduce((a, b) => (b.revenue > a.revenue ? b : a))
/** A row in the table's bottom quarter, below the fold of any window. */
export const foldRow = (seed: number): FieldRow => fieldRows(seed)[30 + (seed % 9)]
/** A row near the top, for the tab-switch task: the switch is what is measured, not a scroll. */
export const nearRow = (seed: number): FieldRow => fieldRows(seed)[2]

export type FieldPage = 'report' | 'form' | 'front'
export const fieldWindow = (page: FieldPage, nonce: string): string => `TC field ${page} ${nonce}`

const fmt = (n: number): string => n.toLocaleString('en-US')

export function reportHtml(seed: number, nonce: string): string {
  const rows = fieldRows(seed)
    .map((r) => `<tr><td>${r.city}</td><td>${fmt(r.revenue)}</td></tr>`)
    .join('')
  return (
    `<!doctype html><meta charset=utf-8><title>${fieldWindow('report', nonce)}</title>` +
    '<style>body{font:15px system-ui;margin:32px}td,th{padding:4px 16px;text-align:left}</style>' +
    '<h1>Quarterly report</h1><p>Revenue by city, in dollars.</p>' +
    `<table><thead><tr><th>City</th><th>Revenue</th></tr></thead><tbody>${rows}</tbody></table>`
  )
}

export const frontHtml = (nonce: string): string =>
  `<!doctype html><meta charset=utf-8><title>${fieldWindow('front', nonce)}</title><style>body{font:15px system-ui;margin:32px}</style><h1>Scratch tab</h1><p>The report is in the tab behind this one.</p>`

/** What the form expects; the confirmation code proves every field reached the page. */
export const FIELD_FORM = { name: 'Avery Quinn', email: 'avery.quinn@example.com', plan: 'Team' } as const

/** suite.py's fnv-1a over ASCII, as the form page computes it. */
export function fieldCode(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return 'TC-' + h.toString(16).toUpperCase().padStart(8, '0')
}

export const fieldFormCode = (nonce: string): string => fieldCode(`${FIELD_FORM.name}|${FIELD_FORM.email}|${FIELD_FORM.plan}|${nonce}`)

export function formHtml(nonce: string): string {
  return `<!doctype html><meta charset=utf-8><title>${fieldWindow('form', nonce)}</title>
<style>body{font:15px system-ui;margin:32px}label{display:block;margin:12px 0}input,select{font:inherit;padding:4px}</style>
<h1>Signup form</h1>
<form id=f>
<label>Full name <input id=name name=name></label>
<label>Email <input id=email name=email type=email></label>
<label>Plan <select id=plan name=plan><option value="">Choose a plan</option><option>Starter</option><option>Team</option><option>Enterprise</option></select></label>
<label><input id=agree type=checkbox> I agree to the terms</label>
<button type=submit id=go>Submit</button>
</form>
<p id=out role=status></p>
<script>
const n='${nonce}';
function fnv(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0}return 'TC-'+h.toString(16).toUpperCase().padStart(8,'0')}
document.getElementById('f').addEventListener('submit',e=>{e.preventDefault();
const v=id=>document.getElementById(id).value.trim();const out=document.getElementById('out');
if(!v('name')||!v('email').includes('@')||!v('plan')||!document.getElementById('agree').checked){out.textContent='Please complete every field.';return}
out.textContent='Confirmation: '+fnv(v('name')+'|'+v('email')+'|'+v('plan')+'|'+n)});
</script>`
}

/** A one-line scratch RTF document, written raw so setup needs no textutil. */
export const docRtf = (lines: readonly string[]): string =>
  `{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0 Helvetica;}}\\f0\\fs28 ${lines.join('\\par ')}\\par }`

export const invoiceItems = (seed: number): number[] => {
  const r = mulberry32((seed || 1) + 7)
  return [0, 1, 2].map(() => 200 + Math.floor(r() * 4700))
}
export const invoiceRtf = (nonce: string, items: readonly number[]): string =>
  docRtf([`Invoice ${nonce}`, ...items.map((n, i) => `Item ${'ABC'[i]}: ${fmt(n)}`)])

export const calcFactors = (seed: number): { a: number; b: number } => {
  const r = mulberry32((seed || 1) + 3)
  return { a: 1100 + Math.floor(r() * 8700), b: 1100 + Math.floor(r() * 8700) }
}

/** The scratch Finder files carry the run's nonce, so a check or a Trash sweep never matches another run's or the person's bytes. */
export const finderDraft = (nonce: string): string => `draft of the plan ${nonce}\n`
export const finderLog = (nonce: string): string => `old log line ${nonce}\n`
export const finderKeep = (nonce: string): string => `# keep ${nonce}\n`

// ── reading the end state ───────────────────────────────────────────────

/**
 * Digit-group separators collapsed only BETWEEN digits (comma, apostrophe,
 * nbsp, narrow nbsp — never a space or newline, which would join adjacent
 * numbers in a dump: "3,456\n789,012" must not contain 456789).
 */
const joinGroups = (s: string): string => s.replace(/(\d)[,'  ](?=\d)/g, '$1')

/** Strips grouping inside one short display value (Calculator's), spaces included: the value is one number, nothing can join. */
const ungroupValue = (s: string): string => s.replace(/(\d)[,\s  '](?=\d)/g, '$1')

/** The number as its own token in the reply: digit boundaries on the raw text, separators normalised without joining numbers. */
export const replyNumberToken = (reply: string, n: number): boolean => new RegExp(`(^|\\D)${n}(?=\\D|$)`).test(joinGroups(reply))

/** The city as its own word, case as the table writes it (Split the city, not "split"). */
export const replyCityToken = (reply: string, city: string): boolean => new RegExp(`(^|[^A-Za-z])${city}(?=[^A-Za-z]|$)`).test(reply)

/** Does any one element of the window (Calculator's display) show the number as a whole value? */
export const treeShowsNumber = (o: ParsedObservation, n: number): boolean =>
  elements(o).some((e) => [e.name, e.value].some((t) => t && new RegExp(`(^|\\D)${n}(?=\\D|$)`).test(ungroupValue(t))))

/**
 * The reply against the table (C2): the expected number (and city) must be
 * named as its own token, and a reply that names more than one of the
 * table's revenues (or cities, where a city is asked) fails as a hedge or a
 * dump — the true row being among the candidates proves nothing.
 */
export function tableReplyCheck(reply: string, rows: readonly FieldRow[], want: FieldRow, opts: { city: boolean }): CheckResult {
  if (!replyNumberToken(reply, want.revenue)) return { ok: false, detail: `the reply lacks ${want.revenue} as its own number` }
  const numbers = rows.filter((r) => replyNumberToken(reply, r.revenue))
  if (numbers.length > 1) return { ok: false, detail: `the reply names ${numbers.length} of the table's revenues: ${numbers.map((r) => r.revenue).join(', ')}` }
  if (opts.city) {
    if (!replyCityToken(reply, want.city)) return { ok: false, detail: `the reply lacks ${want.city}` }
    const cities = rows.filter((r) => replyCityToken(reply, r.city))
    if (cities.length > 1) return { ok: false, detail: `the reply names ${cities.length} of the table's cities: ${cities.map((r) => r.city).join(', ')}` }
  }
  return { ok: true, detail: opts.city ? `${want.city} ${want.revenue}` : String(want.revenue) }
}

/** The form page's confirmation line, from the AX tree; null while it shows none. */
export function confirmationText(o: ParsedObservation): string | null {
  for (const e of elements(o)) {
    for (const text of [e.value, e.name]) {
      const m = text && /Confirmation: TC-[0-9A-F]{8}/.exec(text)
      if (m) return m[0]
    }
  }
  return null
}

export interface WindowGone {
  gone: boolean
  /** a read error that is NOT "no such window" (a hung app, a service restart): the check fails with it, never passes */
  error?: string
}

/** Gone only on the service's own "no such window" (or the app quit); any other error is the caller's failure, not a pass. */
export async function windowGone(read: TaskReader, app: TaskApp, title: string): Promise<WindowGone> {
  try {
    await read.read(app, title)
    return { gone: false }
  } catch (e) {
    const kind = (e as { data?: { kind?: string } }).data?.kind
    const message = e instanceof Error ? e.message : String(e)
    if (kind === 'window_not_found' || /window_not_found|has no window open|quit\.$/.test(message)) return { gone: true }
    return { gone: false, error: message }
  }
}

/** The document's text: the raw bytes when they carry the phrase (RTF keeps ASCII plain), else textutil. */
export async function docText(run: Exec, path: string): Promise<string> {
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    /* unreadable: textutil may still answer */
  }
  return raw + '\n' + ((await rtfText(run, path)) ?? '')
}

/** Files under `dir` named `note`, whatever the extension TextEdit chose. */
export const noteFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((n) => /^note(\.[a-z0-9]+)?$/i.test(n)).map((n) => join(dir, n)) : []

/** Spotlight hits for the nonce, by name or content: where an autosave copy would surface. */
export async function spotlightHits(run: Exec, nonce: string): Promise<string[]> {
  const r = await run('mdfind', [nonce])
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : []
}

export const STRAY_TRIES = { tries: 4, waitMs: 1500 } as const
/** The retry wait, swappable so the unit tests run without real waits. */
export const STRAY_WAIT = { wait: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)) }

/**
 * The strays under the roots, asked of Spotlight several times: a seconds-old
 * autosave in iCloud routinely lags the index, so one empty read proves
 * nothing. Any read that finds strays answers at once; "no strays" only
 * after every try.
 */
export async function spotlightStrays(
  run: Exec,
  nonce: string,
  home: string,
  opts: { tries?: number; waitMs?: number; wait?: (ms: number) => Promise<void> } = {}
): Promise<string[]> {
  const { tries = STRAY_TRIES.tries, waitMs = STRAY_TRIES.waitMs, wait = STRAY_WAIT.wait } = opts
  for (let i = 0; ; i++) {
    const strays = straysUnder(await spotlightHits(run, nonce), home)
    if (strays.length || i >= tries - 1) return strays
    await wait(waitMs)
  }
}

/** Does the file (or any file inside the .rtfd folder) hold the marker? Nothing without it is ours to remove. */
export function holdsMarker(path: string, marker: string): boolean {
  try {
    const stat = statSync(path)
    if (stat.isDirectory()) return readdirSync(path).some((name) => holdsMarker(join(path, name), marker))
    return stat.size < 1_048_576 && readFileSync(path, 'utf8').includes(marker)
  } catch {
    return false
  }
}

/** Removes a stray only once its content proves it is the run's (M1: the roots are the person's folders). */
export function removeStrays(paths: readonly string[], marker: string): string[] {
  const removed: string[] = []
  for (const path of paths) {
    if (!holdsMarker(path, marker)) continue
    rmSync(path, { recursive: true, force: true })
    removed.push(path)
  }
  return removed
}

/**
 * Removes the run's scratch files from the Trash: small top-level entries
 * whose bytes carry the run's nonce (every scratch Finder file does), so a
 * model that trashed the wrong file is cleaned up too and nothing of the
 * person's is ever touched.
 */
export function removeTrashedScratch(home: string, nonce: string): string[] {
  const trash = join(home, '.Trash')
  const removed: string[] = []
  if (!existsSync(trash)) return removed
  for (const name of readdirSync(trash)) {
    const path = join(trash, name)
    try {
      const stat = statSync(path)
      if (!stat.isFile() || stat.size > 4096) continue
      if (!readFileSync(path, 'utf8').includes(nonce)) continue
      rmSync(path, { force: true })
      removed.push(name)
    } catch {
      /* not ours to touch */
    }
  }
  return removed
}

/** A file whose exact bytes sit anywhere under the folder (a rename or a move inside the folder is not a trash). */
export function bytesUnder(dir: string, bytes: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  for (const name of entries) {
    const path = join(dir, name)
    try {
      const stat = statSync(path)
      if (stat.isDirectory()) {
        const hit = bytesUnder(path, bytes)
        if (hit) return hit
      } else if (stat.isFile() && stat.size === Buffer.byteLength(bytes) && readFileSync(path, 'utf8') === bytes) return path
    } catch {
      /* unreadable: not a hit */
    }
  }
  return null
}

/** The trashed file by its exact bytes among the Trash's top-level entries (Finder renames duplicates, so never by name alone). */
export function inTrash(home: string, bytes: string): string | null {
  const trash = join(home, '.Trash')
  if (!existsSync(trash)) return null
  for (const name of readdirSync(trash)) {
    const path = join(trash, name)
    try {
      const stat = statSync(path)
      if (stat.isFile() && stat.size === Buffer.byteLength(bytes) && readFileSync(path, 'utf8') === bytes) return name
    } catch {
      /* unreadable: not a hit */
    }
  }
  return null
}

// ── the field data a run carries ────────────────────────────────────────

export interface FieldData {
  product?: number
  total?: number
  file?: string
  /** the file's bytes at setup, base64: the discard check proves them unchanged */
  bytes?: string
  dir?: string
  text?: string
  extra?: string
  city?: string
  revenue?: number
  code?: string
  home?: string
  /** pins the app the model launched into the run's lane, so the check can read it */
  pin?: (pid: number) => void
}

export interface FieldStart extends TaskStart {
  field: FieldData
}

export const fieldOf = (s: TaskStart): FieldData => (s as FieldStart).field ?? {}

const rule = (message: string): string => `${message} ${COMPUTER_ONLY_LINE}`
const ok = (detail: string): CheckResult => ({ ok: true, detail })
const bad = (detail: string): CheckResult => ({ ok: false, detail })

const CALCULATOR_BUNDLE = 'com.apple.calculator'

const quitCalculator = async (run: Exec): Promise<void> => {
  await run('osascript', ['-e', 'tell application "Calculator" to quit'])
}

const closeFinderWindows = async (run: Exec, name: string): Promise<void> => {
  await run('osascript', [
    '-e',
    `with timeout of 5 seconds\ntell application "Finder"\nrepeat 4 times\ntry\nclose (first window whose name is "${name}")\non error\nexit repeat\nend try\nend repeat\nend tell\nend timeout`
  ])
}

/** Closes the scratch TextEdit documents that hold the run's text, without saving; never LAUNCHES TextEdit (AppleScript would). */
const closeTextEditDocs = async (run: Exec, marker: string): Promise<void> => {
  const running = await run('pgrep', ['-x', 'TextEdit'])
  if (!running.stdout.trim()) return
  await run('osascript', [
    '-e',
    `with timeout of 8 seconds\ntell application "TextEdit"\nrepeat 8 times\nset hit to false\nrepeat with d in (get every document)\ntry\nset t to ""\ntry\nset t to text of d\nend try\nif (name of d contains "${marker}") or (t contains "${marker}") then\nclose d saving no\nset hit to true\nexit repeat\nend if\nend try\nend repeat\nif not hit then exit repeat\nend repeat\nend tell\nend timeout`
  ])
}

const finderSetup = async (ctx: TaskContext): Promise<FieldStart> => {
  const dir = join(ctx.dir, `files-${ctx.nonce}`)
  mkdirSync(dir, { recursive: true })
  await ctx.writeFile(join(dir, 'draft.txt'), finderDraft(ctx.nonce))
  await ctx.writeFile(join(dir, 'old.log'), finderLog(ctx.nonce))
  await ctx.writeFile(join(dir, 'keep.md'), finderKeep(ctx.nonce))
  await ctx.open('Finder', dir)
  return { app: 'Finder', window: `files-${ctx.nonce}`, nonce: ctx.nonce, seed: ctx.seed, field: { dir, home: ctx.home } }
}

/** Every Finder teardown: close the run's window, and sweep the run's files (by their nonce-carrying bytes) out of the Trash. */
const finderTeardown = async (s: TaskStart, run: Exec): Promise<void> => {
  await closeFinderWindows(run, s.window)
  const home = fieldOf(s).home
  if (home) removeTrashedScratch(home, s.nonce)
}

const calcSetup = async (ctx: TaskContext, launchIt: boolean): Promise<FieldStart | { skip: string }> => {
  if (await isAppRunning(ctx.run, CALCULATOR_BUNDLE)) return { skip: "Calculator is open: it is the person's" }
  const { a, b } = calcFactors(ctx.seed)
  if (launchIt) await ctx.open('Calculator', '')
  const pin = ctx.pin
  return { app: 'Calculator', window: 'Calculator', nonce: ctx.nonce, seed: ctx.seed, field: { product: a * b, pin: pin ? (pid) => pin('Calculator', pid) : undefined } }
}

const checkCalc = async (s: TaskStart, read: TaskReader, reply: string): Promise<CheckResult> => {
  const product = fieldOf(s).product!
  if (!replyNumberToken(reply, product)) return bad(`the reply lacks ${product} as its own number`)
  const tree = await read.read('Calculator', 'Calculator')
  return treeShowsNumber(tree, product) ? ok(`Calculator shows ${product}`) : bad('the reply has the product but Calculator never showed it')
}

// ── the tasks ───────────────────────────────────────────────────────────

export const FIELD_TASKS: ComputerTask[] = [
  {
    id: 'field-calc',
    app: 'Calculator',
    version: 2,
    tier: 'background',
    shared: 'calculator',
    stepBudget: 8,
    wallMs: TASK_WALL_MS,
    setup: (ctx) => calcSetup(ctx, true),
    prompt(s) {
      const { a, b } = calcFactors(s.seed)
      return rule(`Using the Calculator app, which is open in the background, compute ${a} × ${b} and answer with the product alone.`)
    },
    check: checkCalc,
    teardown: (_s, run) => quitCalculator(run)
  },
  {
    id: 'field-app-launch',
    app: 'Calculator',
    version: 2,
    tier: 'background',
    shared: 'calculator',
    stepBudget: 10,
    wallMs: TASK_WALL_MS,
    setup: (ctx) => calcSetup(ctx, false),
    prompt(s) {
      const { a, b } = calcFactors(s.seed)
      return rule(`The Calculator app is not running. Launch it in the background, compute ${a} × ${b} in it, and answer with the product alone.`)
    },
    async check(s, read, reply) {
      const r = await read.exec('pgrep', ['-x', 'Calculator'])
      const pid = Number(r.stdout.split('\n').filter(Boolean)[0])
      if (!pid) return bad('Calculator is not running')
      fieldOf(s).pin?.(pid)
      return checkCalc(s, read, reply)
    },
    teardown: (_s, run) => quitCalculator(run)
  },
  {
    id: 'field-chrome-bg-tab',
    app: 'Google Chrome',
    version: 2,
    tier: 'background',
    stepBudget: 10,
    wallMs: TASK_WALL_MS,
    async setup(ctx) {
      const front = join(ctx.dir, 'front.html')
      const report = join(ctx.dir, 'report.html')
      await ctx.writeFile(front, frontHtml(ctx.nonce))
      await ctx.writeFile(report, reportHtml(ctx.seed, ctx.nonce))
      await ctx.open('Google Chrome', pathToFileURL(front).href, { args: [pathToFileURL(report).href] })
      const top = topRow(ctx.seed)
      return { app: 'Google Chrome', window: fieldWindow('front', ctx.nonce), nonce: ctx.nonce, seed: ctx.seed, field: { city: top.city, revenue: top.revenue } } satisfies FieldStart
    },
    prompt: (s) =>
      rule(
        `Chrome's window "${fieldWindow('front', s.nonce)}" has a second tab, "${fieldWindow('report', s.nonce)}", behind the front one. In that report, which city has the highest revenue? Answer with that one city and its revenue, nothing else.`
      ),
    async check(s, _read, reply) {
      const { city, revenue } = fieldOf(s)
      return tableReplyCheck(reply, fieldRows(s.seed), { city: city!, revenue: revenue! }, { city: true })
    },
    teardown: async () => {}
  },
  {
    id: 'field-chrome-below-fold',
    app: 'Google Chrome',
    version: 2,
    tier: 'background',
    stepBudget: 8,
    wallMs: TASK_WALL_MS,
    async setup(ctx) {
      const report = join(ctx.dir, 'report.html')
      await ctx.writeFile(report, reportHtml(ctx.seed, ctx.nonce))
      await ctx.open('Google Chrome', pathToFileURL(report).href)
      const row = foldRow(ctx.seed)
      return { app: 'Google Chrome', window: fieldWindow('report', ctx.nonce), nonce: ctx.nonce, seed: ctx.seed, field: { city: row.city, revenue: row.revenue } } satisfies FieldStart
    },
    prompt: (s) => rule(`In Chrome's window "${fieldWindow('report', s.nonce)}", what is the revenue of ${fieldOf(s).city} in the table? Answer with the number alone.`),
    async check(s, _read, reply) {
      const { city, revenue } = fieldOf(s)
      return tableReplyCheck(reply, fieldRows(s.seed), { city: city!, revenue: revenue! }, { city: false })
    },
    teardown: async () => {}
  },
  {
    id: 'field-chrome-tab-switch',
    app: 'Google Chrome',
    version: 2,
    tier: 'background',
    stepBudget: 8,
    wallMs: TASK_WALL_MS,
    async setup(ctx) {
      const front = join(ctx.dir, 'front.html')
      const report = join(ctx.dir, 'report.html')
      await ctx.writeFile(front, frontHtml(ctx.nonce))
      await ctx.writeFile(report, reportHtml(ctx.seed, ctx.nonce))
      await ctx.open('Google Chrome', pathToFileURL(front).href, { args: [pathToFileURL(report).href] })
      const row = nearRow(ctx.seed)
      return { app: 'Google Chrome', window: fieldWindow('front', ctx.nonce), nonce: ctx.nonce, seed: ctx.seed, field: { city: row.city, revenue: row.revenue } } satisfies FieldStart
    },
    prompt: (s) =>
      rule(`In Chrome's window "${fieldWindow('front', s.nonce)}", switch to the tab "${fieldWindow('report', s.nonce)}" and tell me the revenue of ${fieldOf(s).city}. Answer with the number alone.`),
    async check(s, _read, reply) {
      const { city, revenue } = fieldOf(s)
      return tableReplyCheck(reply, fieldRows(s.seed), { city: city!, revenue: revenue! }, { city: false })
    },
    teardown: async () => {}
  },
  {
    id: 'field-web-form',
    app: 'Google Chrome',
    version: 1,
    tier: 'background',
    stepBudget: 14,
    wallMs: TASK_WALL_MS,
    async setup(ctx) {
      const form = join(ctx.dir, 'form.html')
      await ctx.writeFile(form, formHtml(ctx.nonce))
      await ctx.open('Google Chrome', pathToFileURL(form).href)
      return { app: 'Google Chrome', window: fieldWindow('form', ctx.nonce), nonce: ctx.nonce, seed: ctx.seed, field: { code: fieldFormCode(ctx.nonce) } } satisfies FieldStart
    },
    prompt: (s) =>
      rule(
        `Fill the signup form in Chrome's window "${fieldWindow('form', s.nonce)}": full name ${FIELD_FORM.name}, email ${FIELD_FORM.email}, plan ${FIELD_FORM.plan}, tick "I agree to the terms", then submit. It is a local test page; submitting sends nothing.`
      ),
    async check(s, read) {
      const got = confirmationText(await read.read('Google Chrome', s.window))
      const want = `Confirmation: ${fieldOf(s).code}`
      return got === want ? ok('submitted') : bad(got ? `the page shows ${JSON.stringify(got)}, not ${JSON.stringify(want)}` : 'the page shows no confirmation')
    },
    teardown: async () => {}
  },
  {
    id: 'field-textedit-add-line',
    app: 'TextEdit',
    version: 1,
    tier: 'background',
    stepBudget: 10,
    wallMs: TASK_WALL_MS,
    async setup(ctx) {
      const items = invoiceItems(ctx.seed)
      const file = join(ctx.dir, `${ctx.nonce}.rtf`)
      await ctx.writeFile(file, invoiceRtf(ctx.nonce, items))
      await ctx.open('TextEdit', file)
      return { app: 'TextEdit', window: ctx.nonce, nonce: ctx.nonce, seed: ctx.seed, field: { file, total: items.reduce((a, b) => a + b, 0) } } satisfies FieldStart
    },
    prompt: (s) =>
      rule(`TextEdit's window "${s.window}" shows an invoice with three items. Add a line at the end reading "Total: $N" where N is the sum of the three items, then save the document in place.`),
    async check(s, read) {
      const { file, total } = fieldOf(s)
      const text = await docText(read.exec, file!)
      if (!new RegExp(`Total:\\s*\\$\\s*${total}(?=\\D|$)`).test(joinGroups(text))) return bad(`the file on disk has no "Total: $${total}" line`)
      // The field test's inverse false outcome: the disk was right but the window still read Edited. Best effort: a closed window is fine.
      try {
        const tree = await read.read('TextEdit', s.window)
        if (/\bEdited\b/.test(tree.header.window)) return bad('saved on disk, but the window still reads Edited')
      } catch {
        /* the window closed after the save: the disk already answered */
      }
      return ok(`Total: $${total} saved in place`)
    },
    teardown: async () => {}
  },
  {
    id: 'field-textedit-save-as',
    app: 'TextEdit',
    version: 2,
    // Every field-test run met the save panel only at the session tier.
    tier: 'session',
    stepBudget: 24,
    wallMs: 480_000,
    async setup(ctx) {
      const seedFile = join(ctx.dir, `${ctx.nonce}-seed.rtf`)
      await ctx.writeFile(seedFile, docRtf([`Seed ${ctx.nonce}`]))
      await ctx.open('TextEdit', seedFile)
      return {
        app: 'TextEdit',
        window: `${ctx.nonce}-seed`,
        nonce: ctx.nonce,
        seed: ctx.seed,
        field: { dir: ctx.dir, text: `Computer use test ${ctx.nonce}`, home: ctx.home }
      } satisfies FieldStart
    },
    prompt: (s) => rule(`In TextEdit, create a new document with the text "${fieldOf(s).text}", and save it with the name "note" in the folder ${fieldOf(s).dir}.`),
    async check(s, read) {
      const { dir, text, home } = fieldOf(s)
      const saved: string[] = []
      for (const path of noteFiles(dir!)) if ((await docText(read.exec, path)).includes(text!)) saved.push(path)
      // Spotlight read several times: a seconds-old autosave in iCloud lags the index, and one empty read proves nothing.
      const strays = await spotlightStrays(read.exec, s.nonce, home!)
      if (!saved.length) return bad(`no file named note with the text in ${dir}${strays.length ? `; a copy strayed to ${strays.join(', ')}` : ''}`)
      if (strays.length) return bad(`saved, but a copy strayed outside the folder: ${strays.join(', ')}`)
      return ok('note saved in the folder, no strays')
    },
    async teardown(s, run) {
      await closeTextEditDocs(run, s.nonce)
      // Always remove the strays the run made: Spotlight read again with the retries, each removal content-proved (M1).
      const home = fieldOf(s).home
      if (home) removeStrays(await spotlightStrays(run, s.nonce, home), s.nonce)
    }
  },
  {
    id: 'field-textedit-close-discard',
    app: 'TextEdit',
    version: 2,
    tier: 'background',
    stepBudget: 10,
    wallMs: TASK_WALL_MS,
    async setup(ctx) {
      const file = join(ctx.dir, `${ctx.nonce}.rtf`)
      await ctx.writeFile(file, docRtf([`Field probe ${ctx.nonce}`, 'line two']))
      const bytes = readFileSync(file).toString('base64')
      // "Ask to keep changes when closing": the close raises the sheet instead of keeping silently.
      await ctx.open('TextEdit', file, { args: ['-NSCloseAlwaysConfirmsChanges', 'YES'] })
      return { app: 'TextEdit', window: ctx.nonce, nonce: ctx.nonce, seed: ctx.seed, field: { file, bytes, extra: `Added ${ctx.nonce}` } } satisfies FieldStart
    },
    prompt: (s) => rule(`In TextEdit's window "${s.window}", add the line "${fieldOf(s).extra}" at the end, then close the window. When it asks about the unsaved changes, choose to discard them.`),
    async check(s, read, _reply, calls) {
      const { file, bytes, extra } = fieldOf(s)
      // C6: the end state of "closed an untouched window" is identical; the run must show the edit happened (the typed line in a call).
      if (!calls.some((c) => JSON.stringify(c.input).includes(extra!) || c.result.includes(extra!)))
        return bad(`no call of the run carried the line ${JSON.stringify(extra)}: the window may have been closed unedited, with no sheet`)
      const gone = await windowGone(read, 'TextEdit', s.window)
      if (gone.error) return bad(`the window could not be read: ${gone.error}`)
      if (!gone.gone) return bad('the window is still open')
      return readFileSync(file!).toString('base64') === bytes ? ok('edited, window closed, the file unchanged') : bad('the window closed but the file changed on disk')
    },
    teardown: (s, run) => closeTextEditDocs(run, s.nonce)
  },
  {
    id: 'field-textedit-close-keep',
    app: 'TextEdit',
    version: 2,
    tier: 'background',
    stepBudget: 10,
    wallMs: TASK_WALL_MS,
    async setup(ctx) {
      const file = join(ctx.dir, `${ctx.nonce}.rtf`)
      await ctx.writeFile(file, docRtf([`Field probe ${ctx.nonce}`, 'line two']))
      await ctx.open('TextEdit', file, { args: ['-NSCloseAlwaysConfirmsChanges', 'YES'] })
      return { app: 'TextEdit', window: ctx.nonce, nonce: ctx.nonce, seed: ctx.seed, field: { file, extra: `Added ${ctx.nonce}` } } satisfies FieldStart
    },
    prompt: (s) => rule(`In TextEdit's window "${s.window}", add the line "${fieldOf(s).extra}" at the end, then close the window. When it asks about the unsaved changes, choose to keep them.`),
    async check(s, read) {
      const { file, extra } = fieldOf(s)
      const gone = await windowGone(read, 'TextEdit', s.window)
      if (gone.error) return bad(`the window could not be read: ${gone.error}`)
      if (!gone.gone) return bad('the window is still open')
      return (await docText(read.exec, file!)).includes(extra!) ? ok('window closed, the line kept') : bad('the window closed but the file lacks the line')
    },
    teardown: (s, run) => closeTextEditDocs(run, s.nonce)
  },
  {
    id: 'field-menu-shortcut',
    app: 'TextEdit',
    version: 1,
    tier: 'background',
    stepBudget: 8,
    wallMs: TASK_WALL_MS,
    async setup(ctx) {
      const file = join(ctx.dir, `${ctx.nonce}.rtf`)
      await ctx.writeFile(file, docRtf([`Field probe ${ctx.nonce}`]))
      await ctx.open('TextEdit', file)
      return { app: 'TextEdit', window: ctx.nonce, nonce: ctx.nonce, seed: ctx.seed, field: {} } satisfies FieldStart
    },
    prompt: (s) => rule(`In TextEdit's window "${s.window}", duplicate the document with File's Duplicate command (⇧⌘S). Leave the copy open and answer "done".`),
    async check(s, read) {
      try {
        await read.read('TextEdit', `${s.nonce} copy`)
        return ok('the copy is open')
      } catch {
        return bad(`TextEdit has no window "${s.nonce} copy"`)
      }
    },
    teardown: (s, run) => closeTextEditDocs(run, s.nonce)
  },
  {
    id: 'field-finder-rename',
    app: 'Finder',
    version: 2,
    // Every field-test rename "committed" in the list but not on disk until the session tier typed it.
    tier: 'session',
    shared: 'finder',
    stepBudget: 12,
    wallMs: 420_000,
    setup: finderSetup,
    prompt: (s) => rule(`In the Finder window "${s.window}", rename the file draft.txt to final.txt.`),
    async check(s) {
      const dir = fieldOf(s).dir!
      const final = join(dir, 'final.txt')
      if (!existsSync(final)) return bad('final.txt is not on disk')
      if (existsSync(join(dir, 'draft.txt'))) return bad('draft.txt is still on disk beside final.txt')
      return readFileSync(final, 'utf8') === finderDraft(s.nonce) ? ok('renamed on disk') : bad('final.txt exists but its content changed')
    },
    teardown: finderTeardown
  },
  {
    id: 'field-finder-trash',
    app: 'Finder',
    version: 2,
    tier: 'session',
    shared: 'finder',
    stepBudget: 12,
    wallMs: 420_000,
    setup: finderSetup,
    prompt: (s) => rule(`In the Finder window "${s.window}", move old.log to the Trash.`),
    async check(s) {
      const { dir, home } = fieldOf(s)
      const bytes = finderLog(s.nonce)
      // Renamed in place or moved into a subfolder is not a trash: the bytes must be gone from the whole folder…
      const inside = bytesUnder(dir!, bytes)
      if (inside) return bad(`old.log is still under the folder, as ${inside.slice(dir!.length + 1)}`)
      if (!existsSync(join(dir!, 'keep.md'))) return bad('old.log left, but keep.md went with it')
      // …and IN the Trash, found by its exact bytes (Finder renames duplicates, so never by name).
      return inTrash(home!, bytes) ? ok('old.log is in the Trash') : bad('old.log left the folder but is not in the Trash (deleted outright, or moved elsewhere)')
    },
    teardown: finderTeardown
  },
  {
    id: 'field-finder-new-folder',
    app: 'Finder',
    version: 2,
    tier: 'session',
    shared: 'finder',
    stepBudget: 12,
    wallMs: 420_000,
    setup: finderSetup,
    prompt: (s) => rule(`In the Finder window "${s.window}", create a new folder named "archive".`),
    async check(s) {
      const archive = join(fieldOf(s).dir!, 'archive')
      try {
        return statSync(archive).isDirectory() ? ok('archive is on disk') : bad('archive exists but is no folder')
      } catch {
        return bad('no folder named archive on disk (an "untitled folder" whose rename never committed does not count)')
      }
    },
    teardown: finderTeardown
  }
]

export function fieldTaskById(id: string): ComputerTask {
  const t = FIELD_TASKS.find((x) => x.id === id)
  if (!t) throw new Error(`no field task ${id}`)
  return t
}
