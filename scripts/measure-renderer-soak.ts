/**
 * The renderer over time: a built tree's window soaked under a busy host,
 * sampled for memory, CPU and long tasks, and judged against the Performance
 * 1 targets (docs/box.md "The renderer over time"). Runs on a fresh userData
 * under /tmp/tc-soak, windowed (xvfb-run off macOS), never the person's data.
 *
 *   bun scripts/measure-renderer-soak.ts --label before-board                # synthetic host, prod, board, 10 min
 *   bun scripts/measure-renderer-soak.ts --host box --view stream --minutes 30 --label after-box-stream
 *   bun scripts/measure-renderer-soak.ts --build dev --label dev-board       # needs port 5173 free
 *   bun scripts/measure-renderer-soak.ts --gate                              # the release gate's board scene, 90 s
 *   bun scripts/measure-renderer-soak.ts --gate --scene chat                 # its chat scene
 *   bun scripts/measure-renderer-soak.ts --scene scenarios --screencast /tmp/cast   # the no-jerk timeline, every frame
 *   bun scripts/measure-renderer-soak.ts --gate --cpu-report-only --trace 5  # a hand run: CPU read, not failed, and the frames traced
 *
 * --host synthetic (default) boots scripts/soak-host.ts in a child (a
 *   pinned master, sixteen batch children, the fixed load of soakLoad.ts;
 *   with --scene chat, one plain chat thread with the focused child's load,
 *   shown as a stream)
 *   and pairs with its operate key; box pairs read-only with the real box
 *   (the box's local socket when this runs on the box, else a pairing code
 *   over `ssh box tc-local`), the key or code held in this process only and
 *   revoked at exit. --master and --thread pick the box's threads, else the
 *   busiest pinned master and its newest running child.
 * --build prod (default) runs `electron-vite preview --skipBuild` (the tree's
 *   out/ must be built); dev runs `electron-vite dev` (on 5173, else the next
 *   free port), which writes its own main build into the tree's out/.
 * --view board | stream | split: the master's board, the focused child's
 *   transcript, or both side by side (window.__monocode.open).
 * --minutes, --every: the run and the sampling interval (default 10, 60 s),
 *   after a 30 s warm-up. --tree: the built tree to run (default this
 *   checkout). --port: the window's debug port (default 9251). --no-profile:
 *   skip the 60 s CPU profile at the end.
 * --gate: the release gate's bounded run (scripts/gate.ts renderer-soak and
 *   renderer-soak-chat): synthetic host, production build, the board
 *   scene's split view or the chat scene's stream, a 10 s warm-up and a 50 s
 *   window inside a hard 90 s from launch to teardown, judged by the gate's
 *   rule for the scene (scripts/lib/soakJudge.ts gateRule, GATE_CPU_PCT); its
 *   CPU bound fails the run unless --cpu-report-only.
 * --trace <s>: after the window, a trace that long read into who asks for
 *   each main-thread frame (scripts/lib/soakTrace.ts), written beside the
 *   report as <label>.trace.json. --eval <js>: an experiment evaluated in the
 *   page once the view is open, before the warm-up (docs/box.md has the ones
 *   that sized the bounds).
 * --burst <ms> (chat scene): the stream's deltas leave together about every
 *   <ms> ± 30%, with a 1 s stall every 10 s (soakLoad.ts BurstCadence).
 *   --reveal-report: the streaming reveal's steps over the window, their gaps
 *   and sizes, read by an observer the script installs (scripts/lib/revealReport.ts).
 * --height-report (--scene scenarios): every open tool table and code block
 *   watched for a height that jumps instead of gliding (scripts/lib/heightReport.ts);
 *   a jump fails the run, except under --reduced-motion, which steps by design.
 *   With --scrolled-up the run also fails when the reader's top row moved
 *   while turn 6 streamed (each send parks the prompt, by design).
 * --scene typing: the board scene's load with the master's own churn and
 *   its live edits (soakLoad.ts TYPING_PROFILE), the master's board and
 *   chat open, its composer typed into in phases (scripts/lib/soakTyping.ts:
 *   idle with the load paused, busy, fast, a burst and a paste), each phase's
 *   keystroke-to-frame latency, input delay, Event Timing, long tasks, long
 *   animation frames with their scripts and the store's counters read, its
 *   text checked exactly, and the field cleared; never sent. Judged by
 *   soakJudge.ts TYPING_RULE, with --gate on the gate's shorter phases
 *   (scripts/gate.ts renderer-soak-typing). --trace traces the busy phase;
 *   --why (dev) tallies the re-renders while typing busy against a quiet
 *   window as long. Against --host box it skips the idle phase (no pause).
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
import { homedir, loadavg } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Cdp, REPO, portFree, sleep, type Target } from './lib/packagedApp'
import { profileSummary, type CpuProfile } from './profile-summary'
import { summarizeTrace, TRACE_CATEGORIES, traceMarkdown, type TraceEvent, type TraceSummary } from './lib/soakTrace'
import { REVEAL_OBSERVER, revealLine, summarizeReveal, type RevealRecord } from './lib/revealReport'
import { HEIGHT_OBSERVER, heightLine, summarizeHeights, type HeightRecord } from './lib/heightReport'
import { REVEAL } from '../src/renderer/src/lib/ease'
import { buildIsCurrent, FAMILY, GATE_TIMING, gateRule, handRule, judgeScroll, judgeSend, judgeSoak, judgeSwitch, judgeTyping, parseSoakArgs, REACT_MEASURE_PREFIX, SCROLL_RULE, SEND_RULE, SWITCH_RULE, TYPING_RULE, type BuildStamp, type GateScene, type SoakSample } from './lib/soakJudge'
import { scenarioLength, questionClicks } from './lib/soakScenarios'
import { spread, summarizePhase, typingGaps, typingMarkdown, typingPhases, typingProse, type PhaseSummary, type TypingRecords } from './lib/soakTyping'
import { summarizeSwitch, switchMarkdown, type SwitchClick, type SwitchView } from './lib/soakSwitch'
import { displayInterval, scrollMarkdown, summarizeFrames, wheelPlan, type FrameRun, type ScrollResult, type ScrollSurface } from './lib/soakScroll'

const args = parseSoakArgs(process.argv.slice(2).filter((a) => a !== '--why'))
/** Hand runs on a dev build: also tally the props React names as changed, per component. */
const why = process.argv.includes('--why')
const ROOT = '/tmp/tc-soak'
const tree = resolve(args.tree ?? REPO)
const userData = join(ROOT, `${args.label}.userData`)
const home = join(ROOT, `${args.label}.home`)
const MARKER = `TEMP_CODE_USER_DATA=${userData}`
const CLIENT = 'renderer-soak'
const BOX_ORIGIN = 'https://tempcode.landonhale.com'
const BOX_SERVER_JSON = '/srv/agents/temp-code-data/server.json'
const linux = process.platform === 'linux'
const mac = process.platform === 'darwin'
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
      if (m && Number(m[1]) !== process.pid && ` ${m[2]!} `.includes(` ${MARKER} `)) out.push(Number(m[1]))
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
  // electron-vite dev takes the next free port when 5173 is busy and points its main process at it.
  if (args.build === 'dev' && !(await portFree(5173))) log('5173 is taken: the dev server takes the next free port')
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
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && (t.url.endsWith('/index.html') || /^http:\/\/localhost:\d+\/$/.test(t.url)))
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
  const s = (window.__soak = { tasks: [], renders: new Map(), renderMs: new Map() })
  new PerformanceObserver((list) => { for (const e of list.getEntries()) s.tasks.push({ start: e.startTime, duration: e.duration }) }).observe({ type: 'longtask' })
  // --why: the props React's diff names as changed, per component (its detail's "+ key" rows at the top level).
  s.why = new Map()
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.name.charCodeAt(0) !== ${REACT_MEASURE_PREFIX.charCodeAt(0)}) continue
      const n = e.name.slice(1)
      s.renders.set(n, (s.renders.get(n) || 0) + 1)
      s.renderMs.set(n, (s.renderMs.get(n) || 0) + e.duration)
      if (!window.__soakWhyOn) continue
      const props = e.detail && e.detail.devtools && e.detail.devtools.properties
      if (!Array.isArray(props)) continue
      let byProp = s.why.get(n)
      if (!byProp) s.why.set(n, (byProp = new Map()))
      // React's diff rows: a mark ("+" added, "-" removed, a figure space for a
      // nested header), a no-break space, two more per level, the key. A header
      // for an object or a closure that is new but equal says so in its value.
      const path = []
      const note = (k) => byProp.set(k, (byProp.get(k) || 0) + 1)
      for (const row of props) {
        const label = String(row[0])
        const value = String(row[1] == null ? '' : row[1])
        let at = 2
        let depth = 0
        while (label.charCodeAt(at) === 160 && label.charCodeAt(at + 1) === 160) { depth++; at += 2 }
        const key = label.slice(at)
        path.length = depth
        const mark = label.charAt(0)
        if (mark === '+') note([...path, key].join('.'))
        else if (mark !== '-') {
          path[depth] = key
          if (value.indexOf('deeply equal') >= 0) note(path.join('.') + ' (equal object)')
          else if (value.indexOf('function closure') >= 0) note(path.join('.') + ' (equal closure)')
        }
      }
    }
  }).observe({ type: 'measure' })
  window.__soakWhy = () => [...s.why].map(([n, byProp]) => [n, [...byProp].sort((a, b) => b[1] - a[1]).slice(0, 6)])
  // --why in a dev build: who renders them. Each commit, every function
  // component that rendered with new props is counted under its owner chain
  // (React's dev-only _debugOwner), three owners deep.
  s.owners = new Map()
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__
  const nameOf = (f) => { const t = f && f.type; if (!t) return null; if (typeof t === 'function') return t.displayName || t.name || null; return t.displayName || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)) || null }
  if (hook && typeof hook.onCommitFiberRoot === 'function' && !hook.__soakWrapped) {
    const prior = hook.onCommitFiberRoot.bind(hook)
    hook.__soakWrapped = true
    // A fiber's actualStartTime (a dev build profiles every root) moves only
    // when it begins work: past the last commit's latest, it rendered in this one.
    let lastStart = -1
    hook.onCommitFiberRoot = (id, root, ...rest) => {
      try {
        if (window.__soakWhyOn) {
          let latest = lastStart
          const stack = [root.current]
          while (stack.length) {
            const f = stack.pop()
            if (f.child) stack.push(f.child)
            if (f.sibling) stack.push(f.sibling)
            const started = f.actualStartTime
            if (typeof started !== 'number' || started <= lastStart) continue
            if (started > latest) latest = started
            const a = f.alternate
            // Rendered in this commit with a new props object: the condition React's own measure uses.
            if (!a || a.memoizedProps === f.memoizedProps || (f.tag !== 0 && f.tag !== 11 && f.tag !== 14 && f.tag !== 15)) continue
            const chain = []
            for (let o = f._debugOwner; o && chain.length < 3; o = o._debugOwner) { const n = nameOf(o); if (n) chain.push(n) }
            const key = (nameOf(f) || '?') + ' < ' + chain.join(' < ')
            s.owners.set(key, (s.owners.get(key) || 0) + 1)
          }
          lastStart = latest
        }
      } catch {}
      return prior(id, root, ...rest)
    }
  }
  window.__soakOwners = () => [...s.owners].sort((a, b) => b[1] - a[1]).slice(0, 40)
  window.__soakDrain = () => {
    const out = { tasks: s.tasks, renders: [...s.renders], renderMs: [...s.renderMs] }
    s.tasks = []
    s.renders = new Map()
    s.renderMs = new Map()
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

/** How the synthetic host runs: bun with the electron stub on Linux (relative
 *  paths from the checkout, which the host's port sweep knows for a proof);
 *  on macOS bundled by esbuild under node, since the Mac's bun has no
 *  node:sqlite (scripts/ios-client-test.ts runs its server the same way). */
function hostCommand(): [string, string[]] {
  const burst = args.burstMs ? ['--burst', String(args.burstMs)] : []
  const history = args.scene === 'send' || args.scene === 'scroll' ? ['--history', String(args.history)] : []
  if (!mac) return [process.execPath, ['--preload', 'scripts/lib/electron-stub.ts', 'scripts/soak-host.ts', '--scene', args.scene, ...burst, ...history]]
  const out = join(REPO, 'scripts', '.out', 'soak-host.mjs')
  execFileSync(
    join(REPO, 'node_modules', '.bin', 'esbuild'),
    [
      'scripts/soak-host.ts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--packages=external',
      '--alias:@shared=./src/shared',
      '--alias:aliax-core=./node_modules/aliax-core/src',
      '--alias:electron=./scripts/electron-shim.mjs',
      `--outfile=${out}`,
      '--log-level=warning'
    ],
    { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] }
  )
  return ['node', [out, '--scene', args.scene, ...burst, ...history]]
}

