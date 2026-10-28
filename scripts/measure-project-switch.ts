/**
 * A project switch measured on a built tree against the real box: the
 * stutter of 1.0.307 (5.3 s per switch with the right panel on Changes, 64 ms
 * with it closed; docs/box.md "Measuring a project switch"). Runs the BUILT
 * tree (`electron-vite preview --skipBuild`) under a fresh userData in /tmp
 * on a display (the Mac; xvfb-run where there is none), never the user's data.
 *
 *   TEMP_CODE_PROFILE=1 bun x electron-vite build      # in the tree measured
 *   bun scripts/measure-project-switch.ts --tree <dir> --label after-changes \
 *     --threads <id,id,id> --panel changes --scratch-untracked 10000 --clicks 12 --gap 6000
 *
 * --threads   box threads to open (comma list). With any, the script fetches a
 *             read-only pairing code over `ssh box … tc-local
 *             remote.pairings.create` straight into this process (never
 *             printed or written), pairs, and revokes the key and the code at
 *             exit. Without, it measures the scratch workspace alone.
 * --panel     changes | closed: the right panel of every opened thread.
 * --scratch-untracked <n>
 *             a scratch repo under /tmp with n untracked files (and 100 under
 *             .temp-code/, which the Changes list must never show), added as a
 *             local workspace with one project and a draft thread on it.
 * --clicks, --gap
 *             the cycle: each thread's workspace in the rail, then its project
 *             card, in turn; one click every gap ms (default 12 and 6000).
 * --targets   overrides the cycle: `ws:<name>,card:<name>,…`.
 * --cpuprofile
 *             a CPU profile of each click from the press to its paint
 *             (<label>.click<i>.cpuprofile), its heaviest functions by self
 *             time printed under the click and summed over the run.
 *
 * Per click it prints click → paint (two frames after the mouseup), the long
 * tasks (count, sum, longest), React commit ms (the TEMP_CODE_PROFILE build's
 * profile), the Changes rows mounted, DOM elements, and the requests sent by
 * method with the bytes received; then the median and p90, and
 * /tmp/tc-switch-measure/<label>.json with every click. It also reports how
 * many `.temp-code/` files each opened checkout's git.diffIndex lists.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Cdp, REPO, pageTarget, portFree, sleep } from './lib/packagedApp'

const ROOT = '/tmp/tc-switch-measure'
const ORIGIN = 'https://tempcode.landonhale.com'
const CLIENT = 'switch-measure'
const argv = process.argv.slice(2)
const flag = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const tree = resolve(flag('--tree', REPO)!)
const label = flag('--label') ?? ''
const threads = (flag('--threads') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const panel = flag('--panel', 'changes')!
const scratchFiles = Number(flag('--scratch-untracked', '0'))
const clicks = Number(flag('--clicks', '12'))
const gap = Number(flag('--gap', '6000'))
const port = Number(flag('--port', '9243'))
const sshKey = flag('--ssh-key', join(homedir(), '.orbstack/ssh/id_ed25519'))!
const cpuprofile = argv.includes('--cpuprofile')
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('--label <letters, digits and dashes> is required')
if (panel !== 'changes' && panel !== 'closed') throw new Error('--panel is changes or closed')
if (!Number.isInteger(scratchFiles) || scratchFiles < 0) throw new Error('--scratch-untracked takes a count')
if (!threads.length && !scratchFiles) throw new Error('nothing to measure: give --threads, --scratch-untracked or both')

const userData = join(ROOT, `${label}.userData`)
const scratchRepo = join(ROOT, 'scratch')
const SCRATCH_WS = 'scratch'
const SCRATCH_PROJECT = 'scratch'

// ── the box: a read-only pairing that lives as long as this process ───────
const sshArgs = [...(existsSync(sshKey) ? ['-i', sshKey] : []), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'box']
const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`
function tcLocal<T>(method: string, params?: unknown): T {
  const cmd = `node /srv/agents/temp-code-builds/current/scripts/box/tc-local.mjs ${method}${params ? ` ${quote(JSON.stringify(params))}` : ''}`
  try {
    return JSON.parse(execFileSync('ssh', [...sshArgs, cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) as T
  } catch {
    // The output may hold a code; the error never repeats it.
    throw new Error(`ssh box tc-local ${method} failed`)
  }
}
type Credential = { id: string; name?: string; createdAt?: number }
const startedAt = Date.now()
const ours = (c: Credential): boolean => c.name === CLIENT && Number(c.createdAt) >= startedAt - 60_000
function revoke(): { keys: number; pairings: number } {
  const keys = tcLocal<Credential[]>('remote.keys.list').filter(ours)
  const pairings = tcLocal<Credential[]>('remote.pairings.list').filter(ours)
  for (const k of keys) tcLocal('remote.keys.revoke', { id: k.id })
  for (const p of pairings) tcLocal('remote.pairings.revoke', { id: p.id })
  const left = tcLocal<Credential[]>('remote.keys.list').filter(ours).length + tcLocal<Credential[]>('remote.pairings.list').filter(ours).length
  if (left) throw new Error(`${left} credentials named ${CLIENT} remain on the box: revoke them by hand`)
  return { keys: keys.length, pairings: pairings.length }
}

/** The app's main process holds the debug port; electron-vite's own exit does not take it down. */
function listeners(): number[] {
  try {
    return execFileSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean).map(Number)
  } catch {
    return []
  }
}

