#!/usr/bin/env bun
/**
 * Launch timing of a packaged copy, with Chromium's startup trace on, so the
 * two launch-time code caches (plan kzTjVxj7h35M) are measured instead of
 * assumed: Node's compile cache for out/main/index.js, and the V8 code cache
 * the renderer gets only on a scheme with `codeCache: true` (never file://).
 *
 *   bun run script:e2e-launch-timing                     # build, pack, 4 launches
 *   bun run script:e2e-launch-timing -- --reuse          # drive the last pack again
 *   bun run script:e2e-launch-timing -- --app <bundle>   # drive a bundle packed elsewhere
 *   --launches N      launches per run (default 4: Chromium stamps on 1,
 *                     produces the code cache on 2, consumes from 3)
 *   --label <text>    tag for the report and the saved result JSON
 *   --no-trace        a clean timing pass without Chromium tracing
 *   --seed-app <bundle>  launch that bundle once on the fresh userData before
 *                     launch 1, untimed, to seed a file:// localStorage the
 *                     app under test must migrate to its new origin
 *
 * Every launch: wipe userData and the compile cache for launch 1 only; spawn
 * the executable with --trace-startup (v8, devtools.timeline,
 * disabled-by-default-v8.compile; json; 8 s) and stdout/stderr into
 * <ROOT>/launch-<i>.log; attach over CDP, wait for `tc:ready`, count console
 * errors, call session.list over the server link, wait for the trace file,
 * quit through window.api.app.confirmQuit() (so before-quit runs and Chromium
 * flushes its caches), wait for exit (SIGKILL after 30 s = FAIL).
 *
 * Reported per launch: `index` (Electron init + boot.js + the compile of
 * index.js), `ready-to-show`, `tc:ready` as ms since process start; the index
 * bundle's v8.compile duration and cache fields; whether v8.produceCache named
 * it; V8.Compile* count and sum; sizes of <userData>/Code Cache/js and the
 * compile cache directory after exit.
 *
 * Everything lives under ROOT (/private/tmp/tc-launch-timing) with its own
 * bundle id, userData, CDP port, compile cache (TEMP_CODE_COMPILE_CACHE) and
 * a dead loopback feed, so the copy never polls GitHub. Nothing under
 * /Applications, the installed app's userData or its caches is touched.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import {
  attach,
  builtApp,
  type Cdp,
  findIdentity,
  killAt,
  launchEnv,
  pack,
  pageTarget,
  plistVersionOf,
  portFree,
  prepareEnv,
  readPackage,
  sh,
  sleep,
  waitForReleaseTrain
} from './lib/packagedApp'

const ROOT = '/private/tmp/tc-launch-timing'
const APP_ID = 'dev.landon.tempcode.e2e'
const PRODUCT = 'TempCodeE2E'
const DEBUG_PORT = 9234
const USER_DATA = join(ROOT, 'userData')
const COMPILE_CACHE = join(ROOT, 'compile-cache')
const BUILD_DIR = join(ROOT, 'build')
/** A dead loopback port: the copy's updater never reaches GitHub. */
const FEED_URL = 'http://127.0.0.1:9/'
const TRACE_SECONDS = 8
/** Keep the app alive long enough for the trace and the 10 s compile-cache flush. */
const DWELL_MS = 12_000
const QUIT_TIMEOUT_MS = 30_000

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const reuse = argv.includes('--reuse')
const noTrace = argv.includes('--no-trace')
const appArg = flag('--app')
const seedApp = flag('--seed-app')
const launches = Number(flag('--launches') ?? 4)
const label = flag('--label') ?? 'run'
if (!Number.isInteger(launches) || launches < 1)
  throw new Error('--launches must be a positive integer')

prepareEnv()

let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const info = (name: string, detail = ''): void => {
  console.log(`INFO ${name}${detail ? ` — ${detail}` : ''}`)
}
const log = (msg: string): void =>
  console.log(`[launch-timing ${new Date().toISOString().slice(11, 19)}] ${msg}`)

// ── Build ──────────────────────────────────────────────────────────────────

mkdirSync(ROOT, { recursive: true })
if (!(await portFree(DEBUG_PORT))) throw new Error(`port ${DEBUG_PORT} is in use`)

