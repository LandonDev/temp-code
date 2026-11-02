/**
 * The renderer over time: a built tree's window soaked under a busy host,
 * sampled for memory, CPU and long tasks, and judged against the Performance
 * 1 targets (docs/box.md "The renderer over time"). Runs on a fresh userData
 * under /tmp/tc-soak, windowed (xvfb-run off macOS), never the person's data.
 *
 *   bun scripts/measure-renderer-soak.ts --label before-board                # synthetic host, prod, board, 10 min
 *   bun scripts/measure-renderer-soak.ts --host box --view stream --minutes 30 --label after-box-stream
 *   bun scripts/measure-renderer-soak.ts --build dev --label dev-board       # needs port 5173 free
 *   bun scripts/measure-renderer-soak.ts --gate                              # the release gate's 90 s run
 *
 * --host synthetic (default) boots scripts/lib/soakHost.ts in a child (a
 *   pinned master, sixteen batch children, the fixed load of soakLoad.ts)
 *   and pairs with its operate key; box pairs read-only with the real box
 *   (the box's local socket when this runs on the box, else a pairing code
 *   over `ssh box tc-local`), the key or code held in this process only and
 *   revoked at exit. --master and --thread pick the box's threads, else the
 *   busiest pinned master and its newest running child.
 * --build prod (default) runs `electron-vite preview --skipBuild` (the tree's
 *   out/ must be built); dev runs `electron-vite dev` and refuses while 5173
 *   is taken.
 * --view board | stream | split: the master's board, the focused child's
 *   transcript, or both side by side (window.__monocode.open).
 * --minutes, --every: the run and the sampling interval (default 10, 60 s),
 *   after a 30 s warm-up. --tree: the built tree to run (default this
 *   checkout). --port: the window's debug port (default 9251). --no-profile:
 *   skip the 60 s CPU profile at the end.
 * --gate: the release gate's bounded run (scripts/gate.ts renderer-soak):
 *   synthetic host, production build, split view, a 10 s warm-up and a 50 s
 *   window inside a hard 90 s from launch to teardown, judged by the gate's
 *   rule (scripts/lib/soakJudge.ts GATE_RULE).
 *
 * Each sample forces a GC (HeapProfiler.collectGarbage) and reads the heap
 * (Runtime.getHeapUsage), the renderer's memory (Linux: smaps_rollup PSS and
 * its private split; macOS: ps RSS), the renderer's and the GPU process's CPU
 * time, DOM counters, the long tasks since the last sample (a `longtask`
 * observer) and the timeline's measures and marks; a dev build also counts
 * React's component re-renders with changed props by name (its U+200B
 * measures) and fails loudly when it sees none. Writes /tmp/tc-soak/<label>.json
 * and <label>.md; exits non-zero when a rule fails. Cleanup at exit and on
 * SIGTERM or SIGINT kills every process carrying the instance's
 * TEMP_CODE_USER_DATA and revokes the box key.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Cdp, REPO, portFree, sleep, type Target } from './lib/packagedApp'
import { profileSummary, type CpuProfile } from './profile-summary'
import { FAMILY, GATE_RULE, GATE_TIMING, handRule, judgeSoak, parseSoakArgs, REACT_MEASURE_PREFIX, type SoakSample } from './lib/soakJudge'

const args = parseSoakArgs(process.argv.slice(2))
const ROOT = '/tmp/tc-soak'
const tree = resolve(args.tree ?? REPO)
const userData = join(ROOT, `${args.label}.userData`)
const home = join(ROOT, `${args.label}.home`)
const MARKER = `TEMP_CODE_USER_DATA=${userData}`
const CLIENT = 'renderer-soak'
const BOX_ORIGIN = 'https://tempcode.landonhale.com'
const BOX_SERVER_JSON = '/srv/agents/temp-code-data/server.json'
const linux = process.platform === 'linux'
const launchedAt = Date.now()
const log = (msg: string): void => console.log(`[soak ${((Date.now() - launchedAt) / 1000).toFixed(1).padStart(5)}s] ${msg}`)

// ── what this run owns, for the cleanup ─────────────────────────────────
let app: ChildProcess | null = null
let soakHost: ChildProcess | null = null
let boxCredential: { kind: 'key' | 'pairing'; id: string } | null = null
let cdp: Cdp | null = null

/** Every pid carrying this instance's TEMP_CODE_USER_DATA (children inherit it). */
function markedPids(): number[] {
  const out: number[] = []
  if (linux) {
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d) || Number(d) === process.pid) continue
      try {
        if (readFileSync(`/proc/${d}/environ`, 'latin1').split('\0').includes(MARKER)) out.push(Number(d))
      } catch {
        /* gone, or not ours */
      }
    }
    return out
  }
  try {
    // macOS prints the environment after the command for the user's own processes.
    for (const line of execFileSync('ps', ['-axeww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n')) {
      const m = /^\s*(\d+)\s(.*)$/.exec(line)
      if (m && Number(m[1]) !== process.pid && m[2]!.includes(` ${MARKER} `)) out.push(Number(m[1]))
    }
  } catch {
    /* ps failed: the group kill below still runs */
  }
  return out
}

