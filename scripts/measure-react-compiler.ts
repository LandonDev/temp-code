/**
 * A/B measurement for the React Compiler trial (plan 70GqTBkrP0qv).
 *
 *   TEMP_CODE_PROFILE=1 bunx electron-vite build
 *   bun scripts/measure-react-compiler.ts --label on --runs 3 --seconds 60
 *   (drop the compiler plugin from electron.vite.config.ts, rebuild)
 *   bun scripts/measure-react-compiler.ts --label off --runs 3 --seconds 60
 *   bun scripts/measure-react-compiler.ts --summary
 *
 * The 2026-10-19 trial (plan 70GqTBkrP0qv) kept the compiler: renderMs
 * 7427 → 4867 (0.655), ScriptDuration 20.41 → 12.88 s, no long tasks either
 * way, commits 5945 → 6885 because cheaper commits dropped fewer frames.
 *
 * Each run launches the built preview (out/) cold with the isolated dev
 * userData and CDP on 9224, opens a fresh thread, streams the facade's seeded
 * synthetic turn (`__app.feed`) through the store for the window while the
 * root Profiler and a long-task observer count, reads Chromium's
 * Performance.getMetrics before and after, and quits the app. One JSON per
 * run lands in scripts/.out/react-compiler/<label>-<n>.json.
 *
 *   --open <sessionId>   instead of the feed: open an existing thread and
 *                        measure until the Profiler has been quiet for a
 *                        second (report-only; files open-<label>-<n>.json).
 *                        Use a thread this slot has never opened: boot
 *                        pre-warms recent tabs, and a warm open costs nothing
 *   --summary            medians, ranges and on/off ratios of every file,
 *                        plus the plan's decision rule
 *   --port N --user-data DIR   another isolated slot (default 9224 and
 *                        ~/Library/Application Support/temp-code-dev)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')
const OUT = resolve(ROOT, 'scripts/.out/react-compiler')

const args = process.argv.slice(2)
const flag = (name: string, dflt?: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
/** Isolated dev slot (CLAUDE.md): temp-code-dev on 9224 by default; a second
 *  session takes --user-data …/temp-code-dev2 --port 9226. */
const DEBUG_PORT = Number(flag('port', process.env.TEMP_CODE_DEBUG_PORT ?? '9224'))
const USER_DATA =
  flag('user-data', process.env.TEMP_CODE_USER_DATA) ??
  join(homedir(), 'Library/Application Support/temp-code-dev')
const label = flag('label', 'off')!
const runs = Number(flag('runs', '3'))
const seconds = Number(flag('seconds', '60'))
const perSecond = Number(flag('per-second', '120'))
const openId = flag('open')
const summaryOnly = args.includes('--summary')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (s: string) => console.log(`[measure] ${s}`)

// ── CDP (same shape as scripts/e2e-updater.ts; bun's global WebSocket) ─────

type Target = { type: string; url: string; webSocketDebuggerUrl?: string }

async function pageTarget(timeoutMs: number): Promise<Target> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()) as Target[]
      const page = list.find(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes('/renderer/index.html')
      )
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error(`no CDP page on ${DEBUG_PORT} within ${timeoutMs}ms`)
}

class Cdp {
  private ws: WebSocket
  private next = 1
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()
  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data))
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.rej(new Error(msg.error.message))
      else p.res(msg.result)
    })
  }
  static connect(url: string): Promise<Cdp> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url)
      ws.addEventListener('open', () => res(new Cdp(ws)))
      ws.addEventListener('error', () => rej(new Error('CDP socket failed')))
    })
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.next++
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => this.pending.set(id, { res, rej }))
  }
  async eval<T>(expression: string): Promise<T> {
    const r = (await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })) as {
      result: { value?: T }
      exceptionDetails?: { text: string; exception?: { description?: string } }
    }
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value as T
  }
  async metrics(): Promise<Record<string, number>> {
    const r = (await this.send('Performance.getMetrics')) as {
      metrics: { name: string; value: number }[]
    }
    return Object.fromEntries(r.metrics.map((m) => [m.name, m.value]))
  }
  close(): void {
    this.ws.close()
  }
}

// ── the app ────────────────────────────────────────────────────────────────

const ELECTRON = join(
  ROOT,
  'node_modules/electron/dist',
  readFileSync(join(ROOT, 'node_modules/electron/path.txt'), 'utf8').trim()
)