let APP: string
if (appArg) {
  APP = appArg
} else if (reuse) {
  APP = builtApp(BUILD_DIR, PRODUCT)
  if (!existsSync(APP)) throw new Error(`--reuse: ${APP} missing`)
} else {
  const identity = await findIdentity()
  const version = `1.0.${readPackage().n}`
  await waitForReleaseTrain(log)
  rmSync(BUILD_DIR, { recursive: true, force: true })
  log('bun run build (typecheck + electron-vite)')
  await sh(['bun', 'run', 'build'], { quiet: true })
  APP = await pack({
    version,
    outDir: BUILD_DIR,
    appId: APP_ID,
    product: PRODUCT,
    identity,
    check,
    log,
    harness: {
      TEMP_CODE_USER_DATA: USER_DATA,
      TEMP_CODE_DEBUG_PORT: DEBUG_PORT,
      TEMP_CODE_UPDATE_FEED: FEED_URL
    }
  })
}
if (!existsSync(APP)) throw new Error(`${APP} missing`)

async function exeOf(app: string): Promise<string> {
  const name = (
    await sh(
      ['plutil', '-extract', 'CFBundleExecutable', 'raw', join(app, 'Contents', 'Info.plist')],
      {
        quiet: true
      }
    )
  ).trim()
  return join(app, 'Contents', 'MacOS', name)
}
const EXE = await exeOf(APP)
const bundlePkg = JSON.parse(
  readFileSync(join(APP, 'Contents', 'Resources', 'app', 'package.json'), 'utf8')
) as { main?: string; version?: string }
log(
  `app ${APP} (${await plistVersionOf(APP)}, main ${bundlePkg.main}), label "${label}", ${launches} launches${noTrace ? ', no trace' : ''}`
)

// The environment wins over the baked harness block, so a bundle packed for
// another harness (--app) still comes up on this run's paths.
const env = launchEnv({
  TEMP_CODE_USER_DATA: USER_DATA,
  TEMP_CODE_DEBUG_PORT: String(DEBUG_PORT),
  TEMP_CODE_UPDATE_FEED: FEED_URL,
  TEMP_CODE_COMPILE_CACHE: COMPILE_CACHE
})

// ── Launch and drive ───────────────────────────────────────────────────────

type Proc = ReturnType<typeof Bun.spawn>

function spawnApp(exe: string, logName: string, extraArgs: string[]): Proc {
  const file = Bun.file(join(ROOT, logName))
  return Bun.spawn([exe, ...extraArgs], { env, stdout: file, stderr: file })
}

async function waitExit(proc: Proc, ms: number): Promise<boolean> {
  return Promise.race([proc.exited.then(() => true), sleep(ms).then(() => false)])
}

/** confirmQuit opens the gate and app.quit() tears the page down, so the
 *  promise it returns may never settle; fire and watch the process instead. */
async function quit(cdp: Cdp, proc: Proc, app: string): Promise<boolean> {
  await cdp.eval('(window.api.app.confirmQuit(), true)').catch(() => undefined)
  const exited = await waitExit(proc, QUIT_TIMEOUT_MS)
  cdp.close()
  if (!exited) {
    proc.kill('SIGKILL')
    await killAt(app)
    await waitExit(proc, 5000)
  }
  return exited
}

function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(p)
    else if (entry.isFile()) total += statSync(p).size
  }
  return total
}

interface BootMarks {
  index?: number
  start?: number
  compileCacheOn?: boolean
  compileCacheLine?: string
  serverStart?: number
  dbOpen?: number
  firstSessionList?: number
  readyToShow?: number
  localstorageMigrated?: string
}

