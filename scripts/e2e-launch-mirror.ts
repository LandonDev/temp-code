/**
 * The launch mirror, cold (CLAUDE.md "Launch: the rail paints from the
 * launch mirror"): two isolated instances of the BUILT tree. "box" is
 * headless with TEMP_CODE_PEER_DELAY_MS, so every request a peer makes
 * there waits; "mac" is a windowed instance under xvfb-run with a CDP port,
 * driven through `window.__monocode`. Nothing here touches a real HOME,
 * /Applications/TempCode.app or the box's live service.
 *
 *  1. box seeds a workspace, a project and THREADS threads; mac boots, saves
 *     box as an environment (an admin key minted on box) and lists it. The
 *     writer lands box's rows in mac's launch mirror.
 *  2. "before": mac's mirror is emptied and mac cold-starts again. The box's
 *     section has no rows at tc:ready and the rail's first full paint
 *     (tc:rail-complete) waits for the slow box: two delayed round trips.
 *  3. "after": the mirror is left in place; while mac is down, box renames
 *     one thread, archives one, deletes one and gains one. mac cold-starts:
 *     the box's rows are on screen at tc:ready, tc:rail-complete follows
 *     within a frame or two, and the reconcile resumes from the saved cursor
 *     (`session.changes`, no whole list): the renamed row reads its new
 *     title, the deleted one is gone, the archived one archived, the new
 *     one present, and the rows nothing touched are the same objects.
 * Numbers go to the console; docs/box.md records a run.
 * Run: bun run script:e2e-launch-mirror   (build first: electron-vite build)
 * TC_LM_KEEP=1 keeps the temp root; TC_LM_DELAY_MS sets the peer delay (3000).
 */
import { Database } from 'bun:sqlite'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { attach, type Cdp } from './lib/packagedApp'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_LM_KEEP === '1'
const DELAY_MS = Number(process.env.TC_LM_DELAY_MS ?? 3000)
const THREADS = 12
let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) {
  console.error('out/main is missing: run electron-vite build first')
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
  const d = mkdtempSync(join(tmpdir(), 'tc-launch-mirror-e2e-'))
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
    CLAUDE_CONFIG_DIR: join(inst.home, '.claude'),
    CODEX_HOME: join(inst.home, '.codex'),
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: '/bin/bash',
    ...extra
  }
  // The shell may be the box's own service environment (TEMP_CODE_HEADLESS=1,
  // the real hub and APNs keys): the window asks for a window, and neither
  // instance reaches the hub.
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

/** One request on a headless instance's local socket (the implicit admin). */
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

type Meta = { id: string; title: string; archived: boolean; environmentId: string; status: string }

/** The desktop window over CDP: attach, then wait for the boot helpers. */
async function window_(inst: Inst): Promise<Cdp> {
  const cdp = await attach(inst.debug, 120_000)
  await until(`${inst.name} window helpers`, 60_000, () => cdp.eval<boolean>('!!window.__monocode?.sessionStore'))
  return cdp
}
const markAt = (cdp: Cdp, name: string): Promise<number | null> =>
  cdp.eval<number | null>(`(() => { const e = performance.getEntriesByName(${JSON.stringify(name)})[0]; return e ? e.startTime : null })()`)
const boxMetas = (cdp: Cdp, env: string): Promise<Meta[]> =>
  cdp.eval<Meta[]>(
    `window.__monocode.sessionStore.metas().filter((m) => m.environmentId === ${JSON.stringify(env)}).map((m) => ({ id: m.id, title: m.title, archived: m.archived, environmentId: m.environmentId, status: m.status }))`
  )
const railText = (cdp: Cdp): Promise<string> => cdp.eval<string>(`document.querySelector('[aria-label="Workspaces"]')?.textContent ?? ''`)
/** The window's connection state, for a timed-out wait: which hosts are registered, open, listed or mirrored. */
const stateOf = (cdp: Cdp): Promise<string> =>
  cdp.eval<string>(
    `(() => { const m = window.__monocode; const s = m.sessionStore; const envs = m.registry.environments().map((e) => e.id); return JSON.stringify({ envs, statuses: envs.map((id) => [id, m.registry.statusOf(id).transport, m.registry.statusOf(id).lastError]), attached: s.environmentIds(), listed: s.listedEnvironmentIds(), mirrored: envs.filter((id) => s.isMirrored(id)), metas: s.metas().length }) })()`
  )