function killAll(signal: NodeJS.Signals): void {
  for (const child of [soakHost, app]) {
    if (!child?.pid) continue
    try {
      process.kill(-child.pid, signal)
    } catch {
      child.kill(signal)
    }
  }
  for (const pid of markedPids()) {
    try {
      process.kill(pid, signal)
    } catch {
      /* already gone */
    }
  }
}

let cleaned = false
async function cleanup(): Promise<void> {
  if (cleaned) return
  cleaned = true
  cdp?.close()
  killAll('SIGTERM')
  const until = Date.now() + 5_000
  while (Date.now() < until && markedPids().length) await sleep(200)
  killAll('SIGKILL')
  if (boxCredential) {
    try {
      await revokeBox()
      log('box credential revoked')
    } catch (error) {
      console.error(`the box credential was not revoked: ${(error as Error).message}; revoke "${CLIENT}" by hand`)
      process.exitCode = 2
    }
  }
  rmSync(userData, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log(`${signal}: cleaning up`)
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
  })
}
// A last resort for a crash: the sync kills only.
process.on('exit', () => {
  if (!cleaned) killAll('SIGKILL')
})

// ── the box: a read-only credential that lives as long as this run ───────
const onTheBox = existsSync(BOX_SERVER_JSON)
async function boxLocal<T>(method: string, params: unknown = {}): Promise<T> {
  const { port } = JSON.parse(readFileSync(BOX_SERVER_JSON, 'utf8')) as { port: number }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close()
      fail(new Error(`the box did not answer ${method}`))
    }, 30_000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'soak', method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== 'soak') return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) ok(frame.result as T)
      else fail(new Error(`${method} was refused`))
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      fail(new Error(`no socket for ${method}`))
    })
  })
}
const sshKey = join(homedir(), '.orbstack/ssh/id_ed25519')
function boxSsh<T>(method: string, params?: unknown): T {
  const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`
  const cmd = `node /srv/agents/temp-code-builds/current/scripts/box/tc-local.mjs ${method}${params ? ` ${quote(JSON.stringify(params))}` : ''}`
  try {
    const sshArgs = [...(existsSync(sshKey) ? ['-i', sshKey] : []), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'box', cmd]
    return JSON.parse(execFileSync('ssh', sshArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as T
  } catch {
    // The output may hold a secret; the error never repeats it.
    throw new Error(`ssh box tc-local ${method} failed`)
  }
}
async function revokeBox(): Promise<void> {
  const credential = boxCredential
  if (!credential) return
  if (onTheBox) await boxLocal(credential.kind === 'key' ? 'remote.keys.revoke' : 'remote.pairings.revoke', { id: credential.id })
  else {
    type Row = { id: string; name?: string; createdAt?: number }
    const ours = (r: Row): boolean => r.name === CLIENT && Number(r.createdAt) >= launchedAt - 60_000
    for (const k of boxSsh<Row[]>('remote.keys.list').filter(ours)) boxSsh('remote.keys.revoke', { id: k.id })
    for (const p of boxSsh<Row[]>('remote.pairings.list').filter(ours)) boxSsh('remote.pairings.revoke', { id: p.id })
  }
  boxCredential = null
}

// ── the instance ───────────────────────────────────────────────────────
function launchEnv(): Record<string, string> {
  const base: Record<string, string> = {}
  if (linux) {
    // The agent shell carries the box service's own TEMP_CODE_* (its data dir, headless, the shim claim): start clean.
    Object.assign(base, {
      PATH: `${join(homedir(), '.bun/bin')}:/usr/local/bin:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: join(home, 'tmp'),
      USER: process.env.USER ?? 'agents',
      LANG: 'C.UTF-8',
      SHELL: '/bin/bash'
    })
  } else {
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('TEMP_CODE_') && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'NODE_ENV') base[k] = v
  }
  return {
    ...base,
    ...(args.build === 'prod' ? { NODE_ENV: 'production' } : {}),
    TEMP_CODE_USER_DATA: userData,
    TEMP_CODE_DEBUG_PORT: String(args.port),
    TEMP_CODE_REMOTE_PORT: '0',
    TEMP_CODE_HEADLESS: '0',
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_WARM_HARNESS: '0',
    TEMP_CODE_SOAK_WINDOW: '1',
    TEMP_CODE_ALIAX_DATA_DIR: join(userData, 'aliax'),
    ALIAX_CREDENTIAL_BACKEND: 'file',
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex')
  }
}