// ── CPU profiles ──────────────────────────────────────────────────────────
type CpuProfile = {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]
  samples: number[]
  timeDeltas: number[]
}
/** Self ms per function (name, file and line), heaviest first. */
function selfTimes(profile: CpuProfile): Map<string, number> {
  const names = new Map<number, string>()
  for (const n of profile.nodes) {
    const f = n.callFrame
    names.set(n.id, f.url ? `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}` : f.functionName || '(anonymous)')
  }
  const out = new Map<string, number>()
  profile.samples.forEach((id, i) => {
    const name = names.get(id)!
    out.set(name, (out.get(name) ?? 0) + (profile.timeDeltas[i + 1] ?? 0) / 1000)
  })
  return new Map([...out].filter(([name]) => name !== '(idle)').sort((a, b) => b[1] - a[1]))
}
const top = (times: Map<string, number>, n: number): string[] => [...times].slice(0, n).map(([name, ms]) => `${ms.toFixed(1).padStart(7)} ms  ${name}`)

// ── the scratch checkout ──────────────────────────────────────────────────
function seedScratch(): void {
  rmSync(scratchRepo, { recursive: true, force: true })
  mkdirSync(scratchRepo, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', ['-C', scratchRepo, ...args], { stdio: 'ignore' })
  git('init', '-q')
  writeFileSync(join(scratchRepo, 'README.md'), '# scratch\n')
  git('add', 'README.md')
  git('-c', 'user.name=measure', '-c', 'user.email=measure@example.com', 'commit', '-q', '-m', 'init')
  for (let i = 0; i < scratchFiles; i++) {
    const dir = join(scratchRepo, 'notes', `batch-${String(Math.floor(i / 200)).padStart(3, '0')}`)
    if (i % 200 === 0) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `note-${String(i).padStart(5, '0')}.md`), `note ${i}\n`)
  }
  mkdirSync(join(scratchRepo, '.temp-code', 'threads'), { recursive: true })
  for (let i = 0; i < 100; i++) writeFileSync(join(scratchRepo, '.temp-code', 'threads', `t${i}.md`), 'app\n')
}