function parseLog(text: string): BootMarks {
  const marks: BootMarks = {}
  for (const line of text.split('\n')) {
    const m = /^\[boot\] (.*)$/.exec(line)
    if (!m) continue
    const body = m[1]
    if (body.startsWith('compile-cache ')) {
      marks.compileCacheLine = body
      continue
    }
    const t = /^(\d+) (\S+)(?: (.*))?$/.exec(body)
    if (!t) continue
    const ms = Number(t[1])
    const detail = t[3] ?? ''
    switch (t[2]) {
      case 'index': {
        marks.index = ms
        const start = /start=(\d+)/.exec(detail)
        if (start) marks.start = Number(start[1])
        marks.compileCacheOn = /compile-cache=on/.test(detail)
        break
      }
      case 'server-start':
        marks.serverStart = ms
        break
      case 'db-open':
        marks.dbOpen = ms
        break
      case 'first-session-list':
        marks.firstSessionList = ms
        break
      case 'ready-to-show':
        marks.readyToShow = ms
        break
      case 'localstorage-migrated':
        marks.localstorageMigrated = detail
        break
    }
  }
  return marks
}

interface TraceEvent {
  name: string
  cat?: string
  dur?: number
  args?: { data?: Record<string, unknown> }
}

interface IndexCompile {
  dur?: number
  consumedCacheSize?: number
  cacheRejected?: boolean
  cacheKind?: string
  notStreamedReason?: string
  streamed?: boolean
  producedCache?: boolean
  url?: string
}

interface TraceSummary {
  indexBundle: IndexCompile
  v8CompileCount: number
  v8CompileDurMs: number
}

const INDEX_BUNDLE = /\/assets\/index-[^/]+\.js$/

function parseTrace(text: string): TraceSummary {
  const raw = JSON.parse(text) as TraceEvent[] | { traceEvents: TraceEvent[] }
  const events = Array.isArray(raw) ? raw : raw.traceEvents
  const indexBundle: IndexCompile = {}
  let v8CompileCount = 0
  let v8CompileDur = 0
  for (const ev of events) {
    if (ev.name.startsWith('V8.Compile')) {
      v8CompileCount++
      v8CompileDur += ev.dur ?? 0
    }
    const url = ev.args?.data?.url
    if (typeof url !== 'string' || !INDEX_BUNDLE.test(url)) continue
    if (ev.name === 'v8.compile') {
      const d = ev.args!.data!
      indexBundle.url = url
      indexBundle.dur = (ev.dur ?? 0) / 1000
      if (typeof d.consumedCacheSize === 'number')
        indexBundle.consumedCacheSize = d.consumedCacheSize
      if (typeof d.cacheRejected === 'boolean') indexBundle.cacheRejected = d.cacheRejected
      if (typeof d.cacheKind === 'string') indexBundle.cacheKind = d.cacheKind
      if (typeof d.notStreamedReason === 'string')
        indexBundle.notStreamedReason = d.notStreamedReason
      if (typeof d.streamed === 'boolean') indexBundle.streamed = d.streamed
    } else if (ev.name === 'v8.produceCache') {
      indexBundle.producedCache = true
    }
  }
  return { indexBundle, v8CompileCount, v8CompileDurMs: v8CompileDur / 1000 }
}

interface LaunchResult {
  i: number
  pageUrl: string
  marks: BootMarks
  /** Epoch ms of the renderer's tc:ready mark, and ms since process start. */
  readyEpoch?: number
  readyMs?: number
  /** Ms from our spawn call to tc:ready (includes exec and Electron's own init). */
  spawnToReadyMs?: number
  consoleErrors: string[]
  sessionList: boolean
  localStorageKeys?: string[]
  trace?: TraceSummary
  traceFile?: string
  cleanQuit: boolean
  codeCacheBytes: number
  compileCacheBytes: number
  markerFile: boolean
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (existsSync(path) && statSync(path).size > 0) {
      // Chromium writes the file whole when the duration elapses; a parse
      // that fails is a file still being written.
      try {
        JSON.parse(readFileSync(path, 'utf8'))
        return true
      } catch {
        /* partial */
      }
    }
    await sleep(500)
  }
  return false
}