async function launch(): Promise<void> {
  if (args.build === 'prod' && !existsSync(join(tree, 'out', 'renderer', 'index.html'))) throw new Error(`no build under ${tree}/out (bun x electron-vite build there first)`)
  if (args.build === 'dev' && !(await portFree(5173))) throw new Error('port 5173 is taken: a dev build would load another session\'s renderer')
  if (!(await portFree(args.port))) throw new Error(`debug port ${args.port} is in use (an earlier soak still up?)`)
  for (const dir of [userData, home]) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  }
  mkdirSync(join(home, 'tmp'), { recursive: true })
  // A windowed Linux run quits at boot when the origin migration's hidden window closes first.
  writeFileSync(join(userData, 'localstorage-migrated'), '')
  const bin = join(tree, 'node_modules', '.bin', 'electron-vite')
  const cmd = [bin, ...(args.build === 'prod' ? ['preview', '--skipBuild'] : ['dev'])]
  const argv = linux ? ['xvfb-run', '-a', '-s', '-screen 0 1600x1000x24 -nolisten tcp', 'dbus-run-session', '--', ...cmd] : cmd
  const out = openSync(join(ROOT, `${args.label}.app.log`), 'w')
  app = spawn(argv[0]!, argv.slice(1), { cwd: tree, env: launchEnv(), stdio: ['ignore', out, out], detached: true })
}

