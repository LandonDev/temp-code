/**
 * The fleet switches end to end: one headless instance of the BUILT tree
 * (out/main) in a scratch userData with fake providers, scratch threads
 * made over its local socket, and `session.batch` driven as the menus
 * drive it: archive five idle threads at once (every id answered, each
 * row archived), a subagent's id acting on its root, pause and stop over
 * idle threads answering per id with nothing to do, and resume likewise.
 * Nothing here touches the installed app or anyone's real threads.
 *
 * Run: bun scripts/e2e-thread-batch.ts   (build first: electron-vite build)
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_BATCH_KEEP === '1'
let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
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
  const d = mkdtempSync(join(tmpdir(), 'tc-thread-batch-e2e-'))
  return Bun.spawnSync(['realpath', d]).stdout.toString().trim() || d
})()
const inst = {
  home: join(root, 'home'),
  data: join(root, 'data'),
  tmp: join(root, 'tmp'),
  work: join(root, 'home', 'work'),
  remote: await freePort(),
  log: join(root, 'app.log'),
  proc: undefined as ChildProcess | undefined
}
for (const d of [inst.home, inst.data, inst.tmp, inst.work]) mkdirSync(d, { recursive: true })
const proj = join(inst.work, 'proj')
mkdirSync(proj, { recursive: true })

function launch(): void {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: inst.home,
    TMPDIR: inst.tmp,
    TEMP_CODE_USER_DATA: inst.data,
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_REMOTE_PORT: String(inst.remote),
    TEMP_CODE_ALIAX_DATA_DIR: join(inst.data, 'aliax'),
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_FAKE_PROVIDERS: 'http://127.0.0.1:9',
    TEMP_CODE_WORK_ROOT: inst.work,
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: '/bin/bash'
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TEMP_CODE_DEBUG_PORT
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  const argv =
    process.platform === 'linux'
      ? ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.']
      : [electron, '.']
  const proc = spawn(argv[0], argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  inst.proc = proc
}
const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(300)
  }
  log(`timed out: ${label}`)
  return false
}
const portOf = (): number => (JSON.parse(readFileSync(join(inst.data, 'server.json'), 'utf8')) as { port: number }).port

/** One request on the instance's local socket (the implicit admin). */
async function rpc<T = unknown>(method: string, params: unknown = {}, timeoutMs = 120_000): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${portOf()}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close()
      fail(new Error(`no answer to ${method}`))
    }, timeoutMs)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'e2e', method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== 'e2e') return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) ok(frame.result as T)
      else fail(new Error(frame.error))
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      fail(new Error(`socket error on ${method}`))
    })
  })
}

interface Meta {
  id: string
  parentId: string | null
  status: string
  archived: boolean
  title: string
}
interface Batch {
  attempted: string[]
  succeeded: string[]
  failed: { sessionId: string; error: string }[]
}
const list = (archived = false): Promise<Meta[]> => rpc<Meta[]>('session.list', archived ? { archived: true } : {})
const create = (title: string, parentId: string | null = null): Promise<Meta> =>
  rpc<Meta>('session.create', { provider: 'claude', cwd: proj, title, threadType: parentId ? null : 'chat', permission: 'auto', parentId, agentType: parentId ? 'implementer' : 'orchestrator' })