async function startSynthetic(c: Cdp): Promise<Shown> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('TEMP_CODE_') && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  env.NODE_ENV = 'production'
  if (args.peerDelayMs) env.TEMP_CODE_PEER_DELAY_MS = String(args.peerDelayMs)
  const hostLog = join(ROOT, `${args.label}.host.log`)
  soakHost = spawn(...hostCommand(), {
    cwd: REPO,
    env,
    stdio: ['pipe', 'pipe', openSync(hostLog, 'w')],
    detached: true
  })
  const tail = (): string => {
    try {
      return readFileSync(hostLog, 'utf8').trim().split('\n').slice(-12).join('\n')
    } catch {
      return ''
    }
  }
  const line = await new Promise<string>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('the synthetic host did not start within 30 s')), 30_000)
    const lines = createInterface({ input: soakHost!.stdout! })
    lines.on('line', (l) => {
      if (!l.startsWith('{')) return
      clearTimeout(timer)
      lines.close()
      ok(l)
    })
    soakHost!.on('exit', (code) => fail(new Error(`the synthetic host exited (${code}); its log (${hostLog}) ends:\n${tail()}`)))
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
  if (!picked.masterId && args.view !== 'stream' && args.scene !== 'switch') throw new Error('the box has no pinned master to show (name one with --master)')
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
  // macOS may show no environment for a hardened process, so walk down from
  // the process this run spawned as well as from the marked ones.
  const ours = new Set(marked)
  if (app?.pid) ours.add(app.pid)
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

/** The gate's out/ must be HEAD's: release-publish says so with build.done
 *  (TEMP_CODE_SOAK_BUILD_DONE, waited for up to 10 minutes while its build
 *  runs beside the gate); anywhere else the bundle map's stamp decides, and a
 *  stale or dirty build is rebuilt first. */
async function freshBuild(): Promise<void> {
  const done = process.env.TEMP_CODE_SOAK_BUILD_DONE
  if (done) {
    const until = Date.now() + 10 * 60_000
    while (!existsSync(done)) {
      if (Date.now() > until) throw new Error('the build never finished: no build.done within 10 minutes')
      await sleep(1_000)
    }
    log("the publish build finished: soaking its out/")
    return
  }
  const git = (...a: string[]): string => execFileSync('git', ['-C', tree, ...a], { encoding: 'utf8' }).trim()
  const head = git('rev-parse', 'HEAD')
  const clean = git('status', '--porcelain', '--untracked-files=no') === ''
  let stamp: BuildStamp = null
  try {
    stamp = (JSON.parse(readFileSync(join(tree, 'out', 'bundle-map.json'), 'utf8')) as { head?: BuildStamp }).head ?? null
  } catch {
    /* no build yet */
  }
  if (buildIsCurrent(stamp, head, clean)) return
  log(`out/ is not HEAD's build (${stamp?.sha ? `${stamp.sha.slice(0, 8)}${stamp.clean ? '' : ', dirty'}` : 'none'}, HEAD ${head.slice(0, 8)}${clean ? '' : ' dirty'}): building first`)
  execFileSync(join(tree, 'node_modules', '.bin', 'electron-vite'), ['build'], { cwd: tree, stdio: ['ignore', 'ignore', 'inherit'] })
}

/** A trace of the window after the soak's own: every running animation is
 *  restarted first, so the trace records whether each runs on the compositor. */
async function traceFrames(c: Cdp, seconds: number): Promise<TraceSummary> {
  log(`trace, ${seconds} s`)
  const events: TraceEvent[] = []
  const done = new Promise<void>((ok) => c.on('Tracing.tracingComplete', () => ok()))
  c.on('Tracing.dataCollected', (p) => events.push(...((p as { value: TraceEvent[] }).value)))
  await c.send('Tracing.start', { categories: TRACE_CATEGORIES, transferMode: 'ReportEvents' })
  await sleep(200)
  await c.eval(`document.getAnimations().filter((a) => a.playState === 'running').map((a) => (a.cancel(), a.play())).length`)
  await sleep(seconds * 1000)
  await c.send('Tracing.end')
  await done
  writeFileSync(join(ROOT, `${args.label}.trace.json`), JSON.stringify(events))
  const summary = summarizeTrace(events)
  for (const line of traceMarkdown(summary).slice(0, 3)) if (line) log(line)
  return summary
}