async function pageOf(): Promise<Target> {
  const until = Date.now() + 120_000
  while (Date.now() < until) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${args.port}/json`)).json()) as Target[]
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && (t.url.endsWith('/index.html') || t.url.startsWith('http://localhost:5173')))
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error(`no window on debug port ${args.port} within 120 s (see ${ROOT}/${args.label}.app.log)`)
}

async function waitFor(c: Cdp, expr: string, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await c.eval<boolean>(`!!(${expr})`).catch(() => false)) return
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Long tasks and, in a dev build, React's component re-renders, drained at every sample. */
const OBSERVERS = `(() => {
  if (window.__soak) return true
  const s = (window.__soak = { tasks: [], renders: new Map() })
  new PerformanceObserver((list) => { for (const e of list.getEntries()) s.tasks.push({ start: e.startTime, duration: e.duration }) }).observe({ type: 'longtask' })
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.name.charCodeAt(0) === ${REACT_MEASURE_PREFIX.charCodeAt(0)}) { const n = e.name.slice(1); s.renders.set(n, (s.renders.get(n) || 0) + 1) }
  }).observe({ type: 'measure' })
  window.__soakDrain = () => {
    const out = { tasks: s.tasks, renders: [...s.renders] }
    s.tasks = []
    s.renders = new Map()
    return out
  }
  return true
})()`
const PAGE_STATS = `(() => ({
  measures: performance.getEntriesByType('measure').length,
  marks: performance.getEntriesByType('mark').length,
  animations: document.getAnimations().length,
  entries: window.__monocode.sessionStore.entries?.size ?? null,
  ...window.__soakDrain()
}))()`

// ── the host and the pairing ─────────────────────────────────────────────
type Shown = { environmentId: string; masterId: string; threadId: string }

async function startSynthetic(c: Cdp): Promise<Shown> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('TEMP_CODE_') && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  env.NODE_ENV = 'production'
  soakHost = spawn(process.execPath, ['--preload', join(REPO, 'scripts/lib/electron-stub.ts'), join(REPO, 'scripts/lib/soakHost.ts')], {
    cwd: REPO,
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true
  })
  const line = await new Promise<string>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('the synthetic host did not start within 30 s')), 30_000)
    const lines = createInterface({ input: soakHost!.stdout! })
    lines.on('line', (l) => {
      if (!l.startsWith('{')) return
      clearTimeout(timer)
      lines.close()
      ok(l)
    })
    soakHost!.on('exit', (code) => fail(new Error(`the synthetic host exited (${code})`)))
  })
  const host = JSON.parse(line) as { baseUrl: string; environmentId: string; masterId: string; focusedId: string; key: string }
  await c.eval(
    `window.__monocode.registry.primary().request('remote.environments.add', ${JSON.stringify({ url: host.baseUrl, key: host.key, name: 'soak' })}).then(() => window.__monocode.loadSavedEnvironments(window.__monocode.registry.primary())).then(() => true)`
  )
  log(`paired with the synthetic host ${host.environmentId}`)
  return { environmentId: host.environmentId, masterId: host.masterId, threadId: host.focusedId }
}

async function pairBox(c: Cdp): Promise<Shown> {
  if (onTheBox) {
    const made = await boxLocal<{ key: { id: string }; token: string }>('remote.keys.create', { name: CLIENT, audience: 'client', caps: ['read'] })
    boxCredential = { kind: 'key', id: made.key.id }
    await c.eval(
      `window.__monocode.registry.primary().request('remote.environments.add', ${JSON.stringify({ url: 'http://127.0.0.1:7677', key: made.token, name: 'box' })}).then(() => window.__monocode.loadSavedEnvironments(window.__monocode.registry.primary())).then(() => true)`
    )
  } else {
    const code = boxSsh<{ code?: string; id?: string }>('remote.pairings.create', { name: CLIENT, audience: 'client', caps: ['read'], ttlMinutes: 30 })
    if (typeof code.code !== 'string') throw new Error('the box made no pairing code')
    boxCredential = { kind: 'pairing', id: code.id ?? '' }
    await c.eval(
      `window.__monocode.registry.primary().request('remote.environments.pair', ${JSON.stringify({ origin: BOX_ORIGIN, code: code.code, name: CLIENT })}).then(() => window.__monocode.loadSavedEnvironments(window.__monocode.registry.primary())).then(() => true)`
    )
  }
  const local = await c.eval<string>('window.__monocode.registry.primary().environmentId')
  await waitFor(c, `window.__monocode.registry.environments().some((e) => e.id !== ${JSON.stringify(local)} && window.__monocode.registry.linkOf(e.id)?.connected)`, 60_000, 'the box link')
  const environmentId = await c.eval<string>(`window.__monocode.registry.environments().map((e) => e.id).find((id) => id !== ${JSON.stringify(local)})`)
  await waitFor(c, `window.__monocode.sessionStore.metas().some((m) => m.environmentId === ${JSON.stringify(environmentId)})`, 120_000, "the box's threads")
  // The busiest pinned master and its newest running child, unless named.
  const picked = await c.eval<{ masterId: string | null; threadId: string | null }>(`(() => {
    const metas = window.__monocode.sessionStore.metas().filter((m) => m.environmentId === ${JSON.stringify(environmentId)} && !m.archived)
    const running = (m) => m.status === 'running' || m.status === 'waiting'
    const masters = metas.filter((m) => m.isMaster).map((m) => ({ m, kids: metas.filter((k) => k.masterId === m.id && running(k)) })).sort((a, b) => b.kids.length - a.kids.length)
    const master = ${JSON.stringify(args.master)} ?? masters[0]?.m.id ?? null
    const kids = metas.filter((k) => k.masterId === master && running(k)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const roots = metas.filter((k) => !k.parentId && running(k)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return { masterId: master, threadId: ${JSON.stringify(args.thread)} ?? kids[0]?.id ?? roots[0]?.id ?? null }
  })()`)
  if (!picked.masterId && args.view !== 'stream') throw new Error('the box has no pinned master to show (name one with --master)')
  if (!picked.threadId && args.view !== 'board') throw new Error('the box has no running thread to show (name one with --thread)')
  log(`paired read-only with the box ${environmentId}`)
  return { environmentId, masterId: picked.masterId ?? '', threadId: picked.threadId ?? '' }
}

async function openView(c: Cdp, shown: Shown): Promise<void> {
  const known = (id: string): string => `window.__monocode.sessionStore.metaOf(${JSON.stringify(id)})`
  const pane = (id: string): string => `[...document.querySelectorAll('[data-session-drop="${id}"]')].some((e) => e.getBoundingClientRect().width > 0)`
  const ids = args.view === 'stream' ? [shown.threadId] : args.view === 'board' ? [shown.masterId] : [shown.masterId, shown.threadId]
  for (const id of ids) await waitFor(c, known(id), 60_000, `thread ${id} on the host`)
  if (args.view !== 'stream') {
    await c.eval(`window.__monocode.open(${JSON.stringify(shown.masterId)}).then(() => true)`)
    await waitFor(c, `document.querySelector('[data-batch-foot]')`, 60_000, "the master's board")
  }
  if (args.view !== 'board') {
    await c.eval(`window.__monocode.open(${JSON.stringify(shown.threadId)}, { split: ${args.view === 'split'} }).then(() => true)`)
    await waitFor(c, pane(shown.threadId), 60_000, `the transcript of ${shown.threadId}`)
  }
  log(`showing ${args.view} (${ids.join(', ')})`)
}

// ── the readings ─────────────────────────────────────────────────────────
type Proc = { pid: number; type: string; parent: number }
function processes(): Proc[] {
  if (linux) {
    return markedPids().flatMap((pid) => {
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'latin1').split('\0')
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
        const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
        return [{ pid, type: cmd.find((a) => a.startsWith('--type='))?.slice(7) ?? 'browser', parent }]
      } catch {
        return []
      }
    })
  }
  const marked = new Set(markedPids())
  const rows = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n')
  const all = rows.flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line)
    return m ? [{ pid: Number(m[1]), parent: Number(m[2]), type: /--type=(\S+)/.exec(m[3]!)?.[1] ?? 'browser' }] : []
  })
  // Helpers carry the main process's environment on macOS too; walk down from the marked ones to be sure.
  const ours = new Set(marked)
  for (let grew = true; grew; ) {
    grew = false
    for (const p of all) if (!ours.has(p.pid) && ours.has(p.parent)) (ours.add(p.pid), (grew = true))
  }
  return all.filter((p) => ours.has(p.pid))
}
function cpuSeconds(pid: number): number {
  if (linux) {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ')
    return (Number(f[11]) + Number(f[12])) / 100
  }
  const time = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  return time.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)
}
function memoryMb(pid: number): { mb: number; detail: Record<string, number> } {
  if (linux) {
    const s = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')
    const kb = (k: string): number => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(s)?.[1] ?? 0)
    const mb = (n: number): number => Math.round((n / 1024) * 10) / 10
    return { mb: mb(kb('Pss')), detail: { rss: mb(kb('Rss')), pss: mb(kb('Pss')), private: mb(kb('Private_Clean') + kb('Private_Dirty')), anonymous: mb(kb('Anonymous')) } }
  }
  const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim())
  return { mb: Math.round((rss / 1024) * 10) / 10, detail: { rss: Math.round((rss / 1024) * 10) / 10 } }
}

type Row = SoakSample & { gpuPct: number; cpuPct: number; memory: Record<string, number>; dom: Record<string, number>; measures: number; marks: number; animations: number; entries: number | null }

async function main(): Promise<void> {
  mkdirSync(ROOT, { recursive: true })
  if (args.gate) {
    // The step's own clock: past 90 s the run is a failure, whatever it measured.
    setTimeout(() => {
      console.error(`✗ the gate soak passed its ${GATE_TIMING.budgetMs / 1000} s budget`)
      void cleanup().finally(() => process.exit(1))
    }, GATE_TIMING.budgetMs).unref()
  }
  await launch()
  log(`launched ${args.build} from ${tree}`)
  const page = await pageOf()
  cdp = await Cdp.connect(page.webSocketDebuggerUrl!)
  const c = cdp
  await waitFor(c, `window.__monocode?.registry?.primary?.()?.connected && typeof window.__monocode.open === 'function'`, 90_000, 'the app (is the tree from this branch on?)')
  const shown = args.host === 'synthetic' ? await startSynthetic(c) : await pairBox(c)
  await openView(c, shown)
  await c.eval(OBSERVERS)
  await c.send('HeapProfiler.enable')

  const procs = processes()
  const renderer = procs
    .filter((p) => p.type === 'renderer')
    .map((p) => ({ ...p, mb: memoryMb(p.pid).mb }))
    .sort((a, b) => b.mb - a.mb)[0]
  if (!renderer) throw new Error("no renderer process carries the instance's marker")
  // Under xvfb the compositor may run inside another process; on Linux it is the one with a VizCompositor thread.
  const viz = (pid: number): boolean => {
    try {
      return readdirSync(`/proc/${pid}/task`).some((t) => readFileSync(`/proc/${pid}/task/${t}/comm`, 'utf8').startsWith('VizCompositor'))
    } catch {
      return false
    }
  }
  const gpu = procs.find((p) => p.type === 'gpu-process') ?? (linux ? procs.find((p) => p.pid !== renderer.pid && viz(p.pid)) : undefined)
  const types = [...new Set(procs.map((p) => p.type))].join(', ')
  log(`renderer ${renderer.pid}, gpu ${gpu?.pid ?? 'none'} (${procs.length} processes: ${types})`)

  const warmMs = args.gate ? GATE_TIMING.warmMs : 30_000
  log(`warming up ${warmMs / 1000} s`)
  await sleep(warmMs)
  await c.eval('window.__soakDrain()')

  const rows: Row[] = []
  const renderTotals = new Map<string, number>()
  let last = { t: Date.now(), cpu: cpuSeconds(renderer.pid), gpu: gpu ? cpuSeconds(gpu.pid) : 0 }
  const windowStart = Date.now()
  const take = async (): Promise<Row> => {
    await c.send('HeapProfiler.collectGarbage')
    await c.send('HeapProfiler.collectGarbage')
    const heap = (await c.send('Runtime.getHeapUsage')) as { usedSize: number }
    const memory = memoryMb(renderer.pid)
    const now = Date.now()
    const cpu = cpuSeconds(renderer.pid)
    const gpuCpu = gpu ? cpuSeconds(gpu.pid) : 0
    const wallS = (now - last.t) / 1000
    const dom = (await c.send('Memory.getDOMCounters')) as Record<string, number>
    const stats = await c.eval<{ measures: number; marks: number; animations: number; entries: number | null; tasks: { start: number; duration: number }[]; renders: [string, number][] }>(PAGE_STATS)
    let total = 0
    let family = 0
    for (const [name, n] of stats.renders) {
      renderTotals.set(name, (renderTotals.get(name) ?? 0) + n)
      total += n
      if (FAMILY.test(name)) family += n
    }
    const row: Row = {
      t: now - windowStart,
      heapMb: Math.round((heap.usedSize / 2 ** 20) * 10) / 10,
      rssMb: memory.mb,
      cpuS: cpu - last.cpu,
      wallS,
      gpuCpuS: gpuCpu - last.gpu,
      cpuPct: Math.round(((cpu - last.cpu) / wallS) * 1000) / 10,
      gpuPct: Math.round(((gpuCpu - last.gpu) / wallS) * 1000) / 10,
      longTasks: stats.tasks,
      ...(args.build === 'dev' ? { renders: { total, family } } : {}),
      memory: memory.detail,
      dom,
      measures: stats.measures,
      marks: stats.marks,
      animations: stats.animations,
      entries: stats.entries
    }
    last = { t: now, cpu, gpu: gpuCpu }
    return row
  }
  const windowMs = args.minutes * 60_000
  for (let i = 0; ; i++) {
    const due = windowStart + i * args.every * 1000
    if (due > windowStart + windowMs + 500) break
    while (Date.now() < due) await sleep(100)
    const row = await take()
    rows.push(row)
    // The first sample opens the window; its CPU covers only the forced GC before it.
    const cpuWords = i ? `  cpu ${row.cpuPct}%  gpu ${row.gpuPct}%` : ''
    log(`t ${(row.t / 1000).toFixed(0).padStart(4)}s  heap ${row.heapMb} MB  ${linux ? 'pss' : 'rss'} ${row.rssMb} MB${cpuWords}  long tasks ${row.longTasks.length}${row.renders ? `  renders ${row.renders.total} (family ${row.renders.family})` : ''}  nodes ${row.dom.nodes}`)
  }
  if (args.build === 'dev' && ![...renderTotals.values()].some(Boolean)) {
    throw new Error("a dev build showed no React component measures: React renamed or dropped its track, and the render counts are blind")
  }

  let profile: string | null = null
  if (args.profile) {
    log('CPU profile, 60 s')
    await c.send('Profiler.enable')
    await c.send('Profiler.setSamplingInterval', { interval: 1000 })
    await c.send('Profiler.start')
    await sleep(60_000)
    const { profile: cpuProfile } = (await c.send('Profiler.stop')) as { profile: CpuProfile }
    writeFileSync(join(ROOT, `${args.label}.cpuprofile`), JSON.stringify(cpuProfile))
    profile = profileSummary(cpuProfile)
  }

  const rule = args.gate ? GATE_RULE : handRule(args.build, args.view)
  const verdict = judgeSoak(rows, rule)
  const sha = (() => {
    try {
      return execFileSync('git', ['-C', tree, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  })()
  const topRenders = [...renderTotals].sort((a, b) => b[1] - a[1]).slice(0, 25)
  writeFileSync(
    join(ROOT, `${args.label}.json`),
    JSON.stringify({ label: args.label, args, tree, sha, platform: process.platform, memory: linux ? 'pss' : 'rss', shown, rule, verdict, rows, topRenders }, null, 1)
  )
  const md = [
    `# ${args.label}: ${args.host} host, ${args.build} build, ${args.view} view (${sha ?? 'no git'}, ${process.platform})`,
    '',
    `| t s | heap after GC MB | renderer ${linux ? 'PSS' : 'RSS'} MB | renderer CPU % | GPU CPU % | DOM nodes | listeners | long tasks (ms) | measures / marks |${args.build === 'dev' ? ' re-renders (family) |' : ''}`,
    `|---|---|---|---|---|---|---|---|---|${args.build === 'dev' ? '---|' : ''}`,
    ...rows.map(
      (r, i) =>
        `| ${(r.t / 1000).toFixed(0)} | ${r.heapMb} | ${r.rssMb} | ${i ? r.cpuPct : '–'} | ${i ? r.gpuPct : '–'} | ${r.dom.nodes} | ${r.dom.jsEventListeners} | ${r.longTasks.length} (${Math.round(r.longTasks.reduce((s, x) => s + x.duration, 0))}) | ${r.measures} / ${r.marks} |${r.renders ? ` ${r.renders.total} (${r.renders.family}) |` : ''}`
    ),
    '',
    `Rule: ${rule.name}`,
    '',
    '| reading | got | limit | |',
    '|---|---|---|---|',
    ...verdict.verdicts.map((v) => `| ${v.what} | ${v.got} | ${v.limit} | ${v.ok ? 'pass' : 'FAIL'} |`),
    ...(topRenders.length ? ['', 'Top re-rendered components (changed props):', '', '| component | renders |', '|---|---|', ...topRenders.map(([n, k]) => `| ${n} | ${k} |`)] : []),
    ...(profile ? ['', '```', profile, '```'] : [])
  ].join('\n')
  writeFileSync(join(ROOT, `${args.label}.md`), md + '\n')
  for (const v of verdict.verdicts) console.log(`${v.ok ? '✓' : '✗'} ${v.what}: ${v.got} (limit ${v.limit})`)
  console.log(`${verdict.ok ? 'passed' : 'FAILED'}: ${ROOT}/${args.label}.md`)
  process.exitCode = verdict.ok ? 0 : 1
}

try {
  await main()
} catch (error) {
  console.error(`✗ ${(error as Error).message}`)
  process.exitCode = 1
} finally {
  await cleanup()
  log('done')
}
process.exit(process.exitCode ?? 0)
