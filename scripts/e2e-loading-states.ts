/**
 * Loading is not empty (thread step 6 of the performance plan): two
 * isolated instances of the BUILT tree. "box" is headless with
 * TEMP_CODE_PEER_DELAY_MS (every request a peer makes there waits that
 * long, 12 s by default); "mac" is a windowed instance with a CDP port,
 * paired with box through a minted admin key and driven through
 * `window.__monocode`. Nothing here touches a real HOME,
 * /Applications/TempCode.app or the box's live service.
 *
 *  1. box seeds a workspace, a project and two threads with a user row each.
 *     The rows land without a model: each thread is created queued behind an
 *     idle sibling (`queue: true`, `after`), so its first message is stored
 *     and held, and no harness boots.
 *  2. mac opens thread A. A page-side probe samples A's pane every 50 ms:
 *     the pane opens at once on the transcript skeleton, says "Waiting for
 *     box · N s" once 8 s pass, then shows the rows; the new-thread empty
 *     state never appears. The rail's box dot reads "slow to answer".
 *  3. mac opens thread B and, while its load waits on the box, the proof
 *     closes mac's socket to box as the network would. The pane says it is
 *     retrying, the link reconnects, and the rows land in the SAME pane
 *     element, never reopened, never empty.
 * Run: bun run script:e2e-loading-states   (build first: bun run build)
 * TC_LS_KEEP=1 keeps the temp root; TC_LS_DELAY_MS sets the peer delay (12000).
 *
 * On macOS the windowed side runs as a plain window on an isolated userData;
 * on Linux it runs under xvfb-run as scripts/e2e-launch-mirror.ts does.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { attach, type Cdp } from './lib/packagedApp'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_LS_KEEP === '1'
const DELAY_MS = Number(process.env.TC_LS_DELAY_MS ?? 12_000)
let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) {
  console.error('out/main is missing: run bun run build first')
  process.exit(2)
}
const freePort = (): Promise<number> =>
  new Promise((ok) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })
const root = (() => {
  const d = mkdtempSync(join(tmpdir(), 'tc-loading-states-e2e-'))
  return spawnSync('realpath', [d]).stdout.toString().trim() || d
})()
type Inst = { name: string; home: string; data: string; tmp: string; remote: number; debug: number; log: string; proc?: ChildProcess }
const mk = async (name: string): Promise<Inst> => {
  const inst = {
    name,
    home: join(root, `${name}-home`),
    data: join(root, `${name}-data`),
    tmp: join(root, `${name}-tmp`),
    remote: await freePort(),
    debug: await freePort(),
    log: join(root, `${name}.log`)
  }
  for (const d of [inst.home, inst.data, inst.tmp]) mkdirSync(d, { recursive: true })
  return inst
}
const box = await mk('box')
const mac = await mk('mac')
const BOX_SHOP = join(root, 'box-work', 'shop')
mkdirSync(BOX_SHOP, { recursive: true })

function launch(inst: Inst, mode: 'headless' | 'window', extra: Record<string, string> = {}): void {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: inst.home,
    TMPDIR: inst.tmp,
    TEMP_CODE_USER_DATA: inst.data,
    TEMP_CODE_REMOTE_PORT: mode === 'headless' ? String(inst.remote) : '0',
    TEMP_CODE_ALIAX_DATA_DIR: join(inst.data, 'aliax'),
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_WARM_HARNESS: '0',
    CLAUDE_CONFIG_DIR: join(inst.home, '.claude'),
    CODEX_HOME: join(inst.home, '.codex'),
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: '/bin/bash',
    ...extra
  }
  for (const key of Object.keys(env)) if (/^TEMP_CODE_(HUB|APNS)_/.test(key)) delete env[key]
  env.TEMP_CODE_HEADLESS = mode === 'headless' ? '1' : '0'
  if (mode === 'window') env.TEMP_CODE_DEBUG_PORT = String(inst.debug)
  else delete env.TEMP_CODE_DEBUG_PORT
  delete env.ELECTRON_RUN_AS_NODE
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  const argv =
    process.platform === 'linux'
      ? ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.']
      : [electron, '.']
  rmSync(join(inst.data, 'server.json'), { force: true })
  const proc = spawn(argv[0], argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  inst.proc = proc
}
const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(200)
  }
  log(`timed out: ${label}`)
  return false
}
const up = (inst: Inst): Promise<boolean> => until(`${inst.name} up`, 90_000, () => existsSync(join(inst.data, 'server.json')))

/** One request on a headless instance's local socket (the implicit admin, never delayed). */
async function rpc<T = unknown>(inst: Inst, method: string, params: unknown = {}): Promise<T> {
  const { port } = JSON.parse(readFileSync(join(inst.data, 'server.json'), 'utf8')) as { port: number }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close()
      fail(new Error(`${inst.name}: no answer to ${method}`))
    }, 60_000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'e2e', method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== 'e2e') return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) ok(frame.result as T)
      else fail(new Error(`${inst.name}: ${method}: ${frame.error}`))
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      fail(new Error(`${inst.name}: socket error on ${method}`))
    })
  })
}