async function launch(i: number): Promise<LaunchResult> {
  const traceFile = join(ROOT, `trace-${i}.json`)
  rmSync(traceFile, { force: true })
  const traceArgs = noTrace
    ? []
    : [
        '--trace-startup=v8,devtools.timeline,disabled-by-default-v8.compile',
        `--trace-startup-file=${traceFile}`,
        '--trace-startup-format=json',
        `--trace-startup-duration=${TRACE_SECONDS}`
      ]
  const logName = `launch-${i}.log`
  const spawnAt = Date.now()
  const proc = spawnApp(EXE, logName, traceArgs)
  log(`launch ${i}: pid ${proc.pid}`)
  const consoleErrors: string[] = []
  const result: LaunchResult = {
    i,
    pageUrl: '',
    marks: {},
    consoleErrors,
    sessionList: false,
    cleanQuit: false,
    codeCacheBytes: 0,
    compileCacheBytes: 0,
    markerFile: false
  }
  let cdp: Cdp | null = null
  try {
    cdp = await attach(DEBUG_PORT, 90_000, async (c) => {
      c.on('Runtime.consoleAPICalled', (p) => {
        if (p.type === 'error') {
          const args = (p.args as Array<{ value?: unknown; description?: string }>) ?? []
          consoleErrors.push(
            args
              .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? '')))
              .join(' ')
          )
        }
      })
      c.on('Log.entryAdded', (p) => {
        const entry = p.entry as { level?: string; text?: string; url?: string }
        if (entry?.level === 'error') consoleErrors.push(`${entry.text} ${entry.url ?? ''}`.trim())
      })
      await c.send('Runtime.enable')
      await c.send('Log.enable')
    })
    result.pageUrl = (await pageTarget(DEBUG_PORT, 5000)).url
    const readyUntil = Date.now() + 60_000
    while (Date.now() < readyUntil) {
      const ready = await cdp
        .eval<number | null>(
          `(() => { const e = performance.getEntriesByName('tc:ready')[0]; return e ? performance.timeOrigin + e.startTime : null })()`
        )
        .catch(() => null)
      if (ready !== null) {
        result.readyEpoch = ready
        result.spawnToReadyMs = ready - spawnAt
        break
      }
      await sleep(100)
    }
    result.sessionList = await cdp
      .eval<unknown>(`window.__monocode.server.request('session.list')`)
      .then((rows) => Array.isArray(rows))
      .catch(() => false)
    if (seedApp) {
      result.localStorageKeys = await cdp
        .eval<string[]>('Object.keys(localStorage)')
        .catch(() => [])
    }
    if (!noTrace) {
      const ok = await waitForFile(traceFile, (TRACE_SECONDS + 30) * 1000)
      if (ok) result.traceFile = traceFile
      else check(`launch ${i}: trace file written`, false, traceFile)
    }
    const dwellLeft = spawnAt + DWELL_MS - Date.now()
    if (dwellLeft > 0) await sleep(dwellLeft)
    result.cleanQuit = await quit(cdp, proc, APP)
    cdp = null
  } catch (e) {
    check(`launch ${i}: drive`, false, (e as Error).message)
    cdp?.close()
    proc.kill('SIGKILL')
    await killAt(APP)
  }
  // After exit: the log is complete and Chromium has flushed its caches.
  result.marks = parseLog(readFileSync(join(ROOT, logName), 'utf8'))
  if (result.readyEpoch !== undefined && result.marks.start !== undefined) {
    result.readyMs = result.readyEpoch - result.marks.start
  }
  if (result.traceFile) {
    try {
      result.trace = parseTrace(readFileSync(result.traceFile, 'utf8'))
    } catch (e) {
      check(`launch ${i}: trace parses`, false, (e as Error).message)
    }
  }
  result.codeCacheBytes = dirSize(join(USER_DATA, 'Code Cache', 'js'))
  result.compileCacheBytes = dirSize(COMPILE_CACHE)
  result.markerFile = existsSync(join(USER_DATA, 'localstorage-migrated'))
  return result
}

// ── Run ────────────────────────────────────────────────────────────────────

await killAt(APP)
if (seedApp) await killAt(seedApp)
rmSync(USER_DATA, { recursive: true, force: true })
rmSync(COMPILE_CACHE, { recursive: true, force: true })
mkdirSync(USER_DATA, { recursive: true })

