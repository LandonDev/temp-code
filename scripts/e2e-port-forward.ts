/**
 * Dev servers on the box reach the Mac's browser, for real (docs/box.md "Dev
 * servers on the box"): two isolated headless instances of the BUILT tree
 * (out/main), launched the way scripts/e2e-remote-media.ts launches them (own
 * HOME, userData, TMPDIR and fixed port; on Linux under xvfb-run and a private
 * D-Bus). "box" serves, "mac" is paired to box with an admin key, the way the
 * desktop's link to the box is.
 *
 * Both instances share this machine, so box's dev server already holds its
 * number on the loopback mac binds: every forward here is the collision case,
 * and mac must take the next free number and say so (the unit tests in
 * remote/portForward.test.ts cover the same number when it is free).
 *
 *  - the Dev Server button's road: box detects the project's `dev` script,
 *    runs it, finds its listener, and mac binds the next number up; a GET and
 *    a websocket echo through mac's number reach box's server; box's run names
 *    mac's number; Stop ends the server and mac's listener closes
 *  - a thread's road: a box thread's shell call (the proof seam
 *    session.proofShellCall, TEMP_CODE_E2E_STATUS=1: the call and its output
 *    as the thread's own rows, so the real watchers see it) starts a server
 *    that announces itself; the ledger files a `port` row with its pid, mac
 *    forwards it, a GET goes through; archiving the thread with its resources
 *    kills the pid, stamps the row and closes mac's listener
 *  - the switch: mac's "Dev server forwarding" off closes the forward, on binds it again
 *  - the link: box gone, mac's forwards are gone
 * Run: bun scripts/e2e-port-forward.ts   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app, a real HOME, the real
 * Aliax vault or the box's live temp-code.service.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DevRun, DevTarget } from '../src/shared/contract-devservers'
import type { ForwardHost } from '../src/shared/contract-ports'
import type { ThreadResource } from '../src/shared/contract-resources'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_PORTS_KEEP === '1'
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
/** A free port whose next one up is free too (the forward takes it). */
const freePair = async (): Promise<number> => {
  for (;;) {
    const p = await freePort()
    const taken = await new Promise<boolean>((ok) => {
      const s = createServer()
      s.once('error', () => ok(true))
      s.listen(p + 1, '127.0.0.1', () => s.close(() => ok(false)))
    })
    if (!taken && p < 65000) return p
  }
}

const root = (() => {
  const d = mkdtempSync(join(tmpdir(), 'tc-ports-e2e-'))
  return Bun.spawnSync(['realpath', d]).stdout.toString().trim() || d
})()
type Inst = { name: string; home: string; data: string; tmp: string; remote: number; log: string; proc?: ChildProcess }
const mk = async (name: string): Promise<Inst> => {
  const inst = { name, home: join(root, `${name}-home`), data: join(root, `${name}-data`), tmp: join(root, `${name}-tmp`), remote: await freePort(), log: join(root, `${name}.log`) }
  for (const d of [inst.home, inst.data, inst.tmp]) mkdirSync(d, { recursive: true })
  return inst
}
const mac = await mk('mac')
const box = await mk('box')

// The dev server: http plus a websocket echo (the HMR channel), announcing itself the way Vite does.
const work = join(root, 'box-work')
mkdirSync(work, { recursive: true })
const WS = join(REPO, 'node_modules', 'ws')
writeFileSync(
  join(work, 'server.cjs'),
  `const http = require('http'); const { WebSocketServer } = require(${JSON.stringify(WS)});
const port = Number(process.env.PORT);
const s = http.createServer((q, r) => r.end('served by box ' + q.url));
new WebSocketServer({ server: s }).on('connection', (ws) => ws.on('message', (m) => ws.send('echo ' + m)));
s.listen(port, '127.0.0.1', () => console.log('  ➜  Local:   http://localhost:' + port + '/'));
`
)
const DEV_PORT = await freePair()
const THREAD_PORT = await freePair()
writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'site', scripts: { dev: `PORT=${DEV_PORT} node server.cjs` } }))
Bun.spawnSync(['git', 'init', '-q', work])