async function stop(inst: Inst): Promise<void> {
  if (!inst.proc?.pid) return
  try {
    process.kill(-inst.proc.pid, 'SIGTERM')
  } catch {
    /* gone */
  }
  await until(`${inst.name} stops`, 20_000, () => inst.proc?.exitCode !== null || inst.proc?.signalCode !== null)
  try {
    process.kill(-inst.proc.pid, 'SIGKILL')
  } catch {
    /* gone */
  }
  inst.proc = undefined
  await sleep(500)
}

async function window_(inst: Inst): Promise<Cdp> {
  const cdp = await attach(inst.debug, 120_000)
  await until(`${inst.name} window helpers`, 60_000, () => cdp.eval<boolean>('!!window.__monocode?.sessionStore'))
  return cdp
}

type Sample = {
  t: number
  pane: boolean
  same: boolean
  skeleton: boolean
  empty: boolean
  rows: boolean
  line: string | null
  connection: string | null
  phase: string | null
}

/**
 * A page-side probe on one thread's pane, every 50 ms: is the pane there
 * (and the same element as the first one seen), the skeleton, the empty
 * state, the rows, the load line, the connection line, the store's phase.
 */
const startProbe = (cdp: Cdp, key: string, sessionId: string, marker: string): Promise<unknown> =>
  cdp.eval(`(() => {
    const probes = (window.__loadingProbe ??= {});
    const start = performance.now();
    const state = { samples: [], first: null, timer: 0 };
    probes[${JSON.stringify(key)}] = state;
    state.timer = setInterval(() => {
      const pane = document.querySelector('[data-session-drop=${JSON.stringify(sessionId)}]');
      if (pane && !state.first) state.first = pane;
      const text = pane ? pane.textContent || '' : '';
      state.samples.push({
        t: Math.round(performance.now() - start),
        pane: !!pane,
        same: !!pane && pane === state.first,
        skeleton: !!pane && !!pane.querySelector('[data-surface-skeleton="transcript"]'),
        empty: text.includes('What should we work on'),
        // The transcript's own rows: the composer's queue strip may show the
        // same text while the thread's first message waits in its queue.
        rows: !!pane && [...pane.querySelectorAll('[data-block]')].some((el) => (el.textContent || '').includes(${JSON.stringify(marker)})),
        line: pane?.querySelector('[data-load-line]')?.textContent ?? null,
        connection: pane?.querySelector('[data-connection-line]')?.textContent ?? null,
        phase: window.__monocode.sessionStore.get(${JSON.stringify(sessionId)})?.load?.phase ?? null,
      });
    }, 50);
    return true;
  })()`)
const samplesOf = (cdp: Cdp, key: string): Promise<Sample[]> =>
  cdp.eval<Sample[]>(`window.__loadingProbe[${JSON.stringify(key)}].samples`)
const stopProbe = (cdp: Cdp, key: string): Promise<unknown> =>
  cdp.eval(`clearInterval(window.__loadingProbe[${JSON.stringify(key)}].timer)`)
const firstAt = (samples: Sample[], test: (s: Sample) => boolean): number | null => samples.find(test)?.t ?? null
/** The distinct load and connection lines in order of first sight. */
const linesOf = (samples: Sample[]): string[] => {
  const seen: string[] = []
  for (const s of samples) {
    for (const line of [s.line, s.connection]) {
      const shape = line?.replace(/\d+ s/g, 'N s')
      if (shape && !seen.includes(shape)) seen.push(shape)
    }
  }
  return seen
}

