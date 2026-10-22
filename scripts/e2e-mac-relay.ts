/**
 * The relay for real (docs/box.md "The relay: the phone and the API reach
 * the Mac through the box"): two isolated headless instances of the BUILT
 * tree (out/main), "mac" and "box", each with its own HOME, userData, Aliax
 * vault dir, TMPDIR, work root and fixed port, under xvfb-run and a private
 * D-Bus on Linux, the way scripts/e2e-cross-host-threads.ts runs them.
 * Provider calls go to a dead loopback origin, so no turn reaches a model.
 * mac runs with TEMP_CODE_E2E_PRESENCE=1 (presence.set) and
 * TEMP_CODE_PRESENCE=unlocked,awake.
 *
 *  1. box issues an admin key, mac saves box: mac registers with the relay offer
 *  2. mac creates a chat thread
 *  3. box issues an operate client key (the phone): /api/hello lists mac up, unlocked, awake
 *  4. /ws?ticket&host=<mac>: the hello is mac's id, via box, the key's caps
 *  5. over the lane: session.list names mac's thread; session.send lands a user row on mac;
 *     session.rename lands on mac
 *  6. the box's gate and the relay's refusals: local-only, not relayed, the box's own push
 *     status, the Mac's fence
 *  7. mac locks: a presence push on the lane, session.list still answers, openXcode is
 *     refused; mac sleeps: everything is refused; mac wakes: session.list answers again
 *  8. /mcp with a bot key on box: list_projects names both hosts, list_sessions has the
 *     prefixed row, get_session and send_message reach mac
 *  9. the drop: mac removes box; the lane closes 4010, /api/hello says down, a new lane is
 *     503, /mcp get_session is the unreachable line; mac re-adds box: up again, a lane opens
 * 10. revoking the phone key closes its lane with 4001
 * Run: bun scripts/e2e-mac-relay.ts   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app, a real HOME, the real
 * Aliax vault, the gateway marker or the box's live temp-code.service.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_RELAY_KEEP === '1'
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
  const d = mkdtempSync(join(tmpdir(), 'tc-mac-relay-e2e-'))
  return Bun.spawnSync(['realpath', d]).stdout.toString().trim() || d
})()
type Inst = { name: string; home: string; data: string; tmp: string; work: string; remote: number; log: string; extra: Record<string, string>; proc?: ChildProcess }
const mk = async (name: string, extra: Record<string, string> = {}): Promise<Inst> => {
  const inst = { name, home: join(root, `${name}-home`), data: join(root, `${name}-data`), tmp: join(root, `${name}-tmp`), work: join(root, `${name}-home`, 'work'), remote: await freePort(), log: join(root, `${name}.log`), extra }
  for (const d of [inst.home, inst.data, inst.tmp, inst.work]) mkdirSync(d, { recursive: true })
  return inst
}
const mac = await mk('mac', { TEMP_CODE_E2E_PRESENCE: '1', TEMP_CODE_PRESENCE: 'unlocked,awake' })
const box = await mk('box')
const macProj = join(mac.work, 'proj')
mkdirSync(macProj, { recursive: true })

function launch(inst: Inst): void {
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
    SHELL: '/bin/bash',
    ...inst.extra
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TEMP_CODE_DEBUG_PORT
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  const argv = process.platform === 'linux' ? ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.'] : [electron, '.']
  const proc = spawn(argv[0], argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  inst.proc = proc
}
const logOf = (inst: Inst): string => (existsSync(inst.log) ? readFileSync(inst.log, 'utf8') : '')
const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(300)
  }
  log(`timed out: ${label}`)
  return false
}
const portOf = (inst: Inst): number => (JSON.parse(readFileSync(join(inst.data, 'server.json'), 'utf8')) as { port: number }).port

/** One request on the instance's local socket (the implicit admin). */
async function rpc<T = unknown>(inst: Inst, method: string, params: unknown = {}, timeoutMs = 60_000): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${portOf(inst)}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close()
      fail(new Error(`${inst.name}: no answer to ${method}`))
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
      fail(new Error(`${inst.name}: socket error on ${method}`))
    })
  })
}