function launch(inst: Inst, extra: Record<string, string> = {}): void {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: inst.home,
    TMPDIR: inst.tmp,
    TEMP_CODE_USER_DATA: inst.data,
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_REMOTE_PORT: String(inst.remote),
    TEMP_CODE_ALIAX_DATA_DIR: join(inst.data, 'aliax'),
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_WARM_HARNESS: '0',
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: '/bin/bash',
    ...extra
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

/** One request on the instance's local socket (the implicit admin). */
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

function kill(inst: Inst): void {
  if (!inst.proc?.pid) return
  try {
    process.kill(-inst.proc.pid, 'SIGTERM')
  } catch {
    /* gone */
  }
}
const strays: number[] = []
const cleanup = async (): Promise<void> => {
  kill(mac)
  kill(box)
  // A negative pid is a run's process group (box dying under the proof may leave its dev server behind).
  for (const pid of strays) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  await sleep(1500)
  for (const inst of [mac, box]) {
    try {
      if (inst.proc?.pid) process.kill(-inst.proc.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  if (!KEEP && failures === 0) rmSync(root, { recursive: true, force: true })
  else log(`left for inspection: ${root}`)
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))

const get = async (port: number, path = '/'): Promise<{ status: number; body: string } | null> => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`)
    return { status: r.status, body: await r.text() }
  } catch {
    return null
  }
}
const echo = (port: number): Promise<string> =>
  new Promise((ok, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/hmr`)
    const t = setTimeout(() => (ws.close(), fail(new Error('no echo'))), 10_000)
    ws.addEventListener('open', () => ws.send('ping'))
    ws.addEventListener('message', (ev) => {
      clearTimeout(t)
      ws.close()
      ok(String(ev.data))
    })
    ws.addEventListener('error', () => (clearTimeout(t), fail(new Error('ws error'))))
  })
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