// ── in the page ───────────────────────────────────────────────────────────
/** Installed before the app's own scripts: long tasks, and the paint two frames after an armed mouseup. */
const HOOK = `(() => {
  window.__tcTasks = []
  new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__tcTasks.push({ start: e.startTime, duration: e.duration }) }).observe({ type: 'longtask', buffered: true })
  window.addEventListener('mouseup', () => {
    const armed = window.__tcArmed
    if (armed) requestAnimationFrame(() => requestAnimationFrame(() => { armed.paint = performance.now() }))
  }, true)
})()`
const visible = `(e) => e.getBoundingClientRect().width > 0 && !e.closest('.tab-parked, .board-parked')`
/** The Changes sections mounted (one per warm tab) and their file rows: every
 *  build renders a row as an Item, so the count reads the same before and after. */
const SNAPSHOT = `(() => {
  const shown = ${visible}
  const sections = [...document.querySelectorAll('[data-slot="changes-section"]')]
  const rows = (s) => [...s.querySelectorAll('[data-slot="item"]')]
  return {
    domNodes: document.querySelectorAll('*').length,
    changesPanels: sections.length,
    changesRows: sections.map((s) => rows(s).length),
    visibleChangesRows: sections.filter(shown).reduce((n, s) => n + rows(s).length, 0),
    appRows: sections.reduce((n, s) => n + rows(s).filter((r) => r.textContent.includes('.temp-code')).length, 0),
  }
})()`
const controlExpr = (kind: 'ws' | 'card' | 'button', name: string, scope = 'document'): string => {
  const text = JSON.stringify(name)
  const match = `(e) => { const t = e.getAttribute('aria-label') || e.textContent.trim(); return t === ${text} || t.startsWith(${text} + ',') }`
  const selector = kind === 'ws' ? 'nav[aria-label="Workspaces"] button' : kind === 'card' ? 'button[data-project-card]' : 'button, [role="tab"], [role="radio"]'
  return `[...${scope}.querySelectorAll(${JSON.stringify(selector)})].filter(${visible}).find(${match})`
}

type Wire = { at: number; dir: 'sent' | 'received'; method: string; bytes: number }
type Target = { kind: 'ws' | 'card'; name: string }
type Click = {
  i: number
  target: string
  paintMs: number | null
  longTasks: number
  longTaskMs: number
  maxLongTaskMs: number
  reactCommits: number
  reactRenderMs: number
  heapMb: number
  requests: Record<string, number>
  receivedBytes: number
  fileReads: number
} & Record<string, unknown>