function launch(logPath: string) {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  env.TEMP_CODE_USER_DATA = USER_DATA
  env.TEMP_CODE_DEBUG_PORT = String(DEBUG_PORT)
  const file = Bun.file(logPath)
  return Bun.spawn([ELECTRON, ROOT], { cwd: ROOT, env, stdout: file, stderr: file })
}

async function portFree(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
    return false
  } catch {
    return true
  }
}

async function quit(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  proc.kill('SIGTERM')
  const exited = await Promise.race([proc.exited.then(() => true), sleep(10_000).then(() => false)])
  if (!exited) {
    proc.kill('SIGKILL')
    await proc.exited
  }
  // Chromium releases the debug port a moment after the process exits.
  for (let i = 0; i < 20 && !(await portFree()); i++) await sleep(250)
}

function bundleBytes(): number {
  const dir = join(ROOT, 'out/renderer/assets')
  if (!existsSync(dir)) return 0
  let n = 0
  for (const f of readdirSync(dir)) if (f.endsWith('.js')) n += statSync(join(dir, f)).size
  return n
}

/** Compiled functions read their memo cache through react/compiler-runtime,
 *  whose sentinel appears once in a plain bundle and once per cache in a
 *  compiled one: the arm on disk must be the arm the label claims. Another
 *  session's release gate rebuilds out/ without our env, so this is checked
 *  before every launch and the size again after the run. */
function compiledOnDisk(): boolean {
  const dir = join(ROOT, 'out/renderer/assets')
  let n = 0
  for (const f of readdirSync(dir))
    if (f.startsWith('index-') && f.endsWith('.js'))
      n += readFileSync(join(dir, f), 'utf8').split('react.memo_cache_sentinel').length - 1
  return n > 1
}

function assertArm(): void {
  const compiled = compiledOnDisk()
  if (label === 'on' && !compiled) throw new Error('label on, but out/renderer is not a compiled build')
  if (label === 'off' && compiled) throw new Error('label off, but out/renderer is a compiled build')
}

type Profile = { commits: number; renderMs: number; maxCommitMs: number; longTasks: number; longTaskMs: number }
type Run = {
  label: string
  run: number
  mode: 'feed' | 'open'
  at: string
  seconds: number
  perSecond: number
  pushed: { session: number; event: number; ms: number }
  /** transcript blocks the thread held at the end (the stream reached the fold) */
  blocks: number
  commits: number
  renderMs: number
  msPerCommit: number
  maxCommitMs: number
  longTasks: number
  longTaskMs: number
  ScriptDuration: number
  TaskDuration: number
  LayoutDuration: number
  RecalcStyleDuration: number
  JSHeapUsedSize: number
  bundleBytes: number
}

const METRICS = ['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration'] as const

async function waitFacade(cdp: Cdp): Promise<void> {
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    const ready = await cdp
      .eval<boolean>(
        `!!(window.__app && window.__app.feed && window.__app.profile) && !document.getElementById('boot-splash')`
      )
      .catch(() => false)
    if (ready) return
    await sleep(250)
  }
  throw new Error('window.__app never appeared: is this a TEMP_CODE_PROFILE=1 build?')
}

async function waitQuiet(cdp: Cdp, quietMs = 1000, maxMs = 60_000): Promise<void> {
  const until = Date.now() + maxMs
  let last = -1
  let since = Date.now()
  while (Date.now() < until) {
    const c = await cdp.eval<number>('window.__app.profile.read().commits')
    if (c !== last) {
      last = c
      since = Date.now()
    } else if (Date.now() - since >= quietMs) return
    await sleep(100)
  }
}