let seedKeys: string[] = []
if (seedApp) {
  // Untimed: the older copy writes its localStorage on the file:// origin.
  const seedExe = await exeOf(seedApp)
  const proc = spawnApp(seedExe, 'seed.log', [])
  log(`seed launch of ${seedApp}: pid ${proc.pid}`)
  const cdp = await attach(DEBUG_PORT, 90_000)
  const url = (await pageTarget(DEBUG_PORT, 5000)).url
  await cdp.eval(`localStorage.setItem('tc:e2e-seed', '${Date.now()}'), true`)
  seedKeys = await cdp.eval<string[]>('Object.keys(localStorage)')
  await sleep(2000)
  const exited = await quit(cdp, proc, seedApp)
  check('seed app quit cleanly', exited)
  check(
    'seed app ran on file:// and left localStorage keys',
    url.startsWith('file://') && seedKeys.includes('tc:e2e-seed'),
    `${url} keys ${seedKeys.join(', ')}`
  )
}

const results: LaunchResult[] = []
for (let i = 1; i <= launches; i++) {
  results.push(await launch(i))
}

// ── Report ─────────────────────────────────────────────────────────────────

const fmt = (n: number | undefined, digits = 0): string =>
  n === undefined ? '-' : n.toFixed(digits)
const kb = (bytes: number): string => (bytes / 1024).toFixed(0)
const cols = [
  'launch',
  'index',
  'ready-to-show',
  'tc:ready',
  'spawn→ready',
  'bundle compile',
  'consumed',
  'rejected',
  'produced',
  'V8.Compile* n',
  'V8.Compile* ms',
  'Code Cache KB',
  'compile-cache KB',
  'errors'
]
const rows = results.map((r) => [
  String(r.i),
  fmt(r.marks.index),
  fmt(r.marks.readyToShow),
  fmt(r.readyMs),
  fmt(r.spawnToReadyMs),
  fmt(r.trace?.indexBundle.dur, 1),
  r.trace?.indexBundle.consumedCacheSize === undefined
    ? '-'
    : String(r.trace.indexBundle.consumedCacheSize),
  r.trace?.indexBundle.cacheRejected === undefined
    ? '-'
    : String(r.trace.indexBundle.cacheRejected),
  r.trace ? (r.trace.indexBundle.producedCache ? 'yes' : 'no') : '-',
  r.trace ? String(r.trace.v8CompileCount) : '-',
  r.trace ? fmt(r.trace.v8CompileDurMs) : '-',
  kb(r.codeCacheBytes),
  kb(r.compileCacheBytes),
  String(r.consoleErrors.length)
])
const widths = cols.map((c, j) => Math.max(c.length, ...rows.map((r) => r[j].length)))
const line = (cells: string[]): string => cells.map((c, j) => c.padStart(widths[j])).join('  ')
console.log('')
console.log(`== ${label}: ${APP}${noTrace ? ' (no trace)' : ' (traced)'} ==`)
console.log(line(cols))
for (const r of rows) console.log(line(r))
console.log('')
for (const r of results) {
  const b = r.trace?.indexBundle
  if (b)
    console.log(
      `launch ${r.i}: ${b.url ?? 'index bundle not in trace'} kind=${b.cacheKind ?? '-'} streamed=${b.streamed ?? '-'} ${b.notStreamedReason ?? ''}`
    )
  if (r.marks.compileCacheLine) console.log(`launch ${r.i}: ${r.marks.compileCacheLine}`)
  if (r.marks.localstorageMigrated)
    console.log(`launch ${r.i}: localstorage-migrated ${r.marks.localstorageMigrated}`)
  for (const err of r.consoleErrors.slice(0, 5))
    console.log(`launch ${r.i}: console error: ${err.slice(0, 300)}`)
}
console.log('')

const first = results[0]
const warm = results.slice(1)
const compileCacheOn = first.marks.compileCacheOn === true
const onScheme = first.pageUrl.startsWith('tempcode-app://')
info('page URL', first.pageUrl)
info('main entry', `${bundlePkg.main}; compile-cache=${compileCacheOn ? 'on' : 'off'}`)

check(
  'every launch booted to tc:ready',
  results.every((r) => r.readyMs !== undefined)
)
check(
  'every launch quit cleanly',
  results.every((r) => r.cleanQuit),
  results
    .filter((r) => !r.cleanQuit)
    .map((r) => `launch ${r.i}`)
    .join(', ')
)
check(
  'zero console errors',
  results.every((r) => r.consoleErrors.length === 0),
  results.map((r) => `${r.i}:${r.consoleErrors.length}`).join(' ')
)
check(
  'session.list answered on every launch',
  results.every((r) => r.sessionList)
)