async function main(): Promise<void> {
  mkdirSync(ROOT, { recursive: true })
  if (args.gate) await freshBuild()
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
  if (args.scene !== 'switch') await openView(c, shown)
  await c.eval(OBSERVERS)
  if (args.evalJs) log(`experiment: ${JSON.stringify(await c.eval(args.evalJs))}`)
  if (args.reducedMotion) {
    await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    log('prefers-reduced-motion: reduce')
  }
  if (args.scene === 'scenarios') {
    await recordScenarios(c)
    return
  }
  if (why) await c.eval('window.__soakWhyOn = true')
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
  if (args.scene === 'typing') {
    await recordTyping(c, shown, renderer.pid)
    return
  }
  if (args.scene === 'switch') {
    await recordSwitch(c)
    return
  }
  if (args.scene === 'send') {
    await recordSend(c, shown)
    return
  }
  if (args.scene === 'scroll') {
    await recordScroll(c)
    return
  }

  const warmMs = args.gate ? GATE_TIMING.warmMs : 30_000
  log(`warming up ${warmMs / 1000} s`)
  await sleep(warmMs)
  await c.eval('window.__soakDrain()')
  if (args.revealReport) log(`reveal observer ${await c.eval(REVEAL_OBSERVER)}`)

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

  const reveal = args.revealReport ? summarizeReveal(await c.eval<RevealRecord[]>('window.__revealSteps()'), REVEAL.stepMs) : null
  if (reveal) log(`reveal: ${revealLine(reveal)}`)
  const trace = args.traceS ? await traceFrames(c, args.traceS) : null
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

  const rule = args.gate ? gateRule(args.scene as GateScene, args.cpuReportOnly) : handRule(args.build, args.view)
  const verdict = judgeSoak(rows, rule)
  const sha = (() => {
    try {
      return execFileSync('git', ['-C', tree, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  })()
  const topRenders = [...renderTotals].sort((a, b) => b[1] - a[1]).slice(0, why ? 45 : 25)
  const whyRows = why ? await c.eval<[string, [string, number][]][]>('window.__soakWhy()') : []
  const whyTop = topRenders.map(([n]) => [n, whyRows.find(([m]) => m === n)?.[1] ?? []] as const)
  const owners = why ? await c.eval<[string, number][]>('window.__soakOwners ? window.__soakOwners() : []') : []
  writeFileSync(
    join(ROOT, `${args.label}.json`),
    JSON.stringify({ label: args.label, args, tree, sha, platform: process.platform, memory: linux ? 'pss' : 'rss', shown, rule, verdict, rows, topRenders, trace, reveal, ...(why ? { whyTop, owners } : {}) }, null, 1)
  )
  const md = [
    `# ${args.label}: ${args.host} host, ${args.scene} scene, ${args.build} build, ${args.view} view (${sha ?? 'no git'}, ${process.platform})`,
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
    ...verdict.verdicts.map((v) => `| ${v.what} | ${v.got} | ${v.limit} | ${v.ok ? 'pass' : v.reportOnly ? 'over, reported' : 'FAIL'} |`),
    ...(topRenders.length
      ? ['', 'Top re-rendered components (changed props):', '', `| component | renders |${why ? ' changed props |' : ''}`, `|---|---|${why ? '---|' : ''}`, ...topRenders.map(([n, k]) => `| ${n} | ${k} |${why ? ` ${(whyTop.find(([m]) => m === n)?.[1] ?? []).map(([p, x]) => `${p} ${x}`).join(', ')} |` : ''}`)]
      : []),
    ...(owners.length ? ['', 'Re-renders by owner chain (component < owner < its owner):', '', '| chain | renders |', '|---|---|', ...owners.map(([k, n]) => `| ${k} | ${n} |`)] : []),
    ...(reveal ? ['', `Reveal: ${revealLine(reveal)}`] : []),
    ...(trace ? ['', ...traceMarkdown(trace)] : []),
    ...(profile ? ['', '```', profile, '```'] : [])
  ].join('\n')
  writeFileSync(join(ROOT, `${args.label}.md`), md + '\n')
  for (const v of verdict.verdicts) console.log(`${v.ok ? '✓' : v.reportOnly ? '!' : '✗'} ${v.what}: ${v.got} (limit ${v.limit}${v.reportOnly ? ', reported only' : ''})`)
  console.log(`${verdict.ok ? 'passed' : 'FAILED'}: ${ROOT}/${args.label}.md`)
  process.exitCode = verdict.ok ? 0 : 1
}

// ── typing, measured ─────────────────────────────────────────────────────
/** The master's composer: the one field on screen, kept as window.__typingField. */
const TYPING_FIELD = `(() => {
  const fields = [...document.querySelectorAll('[data-composer-input]')].filter((e) => e.getBoundingClientRect().width > 0)
  if (fields.length !== 1) return { count: fields.length }
  window.__typingField = fields[0]
  const r = fields[0].getBoundingClientRect()
  return { count: 1, x: r.x + r.width / 2, y: r.y + r.height / 2, width: Math.round(r.width), text: fields[0].textContent }
})()`

/** The page side of a typing phase: per keystroke its timestamp, its handler
 *  and the end of the next frame's work; Event Timing, long tasks and long
 *  animation frames; the store's flushes, meta flushes, the master's meta
 *  changes and its live-edit items. begin() opens a window, end() reads it. */
const typingObservers = (masterId: string): string => `(() => {
  if (window.__typing) return true
  const field = window.__typingField
  const store = window.__monocode.sessionStore
  const s = (window.__typing = { active: false, keys: [], events: [], tasks: [], frames: [] })
  const ch = new MessageChannel()
  const pending = new Map()
  let seq = 0
  ch.port1.onmessage = (e) => {
    const rec = pending.get(e.data)
    if (rec) { rec.frame = performance.now(); pending.delete(e.data) }
  }
  document.addEventListener('keydown', (e) => {
    if (!s.active || e.target !== field) return
    const rec = { stamp: e.timeStamp, handler: performance.now(), frame: null }
    s.keys.push(rec)
    const id = seq++
    pending.set(id, rec)
    requestAnimationFrame(() => ch.port2.postMessage(id))
  }, true)
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.interactionId) s.events.push({ interactionId: e.interactionId, duration: e.duration, start: e.startTime }) }).observe({ type: 'event', durationThreshold: 16, buffered: true })
  new PerformanceObserver((list) => { for (const e of list.getEntries()) s.tasks.push({ start: e.startTime, duration: e.duration }) }).observe({ type: 'longtask' })
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration <= 50) continue
        const scripts = [...(e.scripts || [])].sort((a, b) => b.duration - a.duration).slice(0, 3)
        s.frames.push({ start: e.startTime, duration: e.duration, blocking: e.blockingDuration || 0, scripts: scripts.map((x) => ({ invoker: String(x.invoker || ''), fn: String(x.sourceFunctionName || ''), url: String(x.sourceURL || ''), duration: x.duration })) })
      }
    }).observe({ type: 'long-animation-frame' })
  } catch {}
  const counts = { flushes: 0, metaFlushes: 0, masterMetas: 0 }
  store.subscribe(() => counts.flushes++)
  store.onMetaChange((c) => { counts.metaFlushes++; if (c.ids.has(${JSON.stringify(masterId)})) counts.masterMetas++ })
  const read = () => ({ ...counts, liveEdits: store.pushCounts().liveEdit ?? 0 })
  s.begin = () => { s.keys = []; s.t0 = performance.now(); s.c0 = read(); s.active = true; return s.t0 }
  s.end = () => {
    s.active = false
    const t0 = s.t0, t1 = performance.now(), c1 = read()
    const inWindow = (x) => x.start >= t0 && x.start < t1
    const longest = new Map()
    for (const e of s.events) if (inWindow(e) && (longest.get(e.interactionId)?.duration ?? -1) < e.duration) longest.set(e.interactionId, e)
    return {
      keys: s.keys,
      events: [...longest.values()].map((e) => ({ interactionId: e.interactionId, duration: e.duration })),
      longTasks: s.tasks.filter(inWindow),
      frames: s.frames.filter(inWindow),
      store: { flushes: c1.flushes - s.c0.flushes, metaFlushes: c1.metaFlushes - s.c0.metaFlushes, masterMetas: c1.masterMetas - s.c0.masterMetas, liveEdits: c1.liveEdits - s.c0.liveEdits },
      windowMs: t1 - t0
    }
  }
  return true
})()`

/**
 * `--scene typing`: the master's composer typed into, phase by phase
 * (scripts/lib/soakTyping.ts), never sent. The idle phase pauses the
 * synthetic host's load over its stdin and waits for its answer; the box
 * has no pause, so a box run skips it. CPU and memory are read across the
 * phases and reported, not judged.
 */
async function recordTyping(c: Cdp, shown: Shown, rendererPid: number): Promise<void> {
  const canPause = args.host === 'synthetic' && !!soakHost?.stdin
  if (!canPause) log('the box has no pause: the idle phase is skipped')
  const answers = soakHost?.stdout ? createInterface({ input: soakHost.stdout }) : null
  const control = (command: 'pause' | 'resume'): Promise<void> =>
    new Promise((ok, fail) => {
      const want = command === 'pause' ? '"paused"' : '"resumed"'
      const timer = setTimeout(() => fail(new Error(`the synthetic host did not answer ${command}`)), 10_000)
      const onLine = (line: string): void => {
        if (!line.includes(want)) return
        clearTimeout(timer)
        answers!.off('line', onLine)
        ok()
      }
      answers!.on('line', onLine)
      soakHost!.stdin!.write(`${command}\n`)
    })
  log('warming up 3 s')
  await sleep(3_000)
  // The view may still be settling (a host's rows landing): click until the field takes focus.
  const until = Date.now() + 30_000
  let field = { count: 0, x: 0, y: 0, width: 0, text: '' }
  let focused = false
  while (!focused && Date.now() < until) {
    field = await c.eval(TYPING_FIELD)
    if (field.count === 1) {
      if (field.text) throw new Error('the composer already holds text')
      for (const type of ['mousePressed', 'mouseReleased'] as const) await c.send('Input.dispatchMouseEvent', { type, x: field.x, y: field.y, button: 'left', clickCount: 1 })
      focused = await c.eval<boolean>('document.activeElement === window.__typingField')
    }
    if (!focused) await sleep(500)
  }
  if (field.count !== 1) throw new Error(`expected one composer on screen, found ${field.count}`)
  if (!focused) throw new Error('the composer did not take focus')
  await c.eval(typingObservers(shown.masterId))
  log(`typing into the master's composer (${field.width}px wide)`)

  const key = async (k: string, text?: string, modifiers = 0, extra: Record<string, unknown> = {}): Promise<void> => {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text, modifiers, timestamp: Date.now() / 1000, ...extra })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, modifiers, timestamp: Date.now() / 1000, ...extra })
  }
  const fieldText = (): Promise<string> => c.eval<string>('window.__typingField.textContent')
  const clear = async (): Promise<void> => {
    const select = { code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, commands: ['selectAll'] }
    await key('a', undefined, mac ? 4 : 2, select)
    await key('Backspace', undefined, 0, { windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    await sleep(150)
    const left = await fieldText()
    if (left !== '') throw new Error(`the composer did not clear (${left.length} characters left)`)
  }
  const sample = async (): Promise<{ at: number; heapMb: number; rssMb: number; cpuS: number }> => {
    await c.send('HeapProfiler.collectGarbage')
    const heap = (await c.send('Runtime.getHeapUsage')) as { usedSize: number }
    return { at: Date.now(), heapMb: Math.round((heap.usedSize / 2 ** 20) * 10) / 10, rssMb: memoryMb(rendererPid).mb, cpuS: cpuSeconds(rendererPid) }
  }

  const before = await sample()
  const summaries: PhaseSummary[] = []
  let trace: TraceSummary | null = null
  let renders: { typing: [string, number][]; quiet: [string, number][]; ms: number } | null = null
  for (const [i, phase] of typingPhases(args.gate, canPause).entries()) {
    if (phase.name === 'idle') {
      await control('pause')
      await sleep(1_000)
    }
    const expected = typingProse(phase.count, 7 + i)
    if (why && phase.name === 'busy') await c.eval('window.__soakDrain()')
    const tracing = args.traceS && phase.name === 'busy' ? traceFrames(c, args.traceS) : null
    await c.eval('window.__typing.begin()')
    if (phase.name === 'paste') {
      await c.eval(`(() => {
        const data = new DataTransfer()
        data.setData('text/plain', ${JSON.stringify(expected)})
        window.__typingField.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
        return true
      })()`)
    } else {
      const gaps = typingGaps(phase.cadence, phase.count, 123_456_789 + i)
      for (const [k, ch] of [...expected].entries()) {
        await key(ch, ch)
        if (gaps[k]) await sleep(gaps[k]!)
      }
    }
    await sleep(1_000)
    const records = await c.eval<TypingRecords>('window.__typing.end()')
    const summary = summarizePhase(phase, records, expected, await fieldText())
    summaries.push(summary)
    log(`${phase.name}: ${summary.count} in ${summary.seconds} s, key → frame p95 ${summary.frame.p95 ?? '–'} ms, max ${summary.frame.max ?? '–'} ms, long tasks ${summary.longTasks.count} (worst ${summary.longTasks.maxMs} ms), text ${summary.text.ok ? 'exact' : `differs at ${summary.text.firstDifference}`}`)
    if (tracing) trace = await tracing
    if (why && phase.name === 'busy') {
      // The same window's length again with the draft held and nothing typed.
      const typed = (await c.eval<{ renders: [string, number][] }>('window.__soakDrain()')).renders
      await sleep(records.windowMs)
      const quiet = (await c.eval<{ renders: [string, number][] }>('window.__soakDrain()')).renders
      const top = (r: [string, number][]): [string, number][] => [...r].sort((a, b) => b[1] - a[1]).slice(0, 25)
      renders = { typing: top(typed), quiet: top(quiet), ms: Math.round(records.windowMs) }
    }
    if (phase.name === 'idle') {
      await control('resume')
      await sleep(2_000)
    }
    await clear()
  }
  const after = await sample()
  answers?.close()

  const verdict = judgeTyping(summaries)
  const wall = (after.at - before.at) / 1000
  const usage = {
    cpuPct: Math.round(((after.cpuS - before.cpuS) / wall) * 1000) / 10,
    heapGrowthMb: Math.round((after.heapMb - before.heapMb) * 10) / 10,
    rssGrowthMb: Math.round((after.rssMb - before.rssMb) * 10) / 10,
    seconds: Math.round(wall)
  }
  const sha = (() => {
    try {
      return execFileSync('git', ['-C', tree, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  })()
  const owners = why ? await c.eval<[string, number][]>('window.__soakOwners ? window.__soakOwners() : []') : []
  // The props React's diff named as changed, per component, the whole run.
  const whyRows = why ? await c.eval<[string, [string, number][]][]>('window.__soakWhy()') : []
  writeFileSync(join(ROOT, `${args.label}.json`), JSON.stringify({ label: args.label, args, tree, sha, platform: process.platform, shown, rule: TYPING_RULE, verdict, phases: summaries, usage, trace, renders, owners, why: whyRows }, null, 1))
  const propsOf = (n: string): string => (whyRows.find(([m]) => m === n)?.[1] ?? []).map(([p, x]) => `${p} ${x}`).join(', ')
  const renderTable = (rows: [string, number][]): string[] => ['| component | renders | changed props, the whole run |', '|---|---|---|', ...rows.map(([n, k]) => `| ${n} | ${k} | ${propsOf(n)} |`)]
  const md = [
    `# ${args.label}: ${args.host} host, typing scene, ${args.build} build (${sha ?? 'no git'}, ${process.platform}, load ${loadavg()[0]!.toFixed(1)})`,
    '',
    ...typingMarkdown(summaries),
    '',
    `Across the phases (${usage.seconds} s, reported, not judged): renderer CPU ${usage.cpuPct}% of one core, heap after GC ${usage.heapGrowthMb >= 0 ? '+' : ''}${usage.heapGrowthMb} MB, renderer ${linux ? 'PSS' : 'RSS'} ${usage.rssGrowthMb >= 0 ? '+' : ''}${usage.rssGrowthMb} MB.`,
    '',
    `Rule: ${TYPING_RULE.name}`,
    '',
    '| reading | got | limit | |',
    '|---|---|---|---|',
    ...verdict.verdicts.map((v) => `| ${v.what} | ${v.got} | ${v.limit} | ${v.ok ? 'pass' : 'FAIL'} |`),
    ...(renders ? ['', `Re-renders with changed props while typing busy (${renders.ms} ms):`, '', ...renderTable(renders.typing), '', 'And in a quiet window as long, the draft held:', '', ...renderTable(renders.quiet)] : []),
    ...(owners.length ? ['', 'Re-renders by owner chain, the whole run:', '', '| chain | renders |', '|---|---|', ...owners.map(([k, n]) => `| ${k} | ${n} |`)] : []),
    ...(trace ? ['', 'The busy phase, traced:', '', ...traceMarkdown(trace)] : [])
  ].join('\n')
  writeFileSync(join(ROOT, `${args.label}.md`), md + '\n')
  for (const v of verdict.verdicts) console.log(`${v.ok ? '✓' : '✗'} ${v.what}: ${v.got} (limit ${v.limit})`)
  console.log(`${verdict.ok ? 'passed' : 'FAILED'}: ${ROOT}/${args.label}.md`)
  process.exitCode = verdict.ok ? 0 : 1
}

// ── switching workspaces, measured ───────────────────────────────────────
/** The page side of a switch: long tasks, long animation frames, what the
 *  window shows (the column's cards, the strip's threads, the pane and its
 *  rows), and arm(expect), which follows each frame until the column and
 *  strip read as expected and the pane shows its landing thread's rows. */
const SWITCH_OBSERVERS = `(() => {
  if (window.__switch) return true
  const s = (window.__switch = { tasks: [], frames: [] })
  new PerformanceObserver((list) => { for (const e of list.getEntries()) s.tasks.push({ start: e.startTime, duration: e.duration }) }).observe({ type: 'longtask' })
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration <= 50) continue
        const scripts = [...(e.scripts || [])].sort((a, b) => b.duration - a.duration).slice(0, 3)
        s.frames.push({ start: e.startTime, duration: e.duration, scripts: scripts.map((x) => (x.sourceFunctionName || x.invoker || '?') + ' ' + Math.round(x.duration) + ' ms') })
      }
    }).observe({ type: 'long-animation-frame' })
  } catch {}
  const shown = (e) => e.getBoundingClientRect().width > 0 && !e.closest('.tab-parked, .board-parked')
  s.row = (name) => [...document.querySelectorAll('nav[aria-label="Workspaces"] button')].filter(shown).find((e) => { const t = e.getAttribute('aria-label') || e.textContent.trim(); return t === name || t.startsWith(name + ',') })
  s.read = () => {
    const pane = [...document.querySelectorAll('[data-session-drop]')].find(shown)
    return {
      cards: [...document.querySelectorAll('button[data-project-card]')].filter(shown).map((e) => (e.getAttribute('aria-label') || '').split(',')[0]).sort(),
      chips: [...document.querySelectorAll('[data-strip="live"] [role="tab"] [data-chip-title]')].filter(shown).map((e) => e.getAttribute('data-text') || e.textContent.trim()),
      pane: pane ? pane.getAttribute('data-session-drop') : null,
      rows: pane ? pane.querySelectorAll('[data-row], [data-menu-id]').length : 0,
    }
  }
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
  s.arm = (expect) => {
    const run = (s.run = { t0: performance.now(), ready: null, pane: null, waits: !!expect.pane })
    const ch = new MessageChannel()
    ch.port1.onmessage = (e) => { if (run[e.data] === null) run[e.data] = performance.now() }
    const tick = () => {
      if (s.run !== run || performance.now() - run.t0 > 5000) return
      const now = s.read()
      const ready = same(now.cards, expect.cards) && (expect.chips.length ? now.chips.some((c) => expect.chips.includes(c)) : now.chips.length === 0)
      if (ready) ch.port2.postMessage('ready')
      if (expect.pane && now.pane === expect.pane && now.rows > 0) ch.port2.postMessage('pane')
      if (!ready || (expect.pane && !(now.pane === expect.pane && now.rows > 0))) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return run.t0
  }
  return true
})()`

/**
 * `--scene switch`: the rail's two workspaces clicked in turn. A warm-up
 * visit to each records what it shows once settled (3 s); then each click is
 * timed to the end of the first frame showing that view's cards and strip,
 * and to its landing thread's rows. The requests each click sent are counted
 * off the window's sockets. `--trace <s>` traces the first measured clicks.
 */
async function recordSwitch(c: Cdp): Promise<void> {
  await c.eval(SWITCH_OBSERVERS)
  const [a, b] = args.workspaces
  const until = Date.now() + 60_000
  while (Date.now() < until && !(await c.eval<boolean>(`!!window.__switch.row(${JSON.stringify(a)}) && !!window.__switch.row(${JSON.stringify(b)})`))) await sleep(500)
  if (!(await c.eval<boolean>(`!!window.__switch.row(${JSON.stringify(a)}) && !!window.__switch.row(${JSON.stringify(b)})`))) {
    throw new Error(`the rail has no workspaces named ${a} and ${b}: ${JSON.stringify(await c.eval('[...document.querySelectorAll(\'nav[aria-label="Workspaces"] button\')].map((e) => e.getAttribute("aria-label") || e.textContent.trim())'))}`)
  }
  const press = async (name: string): Promise<void> => {
    // A long rail scrolls: the row comes into view before the press.
    const at = await c.eval<{ x: number; y: number }>(`(() => { const e = window.__switch.row(${JSON.stringify(name)}); e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    for (const type of ['mousePressed', 'mouseReleased'] as const) await c.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
  }
  // The requests each click sends, by method, off the window's sockets.
  const sent: { at: number; method: string }[] = []
  await c.send('Network.enable')
  c.on('Network.webSocketFrameSent', (p) => {
    try {
      const frame = JSON.parse((p as { response: { payloadData: string } }).response.payloadData) as { method?: string }
      if (frame.method) sent.push({ at: Date.now(), method: frame.method })
    } catch {
      /* not JSON */
    }
  })
  const expect = new Map<string, SwitchView>()
  for (const name of [a, b, a, b]) {
    await press(name)
    // A host's catalog may still be on its way: a workspace shows its cards before it is recorded.
    const listed = Date.now() + 60_000
    while (Date.now() < listed && !(await c.eval<number>('window.__switch.read().cards.length'))) await sleep(500)
    await sleep(3_000)
    const view = await c.eval<SwitchView & { rows: number }>('window.__switch.read()')
    if (!view.cards.length) {
      const shot = (await c.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
      writeFileSync(join(ROOT, `${args.label}.png`), Buffer.from(shot.data, 'base64'))
      throw new Error(`${name} shows no project cards (the window: ${ROOT}/${args.label}.png)`)
    }
    // A landing on a draft or an empty pane has no rows to wait for.
    expect.set(name, { cards: view.cards, chips: view.chips, pane: view.rows > 0 ? view.pane : null })
  }
  for (const [name, v] of expect) log(`${name}: ${v.cards.length} cards, ${v.chips.length} threads in the strip, landing on ${v.pane ?? 'nothing'}`)
  const clicks: SwitchClick[] = []
  // A dev build: what each click rendered, from its press to its pane, by component (React's component track).
  const rendered = { renders: new Map<string, number>(), ms: new Map<string, number>() }
  const drain = async (keep: boolean): Promise<void> => {
    if (args.build !== 'dev') return
    const d = await c.eval<{ renders: [string, number][]; renderMs: [string, number][] }>('window.__soakDrain()')
    if (!keep) return
    for (const [n, k] of d.renders) rendered.renders.set(n, (rendered.renders.get(n) ?? 0) + k)
    for (const [n, k] of d.renderMs) rendered.ms.set(n, (rendered.ms.get(n) ?? 0) + k)
  }
  const tracing = args.traceS ? traceFrames(c, args.traceS) : null
  // A hand run profiles the measured clicks (not a window after them).
  if (args.profile) {
    await c.send('Profiler.enable')
    await c.send('Profiler.setSamplingInterval', { interval: 200 })
    await c.send('Profiler.start')
  }
  for (let i = 0; i < args.clicks; i++) {
    const target = i % 2 === 0 ? a : b
    await drain(false)
    const t0 = await c.eval<number>(`window.__switch.arm(${JSON.stringify(expect.get(target))})`)
    const wall = Date.now()
    await press(target)
    const done = Date.now() + 5_000
    while (Date.now() < done && (await c.eval<boolean>('(() => { const r = window.__switch.run; return r.ready === null || (r.waits && r.pane === null && performance.now() - r.t0 < 5000) })()'))) await sleep(50)
    await drain(true)
    await sleep(500)
    const got = await c.eval<{ ready: number | null; pane: number | null; tasks: { start: number; duration: number }[]; frames: { start: number; duration: number; scripts: string[] }[]; panes: string[] }>(
      `(() => { const s = window.__switch, r = s.run, end = r.t0 + 5000; return { ready: r.ready, pane: r.pane, tasks: s.tasks.filter((t) => t.start >= r.t0 && t.start < end), frames: s.frames.filter((f) => f.start >= r.t0 && f.start < end), panes: [...document.querySelectorAll('[data-session-drop]')].map((e) => e.getAttribute('data-session-drop')) } })()`
    )
    const requests: Record<string, number> = {}
    for (const r of sent) if (r.at >= wall && r.at < wall + 5_000) requests[r.method] = (requests[r.method] ?? 0) + 1
    const click: SwitchClick = { target, readyMs: got.ready === null ? null : got.ready - t0, paneMs: got.pane === null ? null : got.pane - t0, longTasks: got.tasks, frames: got.frames.map((f) => ({ duration: f.duration, scripts: f.scripts })), requests, panes: got.panes }
    clicks.push(click)
    log(`click ${i + 1} ${target}: column and strip ${click.readyMs === null ? 'never' : `${click.readyMs.toFixed(1)} ms`}, pane ${click.paneMs === null ? '–' : `${click.paneMs.toFixed(1)} ms`}, long tasks ${got.tasks.length}, panes ${got.panes.join(' ')}`)
    await sleep(1_000)
  }
  const trace = tracing ? await tracing : null
  let profile: string | null = null
  if (args.profile) {
    const { profile: cpuProfile } = (await c.send('Profiler.stop')) as { profile: CpuProfile }
    writeFileSync(join(ROOT, `${args.label}.cpuprofile`), JSON.stringify(cpuProfile))
    profile = profileSummary(cpuProfile)
  }
  const summary = summarizeSwitch(clicks)
  const verdict = judgeSwitch(summary)
  writeFileSync(join(ROOT, `${args.label}.json`), JSON.stringify({ label: args.label, args, tree, platform: process.platform, rule: SWITCH_RULE, verdict, expect: Object.fromEntries(expect), clicks, summary, trace }, null, 1))
  const md = [
    `# ${args.label}: ${args.host} host, switch scene, ${args.build} build (${process.platform}, load ${loadavg()[0]!.toFixed(1)})`,
    '',
    ...switchMarkdown(clicks, summary),
    '',
    '| reading | got | limit | |',
    '|---|---|---|---|',
    ...verdict.verdicts.map((v) => `| ${v.what} | ${v.got} | ${v.limit} | ${v.ok ? 'pass' : 'FAIL'} |`),
    ...(trace ? ['', ...traceMarkdown(trace)] : []),
    ...(profile ? ['', 'The measured clicks, profiled:', '', '```', profile, '```'] : []),
    ...(rendered.ms.size
      ? ['', `What the ${args.clicks} clicks rendered from press to pane (dev build, inclusive ms):`, '', '| component | renders | ms |', '|---|---|---|', ...[...rendered.ms].sort((x, y) => y[1] - x[1]).slice(0, 45).map(([n, ms]) => `| ${n} | ${rendered.renders.get(n) ?? 0} | ${Math.round(ms)} |`)]
      : [])
  ].join('\n')
  writeFileSync(join(ROOT, `${args.label}.md`), md + '\n')
  for (const v of verdict.verdicts) console.log(`${v.ok ? '✓' : '✗'} ${v.what}: ${v.got} (limit ${v.limit})`)
  console.log(`${verdict.ok ? 'passed' : 'FAILED'}: ${ROOT}/${args.label}.md`)
  process.exitCode = verdict.ok ? 0 : 1
}

// ── a send into a long thread, measured ─────────────────────────────────
/** The page side of a send: long tasks, long animation frames, and arm(text),
 *  which follows each frame until the person's row with that text is in the
 *  transcript and the composer is empty. */
const SEND_OBSERVERS = `(() => {
  if (window.__send) return true
  const s = (window.__send = { tasks: [], frames: [], keys: [] })
  new PerformanceObserver((list) => { for (const e of list.getEntries()) s.tasks.push({ start: e.startTime, duration: e.duration }) }).observe({ type: 'longtask' })
  // The Enter's own handler: the send's work on the main thread, apart from the wait for a frame.
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.name === 'keydown') s.keys.push({ start: e.startTime, processing: e.processingEnd - e.processingStart }) }).observe({ type: 'event', durationThreshold: 16 })
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration <= 50) continue
        const scripts = [...(e.scripts || [])].sort((a, b) => b.duration - a.duration).slice(0, 3)
        s.frames.push({ start: e.startTime, duration: e.duration, scripts: scripts.map((x) => (x.sourceFunctionName || x.invoker || '?') + ' ' + Math.round(x.duration) + ' ms') })
      }
    }).observe({ type: 'long-animation-frame' })
  } catch {}
  const field = window.__typingField
  s.arm = (text) => {
    const run = (s.run = { t0: performance.now(), row: null, cleared: null })
    const ch = new MessageChannel()
    ch.port1.onmessage = (e) => { if (run[e.data] === null) run[e.data] = performance.now() }
    const tick = () => {
      if (s.run !== run || performance.now() - run.t0 > 5000) return
      const cleared = field.textContent === ''
      const pane = field.closest('[data-session-drop]')
      // On screen: a row mounted in the overscan below the viewport is not seen yet.
      const view = pane?.querySelector('.agent-transcript')?.getBoundingClientRect()
      const row = !!view && [...pane.querySelectorAll('[data-row]')].some((r) => {
        if (!r.textContent.includes(text)) return false
        const box = r.getBoundingClientRect()
        return box.bottom > view.top && box.top < view.bottom
      })
      if (cleared) ch.port2.postMessage('cleared')
      if (row) ch.port2.postMessage('row')
      if (!cleared || !row) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return run.t0
  }
  return true
})()`

/**
 * `--scene send`: messages sent into the master's long thread from its
 * composer (typed in at once, then Enter), each timed to the end of the
 * first frame showing the person's row with its text, and to the composer
 * emptying; the host's answer to the send, off the window's socket, is
 * reported beside them. The synthetic host runs no harness: the row stays the
 * window's own until the host echoes it.
 */
async function recordSend(c: Cdp, shown: Shown): Promise<void> {
  const until = Date.now() + 30_000
  let field = { count: 0, x: 0, y: 0, width: 0, text: '' }
  let focused = false
  await sleep(3_000)
  while (!focused && Date.now() < until) {
    field = await c.eval(TYPING_FIELD)
    if (field.count === 1) {
      for (const type of ['mousePressed', 'mouseReleased'] as const) await c.send('Input.dispatchMouseEvent', { type, x: field.x, y: field.y, button: 'left', clickCount: 1 })
      focused = await c.eval<boolean>('document.activeElement === window.__typingField')
    }
    if (!focused) await sleep(500)
  }
  if (!focused) throw new Error(`the master's composer did not take focus (${field.count} composers on screen)`)
  await c.eval(SEND_OBSERVERS)
  if (args.loadAll) {
    // The whole history paged in, as a reader who scrolled back through it would have it.
    const pages = await c.eval<number>(`(async () => { const s = window.__monocode.sessionStore; let n = 0; while (n < 200 && (await s.loadOlder(${JSON.stringify(shown.masterId)}))) n++; return n })()`)
    log(`paged in ${pages} earlier pages`)
    await sleep(2_000)
  }
  const held = await c.eval<{ blocks: number; rows: number }>(`(() => ({ blocks: window.__monocode.sessionStore.get(${JSON.stringify(shown.masterId)})?.blocks.length ?? 0, rows: window.__typingField.closest('[data-session-drop]').querySelectorAll('[data-row]').length }))()`)
  log(`the master's transcript holds ${held.blocks} blocks, ${held.rows} rows mounted`)
  // The send's request and its answer, off the window's sockets.
  const frames: { at: number; dir: 'sent' | 'received'; id: string; method?: string }[] = []
  await c.send('Network.enable')
  const note = (dir: 'sent' | 'received') => (p: unknown) => {
    try {
      const frame = JSON.parse((p as { response: { payloadData: string } }).response.payloadData) as { id?: string | number; method?: string }
      if (frame.id !== undefined) frames.push({ at: Date.now(), dir, id: String(frame.id), method: frame.method })
    } catch {
      /* not JSON */
    }
  }
  c.on('Network.webSocketFrameSent', note('sent'))
  c.on('Network.webSocketFrameReceived', note('received'))
  const tracing = args.traceS ? traceFrames(c, args.traceS) : null
  if (args.profile) {
    await c.send('Profiler.enable')
    await c.send('Profiler.setSamplingInterval', { interval: 200 })
    await c.send('Profiler.start')
  }
  type Sent = { text: string; wall: number; rowMs: number | null; clearedMs: number | null; handlerMs: number | null; answerMs: number | null; longTasks: { start: number; duration: number }[]; frames: { duration: number; scripts: string[] }[] }
  const sent: Sent[] = []
  const rendered = new Map<string, [number, number]>()
  for (let i = 0; i < args.sends; i++) {
    if (args.build === 'dev') await c.eval('window.__soakDrain()')
    const text = `Send probe ${i + 1}: what landed since the last report?`
    await c.send('Input.insertText', { text })
    await sleep(400)
    const t0 = await c.eval<number>(`window.__send.arm(${JSON.stringify(text)})`)
    const wall = Date.now()
    for (const type of ['keyDown', 'keyUp'] as const) await c.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) })
    const done = Date.now() + 5_000
    while (Date.now() < done && (await c.eval<boolean>('(() => { const r = window.__send.run; return r.row === null || r.cleared === null })()'))) await sleep(50)
    await sleep(300)
    const got = await c.eval<{ row: number | null; cleared: number | null; handler: number | null; tasks: { start: number; duration: number }[]; frames: { start: number; duration: number; scripts: string[] }[] }>(
      `(() => { const s = window.__send, r = s.run, end = r.t0 + 5000; return { row: r.row, cleared: r.cleared, handler: s.keys.find((k) => k.start >= r.t0 && k.start < end)?.processing ?? null, tasks: s.tasks.filter((t) => t.start >= r.t0 && t.start < end), frames: s.frames.filter((f) => f.start >= r.t0 && f.start < end) } })()`
    )
    if (args.build === 'dev') {
      const d = await c.eval<{ renders: [string, number][]; renderMs: [string, number][] }>('window.__soakDrain()')
      for (const [n, ms] of d.renderMs) {
        const had = rendered.get(n) ?? [0, 0]
        rendered.set(n, [had[0] + (d.renders.find(([m]) => m === n)?.[1] ?? 0), had[1] + ms])
      }
    }
    const one: Sent = { text, wall, rowMs: got.row === null ? null : got.row - t0, clearedMs: got.cleared === null ? null : got.cleared - t0, handlerMs: got.handler, answerMs: null, longTasks: got.tasks, frames: got.frames.map((f) => ({ duration: f.duration, scripts: f.scripts })) }
    sent.push(one)
    log(`send ${i + 1}: row ${one.rowMs === null ? 'never' : `${one.rowMs.toFixed(1)} ms`}, composer clear ${one.clearedMs === null ? 'never' : `${one.clearedMs.toFixed(1)} ms`}, Enter's handler ${one.handlerMs === null ? '–' : `${one.handlerMs.toFixed(1)} ms`}, long tasks ${got.tasks.length}`)
    await sleep(1_500)
  }
  // The host's answers, read once the last could have come (a held one lands after its send's row).
  await sleep(args.peerDelayMs)
  for (const one of sent) {
    const request = frames.find((f) => f.dir === 'sent' && f.at >= one.wall && (f.method === 'session.send' || f.method === 'queue.add'))
    const answer = request ? frames.find((f) => f.dir === 'received' && f.id === request.id && f.at >= request.at) : undefined
    one.answerMs = answer ? answer.at - one.wall : null
  }
  const trace = tracing ? await tracing : null
  let profile: string | null = null
  if (args.profile) {
    const { profile: cpuProfile } = (await c.send('Profiler.stop')) as { profile: CpuProfile }
    writeFileSync(join(ROOT, `${args.label}.cpuprofile`), JSON.stringify(cpuProfile))
    profile = profileSummary(cpuProfile)
  }
  const times = (key: 'rowMs' | 'clearedMs' | 'handlerMs' | 'answerMs'): number[] => sent.flatMap((x) => (x[key] === null ? [] : [x[key]!]))
  const summary = { sends: sent.length, row: spread(times('rowMs')), cleared: spread(times('clearedMs')), handler: spread(times('handlerMs')), answer: spread(times('answerMs')), missed: sent.filter((x) => x.rowMs === null).length }
  const verdict = judgeSend(summary)
  const ms = (n: number | null): string => (n === null ? '–' : String(Math.round(n * 10) / 10))
  writeFileSync(join(ROOT, `${args.label}.json`), JSON.stringify({ label: args.label, args, tree, platform: process.platform, held, rule: SEND_RULE, verdict, sent, summary, trace }, null, 1))
  const md = [
    `# ${args.label}: synthetic host, send scene, ${args.build} build (${process.platform}, load ${loadavg()[0]!.toFixed(1)}), the master's ${args.history}-row history: ${held.blocks} blocks held, ${held.rows} rows mounted`,
    '',
    "| send | → the person's row ms | → composer clear ms | Enter's handler ms | → host's answer ms | long tasks (worst ms) | long frames |",
    '|---|---|---|---|---|---|---|',
    ...sent.map((x, i) => `| ${i + 1} | ${ms(x.rowMs)} | ${ms(x.clearedMs)} | ${ms(x.handlerMs)} | ${ms(x.answerMs)} | ${x.longTasks.length}${x.longTasks.length ? ` (${Math.round(Math.max(...x.longTasks.map((t) => t.duration)))})` : ''} | ${x.frames.map((f) => `${Math.round(f.duration)} ms: ${f.scripts.join('; ') || 'no script named'}`).join(' / ') || 'none'} |`),
    '',
    `Row p50 / p95 / max ${ms(summary.row.p50)} / ${ms(summary.row.p95)} / ${ms(summary.row.max)} ms; composer clear ${ms(summary.cleared.p50)} / ${ms(summary.cleared.p95)} / ${ms(summary.cleared.max)} ms; Enter's handler ${ms(summary.handler.p50)} / ${ms(summary.handler.p95)} / ${ms(summary.handler.max)} ms; the host's answer ${ms(summary.answer.p50)} / ${ms(summary.answer.p95)} / ${ms(summary.answer.max)} ms.`,
    '',
    '| reading | got | limit | |',
    '|---|---|---|---|',
    ...verdict.verdicts.map((v) => `| ${v.what} | ${v.got} | ${v.limit} | ${v.ok ? 'pass' : 'FAIL'} |`),
    ...(trace ? ['', ...traceMarkdown(trace)] : []),
    ...(profile ? ['', 'The sends, profiled:', '', '```', profile, '```'] : []),
    ...(rendered.size
      ? ['', `What the ${args.sends} sends rendered (dev build, inclusive ms):`, '', '| component | renders | ms |', '|---|---|---|', ...[...rendered].sort((x, y) => y[1][1] - x[1][1]).slice(0, 40).map(([n, [k, ms]]) => `| ${n} | ${k} | ${Math.round(ms)} |`)]
      : [])
  ].join('\n')
  writeFileSync(join(ROOT, `${args.label}.md`), md + '\n')
  for (const v of verdict.verdicts) console.log(`${v.ok ? '✓' : '✗'} ${v.what}: ${v.got} (limit ${v.limit})`)
  console.log(`${verdict.ok ? 'passed' : 'FAILED'}: ${ROOT}/${args.label}.md`)
  process.exitCode = verdict.ok ? 0 : 1
}

// ── scrolling while the board works, measured ───────────────────────────
/** The page side of the scroll scene: long tasks, long animation frames,
 *  `find(surface)` (the scroller on screen, its centre and range), and a
 *  run that keeps every animation frame's interval and the pixels scrolled. */
const SCROLL_OBSERVERS = `(() => {
  if (window.__scroll) return true
  const s = (window.__scroll = { tasks: [], frames: [], run: null, el: null })
  new PerformanceObserver((list) => { for (const e of list.getEntries()) s.tasks.push({ start: e.startTime, duration: e.duration }) }).observe({ type: 'longtask' })
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration <= 50) continue
        const scripts = [...(e.scripts || [])].sort((a, b) => b.duration - a.duration).slice(0, 3)
        s.frames.push({ start: e.startTime, duration: e.duration, scripts: scripts.map((x) => (x.sourceFunctionName || x.invoker || '?') + ' ' + Math.round(x.duration) + ' ms') })
      }
    }).observe({ type: 'long-animation-frame' })
  } catch {}
  const shown = (e) => e.getBoundingClientRect().width > 0 && !e.closest('.tab-parked, .board-parked')
  const scrollerOf = (e) => {
    for (let n = e.parentElement; n; n = n.parentElement) {
      const y = getComputedStyle(n).overflowY
      if (y === 'auto' || y === 'scroll') return n
    }
    return null
  }
  const pick = {
    transcript: () => [...document.querySelectorAll('.agent-transcript')].find(shown),
    board: () => [...document.querySelectorAll('[data-board-scroller]')].find(shown),
    rail: () => [...document.querySelectorAll('nav[aria-label="Workspaces"] .overflow-y-auto')].find(shown),
    column: () => { const row = [...document.querySelectorAll('[data-project-row]')].find(shown); return row ? scrollerOf(row) : null }
  }
  s.find = (surface) => {
    const el = pick[surface]() ?? null
    s.el = el
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), range: el.scrollHeight - el.clientHeight, top: el.scrollTop }
  }
  s.idle = (ms) => new Promise((done) => {
    const out = []
    let last = null
    const t0 = performance.now()
    const frame = (t) => { if (last !== null) out.push(t - last); last = t; if (t - t0 < ms) requestAnimationFrame(frame); else done(out) }
    requestAnimationFrame(frame)
  })
  s.start = () => {
    const el = s.el
    const run = (s.run = { t0: performance.now(), last: null, intervals: [], top: el.scrollTop, px: 0 })
    const onScroll = () => { run.px += Math.abs(el.scrollTop - run.top); run.top = el.scrollTop }
    el.addEventListener('scroll', onScroll, { passive: true })
    run.off = () => el.removeEventListener('scroll', onScroll)
    const frame = (t) => { if (s.run !== run) return; if (run.last !== null) run.intervals.push(t - run.last); run.last = t; requestAnimationFrame(frame) }
    requestAnimationFrame(frame)
    return true
  }
  s.stop = () => {
    const run = s.run
    s.run = null
    run.off()
    const end = performance.now()
    return { intervals: run.intervals, ms: end - run.t0, scrolledPx: run.px, longTasks: s.tasks.filter((t) => t.start >= run.t0 && t.start < end), frames: s.frames.filter((f) => f.start >= run.t0 && f.start < end).map((f) => ({ duration: f.duration, scripts: f.scripts })) }
  }
  return true
})()`

/**
 * `--scene scroll`: each surface of SCROLL_SURFACES, or those `--surfaces` names (the master's
 * transcript, its board, the rail's workspaces, the workspace column)
 * turned by the wheel at 60 Hz for `--wheel` seconds, 40 px a tick, back at
 * either end, then flung once (`Input.synthesizeScrollGesture`), under the
 * board's load; every animation frame's interval kept while it moves.
 * Judged by SCROLL_RULE; a surface that is not on screen or does not
 * overflow is said so, and fails the synthetic scene.
 */
async function recordScroll(c: Cdp): Promise<void> {
  await sleep(3_000)
  await c.eval(SCROLL_OBSERVERS)
  const displayMs = displayInterval(await c.eval<number[]>('window.__scroll.idle(1000)'))
  log(`the display draws every ${displayMs.toFixed(1)} ms; scrolling ${args.surfaces.join(', ')}`)
  const tracing = args.traceS ? traceFrames(c, args.traceS) : null
  if (args.profile) {
    await c.send('Profiler.enable')
    await c.send('Profiler.setSamplingInterval', { interval: 200 })
    await c.send('Profiler.start')
  }
  const results: ScrollResult[] = []
  const where = (surface: ScrollSurface) => c.eval<{ x: number; y: number; range: number; top: number } | null>(`window.__scroll.find(${JSON.stringify(surface)})`)
  for (const surface of args.surfaces) {
    const at = await where(surface)
    const skipped = !at ? 'not on screen' : at.range < 200 ? `does not overflow (${Math.max(0, at.range)} px)` : null
    if (skipped || !at) {
      for (const mode of ['wheel', 'fling'] as const) results.push({ surface, mode, summary: null, skipped, frames: [] })
      log(`${surface}: ${skipped}`)
      continue
    }
    // The wheel: ticks on the clock, each sent without waiting on the one before.
    const ticks = wheelPlan(args.wheelS * 1000, 60, 40, at.range, at.top)
    await c.eval('window.__scroll.start()')
    const t0 = Date.now()
    const sent: Promise<unknown>[] = []
    for (const tick of ticks) {
      const wait = t0 + tick.at - Date.now()
      if (wait > 0) await sleep(wait)
      sent.push(c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: tick.deltaY }))
    }
    await Promise.all(sent)
    await sleep(300)
    const wheel = await c.eval<FrameRun>('window.__scroll.stop()')
    results.push({ surface, mode: 'wheel', summary: summarizeFrames(wheel, displayMs), skipped: null, frames: wheel.frames })
    // The fling: as far as the range allows, toward the far end (a positive distance scrolls up).
    const now = (await where(surface))!
    const yDistance = now.top > now.range / 2 ? Math.min(3_000, now.top) : -Math.min(3_000, now.range - now.top)
    await c.eval('window.__scroll.start()')
    await c.send('Input.synthesizeScrollGesture', { x: now.x, y: now.y, yDistance, speed: 4_000, preventFling: false })
    await sleep(600)
    const fling = await c.eval<FrameRun>('window.__scroll.stop()')
    results.push({ surface, mode: 'fling', summary: summarizeFrames(fling, displayMs), skipped: null, frames: fling.frames })
    for (const r of results.slice(-2)) log(`${surface} ${r.mode}: ${r.summary!.fps} fps, ${r.summary!.dropped} dropped, longest ${r.summary!.longestMs} ms, ${r.summary!.longTasks.count} long tasks, ${r.summary!.scrolledPx} px`)
  }
  const trace = tracing ? await tracing : null
  let profile: string | null = null
  if (args.profile) {
    const { profile: cpuProfile } = (await c.send('Profiler.stop')) as { profile: CpuProfile }
    writeFileSync(join(ROOT, `${args.label}.cpuprofile`), JSON.stringify(cpuProfile))
    profile = profileSummary(cpuProfile)
  }
  // The gate reports the frame bounds until a run on the Mac sizes them there (docs/box.md "Scrolling while threads work").
  const verdict = judgeScroll(results, displayMs, { allSurfaces: args.host === 'synthetic', framesReportOnly: args.gate })
  writeFileSync(join(ROOT, `${args.label}.json`), JSON.stringify({ label: args.label, args, tree, platform: process.platform, displayMs, rule: SCROLL_RULE, verdict, results, trace }, null, 1))
  const md = [
    `# ${args.label}: ${args.host} host, scroll scene, ${args.build} build (${process.platform}, load ${loadavg()[0]!.toFixed(1)}), the wheel ${args.wheelS} s a surface`,
    '',
    ...scrollMarkdown(results, displayMs),
    '',
    '| reading | got | limit | |',
    '|---|---|---|---|',
    ...verdict.verdicts.map((v) => `| ${v.what} | ${v.got} | ${v.limit} | ${v.ok ? 'pass' : v.reportOnly ? 'over, reported' : 'FAIL'} |`),
    ...(trace ? ['', ...traceMarkdown(trace)] : []),
    ...(profile ? ['', 'The scrolling, profiled:', '', '```', profile, '```'] : [])
  ].join('\n')
  writeFileSync(join(ROOT, `${args.label}.md`), md + '\n')
  for (const v of verdict.verdicts) console.log(`${v.ok ? '✓' : v.reportOnly ? '!' : '✗'} ${v.what}: ${v.got} (limit ${v.limit}${v.reportOnly ? ', reported only' : ''})`)
  console.log(`${verdict.ok ? 'passed' : 'FAILED'}: ${ROOT}/${args.label}.md`)
  process.exitCode = verdict.ok ? 0 : 1
}

