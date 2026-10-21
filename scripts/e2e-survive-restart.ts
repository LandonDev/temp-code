/**
 * Threads mid-turn survive a host restart, for real: an isolated headless
 * instance (TEMP_CODE_HEADLESS=1, its own TEMP_CODE_USER_DATA, remote off),
 * two claude-haiku-5-5 threads in a scratch directory each sent a long turn,
 * SIGTERM to the instance mid-turn (what systemd's stop sends), the two rows
 * checked in resume_after_boot, a relaunch on the same data, both threads
 * back to running with the "host restarted" nudge in their logs and then
 * idle, the once-per-boot `boot-resume` push read on a fresh socket, and
 * nothing left recorded after a clean stop.
 *
 * Needs `out/main` (electron-vite build) and a Claude account the host's
 * Aliax vault routes to (HOME is kept; only the app data is isolated).
 * TC_SURVIVE_KEEP=1 leaves the scratch tree behind for a look.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_SURVIVE_KEEP === '1'
const MODEL = process.env.TC_SURVIVE_MODEL ?? 'claude-haiku-5-5'
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

const root = mkdtempSync(join(tmpdir(), 'tc-survive-e2e-'))
const data = join(root, 'data')
const tmp = join(root, 'tmp')
const work = join(root, 'work')
const logFile = join(root, 'instance.log')
for (const d of [data, tmp, work]) mkdirSync(d, { recursive: true })
let proc: ChildProcess | undefined

function launch(): ChildProcess {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TMPDIR: tmp,
    TEMP_CODE_USER_DATA: data,
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_REMOTE_PORT: '0',
    TEMP_CODE_CLAIM_SHIM: '0',
    NODE_ENV: 'production',
    SHELL: process.env.SHELL || '/bin/bash'
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TEMP_CODE_DEBUG_PORT
  rmSync(join(data, 'server.json'), { force: true })
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  const argv =
    process.platform === 'linux'
      ? ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.']
      : [electron, '.']
  const child = spawn(argv[0], argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  child.stdout?.on('data', (c: Buffer) => appendFileSync(logFile, c))
  child.stderr?.on('data', (c: Buffer) => appendFileSync(logFile, c))
  proc = child
  return child
}

/** SIGTERM to the instance's process group (xvfb-run, dbus, electron), as systemd's stop does; resolves on exit. */
function terminate(child: ChildProcess): Promise<number | null> {
  return new Promise((ok) => {
    if (child.exitCode !== null) return ok(child.exitCode)
    child.once('exit', (code) => ok(code))
    try {
      process.kill(-child.pid!, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  })
}

const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(500)
  }
  log(`timed out: ${label}`)
  return false
}

const port = (): number => (JSON.parse(readFileSync(join(data, 'server.json'), 'utf8')) as { port: number }).port

/** One request on the instance's local socket (the implicit admin). */
async function rpc<T = unknown>(method: string, params: unknown = {}): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${port()}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close()
      fail(new Error(`no answer to ${method}`))
    }, 60_000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'e2e', method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== 'e2e') return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) ok(frame.result as T)
      else fail(new Error(`${method}: ${frame.error}`))
    })
    ws.addEventListener('error', () => fail(new Error(`${method}: socket error`)))
  })
}

/** Every push a fresh socket hears in its first moments. */
function pushes(ms: number): Promise<Record<string, unknown>[]> {
  const ws = new WebSocket(`ws://127.0.0.1:${port()}/`)
  const heard: Record<string, unknown>[] = []
  return new Promise((ok) => {
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as Record<string, unknown>
      if (typeof frame.push === 'string') heard.push(frame)
    })
    setTimeout(() => {
      ws.close()
      ok(heard)
    }, ms)
  })
}

type Meta = { id: string; status: string; title: string }
type Row = { seq: number; event: { type: string; status?: string; detail?: string; text?: string; message?: string } }
const metas = async (): Promise<Meta[]> => rpc<Meta[]>('session.list')
const metaOf = async (id: string): Promise<Meta | undefined> => (await metas()).find((m) => m.id === id)
const rows = async (id: string): Promise<Row[]> => {
  const page = await rpc<{ rows: Row[] } | Row[]>('session.events', { sessionId: id, afterSeq: 0 })
  return Array.isArray(page) ? page : page.rows
}
const recorded = (): { session_id: string; recorded_at: number; last_user_seq: number | null; shutdown_at: number | null }[] => {
  const db = new DatabaseSync(join(data, 'temp-code.db'), { readOnly: true })
  try {
    return db.prepare('SELECT session_id, recorded_at, last_user_seq, shutdown_at FROM resume_after_boot ORDER BY rowid').all() as never
  } finally {
    db.close()
  }
}