const boxHttp = (path: string, init: RequestInit = {}): Promise<Response> => fetch(`http://127.0.0.1:${box.remote}${path}`, init)
const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` })
const hello = async (token: string): Promise<{ hosts?: { environmentId: string; link: string; screen: string; power: string; since: number }[] }> =>
  (await boxHttp('/api/hello', { headers: bearer(token) })).json()

interface Lane {
  ws: WebSocket
  frames: Record<string, unknown>[]
  closed: Promise<number>
  request: (method: string, params?: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>
}
const ticketOf = async (token: string): Promise<string> =>
  ((await (await boxHttp('/api/ticket', { method: 'POST', headers: bearer(token) })).json()) as { ticket: string }).ticket
/** The upgrade's status for a lane to `host`: 101 when it would open, else the refusal (spends one ticket). */
async function upgradeStatus(token: string, host: string): Promise<number> {
  const path = `/ws?ticket=${await ticketOf(token)}&host=${host}`
  return new Promise((ok) => {
    const req = httpRequest({ host: '127.0.0.1', port: box.remote, path, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } })
    req.on('upgrade', (_res, socket) => {
      socket.destroy()
      ok(101)
    })
    req.on('response', (res) => {
      res.resume()
      ok(res.statusCode ?? 0)
    })
    req.on('error', () => ok(-1))
    req.end()
  })
}
/** A phone's socket on box: a direct lane, or with `host` a relayed one; a refused relayed upgrade answers its status. */
async function lane(token: string, host?: string): Promise<Lane | number> {
  if (host) {
    const status = await upgradeStatus(token, host)
    if (status !== 101) return status
  }
  return openLane(`ws://127.0.0.1:${box.remote}/ws?ticket=${await ticketOf(token)}${host ? `&host=${host}` : ''}`)
}
function openLane(url: string): Promise<Lane> {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(url)
    const frames: Record<string, unknown>[] = []
    const pending = new Map<string, (f: { ok: boolean; result?: unknown; error?: string }) => void>()
    let next = 1
    let onClose: (code: number) => void = () => {}
    const closed = new Promise<number>((r) => (onClose = r))
    ws.addEventListener('message', (ev) => {
      const f = JSON.parse(String(ev.data)) as Record<string, unknown>
      frames.push(f)
      if (typeof f.id === 'string') pending.get(f.id)?.(f as never)
    })
    ws.addEventListener('close', (ev) => onClose(ev.code))
    ws.addEventListener('error', () => fail(new Error('lane error')))
    ws.addEventListener('open', () =>
      ok({
        ws,
        frames,
        closed,
        request: (method, params = {}) =>
          new Promise((r) => {
            const id = `r${next++}`
            pending.set(id, r)
            ws.send(JSON.stringify({ id, method, params }))
          })
      })
    )
  })
}
const first = async (l: Lane, push: string): Promise<Record<string, unknown> | undefined> => {
  await until(`${push} frame`, 15_000, () => l.frames.some((f) => f.push === push))
  return l.frames.find((f) => f.push === push)
}
/** One /mcp tool call with a bot key; the text of the result (an error starts "error: "). */
async function mcp(token: string, name: string, args: unknown): Promise<{ text: string; structured?: Record<string, unknown> }> {
  const res = await boxHttp('/mcp', {
    method: 'POST',
    headers: { ...bearer(token), 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  const body = (await res.json()) as { result: { content: { text: string }[]; structuredContent?: Record<string, unknown> } }
  return { text: body.result.content[0].text, structured: body.result.structuredContent }
}

function kill(inst: Inst): void {
  if (!inst.proc?.pid) return
  try {
    process.kill(-inst.proc.pid, 'SIGTERM')
  } catch {
    /* gone */
  }
}
const cleanup = async (): Promise<void> => {
  kill(mac)
  kill(box)
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

launch(mac)
launch(box)
try {
  const up = (await until('mac up', 90_000, () => existsSync(join(mac.data, 'server.json')))) && (await until('box up', 90_000, () => existsSync(join(box.data, 'server.json'))))
  if (!check('both headless instances published their local socket', up)) throw new Error(`no server.json; logs ${mac.log} ${box.log}`)
  const macId = (await rpc<{ environmentId: string }>(mac, 'remote.status')).environmentId
  const boxId = (await rpc<{ environmentId: string }>(box, 'remote.status')).environmentId
  log(`mac ${macId}, box ${boxId} on :${box.remote}; logs ${mac.log} ${box.log}`)

  // ── 1. pair ───────────────────────────────────────────────────────────
  const admin = await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'mac (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  const env = await rpc<{ id: string }>(mac, 'remote.environments.add', { url: `http://127.0.0.1:${box.remote}`, key: admin.token, name: 'box' })
  check('box logged the relay offer in the registration', await until('relay offer', 60_000, () => new RegExp(`\\[peer-calls\\] ${macId} registered \\(offers [^)]*relay`).test(logOf(box))))

  // ── 2. a thread on mac ────────────────────────────────────────────────
  const thread = await rpc<{ id: string }>(mac, 'session.create', { provider: 'claude', cwd: macProj, title: 'mac thread', threadType: 'chat', permission: 'edits' })
  const sid = thread.id

  // ── 3. the phone's key and /api/hello ────────────────────────────────
  const phone = await rpc<{ key: { id: string }; token: string }>(box, 'remote.keys.create', { name: 'phone (e2e)', audience: 'client', caps: ['read', 'operate'] })
  const h = await hello(phone.token)
  const row = h.hosts?.find((x) => x.environmentId === macId)
  check('/api/hello lists mac up, unlocked and awake', row?.link === 'up' && row.screen === 'unlocked' && row.power === 'awake', JSON.stringify(h.hosts))

  // ── 4. the lane ───────────────────────────────────────────────────────
  const l = await lane(phone.token, macId)
  if (typeof l === 'number') throw new Error(`the lane to mac was refused ${l}`)
  const hi = (await first(l, 'hello')) as { environmentId?: string; via?: string; caps?: string[]; presence?: { link: string } } | undefined
  check("the lane's hello is mac's, via box, with the key's caps", hi?.environmentId === macId && hi.via === boxId && hi.presence?.link === 'up' && JSON.stringify(hi.caps) === JSON.stringify(['operate', 'read']), JSON.stringify(hi))

  // ── 5. steering a mac thread through the box ─────────────────────────
  const list = await l.request('session.list', {})
  check("session.list over the lane names mac's thread", JSON.stringify(list.result ?? '').includes(sid), JSON.stringify(list).slice(0, 300))
  await l.request('session.subscribe', { sessionId: sid })
  await l.request('session.send', { sessionId: sid, text: 'hello from the phone through the box' })
  check('the sent row lands on mac', await until('row on mac', 20_000, async () => JSON.stringify(await rpc(mac, 'session.events', { sessionId: sid, afterSeq: 0 })).includes('hello from the phone through the box')))
  check('an events push carries it back on the lane', await until('events push', 20_000, () => l.frames.some((f) => f.push === 'events' && JSON.stringify(f).includes('hello from the phone'))))
  await l.request('session.rename', { sessionId: sid, title: 'renamed through the box' })
  check('the rename lands on mac', await until('rename', 15_000, async () => JSON.stringify(await rpc(mac, 'session.list')).includes('renamed through the box')))

  // ── 6. the gate and the refusals ─────────────────────────────────────
  check('a local method is refused on the box', (await l.request('app.listThreads', { sessionId: 'x' })).error === 'forbidden: app.listThreads is local-only')
  check('a method outside the relay table does not cross', (await l.request('doctor.get', {})).error === 'forbidden: doctor.get does not relay to another host')
  check("the box answers the key's own push status", (await l.request('remote.push.status', {})).ok === true)
  // fs.readPreview: path-fenced and on the relay table (fs.readText never relays, so the box refused it before the Mac's fence saw it).
  const fenced = await l.request('fs.readPreview', { path: join(mac.home, '.ssh', 'id_ed25519'), maxLines: 5 })
  check("the Mac's fence refuses a path outside its roots", (fenced.error ?? '').includes('outside app-managed roots'), JSON.stringify(fenced).slice(0, 300))

  // ── 7. lock, sleep, wake ─────────────────────────────────────────────
  await rpc(mac, 'presence.set', { screen: 'locked' })
  check('a presence push says locked', await until('locked push', 15_000, () => l.frames.some((f) => f.push === 'presence' && JSON.stringify(f).includes('"screen":"locked"'))))
  check('a locked Mac still lists', (await l.request('session.list', {})).ok === true)
  check('a locked Mac refuses opening Xcode', (await l.request('host.device.openXcode', { udid: 'X' })).error === 'unavailable: the Mac is locked')
  await rpc(mac, 'presence.set', { power: 'asleep' })
  await until('asleep', 15_000, () => l.frames.some((f) => f.push === 'presence' && JSON.stringify(f).includes('"power":"asleep"')))
  check('an asleep Mac refuses everything', (await l.request('session.list', {})).error === 'unavailable: the Mac is asleep')
  await rpc(mac, 'presence.set', { power: 'awake', screen: 'unlocked' })
  await until('awake', 15_000, () => l.frames.filter((f) => f.push === 'presence').some((f) => JSON.stringify(f).includes('"power":"awake"') && JSON.stringify(f).includes('"screen":"unlocked"')))
  check('awake again, session.list answers', (await l.request('session.list', {})).ok === true)

  // ── 8. /mcp ───────────────────────────────────────────────────────────
  const bot = await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'bot (e2e)', audience: 'mcp', caps: ['read', 'operate'] })
  const projects = await mcp(bot.token, 'list_projects', {})
  const hosts = (projects.structured?.hosts ?? []) as { environmentId: string; self: boolean; state: string }[]
  check('list_projects names box (self) and mac (available)', hosts.some((x) => x.environmentId === boxId && x.self) && hosts.some((x) => x.environmentId === macId && x.state === 'available'), projects.text.slice(0, 300))
  const sessions = await mcp(bot.token, 'list_sessions', {})
  const relayed = ((sessions.structured?.sessions ?? []) as { id: string; host: string }[]).find((x) => x.id === `${macId}:${sid}`)
  check("list_sessions has mac's row, prefixed, with its host", relayed?.host === macId, sessions.text.slice(0, 300))
  const got = await mcp(bot.token, 'get_session', { session: `${macId}:${sid}` })
  check('get_session reaches mac', !got.text.startsWith('error:') && got.text.includes('renamed through the box'), got.text.slice(0, 200))
  await mcp(bot.token, 'send_message', { session: `${macId}:${sid}`, text: 'hello from the bot through the box' })
  check("send_message lands a row on mac", await until('bot row', 20_000, async () => JSON.stringify(await rpc(mac, 'session.events', { sessionId: sid, afterSeq: 0 })).includes('hello from the bot')))

  // ── 9. the drop ───────────────────────────────────────────────────────
  await rpc(mac, 'remote.environments.remove', { id: env.id })
  check('the open lane closes 4010', (await Promise.race([l.closed, sleep(30_000).then(() => -1)])) === 4010)
  check('/api/hello says mac is down', await until('down', 15_000, async () => (await hello(phone.token)).hosts?.find((x) => x.environmentId === macId)?.link === 'down'))
  check('a new lane to mac is refused 503', (await lane(phone.token, macId)) === 503)
  const unreachable = await mcp(bot.token, 'get_session', { session: `${macId}:${sid}` })
  check('/mcp get_session says unreachable since HH:MM', /^error: unavailable: the Mac is unreachable since (\d{1,2} [A-Z][a-z]{2} )?\d\d:\d\d$/.test(unreachable.text), unreachable.text)
  await rpc(mac, 'remote.environments.add', { url: `http://127.0.0.1:${box.remote}`, key: admin.token, name: 'box' })
  check('mac is up again', await until('up again', 60_000, async () => (await hello(phone.token)).hosts?.find((x) => x.environmentId === macId)?.link === 'up'))
  const l2 = await lane(phone.token, macId)
  check('a new lane opens', typeof l2 !== 'number')

  // ── 10. revoke ────────────────────────────────────────────────────────
  if (typeof l2 !== 'number') {
    await first(l2, 'hello')
    await rpc(box, 'remote.keys.revoke', { id: phone.key.id })
    check('revoking the phone key closes its lane with 4001', (await Promise.race([l2.closed, sleep(15_000).then(() => -1)])) === 4001)
  }
} catch (err) {
  check('the run finished', false, err instanceof Error ? err.message : String(err))
} finally {
  await cleanup()
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