try {
  launch(mac)
  launch(box, { TEMP_CODE_E2E_STATUS: '1' })
  const up = (await until('mac up', 90_000, () => existsSync(join(mac.data, 'server.json')))) && (await until('box up', 90_000, () => existsSync(join(box.data, 'server.json'))))
  if (!check('both headless instances published their local socket', up)) throw new Error(`no server.json; logs ${mac.log} ${box.log}`)
  const boxEnv = (JSON.parse(readFileSync(join(box.data, 'environment.json'), 'utf8')) as { id: string }).id
  const macEnv = (JSON.parse(readFileSync(join(mac.data, 'environment.json'), 'utf8')) as { id: string }).id

  // ── 1. pair: box issues an admin key, mac saves box ──
  const admin = await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'mac (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  await rpc(mac, 'remote.environments.add', { url: `http://127.0.0.1:${box.remote}`, key: admin.token, name: 'The box' })
  const forwards = async (): Promise<ForwardHost | undefined> => (await rpc<{ hosts: ForwardHost[] }>(mac, 'ports.forwards')).hosts.find((h) => h.environmentId === boxEnv)
  check('mac lists box with forwarding on by default', await until('mac links to box', 60_000, async () => !!(await forwards())?.connected && !!(await forwards())?.enabled))

  // ── 2. the Dev Server button's road ──
  const ws = await rpc<{ id: string }>(box, 'workspace.create', { path: work, name: 'site' })
  const project = await rpc<{ id: string }>(box, 'project.create', { workspaceId: ws.id, name: 'site', mode: 'local' })
  const { targets } = await rpc<{ targets: DevTarget[] }>(box, 'devServer.targets', { projectId: project.id })
  check('box detects the dev script with its runner', targets.length === 1 && targets[0].id === '.#dev' && targets[0].command === 'npm run dev', JSON.stringify(targets.map((t) => t.command)))
  const { run } = await rpc<{ run: DevRun }>(box, 'devServer.start', { projectId: project.id, targetId: '.#dev' })
  check('box runs it', run.status === 'running', run.status)
  const devMac = DEV_PORT + 1
  const bound = await until('mac binds the dev run', 30_000, async () => (await forwards())?.forwards.some((f) => f.port === DEV_PORT && f.macPort === devMac) ?? false)
  check(`mac binds ${devMac}: ${DEV_PORT} is taken on this machine (box's own server)`, bound, JSON.stringify((await forwards())?.forwards))
  const page = await get(devMac, '/hello')
  check('a GET through the Mac number reaches box’s server', page?.status === 200 && page.body === 'served by box /hello', JSON.stringify(page))
  check('a websocket echo goes both ways (HMR)', (await echo(devMac).catch((e: Error) => e.message)) === 'echo ping')
  const runNow = (await rpc<{ run: DevRun; lines: string[] }>(box, 'devServer.log', { runId: run.id }))
  check('box’s run names the Mac’s number for its port', runNow.run.ports.some((p) => p.port === DEV_PORT && p.forwards.some((f) => f.environmentId === macEnv && f.macPort === devMac)), JSON.stringify(runNow.run.ports))
  check('its console carries the server’s own line', runNow.lines.some((l) => l.includes(`Local:   http://localhost:${DEV_PORT}/`)))
  await rpc(box, 'devServer.stop', { runId: run.id })
  check('Stop closes mac’s listener', await until('dev forward gone', 20_000, async () => !(await forwards())?.forwards.some((f) => f.port === DEV_PORT) && (await get(devMac)) === null))

  // ── 3. a thread's road ──
  const thread = await rpc<{ id: string }>(box, 'session.create', { provider: 'claude', cwd: work, title: 'port forward e2e', threadType: 'chat' })
  const server = spawn('node', ['server.cjs'], { cwd: work, env: { ...process.env, PORT: String(THREAD_PORT) }, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  strays.push(server.pid as number)
  const announced = await new Promise<string>((ok) => server.stdout?.on('data', (c: Buffer) => ok(String(c))))
  await rpc(box, 'session.proofShellCall', { sessionId: thread.id, callId: 'call-1', command: `PORT=${THREAD_PORT} nohup node server.cjs &`, output: announced })
  let row: ThreadResource | undefined
  const filed = await until('the ledger files the port', 20_000, async () => {
    row = (await rpc<{ resources: ThreadResource[] }>(box, 'resources.list', { sessionId: thread.id })).resources.find((r) => r.kind === 'port')
    return !!row
  })
  check('the ledger files a port row with its pid and call', filed && row?.identifier === String(THREAD_PORT) && row.pid === server.pid && row.callId === 'call-1', JSON.stringify(row))
  const threadMac = THREAD_PORT + 1
  check('mac forwards it', await until('thread forward', 20_000, async () => (await forwards())?.forwards.some((f) => f.port === THREAD_PORT && f.macPort === threadMac) ?? false))
  const viaRow = (await rpc<{ resources: ThreadResource[] }>(box, 'resources.list', { sessionId: thread.id })).resources.find((r) => r.kind === 'port')
  check('the row carries the Mac’s number', viaRow?.forwards?.some((f) => f.environmentId === macEnv && f.macPort === threadMac) ?? false, JSON.stringify(viaRow?.forwards))
  check('a GET goes through', (await get(threadMac, '/t'))?.body === 'served by box /t')

  // ── 4. the switch ──
  await rpc(mac, 'ports.setForwarding', { environmentId: boxEnv, enabled: false })
  check('switched off, mac closes the forward', (await forwards())?.forwards.length === 0 && (await get(threadMac)) === null)
  await rpc(mac, 'ports.setForwarding', { environmentId: boxEnv, enabled: true })
  check('switched on, it is back on its number', await until('forward back', 20_000, async () => (await get(threadMac, '/x'))?.body === 'served by box /x'))

  // ── 5. archive with the resources ──
  await rpc(box, 'session.archive', { sessionId: thread.id, archived: true, removeResources: true })
  const ended = await until('the server is killed', 20_000, () => !alive(server.pid as number))
  check('archiving the thread kills the dev server', ended)
  const stamped = (await rpc<{ resources: ThreadResource[] }>(box, 'resources.list', { sessionId: thread.id, includeRemoved: true })).resources.find((r) => r.kind === 'port')
  check('and stamps its row removed', !!stamped?.removedAt, JSON.stringify(stamped))
  check('and mac’s listener closes', await until('thread forward gone', 20_000, async () => (await get(threadMac)) === null && !(await forwards())?.forwards.length))

  // ── 6. the link ──
  const again = await rpc<{ run: DevRun }>(box, 'devServer.start', { projectId: project.id, targetId: '.#dev' })
  if (again.run.pid) strays.push(-again.run.pid)
  await until('rebound', 20_000, async () => (await get(devMac))?.status === 200)
  kill(box)
  check('with box gone, mac’s forwards close', await until('link down', 30_000, async () => (await get(devMac)) === null && !(await forwards())?.forwards.length), again.run.id)
} catch (err) {
  check('the proof ran to the end', false, err instanceof Error ? err.message : String(err))
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