const cleanup = async (): Promise<void> => {
  if (proc && proc.exitCode === null) await terminate(proc)
  if (!KEEP) rmSync(root, { recursive: true, force: true })
  else log(`kept ${root}`)
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))

try {
  log(`scratch ${root}`)
  const first = launch()
  check('instance 1 is up', await until('server.json', 90_000, () => existsSync(join(data, 'server.json'))))
  const ids: string[] = []
  for (const title of ['survive-a', 'survive-b']) {
    const meta = await rpc<Meta>('session.create', { cwd: work, provider: 'claude', model: MODEL, reasoning: 'low', permission: 'auto', title, threadType: 'chat' })
    ids.push(meta.id)
  }
  check('two threads created', ids.length === 2, ids.join(','))
  for (const id of ids) {
    await rpc('session.send', { sessionId: id, text: 'Count from 1 to 400, one number per line, no tools, no commentary. Then say DONE.' })
  }
  // Mid-turn: running, with answer text already streaming.
  const midTurn = await until('both threads streaming', 120_000, async () => {
    for (const id of ids) {
      const m = await metaOf(id)
      if (m?.status !== 'running') return false
      if (!(await rows(id)).some((r) => r.event.type === 'assistant-text')) return false
    }
    return true
  })
  if (!check('both threads are mid-turn', midTurn)) {
    for (const id of ids) {
      const err = (await rows(id)).filter((r) => r.event.type === 'error').map((r) => r.event.message).join(' | ')
      log(`${id}: ${(await metaOf(id))?.status} ${err}`)
    }
    throw new Error('threads never got mid-turn (an account that routes here is needed)')
  }
  const cutAt = Date.now()
  const code = await terminate(first)
  log(`instance 1 exited with ${code}`)
  const rec = recorded()
  check('both threads are recorded for the next boot', rec.map((r) => r.session_id).sort().join(',') === [...ids].sort().join(','), JSON.stringify(rec))
  check('each row names the user turn in flight', rec.every((r) => typeof r.last_user_seq === 'number' && r.last_user_seq > 0))
  check('the rows are from this run', rec.every((r) => r.recorded_at <= cutAt + 10_000))
  // Under xvfb-run + dbus-run-session (the box's unit too) a group SIGTERM
  // takes dbus-daemon with us and Chromium may abort on the disconnect before
  // the handler runs; the ledger row written at the turn's start covers that.
  const stamped = readFileSync(logFile, 'utf8').includes('[resume] 2 thread(s) mid-turn recorded for the next boot')
  log(stamped ? 'the shutdown handler ran and stamped the rows' : 'the process died before its handler (D-Bus abort); the ledger rows stand')
  check('a stamped row carries the shutdown time', rec.every((r) => (stamped ? Math.abs((r.shutdown_at ?? 0) - cutAt) < 10_000 : r.shutdown_at === null)))

  const second = launch()
  check('instance 2 is up', await until('server.json again', 90_000, () => existsSync(join(data, 'server.json'))))
  const resumed = await until('both threads resumed', 120_000, async () => {
    for (const id of ids) {
      const list = await rows(id)
      if (!list.some((r) => r.event.type === 'status' && r.event.detail?.startsWith('Resumed after the host restarted at '))) return false
    }
    return true
  })
  check('both threads were resumed with the restart nudge in their logs', resumed)
  const statuses = await Promise.all(ids.map(async (id) => (await metaOf(id))?.status))
  check('both are running (or already done) after the resume', statuses.every((s) => s === 'running' || s === 'idle'), statuses.join(','))
  check('no row keeps a shutdown stamp after the resume', recorded().every((r) => r.shutdown_at === null))
  const heard = await pushes(2_000)
  const boot = heard.find((p) => p.push === 'boot-resume') as { count?: number; at?: number } | undefined
  check('a fresh socket hears the once-per-boot push for two threads', boot?.count === 2 && typeof boot.at === 'number', JSON.stringify(boot ?? heard.map((p) => p.push)))
  const settled = await until('both turns settle', 300_000, async () => (await Promise.all(ids.map((id) => metaOf(id)))).every((m) => m?.status === 'idle'))
  check('both resumed turns settle idle', settled)
  for (const id of ids) {
    const list = await rows(id)
    const after = list.findIndex((r) => r.event.type === 'status' && r.event.detail?.startsWith('Resumed after'))
    const text = list.slice(after + 1).filter((r) => r.event.type === 'assistant-text').length
    check(`${id} answered after the resume`, text > 0, `${text} text rows`)
  }
  check('nothing is recorded by a stop with every thread idle', (await terminate(second), recorded().length === 0))
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  if (existsSync(logFile)) log(readFileSync(logFile, 'utf8').split('\n').slice(-30).join('\n'))
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