async function oneRun(n: number): Promise<Run> {
  if (!(await portFree())) throw new Error(`port ${DEBUG_PORT} is busy: another instance is up`)
  assertArm()
  const bytesAtLaunch = bundleBytes()
  mkdirSync(OUT, { recursive: true })
  const mode = openId ? 'open' : 'feed'
  const proc = launch(join(OUT, `${mode === 'open' ? 'open-' : ''}${label}-${n}.log`))
  log(`run ${n}: launched pid ${proc.pid}`)
  try {
    const target = await pageTarget(60_000)
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl!)
    try {
      await cdp.send('Page.enable')
      await cdp.send('Performance.enable')
      await cdp.send('Page.bringToFront')
      await waitFacade(cdp)
      await sleep(3000) // boot settles: stores filled, first paint done

      let pushed = { session: 0, event: 0, ms: 0 }
      let blocks = 0
      let before: Record<string, number>
      let profile: Profile
      if (mode === 'feed') {
        const id = await cdp.eval<string>('window.__app.newSession()')
        await cdp.eval(`window.__app.openSession(${JSON.stringify(id)})`)
        await sleep(2000)
        before = await cdp.metrics()
        await cdp.eval('window.__app.profile.start()')
        pushed = await cdp.eval<typeof pushed>(
          `window.__app.feed({ sessionId: ${JSON.stringify(id)}, seconds: ${seconds}, perSecond: ${perSecond} })`
        )
        profile = await cdp.eval<Profile>('window.__app.profile.stop()')
        blocks = await cdp.eval<number>(`(window.__app.store.get(${JSON.stringify(id)})?.blocks.length) ?? 0`)
      } else {
        // Boot warms recent tabs and the layout remembers open ones, so a
        // thread opened once in this slot is already loaded at the next boot:
        // pick one that has never been opened here, or the open costs nothing.
        const warm = await cdp.eval<boolean>(`!!window.__app.store.get(${JSON.stringify(openId)})?.loaded`)
        if (warm) log(`run ${n}: WARNING ${openId} is already loaded; this open measures nothing`)
        before = await cdp.metrics()
        await cdp.eval('window.__app.profile.start()')
        const t0 = Date.now()
        await cdp.eval(`window.__app.openSession(${JSON.stringify(openId)})`)
        await waitQuiet(cdp)
        pushed = { session: 0, event: 0, ms: Date.now() - t0 }
        profile = await cdp.eval<Profile>('window.__app.profile.stop()')
        blocks = await cdp.eval<number>(`(window.__app.store.get(${JSON.stringify(openId)})?.blocks.length) ?? 0`)
      }
      const after = await cdp.metrics()
      // One frame of what the run looked like at its end, for the record.
      const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
      writeFileSync(join(OUT, `${mode === 'open' ? 'open-' : ''}${label}-${n}.png`), Buffer.from(shot.data, 'base64'))
      const delta = (k: (typeof METRICS)[number]) => Math.round((after[k] - before[k]) * 1000) / 1000
      const run: Run = {
        label,
        run: n,
        mode,
        at: new Date().toISOString(),
        seconds,
        perSecond,
        pushed,
        blocks,
        commits: profile.commits,
        renderMs: Math.round(profile.renderMs),
        msPerCommit: profile.commits ? Math.round((profile.renderMs / profile.commits) * 1000) / 1000 : 0,
        maxCommitMs: Math.round(profile.maxCommitMs * 10) / 10,
        longTasks: profile.longTasks,
        longTaskMs: Math.round(profile.longTaskMs),
        ScriptDuration: delta('ScriptDuration'),
        TaskDuration: delta('TaskDuration'),
        LayoutDuration: delta('LayoutDuration'),
        RecalcStyleDuration: delta('RecalcStyleDuration'),
        JSHeapUsedSize: after.JSHeapUsedSize,
        bundleBytes: bytesAtLaunch
      }
      if (bundleBytes() !== bytesAtLaunch)
        log(`run ${n}: WARNING out/renderer changed on disk during the run (another build?); the app had already loaded`)
      writeFileSync(join(OUT, `${mode === 'open' ? 'open-' : ''}${label}-${n}.json`), JSON.stringify(run, null, 2))
      log(
        `run ${n}: commits ${run.commits} renderMs ${run.renderMs} script ${run.ScriptDuration}s long ${run.longTasks}/${run.longTaskMs}ms events ${run.pushed.event} blocks ${run.blocks}`
      )
      return run
    } finally {
      cdp.close()
    }
  } finally {
    await quit(proc)
  }
}

// ── summary ────────────────────────────────────────────────────────────────

const KEYS = [
  'commits',
  'renderMs',
  'msPerCommit',
  'maxCommitMs',
  'longTasks',
  'longTaskMs',
  'ScriptDuration',
  'TaskDuration',
  'LayoutDuration',
  'RecalcStyleDuration',
  'JSHeapUsedSize',
  'bundleBytes'
] as const
type Key = (typeof KEYS)[number]

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))
const stat = (runs: Run[], k: Key) => {
  const xs = runs.map((r) => r[k])
  return { med: median(xs), min: Math.min(...xs), max: Math.max(...xs) }
}