/** The probe's samples folded to the moments something changed, for the log. */
const transitions = (samples: Sample[]): string[] => {
  const out: string[] = []
  let last = ''
  for (const s of samples) {
    const shape = [
      s.pane ? 'pane' : 'no pane',
      s.skeleton ? 'skeleton' : '',
      s.empty ? 'EMPTY' : '',
      s.rows ? 'rows' : '',
      s.phase ?? '',
      s.line?.replace(/\d+ s/, 'N s') ?? '',
      s.connection ?? ''
    ]
      .filter(Boolean)
      .join(' · ')
    if (shape !== last) out.push(`${String(s.t).padStart(6)} ms  ${shape}`)
    last = shape
  }
  return out
}

const numbers: Record<string, number | null> = {}
launch(box, 'headless', { TEMP_CODE_PEER_DELAY_MS: String(DELAY_MS) })
try {
  if (!check('box published its local socket', await up(box))) throw new Error(`no server.json; log ${box.log}`)
  const boxEnv = (await rpc<{ environmentId: string }>(box, 'remote.status')).environmentId
  log(`box ${boxEnv} on :${box.remote}, peer delay ${DELAY_MS} ms; logs ${box.log} ${mac.log}`)

  // ── 1. seed: two threads with a stored user row, no harness ──────────
  const ws = await rpc<{ id: string }>(box, 'workspace.create', { path: BOX_SHOP, name: 'shop' })
  const proj = await rpc<{ id: string }>(box, 'project.create', { workspaceId: ws.id, name: 'shop', mode: 'local' })
  await rpc(box, 'session.create', { id: 'e2e-ls-hold', projectId: proj.id, provider: 'claude', title: 'Holds the queue', threadType: 'chat' })
  const threads = [
    { id: 'e2e-ls-a', marker: 'LOADING-PROOF-A', title: 'Slow box thread A' },
    { id: 'e2e-ls-b', marker: 'LOADING-PROOF-B', title: 'Slow box thread B' }
  ]
  for (const t of threads) {
    await rpc(box, 'session.create', { id: t.id, projectId: proj.id, provider: 'claude', title: t.title, threadType: 'chat', queue: true, after: 'e2e-ls-hold' })
    await rpc(box, 'session.send', { sessionId: t.id, text: `${t.marker} hello from the box` })
  }
  const stored = await until('the user rows are stored', 30_000, async () => {
    for (const t of threads) {
      const rows = await rpc<unknown>(box, 'session.events', { sessionId: t.id, afterSeq: 0 })
      if (!JSON.stringify(rows).includes(t.marker)) return false
    }
    return true
  })
  check('box stored a user row on each thread without booting a harness', stored)
  const key = await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'mac (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })

  // ── pair mac with the slow box ───────────────────────────────────────
  launch(mac, 'window')
  const cdp = await window_(mac)
  await until('mac local link', 60_000, () => cdp.eval<boolean>(`window.__monocode.registry.link('local')?.connected === true`))
  await cdp.eval(
    `window.__monocode.registry.primary().request('remote.environments.add', ${JSON.stringify({ url: `http://127.0.0.1:${box.remote}`, key: key.token, name: 'box' })}).then(() => window.__monocode.loadSavedEnvironments())`
  )
  const listed = await until('mac lists box', 90_000, () =>
    cdp.eval<boolean>(`${JSON.stringify(threads.map((t) => t.id))}.every((id) => !!window.__monocode.sessionStore.metaOf(id))`)
  )
  check("mac saved box and listed its threads through the slow peer", listed)

  // ── 2. open A: skeleton, the slow line, the rows; never empty ─────────
  const a = threads[0]
  await startProbe(cdp, 'a', a.id, a.marker)
  await cdp.eval(`window.__monocode.sessionStore.requestOpen(${JSON.stringify(a.id)})`)
  const aLoaded = await until('A shows its rows', DELAY_MS * 4 + 30_000, async () => (await samplesOf(cdp, 'a')).some((s) => s.rows))
  await sleep(500)
  await stopProbe(cdp, 'a')
  const aSamples = await samplesOf(cdp, 'a')
  numbers.aPane = firstAt(aSamples, (s) => s.pane)
  numbers.aSlow = firstAt(aSamples, (s) => s.phase === 'slow')
  numbers.aRows = firstAt(aSamples, (s) => s.rows)
  check('A: the pane opened at once, before the box answered', numbers.aPane !== null && numbers.aPane < 2_000, `pane at ${numbers.aPane} ms`)
  check(
    'A: the pane showed the transcript skeleton before the rows',
    aSamples.some((s) => s.skeleton && !s.rows) && aSamples.filter((s) => s.rows).every((s) => !s.skeleton),
    `${aSamples.filter((s) => s.skeleton).length} samples with the skeleton`
  )
  check('A: the new-thread empty state never showed', aSamples.every((s) => !s.empty), `${aSamples.filter((s) => s.empty).length} of ${aSamples.length} samples empty`)
  const aSlowLine = aSamples.find((s) => s.line?.startsWith('Waiting for box'))?.line ?? null
  check('A: slow after 8 s, one line naming the host with the seconds', numbers.aSlow !== null && numbers.aSlow >= 7_500 && !!aSlowLine, `slow at ${numbers.aSlow} ms, "${aSlowLine}"`)
  check('A: the rows landed', aLoaded, `rows at ${numbers.aRows} ms`)
  for (const line of transitions(aSamples)) log(`A ${line}`)
  const dotTitle = await cdp.eval<string | null>(
    `document.querySelector('[data-host-row=${JSON.stringify(boxEnv)}] [data-host-status]')?.getAttribute('title') ?? null`
  )
  check("the box's host row dot reads slow from the link's health", !!dotTitle?.includes('slow to answer'), `title "${dotTitle}"`)

  // ── 3. open B, drop the link mid-wait: retrying, then the rows ─────────
  const b = threads[1]
  await startProbe(cdp, 'b', b.id, b.marker)
  await cdp.eval(`window.__monocode.sessionStore.requestOpen(${JSON.stringify(b.id)})`)
  const waiting = await until('B is waiting on the box', 10_000, async () => (await samplesOf(cdp, 'b')).some((s) => s.skeleton))
  check('B: the pane opened on the skeleton', waiting)
  await sleep(3_000)
  const dropped = await cdp.eval<boolean>(
    `(() => { const t = window.__monocode.registry.link(${JSON.stringify(boxEnv)})?.transport; if (!t) return false; t.close({ kind: 'network', message: 'dropped by the proof' }); return true })()`
  )
  check("B: mac's socket to box dropped while the load waited", dropped)
  const bLoaded = await until('B shows its rows', DELAY_MS * 5 + 60_000, async () => (await samplesOf(cdp, 'b')).some((s) => s.rows))
  await sleep(500)
  await stopProbe(cdp, 'b')
  const bSamples = await samplesOf(cdp, 'b')
  const bLines = linesOf(bSamples)
  numbers.bFailed = firstAt(bSamples, (s) => s.phase === 'failed')
  numbers.bRows = firstAt(bSamples, (s) => s.rows)
  check('B: the pane said it was retrying', bLines.some((l) => l.includes('retrying')), JSON.stringify(bLines))
  check('B: the load failed on the drop and tried again by itself', numbers.bFailed !== null, `failed at ${numbers.bFailed} ms`)
  check('B: the rows landed without reopening the pane', bLoaded && bSamples.filter((s) => s.pane).every((s) => s.same), `rows at ${numbers.bRows} ms`)
  for (const line of transitions(bSamples)) log(`B ${line}`)
  check('B: the new-thread empty state never showed', bSamples.every((s) => !s.empty), `${bSamples.filter((s) => s.empty).length} of ${bSamples.length} samples empty`)
  cdp.close()
  await stop(mac)

  console.log('')
  console.log(`      peer delay ${DELAY_MS} ms (each request a peer makes waits that long; a first load is subscribe + events):`)
  console.log(`        A: pane ${numbers.aPane} ms, slow ${numbers.aSlow} ms, rows ${numbers.aRows} ms`)
  console.log(`        B: dropped at ~3 s, failed ${numbers.bFailed} ms, rows ${numbers.bRows} ms`)
} catch (err) {
  console.error(err)
  failures++
} finally {
  await stop(mac)
  await stop(box)
  if (!KEEP) rmSync(root, { recursive: true, force: true })
  else log(`kept ${root}`)
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
