/**
 * A thread on the box starting threads on the Mac, for real (docs/box.md
 * "Starting a thread on the Mac from the box"): two isolated headless
 * instances of the BUILT tree (out/main), the way scripts/e2e-mac-bridge.ts
 * runs them: each with its own HOME, userData, Aliax vault dir, TMPDIR,
 * work root and fixed port, under xvfb-run and a private D-Bus on Linux.
 * "mac" plays the Mac, "box" plays the box. Provider calls go to a dead
 * loopback origin (TEMP_CODE_FAKE_PROVIDERS), so no turn reaches a model:
 * every thread's turn fails fast and settles, which is what the control
 * plane needs to prove.
 *
 *  - box issues an admin key, mac saves box as an environment: mac's link
 *    registers on box with the `threads` offer beside `mac-bridge`
 *  - a box thread calls app.startThread with environmentId `mac`: the thread
 *    appears on mac at once (session.list), an ordinary chat under the
 *    caller's permission, in the mac checkout the box path maps to (the
 *    box's `<work root>/proj` → the mac's `<work root>/proj`), and the id
 *    comes back as `<macId>:<sessionId>`; a box path with no checkout on
 *    mac starts in mac's work root with cwdNote
 *  - app.sendToAgent lands a second user row on mac; app.waitForAgent
 *    settles when the turn ends; app.readThread with the encoded id reads
 *    its rows over the link; app.checkAgent answers live state
 *  - app.spawnAgent with environmentId `mac` makes a child on mac whose
 *    parentId is the box thread, the box thread's log gets agent-spawned
 *    with mac's environment id, and app.listAgents names both with host
 *  - app.answerAgent with nothing pending is refused with the reason;
 *    app.interruptAgent answers
 *  - the codex stdio bridge lists environmentId on spawn_agent and
 *    app_start_thread, and allow on answer_agent
 *  - with the host removed on mac (the link drops): app.waitForAgent answers
 *    the last known state with linkDown, app.listAgents says linkDown, and
 *    app.startThread refuses naming the Mac bridge switch
 * Run: bun scripts/e2e-cross-host-threads.ts   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app, a real HOME, the real
 * Aliax vault, the gateway marker or the box's live temp-code.service.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_XH_KEEP === '1'
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
  const d = mkdtempSync(join(tmpdir(), 'tc-cross-host-e2e-'))
  return Bun.spawnSync(['realpath', d]).stdout.toString().trim() || d
})()
type Inst = { name: string; home: string; data: string; tmp: string; work: string; remote: number; log: string; proc?: ChildProcess }
const mk = async (name: string): Promise<Inst> => {
  const inst = {
    name,
    home: join(root, `${name}-home`),
    data: join(root, `${name}-data`),
    tmp: join(root, `${name}-tmp`),
    work: join(root, `${name}-home`, 'work'),
    remote: await freePort(),
    log: join(root, `${name}.log`)
  }
  for (const d of [inst.home, inst.data, inst.tmp, inst.work]) mkdirSync(d, { recursive: true })
  return inst
}
const mac = await mk('mac')
const box = await mk('box')
// The box thread's checkout, and the same name on the Mac (the map lands it there).
const boxProj = join(box.work, 'proj')
const macProj = join(mac.work, 'proj')
const boxMissing = join(box.work, 'missing')
mkdirSync(boxProj, { recursive: true })
mkdirSync(macProj, { recursive: true })
mkdirSync(boxMissing, { recursive: true })

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
async function rpc<T = unknown>(inst: Inst, method: string, params: unknown = {}, timeoutMs = 180_000): Promise<T> {
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
const errorOf = async (p: Promise<unknown>): Promise<string> => p.then(() => '(no error)', (e: Error) => e.message)

interface Meta {
  id: string
  parentId: string | null
  threadType: string | null
  permission: string
  cwd: string
  status: string
  title: string
  agentType: string
}
const sessionsOf = (inst: Inst): Promise<Meta[]> => rpc<Meta[]>(inst, 'session.list')
const eventsOf = (inst: Inst, sessionId: string): Promise<{ seq: number; event: { type: string; text?: string; environmentId?: string; childSessionId?: string } }[]> =>
  rpc(inst, 'session.events', { sessionId, afterSeq: 0 })

/** The codex stdio bridge, as codex would spawn it: initialize and tools/list. */
async function codexTools(sessionId: string): Promise<{ name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[]> {
  const child = spawn('node', [join(REPO, 'scripts', 'app-mcp-bridge.mjs')], {
    env: { PATH: process.env.PATH ?? '', TEMP_CODE_PORT: String(portOf(box)), TEMP_CODE_SESSION: sessionId },
    stdio: ['pipe', 'pipe', 'inherit']
  })
  const answers = new Map<number, unknown>()
  let buf = ''
  child.stdout.on('data', (c: Buffer) => {
    buf += c.toString()
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const msg = JSON.parse(buf.slice(0, nl)) as { id: number; result: unknown }
      buf = buf.slice(nl + 1)
      answers.set(msg.id, msg.result)
    }
  })
  const ask = async (id: number, method: string, params: unknown): Promise<unknown> => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    const end = Date.now() + 60_000
    while (!answers.has(id) && Date.now() < end) await sleep(50)
    return answers.get(id)
  }
  try {
    await ask(1, 'initialize', { protocolVersion: '2025-03-26' })
    const list = (await ask(2, 'tools/list', {})) as { tools: { name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }[] }
    return list.tools
  } finally {
    child.kill()
  }
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
  const up =
    (await until('mac up', 90_000, () => existsSync(join(mac.data, 'server.json')))) &&
    (await until('box up', 90_000, () => existsSync(join(box.data, 'server.json'))))
  if (!check('both headless instances published their local socket', up)) throw new Error(`no server.json; logs ${mac.log} ${box.log}`)
  const macId = (await rpc<{ environmentId: string }>(mac, 'remote.status')).environmentId
  const boxId = (await rpc<{ environmentId: string }>(box, 'remote.status')).environmentId
  log(`mac ${macId}, box ${boxId} on :${box.remote}; logs ${mac.log} ${box.log}`)

  // ── 1. pair: box issues an admin key, mac saves box; mac's link registers both offers ──
  const key = await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'mac (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  await rpc(mac, 'remote.environments.add', { url: `http://127.0.0.1:${box.remote}`, key: key.token, name: 'box' })
  const registered = await until('mac registers on box', 60_000, () => logOf(box).includes(`[peer-calls] ${macId} registered (offers mac-bridge,threads`))
  check("box logged mac's registration with the threads offer beside mac-bridge", registered)

  // ── 2. a box thread starts a thread on mac ────────────────────────────
  const caller = await rpc<{ id: string }>(box, 'session.create', { provider: 'claude', cwd: boxProj, title: 'box thread', threadType: 'chat', permission: 'auto' })
  const sid = caller.id
  const started = await rpc<{ threadId: string; title: string; host: string; cwd: string; cwdNote?: string } | string>(box, 'app.startThread', {
    sessionId: sid,
    environmentId: 'mac',
    threadType: 'chat',
    provider: 'claude',
    firstMessage: 'hello from the box',
    title: 'started from the box'
  })
  check('app.startThread with environmentId mac answers an encoded id and the host', typeof started === 'object' && started.threadId === `${macId}:${started.threadId.split(':')[1]}` && started.host === macId, JSON.stringify(started))
  if (typeof started === 'string') throw new Error(started)
  const macSid = started.threadId.split(':')[1]
  check('the box path mapped onto the mac checkout of the same name under its work root', started.cwd === macProj && !started.cwdNote, JSON.stringify(started))
  const onMac = (await sessionsOf(mac)).find((s) => s.id === macSid)
  check('mac lists the thread at once: an ordinary chat, no parent, the caller permission, in that checkout', !!onMac && onMac.threadType === 'chat' && onMac.parentId === null && onMac.permission === 'auto' && onMac.cwd === macProj && onMac.title === 'started from the box', JSON.stringify(onMac))
  const firstRows = await eventsOf(mac, macSid)
  check('its first message landed on mac as the first user row', firstRows.some((r) => r.event.type === 'user-text' && r.event.text === 'hello from the box'), JSON.stringify(firstRows.slice(0, 3)))
  // A box thread in a checkout mac does not have: its thread lands in mac's work root.
  const elsewhere = await rpc<{ id: string }>(box, 'session.create', { provider: 'claude', cwd: boxMissing, title: 'box thread elsewhere', threadType: 'chat', permission: 'auto' })
  const missing = await rpc<{ cwd: string; cwdNote?: string } | string>(box, 'app.startThread', { sessionId: elsewhere.id, environmentId: macId, threadType: 'chat', provider: 'claude', firstMessage: 'x' })
  check("a box path with no checkout on mac starts in mac's work root and says so", typeof missing === 'object' && missing.cwd === mac.work && !!missing.cwdNote?.includes('no checkout'), JSON.stringify(missing))

  // ── 3. send, wait, read, check ────────────────────────────────────────
  const sent = await rpc<string>(box, 'app.sendToAgent', { sessionId: sid, agentId: started.threadId, message: 'second message' })
  check('app.sendToAgent by the encoded id answers sent', sent === 'sent', sent)
  const landed = await until('second user row on mac', 30_000, async () => (await eventsOf(mac, macSid)).some((r) => r.event.type === 'user-text' && r.event.text === 'second message'))
  check('the second message landed on mac', landed)
  const waited = JSON.parse(await rpc<string>(box, 'app.waitForAgent', { sessionId: sid, agentId: started.threadId, timeoutSeconds: 120 })) as { agentId: string; status: string; linkDown?: boolean; note?: string }
  check('app.waitForAgent settles when the turn ends (no model: it fails fast) without linkDown', waited.agentId === started.threadId && waited.status !== 'running' && waited.status !== 'timeout' && !waited.linkDown, JSON.stringify(waited))
  const digest = await rpc<string | null>(box, 'app.readThread', { sessionId: sid, threadId: started.threadId })
  check('app.readThread with the encoded id reads the rows over the link', !!digest && digest.includes('hello from the box') && digest.includes('second message'), String(digest).slice(0, 300))
  const checked = JSON.parse(await rpc<string>(box, 'app.checkAgent', { sessionId: sid, agentId: started.threadId })) as { host: string; status: string; title: string }
  check('app.checkAgent answers live state with the host', checked.host === macId && checked.title === 'started from the box' && typeof checked.status === 'string', JSON.stringify(checked))

  // ── 4. spawn a subagent on mac ────────────────────────────────────────
  const spawned = JSON.parse(await rpc<string>(box, 'app.spawnAgent', { sessionId: sid, environmentId: 'mac', provider: 'claude', agentType: 'explorer', task: 'look around on the Mac\nand report' })) as { agentId?: string; title?: string; host?: string; cwd?: string } & Record<string, unknown>
  check('app.spawnAgent with environmentId mac answers an encoded agent id', typeof spawned.agentId === 'string' && spawned.agentId!.startsWith(`${macId}:`) && spawned.host === macId && spawned.title === 'look around on the Mac', JSON.stringify(spawned))
  const childId = String(spawned.agentId ?? '').split(':')[1]
  const child = (await sessionsOf(mac)).find((s) => s.id === childId)
  check("mac holds the child with the box thread as its parent and the box thread's permission", !!child && child.parentId === sid && child.permission === 'auto' && child.agentType === 'explorer', JSON.stringify(child))
  const parentRows = await eventsOf(box, sid)
  check("the box thread's log records agent-spawned with mac's environment id", parentRows.some((r) => r.event.type === 'agent-spawned' && r.event.childSessionId === childId && r.event.environmentId === macId), JSON.stringify(parentRows.filter((r) => r.event.type === 'agent-spawned')))
  const listed = JSON.parse(await rpc<string>(box, 'app.listAgents', { sessionId: sid })) as { agentId: string; host?: string; kind?: string; linkDown?: boolean }[]
  check('app.listAgents names the started thread and the spawned agent with host, live', listed.some((a) => a.agentId === started.threadId && a.host === macId && a.kind === 'started' && !a.linkDown) && listed.some((a) => a.agentId === spawned.agentId && a.kind === 'spawned' && !a.linkDown), JSON.stringify(listed))
  const childWait = JSON.parse(await rpc<string>(box, 'app.waitForAgent', { sessionId: sid, agentIds: [spawned.agentId], mode: 'any', timeoutSeconds: 120 })) as { agentId: string; status: string }
  check("wait_for_agent collects the spawned agent's settled report", childWait.agentId === spawned.agentId && childWait.status !== 'running' && childWait.status !== 'timeout', JSON.stringify(childWait))
  const noPending = await rpc<string>(box, 'app.answerAgent', { sessionId: sid, agentId: spawned.agentId, requestId: 'nothing', answers: [['a']] })
  check('app.answerAgent with nothing pending is refused with the reason', noPending.startsWith('refused:') && noPending.includes('nothing pending'), noPending)
  const interrupted = await rpc<string>(box, 'app.interruptAgent', { sessionId: sid, agentId: spawned.agentId })
  check('app.interruptAgent answers', interrupted.startsWith('interrupted'), interrupted)
  const foreign = await rpc<string>(box, 'app.sendToAgent', { sessionId: sid, agentId: `${macId}:not-mine`, message: 'x' })
  check('a thread this box thread did not start is refused', foreign.includes('not a subagent'), foreign)

  // ── 5. the codex bridge lists the host field ──────────────────────────
  const tools = await codexTools(sid)
  const spawnTool = tools.find((t) => t.name === 'spawn_agent')
  const startTool = tools.find((t) => t.name === 'app_start_thread')
  const answerTool = tools.find((t) => t.name === 'answer_agent')
  check('the codex bridge lists environmentId on spawn_agent and app_start_thread, and allow on answer_agent', !!spawnTool?.inputSchema.properties.environmentId && !!startTool?.inputSchema.properties.environmentId && !!answerTool?.inputSchema.properties.allow && !answerTool.inputSchema.required?.includes('answers'), JSON.stringify({ spawn: Object.keys(spawnTool?.inputSchema.properties ?? {}), answer: answerTool?.inputSchema.required }))

  // ── 6. the link drops: linkDown, not a hang ───────────────────────────
  await rpc(mac, 'remote.environments.remove', { id: boxId })
  const gone = await until('mac offline on box', 30_000, () => logOf(box).includes(`[peer-calls] ${macId} went offline`))
  check('box saw mac go offline', gone)
  const offlineWait = JSON.parse(await rpc<string>(box, 'app.waitForAgent', { sessionId: sid, agentId: started.threadId, timeoutSeconds: 30 })) as { linkDown?: boolean; status: string; note?: string }
  check('app.waitForAgent off the link answers the last known state with linkDown', offlineWait.linkDown === true && typeof offlineWait.status === 'string' && !!offlineWait.note?.includes('down'), JSON.stringify(offlineWait))
  const offlineList = JSON.parse(await rpc<string>(box, 'app.listAgents', { sessionId: sid })) as { agentId: string; linkDown?: boolean }[]
  check('app.listAgents off the link keeps the ids with linkDown', offlineList.length === 2 && offlineList.every((a) => a.linkDown === true), JSON.stringify(offlineList))
  const refused = await rpc<string>(box, 'app.startThread', { sessionId: sid, environmentId: 'mac', threadType: 'chat', provider: 'claude', firstMessage: 'x' })
  check('app.startThread with no Mac linked refuses naming the Mac bridge switch', typeof refused === 'string' && refused.includes('no Mac is linked') && refused.includes('macBridge.thread.set'), String(refused))
  const unknownHost = await errorOf(rpc(box, 'app.spawnAgent', { sessionId: sid, environmentId: 'env_nope', task: 'x' }))
  log(`an unknown host: ${unknownHost}`)
} catch (err) {
  check('the run completed', false, err instanceof Error ? err.message : String(err))
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