const waitMark = async (cdp: Cdp, name: string, ms: number): Promise<boolean> => {
  const ok = await until(name, ms, async () => (await markAt(cdp, name)) !== null)
  if (!ok) log(`state: ${await stateOf(cdp).catch((e) => String(e))}`)
  return ok
}
/** Rows of mac's mirror for one host, straight from its database. */
function mirrorRows(inst: Inst, env: string): { ids: string[]; cursor: { seq: number; generation: string } | null } {
  const db = new Database(join(inst.data, 'temp-code.db'), { readonly: true })
  try {
    const ids = (db.prepare('SELECT id FROM launch_mirror_sessions WHERE environment_id = ? ORDER BY id').all(env) as { id: string }[]).map((r) => r.id)
    const host = db.prepare('SELECT cursor_seq, cursor_generation FROM launch_mirror_hosts WHERE environment_id = ?').get(env) as { cursor_seq: number | null; cursor_generation: string | null } | null
    return { ids, cursor: host?.cursor_seq != null && host.cursor_generation ? { seq: host.cursor_seq, generation: host.cursor_generation } : null }
  } catch {
    return { ids: [], cursor: null }
  } finally {
    db.close()
  }
}

const numbers: Record<string, number | null> = {}
launch(box, 'headless', { TEMP_CODE_PEER_DELAY_MS: String(DELAY_MS) })
try {
  if (!check('box published its local socket', await up(box))) throw new Error(`no server.json; log ${box.log}`)
  const boxEnv = (await rpc<{ environmentId: string }>(box, 'remote.status')).environmentId
  log(`box ${boxEnv} on :${box.remote}, peer delay ${DELAY_MS} ms; logs ${box.log} ${mac.log}`)
  const ws = await rpc<{ id: string }>(box, 'workspace.create', { path: BOX_SHOP, name: 'shop' })
  const proj = await rpc<{ id: string }>(box, 'project.create', { workspaceId: ws.id, name: 'shop', mode: 'local' })
  const ids: string[] = []
  for (let i = 0; i < THREADS; i++) {
    const id = `e2e-mirror-${String(i).padStart(2, '0')}`
    await rpc(box, 'session.create', { id, projectId: proj.id, provider: 'claude', title: `Mirror thread ${i}`, threadType: 'chat' })
    ids.push(id)
  }
  const key = await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'mac (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })

  // ── 1. pair, list, and let the writer land the mirror ────────────────
  launch(mac, 'window')
  let cdp = await window_(mac)
  await until('mac local link', 60_000, () => cdp.eval<boolean>(`window.__monocode.registry.link('local')?.connected === true`))
  await cdp.eval(
    `window.__monocode.registry.primary().request('remote.environments.add', ${JSON.stringify({ url: `http://127.0.0.1:${box.remote}`, key: key.token, name: 'box' })}).then(() => window.__monocode.loadSavedEnvironments())`
  )
  const listed = await until('mac lists box', 60_000, async () => (await boxMetas(cdp, boxEnv)).length >= THREADS)
  check(`mac saved box and listed its ${THREADS} threads through the slow peer`, listed)
  const written = await until('the mirror lands', 30_000, () => mirrorRows(mac, boxEnv).ids.length >= THREADS)
  const first = mirrorRows(mac, boxEnv)
  check('the writer put every box thread and the list cursor in the mirror', written && first.cursor !== null, `rows ${first.ids.length}, cursor ${JSON.stringify(first.cursor)}`)
  cdp.close()
  await stop(mac)

  // ── 2. before: the saved host, no mirror ───────────────────────────────
  {
    const db = new Database(join(mac.data, 'temp-code.db'))
    db.exec('DELETE FROM launch_mirror_sessions; DELETE FROM launch_mirror_hosts')
    db.close()
  }
  launch(mac, 'window')
  cdp = await window_(mac)
  await until('tc:ready (before)', 60_000, async () => (await markAt(cdp, 'tc:ready')) !== null)
  const beforeAtReady = await boxMetas(cdp, boxEnv)
  const beforeRail = await railText(cdp)
  check('before: the box section has no rows at tc:ready', beforeAtReady.length === 0, `${beforeAtReady.length} rows; rail says "${beforeRail.slice(0, 80)}"`)
  await waitMark(cdp, 'tc:rail-complete', 90_000)
  const b0 = await markAt(cdp, 'tc:ready')
  const b1 = await markAt(cdp, 'tc:rail-complete')
  numbers.before = b0 !== null && b1 !== null ? Math.round(b1 - b0) : null
  check('before: the first full paint waited for the slow box', numbers.before !== null && numbers.before >= DELAY_MS, `tc:ready → tc:rail-complete ${numbers.before} ms`)
  await until('the mirror lands again', 30_000, () => mirrorRows(mac, boxEnv).ids.length >= THREADS)
  const second = mirrorRows(mac, boxEnv)
  cdp.close()
  await stop(mac)

  // ── the box changes while mac is down ──────────────────────────────────
  const [renamed, archived, deleted] = ids
  await rpc(box, 'session.rename', { sessionId: renamed, title: 'Renamed while away' })
  await rpc(box, 'session.archive', { sessionId: archived, archived: true })
  await rpc(box, 'session.delete', { sessionId: deleted })
  await rpc(box, 'session.create', { id: 'e2e-mirror-new', projectId: proj.id, provider: 'claude', title: 'Born while away', threadType: 'chat' })
  const head = await rpc<{ seq: number; generation: string }>(box, 'session.changes', { afterSeq: 0 })

  // ── 3. after: the mirror paints, the resume reconciles ─────────────────
  launch(mac, 'window')
  cdp = await window_(mac)
  await until('tc:ready (after)', 60_000, async () => (await markAt(cdp, 'tc:ready')) !== null)
  const afterAtReady = await boxMetas(cdp, boxEnv)
  const afterRail = await railText(cdp)
  const mirroredStill = await cdp.eval<boolean>(`window.__monocode.sessionStore.isMirrored(${JSON.stringify(boxEnv)})`)
  check(`after: the box's ${THREADS} rows are on screen at tc:ready, from the mirror`, afterAtReady.length === THREADS && mirroredStill, `${afterAtReady.length} rows, mirrored=${mirroredStill}`)
  check('after: the rail has the box section and its workspace before the box answers', afterRail.includes('box') && afterRail.includes('shop'), `rail says "${afterRail.slice(0, 120)}"`)
  check('after: the deleted thread still shows from the mirror (the host has not said yet)', afterAtReady.some((m) => m.id === deleted))
  await waitMark(cdp, 'tc:rail-complete', 30_000)
  const a0 = await markAt(cdp, 'tc:ready')
  const a1 = await markAt(cdp, 'tc:rail-complete')
  numbers.after = a0 !== null && a1 !== null ? Math.round(a1 - a0) : null
  check('after: the first full paint did not wait for the box', numbers.after !== null && numbers.after < DELAY_MS / 2, `tc:ready → tc:rail-complete ${numbers.after} ms`)
  const reconciled = await until('the reconcile lands', 60_000, async () => !(await cdp.eval<boolean>(`window.__monocode.sessionStore.isMirrored(${JSON.stringify(boxEnv)})`)))
  const afterReconcile = await boxMetas(cdp, boxEnv)
  const byId = new Map(afterReconcile.map((m) => [m.id, m]))
  check('after: the host confirmed the mirror', reconciled)
  check('after: the renamed thread reads its new title in place', byId.get(renamed)?.title === 'Renamed while away', byId.get(renamed)?.title)
  check('after: the deleted thread left quietly', !byId.has(deleted))
  check('after: the archived thread is archived', byId.get(archived)?.archived === true)
  check('after: the thread born while away is present', byId.get('e2e-mirror-new')?.title === 'Born while away')
  const cursor = await cdp.eval<{ seq: number; generation: string } | null>(`window.__monocode.sessionStore.cursorOf(${JSON.stringify(boxEnv)})`)
  check('after: the resume spoke to the change log (the cursor is the box\'s current head)', cursor?.generation === head.generation && cursor?.seq === head.seq, `${JSON.stringify(cursor)} vs ${JSON.stringify(head)}, saved cursor ${JSON.stringify(second.cursor)}`)
  const untouched = ids.slice(3)
  const sameObjects = await cdp.eval<number>(
    `(() => { const s = window.__monocode.sessionStore; return ${JSON.stringify(untouched)}.filter((id) => s.metaOf(id) && s.metaOf(id).title.startsWith('Mirror thread')).length })()`
  )
  check('after: the rows nothing touched kept their titles', sameObjects === untouched.length, `${sameObjects}/${untouched.length}`)
  await until('the mirror lands a third time', 30_000, () => !mirrorRows(mac, boxEnv).ids.includes(deleted))
  const third = mirrorRows(mac, boxEnv)
  check('after: the mirror no longer carries the deleted thread and holds the new cursor', !third.ids.includes(deleted) && third.ids.includes('e2e-mirror-new') && third.cursor?.seq === head.seq, `rows ${third.ids.length}, cursor ${JSON.stringify(third.cursor)}`)
  cdp.close()
  await stop(mac)

  console.log('')
  console.log(`      tc:ready → rail complete, peer delay ${DELAY_MS} ms, ${THREADS} threads on the box:`)
  console.log(`        before (saved host, no mirror): ${numbers.before} ms`)
  console.log(`        after  (launch mirror):         ${numbers.after} ms`)
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