// ── the scenarios, recorded ──────────────────────────────────────────────
/**
 * `--scene scenarios`: the synthetic host plays the no-jerk timeline
 * (scripts/lib/soakScenarios.ts) on the thread on screen, once. With
 * `--screencast <dir>` every frame the window paints is written as
 * `<ms>.png` (the frame's own timestamp) with `index.json`: the steps with
 * their times and, per step, the frames from its time to 600 ms after, the
 * ones to look at. `--scrolled-up` scrolls the reader up into the history
 * first; `--trace <s>` traces the same run. Fails on a long task over 200 ms,
 * and with `--height-report` on a tool table or code block that jumped
 * (never under reduced motion) or, scrolled up, on the reader's top row moving
 * through turn 6.
 */
async function recordScenarios(c: Cdp): Promise<void> {
  if (!soakHost?.stdin || !soakHost.stdout) throw new Error('the scenarios need the synthetic host')
  await sleep(1_500)
  if (args.scrolledUp) {
    const at = await c.eval<number>(`(() => {
      const el = document.querySelector('.agent-transcript')
      if (!el) return -1
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true }))
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 900)
      el.dispatchEvent(new Event('scroll'))
      return el.scrollTop
    })()`)
    log(`scrolled up to ${at}`)
    await sleep(500)
  }
  const frames: { file: string; t: number }[] = []
  const dir = args.screencast ? resolve(args.screencast) : null
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    c.on('Page.screencastFrame', (p) => {
      const frame = p as { data: string; sessionId: number; metadata: { timestamp?: number } }
      const t = Math.round((frame.metadata.timestamp ?? Date.now() / 1000) * 1000)
      const file = `${t}.png`
      writeFileSync(join(dir, file), Buffer.from(frame.data, 'base64'))
      frames.push({ file, t })
      void c.send('Page.screencastFrameAck', { sessionId: frame.sessionId })
    })
    await c.send('Page.enable')
    await c.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
  }
  await c.eval('window.__soakDrain()')
  if (args.heightReport) log(`height observer ${await c.eval(HEIGHT_OBSERVER)}`)
  // The reader's top row, read by the same rule before and after: its key and where it sits.
  const TOP_ROW = `(() => {
    const el = document.querySelector('.agent-transcript')
    if (!el) return null
    const top = el.getBoundingClientRect().top
    const row = [...el.querySelectorAll('[data-row]')].find((r) => r.getBoundingClientRect().bottom > top + 1)
    return row ? { row: row.dataset.row, top: Math.round(row.getBoundingClientRect().top - top) } : null
  })()`
  // Each send parks the transcript on its prompt, by design, so the reader's
  // place is held over turn 6 alone: scrolled up once its calls start, its top
  // row read again as it settles, through the landings, the fence and the list.
  const SCROLL_UP = `(() => {
    const el = document.querySelector('.agent-transcript')
    if (!el) return -1
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true }))
    el.scrollTop = Math.max(0, el.scrollTop - 600)
    el.dispatchEvent(new Event('scroll'))
    return el.scrollTop
  })()`
  let topBefore: Promise<{ row: string; top: number } | null> | null = null
  let topAfter: Promise<{ row: string; top: number } | null> | null = null
  const steps: { label: string; t: number }[] = []
  const lines = createInterface({ input: soakHost.stdout })
  lines.on('line', (l) => {
    if (!l.startsWith('{"step"')) return
    const step = JSON.parse(l) as { step: string; clicks?: string[] }
    const label = step.step
    steps.push({ label, t: Date.now() })
    if (step.clicks) void c.eval(questionClicks(step.clicks)).catch(() => {})
    if (!args.scrolledUp) return
    if (label === 'turn 6: ten calls start') topBefore = c.eval<number>(SCROLL_UP).then(() => sleep(300)).then(() => c.eval(TOP_ROW))
    if (label === 'turn 6: settles') topAfter = c.eval(TOP_ROW)
  })
  const length = scenarioLength()
  soakHost.stdin.write('go\n')
  log(`playing the scenarios, ${(length / 1000).toFixed(0)} s`)
  const trace = args.traceS ? traceFrames(c, Math.min(args.traceS, length / 1000)) : null
  await sleep(length + 1_500)
  const traced = trace ? await trace : null
  if (dir) await Promise.race([c.send('Page.stopScreencast'), sleep(5_000)])
  lines.close()
  const drained = await c.eval<{ tasks: { start: number; duration: number }[] }>('window.__soakDrain()')
  const longest = Math.max(0, ...drained.tasks.map((t) => t.duration))
  const heights = args.heightReport ? summarizeHeights(await c.eval<HeightRecord[]>('window.__heightRecords()'), steps) : null
  const before = topBefore ? await topBefore : null
  const after = topAfter ? await topAfter : null
  const anchored = !args.scrolledUp || (!!before && !!after && after.row === before.row && Math.abs(after.top - before.top) <= 1)
  const index = {
    steps: steps.map((s) => ({ ...s, frames: frames.filter((f) => f.t >= s.t - 50 && f.t <= s.t + 600).map((f) => f.file) })),
    frames: frames.length,
    reducedMotion: args.reducedMotion,
    scrolledUp: args.scrolledUp,
    longestTaskMs: longest,
    trace: traced,
    heights,
    topRow: args.scrolledUp ? { before, after } : null,
  }
  if (dir) writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 1))
  if (traced) writeFileSync(join(ROOT, `${args.label}.trace.md`), traceMarkdown(traced).join('\n') + '\n')
  log(`${steps.length} steps, ${frames.length} frames${dir ? ` in ${dir}` : ''}; longest task ${Math.round(longest)} ms`)
  console.log(`${longest <= 200 ? '✓' : '✗'} longest long task, ms: ${Math.round(longest)} (limit 200)`)
  let ok = longest <= 200
  if (heights) {
    // Reduced motion steps every height by design: reported, never failed.
    const failed = heights.jumps.length > 0 && !args.reducedMotion
    for (const j of heights.jumps) log(`jump: ${j.kind} ${j.box} ${j.from} -> ${j.to}px at "${j.step}"`)
    console.log(`${failed ? '✗' : heights.jumps.length ? '!' : '✓'} heights: ${heightLine(heights)}${args.reducedMotion && heights.jumps.length ? ' (reduced motion, reported only)' : ''}`)
    if (failed) ok = false
  }
  if (args.scrolledUp) {
    const at = (r: { row: string; top: number } | null) => (r ? `${r.row} at ${r.top}px` : 'none')
    console.log(`${anchored ? '✓' : '✗'} the reader's top row through turn 6: ${at(before)}, then ${at(after)}`)
    if (!anchored) ok = false
  }
  process.exitCode = ok ? 0 : 1
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