function loadRuns(mode: 'feed' | 'open'): Map<string, Run[]> {
  const by = new Map<string, Run[]>()
  if (!existsSync(OUT)) return by
  for (const f of readdirSync(OUT)) {
    if (!f.endsWith('.json')) continue
    if ((mode === 'open') !== f.startsWith('open-')) continue
    const r = JSON.parse(readFileSync(join(OUT, f), 'utf8')) as Run
    by.set(r.label, [...(by.get(r.label) ?? []), r])
  }
  return by
}

function printLabel(name: string, rs: Run[]): void {
  console.log(`\n${name} (${rs.length} runs; events/run ${rs.map((r) => r.pushed.event).join(', ')})`)
  console.log('| metric | median | min | max |\n|---|---|---|---|')
  for (const k of KEYS) {
    const s = stat(rs, k)
    console.log(`| ${k} | ${fmt(s.med)} | ${fmt(s.min)} | ${fmt(s.max)} |`)
  }
}

function printSideBySide(mode: 'feed' | 'open'): void {
  const by = loadRuns(mode)
  const off = by.get('off')
  const on = by.get('on')
  console.log(`\n## ${mode === 'feed' ? 'Synthetic feed' : 'Thread open'} — off vs on`)
  if (!off || !on) {
    for (const [l, rs] of by) printLabel(l, rs)
    console.log(off && on ? '' : '\n(need both an off and an on label for ratios)')
    return
  }
  console.log(`off: ${off.length} runs · on: ${on.length} runs`)
  console.log('| metric | off median (min–max) | on median (min–max) | on/off |\n|---|---|---|---|')
  for (const k of KEYS) {
    const a = stat(off, k)
    const b = stat(on, k)
    const ratio = a.med ? (b.med / a.med).toFixed(3) : '—'
    console.log(`| ${k} | ${fmt(a.med)} (${fmt(a.min)}–${fmt(a.max)}) | ${fmt(b.med)} (${fmt(b.min)}–${fmt(b.max)}) | ${ratio} |`)
  }
  if (mode !== 'feed') return
  const r = stat(off, 'renderMs')
  const o = stat(on, 'renderMs')
  const checks: [string, boolean][] = [
    [`renderMs(on) ≤ 0.85 × renderMs(off): ${fmt(o.med)} vs ${fmt(0.85 * r.med)}`, o.med <= 0.85 * r.med],
    [`slowest on-run (${fmt(o.max)}) below fastest off-run (${fmt(r.min)})`, o.max < r.min],
    [
      `ScriptDuration(on) ≤ 1.02 × off: ${fmt(stat(on, 'ScriptDuration').med)} vs ${fmt(1.02 * stat(off, 'ScriptDuration').med)}`,
      stat(on, 'ScriptDuration').med <= 1.02 * stat(off, 'ScriptDuration').med
    ],
    // The load guard: the plan wrote it as commits within ±5%, meant to catch
    // the feed moving. Commits count frames painted, and a cheaper commit
    // drops fewer frames, so the pushed rows are the measure of the load.
    [
      `pushed events equal across arms (the load did not move): ${median(on.map((r) => r.pushed.event))} vs ${median(off.map((r) => r.pushed.event))}`,
      median(on.map((r) => r.pushed.event)) === median(off.map((r) => r.pushed.event))
    ],
    [`longTasks(on) ≤ longTasks(off): ${stat(on, 'longTasks').med} vs ${stat(off, 'longTasks').med}`, stat(on, 'longTasks').med <= stat(off, 'longTasks').med]
  ]
  console.log('\nDecision rule:')
  for (const [text, pass] of checks) console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${text}`)
  console.log(`\n=> ${checks.every(([, p]) => p) ? 'WIN (numbers only; the CDP smoke still decides)' : 'REVERT'}`)
}

// ── main ───────────────────────────────────────────────────────────────────

if (summaryOnly) {
  printSideBySide('feed')
  if (loadRuns('open').size) printSideBySide('open')
} else {
  if (!existsSync(join(ROOT, 'out/renderer/index.html'))) throw new Error('no out/renderer build: run electron-vite build first')
  const done: Run[] = []
  const existing = existsSync(OUT)
    ? readdirSync(OUT).filter((f) => f.startsWith(`${openId ? 'open-' : ''}${label}-`) && f.endsWith('.json')).length
    : 0
  for (let i = 1; i <= runs; i++) done.push(await oneRun(existing + i))
  printLabel(label, done)
}