// Part 1: Node compile cache for the main bundle.
if (compileCacheOn) {
  check(
    'compile-cache ENABLED on launch 1',
    /^compile-cache ENABLED /.test(first.marks.compileCacheLine ?? ''),
    first.marks.compileCacheLine
  )
  check(
    'compile cache directory non-empty after launch 1 exits',
    first.compileCacheBytes > 0,
    `${kb(first.compileCacheBytes)} KB`
  )
  if (warm.length)
    check(
      '`index` mark lower on warm launches than on launch 1',
      warm.every(
        (r) =>
          r.marks.index !== undefined &&
          first.marks.index !== undefined &&
          r.marks.index < first.marks.index
      ),
      `launch 1 ${fmt(first.marks.index)} ms; warm ${warm.map((r) => fmt(r.marks.index)).join(', ')}`
    )
} else {
  info(
    'compile cache off on this tree: Part 1 checks skipped',
    `compile-cache dir ${kb(first.compileCacheBytes)} KB`
  )
}

// Part 2: V8 code cache for the renderer's index bundle.
if (!noTrace) {
  const produced = results.filter((r) => r.trace?.indexBundle.producedCache).map((r) => r.i)
  const consumed = results
    .filter((r) => (r.trace?.indexBundle.consumedCacheSize ?? 0) > 0)
    .map((r) => r.i)
  if (onScheme) {
    check(
      'v8.produceCache for the index bundle on launch 2',
      produced.includes(2),
      `produced on ${produced.join(', ') || 'none'}`
    )
    const fromThree = results.filter((r) => r.i >= 3)
    check(
      'consumedCacheSize > 0 with cacheRejected false on launches ≥ 3',
      fromThree.length > 0 &&
        fromThree.every(
          (r) =>
            (r.trace?.indexBundle.consumedCacheSize ?? 0) > 0 &&
            r.trace?.indexBundle.cacheRejected === false
        ),
      fromThree
        .map(
          (r) =>
            `${r.i}: consumed ${r.trace?.indexBundle.consumedCacheSize ?? '-'} rejected ${r.trace?.indexBundle.cacheRejected ?? '-'}`
        )
        .join('; ')
    )
    check(
      'Code Cache/js grew past launch 1',
      results[results.length - 1].codeCacheBytes > first.codeCacheBytes + 100 * 1024,
      `${kb(first.codeCacheBytes)} KB → ${kb(results[results.length - 1].codeCacheBytes)} KB`
    )
  } else {
    // The file:// verification: Chromium keeps no code cache for it.
    check(
      'file://: no v8.produceCache for the index bundle on any launch',
      produced.length === 0,
      `produced on ${produced.join(', ') || 'none'}`
    )
    check(
      'file://: no consumedCacheSize on any launch',
      consumed.length === 0,
      `consumed on ${consumed.join(', ') || 'none'}`
    )
    info(
      'file://: Code Cache/js after the last launch',
      `${kb(results[results.length - 1].codeCacheBytes)} KB`
    )
  }
}

if (seedApp) {
  const keys = first.localStorageKeys ?? []
  check(
    'seeded localStorage keys present on the new origin (launch 1)',
    seedKeys.length > 0 && seedKeys.every((k) => keys.includes(k)),
    `seeded ${seedKeys.length}, present ${seedKeys.filter((k) => keys.includes(k)).length}: ${keys.join(', ')}`
  )
  check('migration marker written after launch 1', first.markerFile)
  check('migration ran once', results.filter((r) => r.marks.localstorageMigrated).length <= 1)
}

const out = join(ROOT, `result-${label.replace(/[^\w.-]+/g, '_')}.json`)
writeFileSync(
  out,
  JSON.stringify({ label, app: APP, traced: !noTrace, seedKeys, results }, null, 2)
)
log(`per-launch logs and traces under ${ROOT}; results ${out}`)
console.log(
  failures === 0
    ? `E2E LAUNCH TIMING (${label}): PASS`
    : `E2E LAUNCH TIMING (${label}): ${failures} FAILED`
)
process.exit(failures === 0 ? 0 : 1)