async function main(): Promise<void> {
  if (!existsSync(join(tree, 'out', 'renderer', 'index.html'))) throw new Error(`no build under ${tree}/out (TEMP_CODE_PROFILE=1 bun x electron-vite build)`)
  if (!(await portFree(port))) throw new Error(`port ${port} is in use (an earlier instance still up?)`)
  mkdirSync(ROOT, { recursive: true })
  rmSync(userData, { recursive: true, force: true })
  mkdirSync(userData, { recursive: true })
  if (scratchFiles) seedScratch()

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  Object.assign(env, {
    TEMP_CODE_USER_DATA: userData,
    TEMP_CODE_DEBUG_PORT: String(port),
    TEMP_CODE_REMOTE_PORT: '0',
    TEMP_CODE_HEADLESS: '0',
    TEMP_CODE_WARM_HARNESS: '0',
    TEMP_CODE_ALIAX_DATA_DIR: join(userData, 'aliax'),
    ALIAX_CREDENTIAL_BACKEND: 'file',
    CLAUDE_CONFIG_DIR: join(userData, 'claude'),
    CODEX_HOME: join(userData, 'codex')
  })
  const bin = join(tree, 'node_modules', '.bin', 'electron-vite')
  const cmd = process.platform === 'linux' && !env.DISPLAY ? ['xvfb-run', '-a', '-s', '-screen 0 1600x1000x24', bin, 'preview', '--skipBuild'] : [bin, 'preview', '--skipBuild']
  const log = openSync(join(ROOT, `${label}.app.log`), 'w')
  const app = Bun.spawn(cmd, { cwd: tree, env, stdout: log, stderr: log })
  const result: Record<string, unknown> = { label, tree, at: new Date().toISOString(), panel, scratchFiles, threads, clicks: [] as Click[] }
  const sha = execFileSync('git', ['-C', tree, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  result.sha = sha
  const save = () => writeFileSync(join(ROOT, `${label}.json`), JSON.stringify(result, null, 2))
  let paired = false
  let cdp: Cdp | null = null
  try {
    const page = await pageTarget(port, 120_000)
    cdp = await Cdp.connect(page.webSocketDebuggerUrl!)
    const c = cdp
    await c.send('Page.enable')
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK })
    await c.send('Page.reload')
    const waitFor = async (expr: string, ms = 120_000, what = expr): Promise<void> => {
      const until = Date.now() + ms
      while (Date.now() < until) {
        if (await c.eval<boolean>(`!!(${expr})`).catch(() => false)) return
        await sleep(500)
      }
      throw new Error(`timed out waiting for ${what}`)
    }
    await waitFor('Array.isArray(window.__tcTasks) && window.__app?.profile && window.__monocode?.registry.primary()?.connected', 120_000, 'the app (is the tree a TEMP_CODE_PROFILE=1 build?)')
    const local = await c.eval<string>('window.__monocode.registry.primary().environmentId')
    const request = <T>(environmentId: string, method: string, params: unknown): Promise<T> =>
      c.eval<T>(`window.__monocode.registry.linkOf(${JSON.stringify(environmentId)}).request(${JSON.stringify(method)}, ${JSON.stringify(params)})`)

    // Pair with the box: the code goes from ssh into the page and nowhere else.
    let boxId: string | null = null
    if (threads.length) {
      const code = tcLocal<{ code?: string }>('remote.pairings.create', { name: CLIENT, audience: 'client', caps: ['read'], ttlMinutes: 30 }).code
      if (typeof code !== 'string') throw new Error('the box made no pairing code')
      paired = true
      const pairedEnv = await c
        .eval<{ id: string }>(`window.__monocode.registry.primary().request('remote.environments.pair', ${JSON.stringify({ origin: ORIGIN, code, name: CLIENT })}).then((r) => ({ id: r.id }))`)
        .catch(() => {
          throw new Error('pairing with the box failed')
        })
      boxId = pairedEnv.id
      await c.eval('window.__monocode.loadSavedEnvironments(window.__monocode.registry.primary()).then(() => true)')
      await waitFor(`window.__monocode.registry.linkOf(${JSON.stringify(boxId)})?.connected && ${JSON.stringify(threads)}.every((id) => window.__monocode.sessionStore.metas().some((m) => m.id === id))`, 240_000, 'the box and its threads')
    }

    // The wire: requests by method, bytes received, from here on.
    const wire: Wire[] = []
    const pending = new Map<string, string>()
    await c.send('Network.enable')
    const note = (dir: Wire['dir']) => (p: Record<string, unknown>) => {
      const response = p.response as { payloadData: string; opcode: number }
      const bytes = response.opcode === 1 ? Buffer.byteLength(response.payloadData) : Buffer.from(response.payloadData, 'base64').length
      let method = 'other'
      try {
        const frame = JSON.parse(response.payloadData) as { id?: string | number; method?: string; push?: string }
        const key = `${p.requestId}:${frame.id ?? ''}`
        if (dir === 'sent' && frame.method) {
          method = frame.method
          pending.set(key, method)
        } else if (frame.push) method = `push:${frame.push}`
        else if (frame.id !== undefined) {
          method = pending.get(key) ?? 'reply'
          pending.delete(key)
        }
      } catch {
        /* binary or not JSON */
      }
      wire.push({ at: Date.now(), dir, method, bytes })
    }
    c.on('Network.webSocketFrameSent', note('sent'))
    c.on('Network.webSocketFrameReceived', note('received'))

    const point = async (expr: string, what: string): Promise<{ x: number; y: number }> => {
      await waitFor(expr, 30_000, what)
      return c.eval(`(() => { const e = ${expr}; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    }
    const press = async (at: { x: number; y: number }): Promise<void> => {
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
    }
    const click = async (kind: 'ws' | 'card' | 'button', name: string, scope?: string): Promise<void> => press(await point(controlExpr(kind, name, scope), `${kind} ${name}`))
    /** The thread on screen gets its right panel as asked: on Changes, or closed. */
    const setPanel = async (): Promise<void> => {
      const toggle = `[...document.querySelectorAll('button[aria-label="Panel"]')].find(${visible})`
      await waitFor(toggle, 30_000, 'the Panel toggle')
      const open = await c.eval<boolean>(`!![...document.querySelectorAll('aside[aria-label="Thread panel"]')].find(${visible})`)
      if (open !== (panel === 'changes')) await press(await point(toggle, 'the Panel toggle'))
      if (panel === 'changes') {
        await click('button', 'Changes', `[...document.querySelectorAll('aside[aria-label="Thread panel"]')].find(${visible})`)
        await waitFor(`[...document.querySelectorAll('[data-slot="changes-section"]')].find(${visible})`, 60_000, 'the Changes section')
      }
      await sleep(3000)
    }

    // The box threads, each with its panel set; the cycle from their workspaces and cards.
    const cycle: Target[] = []
    const checkouts: Record<string, unknown>[] = []
    for (const id of threads) {
      await c.eval(`window.__tcOpening = window.__app.openSession(${JSON.stringify(id)})`)
      await waitFor(`[...document.querySelectorAll('[data-session-drop="${id}"]')].find(${visible})`, 240_000, `thread ${id}`)
      await sleep(2000)
      await setPanel()
      const meta = await c.eval<{ environmentId: string; projectId?: string; cwd?: string }>(`(() => { const m = window.__monocode.sessionStore.metas().find((m) => m.id === ${JSON.stringify(id)}); return { environmentId: m.environmentId, projectId: m.projectId, cwd: m.cwd } })()`)
      const projects = await request<{ id: string; name: string; workspaceId: string; cwd: string }[]>(meta.environmentId, 'project.list', {})
      const workspaces = await request<{ id: string; name: string; path: string }[]>(meta.environmentId, 'workspace.list', {})
      const project = projects.find((p) => p.id === meta.projectId)
      const workspace = workspaces.find((w) => w.id === project?.workspaceId)
      if (workspace && !cycle.some((t) => t.kind === 'ws' && t.name === workspace.name)) cycle.push({ kind: 'ws', name: workspace.name })
      if (project) cycle.push({ kind: 'card', name: project.name })
      const cwd = project?.cwd ?? meta.cwd
      if (cwd) {
        const index = await request<{ files: { relative: string }[] }>(meta.environmentId, 'git.diffIndex', { cwd }).catch(() => null)
        checkouts.push({ thread: id, cwd, files: index?.files.length ?? null, appFiles: index ? index.files.filter((f) => f.relative.includes('.temp-code/')).length : null })
      }
    }
    result.checkouts = checkouts

    // Set up scratch last: opening a box thread would replace its blank pane.
    let scratch: Target[] = []
    if (scratchFiles) {
      const ws = await request<{ id: string }>(local, 'workspace.create', { path: scratchRepo, name: SCRATCH_WS })
      await request(local, 'project.create', { workspaceId: ws.id, name: SCRATCH_PROJECT, mode: 'local' })
      await click('ws', SCRATCH_WS)
      await click('card', SCRATCH_PROJECT)
      await sleep(1000)
      // Empty drafts skip ThreadView (and its panel). Mount its view without
      // adding a message or sending anything: only this scratch draft's load flag.
      await c.eval(`(() => {
        const s = window.__app.store.getState().find((s) => s.cwd === ${JSON.stringify(scratchRepo)})
        if (!s?.load) throw new Error('the scratch draft has no load state')
        s.load.empty = false
        window.__monocode.sessionStore.patch(s.id, { load: s.load })
      })()`)
      await sleep(2000)
      await setPanel()
      scratch = [{ kind: 'ws', name: SCRATCH_WS }, { kind: 'card', name: SCRATCH_PROJECT }]
      const index = await request<{ files: { relative: string }[] }>(local, 'git.diffIndex', { cwd: scratchRepo })
      result.scratchIndex = { files: index.files.length, appFiles: index.files.filter((f) => f.relative.includes('.temp-code/')).length }
    }

    const override = flag('--targets')
    const targets: Target[] = override
      ? override.split(',').map((t) => {
          const [kind, ...name] = t.split(':')
          if (kind !== 'ws' && kind !== 'card') throw new Error(`--targets: ${t}`)
          return { kind, name: name.join(':') }
        })
      : [...cycle, ...scratch]
    result.targets = targets
    await sleep(5000)
    result.before = await c.eval(SNAPSHOT)
    save()

    // The cycle.
    await c.eval('window.__app.profile.start()')
    if (cpuprofile) {
      await c.send('Profiler.enable')
      await c.send('Profiler.setSamplingInterval', { interval: 100 })
    }
    const total = new Map<string, number>()
    const rows: Click[] = []
    for (let i = 0; i < clicks; i++) {
      const target = targets[i % targets.length]!
      const at = await point(controlExpr(target.kind, target.name), `${target.kind} ${target.name}`)
      const before = await c.eval<{ start: number; profile: Record<string, number> }>(`(() => { window.__tcArmed = { start: performance.now(), paint: null }; return { start: window.__tcArmed.start, profile: window.__app.profile.read() } })()`)
      if (cpuprofile) await c.send('Profiler.start')
      const wall = Date.now()
      await press(at)
      let self: Map<string, number> | null = null
      if (cpuprofile) {
        while (Date.now() - wall < 5000 && (await c.eval<number | null>('window.__tcArmed.paint')) === null) await sleep(4)
        const { profile } = (await c.send('Profiler.stop')) as { profile: CpuProfile }
        writeFileSync(join(ROOT, `${label}.click${i}.cpuprofile`), JSON.stringify(profile))
        self = selfTimes(profile)
        for (const [name, ms] of self) total.set(name, (total.get(name) ?? 0) + ms)
      }
      await sleep(Math.max(0, Math.min(gap, 5000) - (Date.now() - wall)))
      const after = await c.eval<{ paint: number | null; tasks: { start: number; duration: number }[]; profile: Record<string, number> }>(`(() => { const a = window.__tcArmed; return { paint: a.paint, tasks: window.__tcTasks.filter((t) => t.start >= a.start && t.start < a.start + ${Math.min(gap, 5000)}), profile: window.__app.profile.read() } })()`)
      const heap = (await c.send('Runtime.getHeapUsage')) as { usedSize: number }
      const inWindow = wire.filter((w) => w.at >= wall && w.at < wall + Math.min(gap, 5000))
      const requests: Record<string, number> = {}
      for (const w of inWindow) if (w.dir === 'sent') requests[w.method] = (requests[w.method] ?? 0) + 1
      const row: Click = {
        i,
        target: `${target.kind}:${target.name}`,
        paintMs: after.paint === null ? null : after.paint - before.start,
        longTasks: after.tasks.length,
        longTaskMs: after.tasks.reduce((n, t) => n + t.duration, 0),
        maxLongTaskMs: Math.max(0, ...after.tasks.map((t) => t.duration)),
        reactCommits: (after.profile.commits ?? 0) - (before.profile.commits ?? 0),
        reactRenderMs: (after.profile.renderMs ?? 0) - (before.profile.renderMs ?? 0),
        heapMb: heap.usedSize / 1048576,
        requests,
        receivedBytes: inWindow.filter((w) => w.dir === 'received').reduce((n, w) => n + w.bytes, 0),
        fileReads: requests['file.read'] ?? 0,
        ...(self ? { topSelf: top(self, 12) } : {}),
        ...(await c.eval<Record<string, unknown>>(SNAPSHOT))
      }
      rows.push(row)
      ;(result.clicks as Click[]).push(row)
      save()
      console.log(
        [`${i}`.padStart(2), row.target.padEnd(28), `paint ${row.paintMs?.toFixed(0) ?? '>5000'} ms`.padEnd(15), `tasks ${row.longTasks} ${row.longTaskMs.toFixed(0)} ms max ${row.maxLongTaskMs.toFixed(0)}`.padEnd(26), `react ${row.reactRenderMs.toFixed(0)} ms/${row.reactCommits}`.padEnd(16), `rows ${(row.changesRows as number[]).join('+')}`.padEnd(16), `dom ${row.domNodes}`.padEnd(12), `file.read ${row.fileReads}`, `in ${(row.receivedBytes / 1024).toFixed(0)} kB`].join('  ')
      )
      if (self) for (const line of top(self, 6)) console.log(`      ${line}`)
      await sleep(Math.max(0, gap - (Date.now() - wall)))
    }
    await c.eval('window.__app.profile.stop()').catch(() => undefined)

    // A paint still pending at the end of its window counts as the window.
    const sorted = rows.map((r) => r.paintMs ?? 5000).sort((a, b) => a - b)
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!
    const summary = {
      paintMedianMs: q(0.5),
      paintP90Ms: q(0.9),
      maxLongTaskMs: Math.max(0, ...rows.map((r) => r.maxLongTaskMs)),
      longTasksOver100: rows.reduce((n, r) => n + (r.maxLongTaskMs > 100 ? 1 : 0), 0),
      maxChangesRowsPerPanel: Math.max(0, ...rows.flatMap((r) => r.changesRows as number[])),
      fileReadsPerClick: rows.reduce((n, r) => n + r.fileReads, 0) / Math.max(1, rows.length),
      appRowsShown: Math.max(0, ...rows.map((r) => r.appRows as number))
    }
    result.summary = summary
    save()
    console.log(`\n${label} @ ${sha}  panel ${panel}  scratch ${scratchFiles}`)
    console.log(`click → paint  median ${summary.paintMedianMs.toFixed(0)} ms  p90 ${summary.paintP90Ms.toFixed(0)} ms`)
    console.log(`longest task   ${summary.maxLongTaskMs.toFixed(0)} ms  clicks with one over 100 ms: ${summary.longTasksOver100}`)
    console.log(`Changes rows   ${summary.maxChangesRowsPerPanel} at most in one panel  .temp-code rows shown: ${summary.appRowsShown}`)
    console.log(`file.read      ${summary.fileReadsPerClick.toFixed(1)} per click`)
    if (cpuprofile) {
      result.topSelf = top(new Map([...total].sort((a, b) => b[1] - a[1])), 40)
      console.log('press → paint, self time summed over the clicks:')
      for (const line of top(new Map([...total].sort((a, b) => b[1] - a[1])), 20)) console.log(`  ${line}`)
      save()
    }
    for (const k of checkouts) console.log(`git.diffIndex  ${k.cwd}: ${k.files} files, ${k.appFiles} under .temp-code/`)
    if (result.scratchIndex) console.log(`git.diffIndex  scratch: ${JSON.stringify(result.scratchIndex)}`)
    console.log(join(ROOT, `${label}.json`))
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    save()
    throw error
  } finally {
    cdp?.close()
    const pids = listeners()
    app.kill('SIGTERM')
    for (const pid of pids) process.kill(pid, 'SIGTERM')
    await Promise.race([app.exited, sleep(5000)])
    if (app.exitCode === null) app.kill('SIGKILL')
    for (const pid of listeners()) process.kill(pid, 'SIGKILL')
    if (paired) {
      result.revoked = revoke()
      save()
    }
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
)