try {
  launch()
  const up = await until('instance up', 90_000, () => existsSync(join(inst.data, 'server.json')))
  if (!check('the headless instance published its local socket', up)) throw new Error(`no server.json; log ${inst.log}`)

  // Six scratch threads, and a subagent under the sixth.
  const roots: Meta[] = []
  for (let i = 1; i <= 6; i++) roots.push(await create(`scratch ${i}`))
  const child = await create('scratch 6 child', roots[5].id)
  check('six scratch roots and one subagent exist', (await list()).length === 7, String((await list()).length))

  // Archive done over five of them: every id answered, each row archived.
  const five = roots.slice(0, 5).map((m) => m.id)
  const archived = await rpc<Batch>('session.batch', { action: 'archive', ids: five })
  check('archive answers every id, in order, all succeeded', JSON.stringify(archived.attempted) === JSON.stringify(five) && JSON.stringify(archived.succeeded) === JSON.stringify(five) && archived.failed.length === 0, JSON.stringify(archived))
  const after = await list()
  const gone = await list(true)
  check('the five rows are archived and the sixth is not', after.length === 2 && gone.filter((m) => five.includes(m.id)).length === 5 && after.some((m) => m.id === roots[5].id), `live ${after.map((m) => m.title).join(', ')}; archived ${gone.length}`)

  // A subagent's id acts on its root, once.
  const viaChild = await rpc<Batch>('session.batch', { action: 'pause', ids: [child.id, roots[5].id, child.id] })
  check("a subagent's id is attempted as its root, once", JSON.stringify(viaChild.attempted) === JSON.stringify([roots[5].id]) && viaChild.succeeded.length === 1, JSON.stringify(viaChild))

  // Pause, stop and resume over an idle tree: nothing to do, each id answered, nothing changes.
  for (const action of ['pause', 'stop', 'resume'] as const) {
    const r = await rpc<Batch>('session.batch', { action, ids: [roots[5].id] })
    check(`${action} over an idle thread answers its id as succeeded`, r.succeeded.length === 1 && r.failed.length === 0, JSON.stringify(r))
  }
  const still = (await list()).find((m) => m.id === roots[5].id)
  check('the idle thread is still idle and unarchived afterwards', !!still && still.status === 'idle' && !still.archived, JSON.stringify(still))

  // An empty batch, and cleanup on a host with no clean-up: both answer cleanly.
  const empty = await rpc<Batch>('session.batch', { action: 'stop', ids: [] })
  check('an empty batch answers empty', empty.attempted.length === 0 && empty.succeeded.length === 0 && empty.failed.length === 0)
  const cleaned = await rpc<Batch>('session.batch', { action: 'archive', ids: [roots[5].id], cleanup: true })
  check('archive with cleanup on a host without a clean-up still archives', cleaned.succeeded.length === 1 && cleaned.failed.length === 0, JSON.stringify(cleaned))
  // A subagent keeps its own row (it renders on the parent's board); the root is what leaves the list.
  check('the sixth thread is gone from the live list', (await list()).every((m) => m.id !== roots[5].id))

  // Capabilities: a read-only remote key is refused.
  const pairing = await rpc<{ code: string }>('remote.pairings.create', { audience: 'client', caps: ['read'], name: 'reader' })
  const paired = await fetch(`http://127.0.0.1:${inst.remote}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pairing.code, kind: 'key' }) }).then((r) => r.json() as Promise<{ key: string }>)
  const ticket = await fetch(`http://127.0.0.1:${inst.remote}/api/ticket`, { method: 'POST', headers: { authorization: `Bearer ${paired.key}` } }).then((r) => r.json() as Promise<{ ticket: string }>)
  const refused = await new Promise<string>((ok) => {
    const ws = new WebSocket(`ws://127.0.0.1:${inst.remote}/ws?ticket=${encodeURIComponent(ticket.ticket)}`)
    const timer = setTimeout(() => {
      ws.close()
      ok('(no answer)')
    }, 20_000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'r', method: 'session.batch', params: { action: 'pause', ids: [] } })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; error?: string }
      if (frame.id !== 'r') return
      clearTimeout(timer)
      ws.close()
      ok(frame.ok ? '(allowed)' : frame.error ?? '(refused)')
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      ok('(socket error)')
    })
  })
  check('a read key is refused session.batch (operate)', /forbidden|operate|capab/i.test(refused), refused)
} catch (err) {
  check('the proof ran to the end', false, err instanceof Error ? err.message : String(err))
} finally {
  if (inst.proc?.pid) {
    try {
      process.kill(-inst.proc.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  await sleep(1500)
  if (!KEEP && failures === 0) rmSync(root, { recursive: true, force: true })
  else log(`kept ${root}`)
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
