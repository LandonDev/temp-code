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
 *  - the other way (docs/box.md "Threads across hosts"): a mac thread calls
 *    app.startThread and app.spawnAgent with environmentId `box`; the calls
 *    go as thread.* requests on mac's own link, the threads land on box
 *    under the mac thread (startedBy, parentId), the ids come back as
 *    `<boxId>:<sessionId>`, send, wait, read, check and list work by them,
 *    and the spawned child's settle reaches the mac thread as a peer.call
 *    report down mac's link (an agent-report row)
 *  - a master on box with one child on each host: the far child carries the
 *    masterId on mac, batch.get lists both with their hosts, a loose mac
 *    root joins through batch.adopt by `<macId>:<id>`, Pause on the master
 *    pauses the far child, each child lands through its own host's
 *    merge_branch against a shared bare origin, the far landing is reported
 *    to box and the end's land step fetches it into the box checkout before
 *    the (stubbed) gate and release, and batch.archive done archives the
 *    far child on mac
 *  - with the host removed on mac (the link drops): app.waitForAgent answers
 *    the last known state with linkDown, app.listAgents says linkDown, and
 *    app.startThread refuses naming the Mac bridge switch
 * Run: bun scripts/e2e-cross-host-threads.ts   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app, a real HOME, the real
 * Aliax vault, the gateway marker or the box's live temp-code.service.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
// The box thread's checkout, and the same name on the Mac (the map lands it
// there): two clones of one bare origin, so a landing on either host reaches
// the other through origin.
const boxProj = join(box.work, 'proj')
const macProj = join(mac.work, 'proj')
const boxMissing = join(box.work, 'missing')
const origin = join(root, 'origin.git')
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@x', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@x' } }).trim()
mkdirSync(boxMissing, { recursive: true })
execFileSync('git', ['init', '--bare', '-q', '-b', 'master', origin])
for (const dir of [boxProj, macProj]) {
  execFileSync('git', ['clone', '-q', origin, dir])
  git(dir, 'checkout', '-q', '-b', 'master')
}
writeFileSync(join(boxProj, 'README'), 'proof\n')
git(boxProj, 'add', 'README')
git(boxProj, 'commit', '-q', '-m', 'initial')
git(boxProj, 'push', '-q', '-u', 'origin', 'master')
git(macProj, 'pull', '-q', 'origin', 'master')
git(macProj, 'branch', '-q', '--set-upstream-to=origin/master', 'master')
/** The gate steps stubbed green on both hosts (gateRun.ts seam): a child's typecheck, the batch's gate and release. */
const GATE_STUB = JSON.stringify([
  { step: 'typecheck', ok: true, log: '✓ typecheck 1s passed' },
  { step: 'gate', ok: true, log: '✓ typecheck 1s passed\n✓ vitest 2s passed\n✓ build 3s passed' },
  { step: 'release', ok: true, log: 'released v1 (tag release-1, package.json 1.0.1) — publish it with: bun run release:publish' }
])

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
    TEMP_CODE_E2E_STATUS: '1',
    TEMP_CODE_GATE_STUB: GATE_STUB,
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
  startedBy: string | null
  masterId: string | null
  threadType: string | null
  permission: string
  cwd: string
  status: string
  title: string
  agentType: string
  archived: boolean
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

  // ── 6. the other way: a mac thread starts and spawns on box over its own link ──
  const macCaller = await rpc<{ id: string }>(mac, 'session.create', { provider: 'claude', cwd: macProj, title: 'mac thread', threadType: 'chat', permission: 'auto' })
  const onBox = await rpc<{ threadId: string; host: string; cwd: string; cwdNote?: string } | string>(mac, 'app.startThread', {
    sessionId: macCaller.id,
    environmentId: 'box',
    threadType: 'chat',
    provider: 'claude',
    firstMessage: 'hello from the mac',
    title: 'started from the mac'
  })
  check('app.startThread with environmentId box answers `<boxId>:<id>` with the host and the box checkout', typeof onBox === 'object' && onBox.threadId.startsWith(`${boxId}:`) && onBox.host === boxId && onBox.cwd === boxProj && !onBox.cwdNote, JSON.stringify(onBox))
  if (typeof onBox === 'string') throw new Error(onBox)
  const boxSid = onBox.threadId.split(':')[1]
  const boxMeta = (await sessionsOf(box)).find((s) => s.id === boxSid)
  check('box lists the thread at once: a root started by the mac thread, the caller permission, in the box checkout', !!boxMeta && boxMeta.parentId === null && boxMeta.startedBy === macCaller.id && boxMeta.permission === 'auto' && boxMeta.cwd === boxProj && boxMeta.title === 'started from the mac', JSON.stringify(boxMeta))
  check('box logged the request as a thread.start from mac', logOf(box).includes(`thread=${macCaller.id} thread.start → started ${boxSid}`))
  check('app.sendToAgent to box answers sent', (await rpc<string>(mac, 'app.sendToAgent', { sessionId: macCaller.id, agentId: onBox.threadId, message: 'second from the mac' })) === 'sent')
  check('the message landed on box', await until('second user row on box', 30_000, async () => (await eventsOf(box, boxSid)).some((r) => r.event.type === 'user-text' && r.event.text === 'second from the mac')))
  const waitedBox = JSON.parse(await rpc<string>(mac, 'app.waitForAgent', { sessionId: macCaller.id, agentId: onBox.threadId, timeoutSeconds: 120 })) as { agentId: string; status: string; linkDown?: boolean }
  check('app.waitForAgent over the link settles without linkDown', waitedBox.agentId === onBox.threadId && waitedBox.status !== 'running' && waitedBox.status !== 'timeout' && !waitedBox.linkDown, JSON.stringify(waitedBox))
  const boxDigest = await rpc<string | null>(mac, 'app.readThread', { sessionId: macCaller.id, threadId: onBox.threadId })
  check('app.readThread reads the box rows over the link, naming the host', !!boxDigest && boxDigest.includes('hello from the mac') && boxDigest.includes(`on host ${boxId}`), String(boxDigest).slice(0, 200))
  const checkedBox = JSON.parse(await rpc<string>(mac, 'app.checkAgent', { sessionId: macCaller.id, agentId: onBox.threadId })) as { host: string; title: string }
  check('app.checkAgent answers live state with the box as host', checkedBox.host === boxId && checkedBox.title === 'started from the mac', JSON.stringify(checkedBox))
  const spawnedOnBox = JSON.parse(await rpc<string>(mac, 'app.spawnAgent', { sessionId: macCaller.id, environmentId: boxId, provider: 'claude', agentType: 'explorer', task: 'look around on the box' })) as { agentId?: string; host?: string }
  check('app.spawnAgent with the box id answers an encoded agent id', typeof spawnedOnBox.agentId === 'string' && spawnedOnBox.agentId!.startsWith(`${boxId}:`) && spawnedOnBox.host === boxId, JSON.stringify(spawnedOnBox))
  const boxChildId = String(spawnedOnBox.agentId ?? '').split(':')[1]
  const boxChild = (await sessionsOf(box)).find((s) => s.id === boxChildId)
  check('box holds the child under the mac thread as its parent', !!boxChild && boxChild.parentId === macCaller.id && boxChild.agentType === 'explorer', JSON.stringify(boxChild))
  const listedOnMac = JSON.parse(await rpc<string>(mac, 'app.listAgents', { sessionId: macCaller.id })) as { agentId: string; host?: string; hostName?: string; linkDown?: boolean }[]
  check('app.listAgents on mac names both box threads with the host, live', listedOnMac.filter((a) => a.host === boxId && !a.linkDown && a.hostName === 'box').length === 2, JSON.stringify(listedOnMac))
  const reported = await until('the settle of the box child reaches the mac thread', 60_000, async () => (await eventsOf(mac, macCaller.id)).some((r) => r.event.type === 'agent-report' && (r.event as { agentId?: string }).agentId === spawnedOnBox.agentId))
  check("the box child's settle reached the mac thread as an agent-report (a peer.call down mac's link)", reported)

  // ── 7. a master on box with a child on each host ──────────────────────
  const boxWs = await rpc<{ id: string }>(box, 'workspace.create', { path: boxProj, name: 'proj' })
  const boxProject = await rpc<{ id: string; cwd: string }>(box, 'project.create', { workspaceId: boxWs.id, name: 'proj', mode: 'local' })
  const macWs = await rpc<{ id: string }>(mac, 'workspace.create', { path: macProj, name: 'proj' })
  const macProject = await rpc<{ id: string; cwd: string }>(mac, 'project.create', { workspaceId: macWs.id, name: 'proj', mode: 'local' })
  check('both hosts hold the project at its checkout', boxProject.cwd === boxProj && macProject.cwd === macProj, JSON.stringify({ boxProject, macProject }))
  const masterMeta = await rpc<{ id: string }>(box, 'session.create', { provider: 'claude', cwd: boxProj, projectId: boxProject.id, title: 'Master', threadType: 'chat', permission: 'auto' })
  const master = masterMeta.id
  await rpc(box, 'session.setMaster', { sessionId: master, master: true })
  const near = await rpc<{ id: string }>(box, 'session.create', { provider: 'claude', cwd: boxProj, projectId: boxProject.id, masterId: master, title: 'Near', threadType: 'implementation', permission: 'auto' })
  const farStart = await rpc<{ threadId: string; cwd: string } | string>(box, 'app.startThread', { sessionId: master, environmentId: 'mac', threadType: 'implementation', provider: 'claude', firstMessage: 'far work', title: 'Far' })
  if (typeof farStart === 'string') throw new Error(farStart)
  const farSid = farStart.threadId.split(':')[1]
  const farMeta = (await sessionsOf(mac)).find((s) => s.id === farSid)
  check("the far child on mac carries the box master's id and the master as its starter, in the mac checkout", !!farMeta && farMeta.masterId === master && farMeta.startedBy === master && farMeta.cwd === macProj, JSON.stringify(farMeta))
  type Batch = { children?: { sessionId: string; environmentId: string; status: string; threadType: string | null; title: string }[]; pending: string[]; landed: string[]; blocked: { sessionId: string; why: string } | null; finishedAt: number | null; steps: { id: string; status: string; log: string[] }[] }
  const batch = (): Promise<Batch> => rpc<Batch>(box, 'batch.get', { masterId: master })
  let state = await batch()
  check('batch.get lists both children with their hosts and types', !!state.children && state.children.some((c) => c.sessionId === near.id && c.environmentId === boxId && c.threadType === 'implementation') && state.children.some((c) => c.sessionId === farSid && c.environmentId === macId && c.title === 'Far'), JSON.stringify(state.children))
  check('pending names the far child as <macId>:<id>', state.pending.includes(near.id) && state.pending.includes(farStart.threadId), JSON.stringify(state.pending))
  // A loose root on mac joins through batch.adopt by its encoded id.
  const loose = await rpc<{ id: string }>(mac, 'session.create', { provider: 'claude', cwd: macProj, projectId: macProject.id, title: 'Loose on mac', threadType: 'chat', permission: 'auto' })
  const adopted = await rpc<{ adopted: string[]; refused: { sessionId: string; why: string }[] }>(box, 'batch.adopt', { masterId: master, sessionIds: [`${macId}:${loose.id}`, `${macId}:nope`] })
  check('batch.adopt takes a mac root by <macId>:<id> and refuses an unknown one with why', adopted.adopted.length === 1 && adopted.adopted[0] === `${macId}:${loose.id}` && adopted.refused.length === 1 && adopted.refused[0].why === 'unknown thread', JSON.stringify(adopted))
  check('the adopted thread carries the master id on mac', (await sessionsOf(mac)).find((s) => s.id === loose.id)?.masterId === master)
  // Pause on the master reaches the far child; Resume too.
  await rpc(mac, 'session.markStatus', { sessionId: farSid, status: 'running' })
  await rpc(box, 'session.pause', { sessionId: master })
  check('Pause on the master paused the far child on mac', await until('far paused', 20_000, async () => (await sessionsOf(mac)).find((s) => s.id === farSid)?.status === 'paused'))
  await rpc(box, 'session.resume', { sessionId: master })
  check('Resume on the master resumed it', await until('far resumed', 20_000, async () => (await sessionsOf(mac)).find((s) => s.id === farSid)?.status !== 'paused'))
  // Each child lands through its own host's merge_branch. near first, on box.
  const nearWt = join(root, 'near-wt')
  git(boxProj, 'worktree', 'add', '-q', '-b', 'near', nearWt)
  writeFileSync(join(nearWt, 'near.txt'), 'near\n')
  git(nearWt, 'add', 'near.txt')
  git(nearWt, 'commit', '-q', '-m', 'near: add near.txt')
  const nearMerge = await rpc<string>(box, 'app.mergeBranch', { sessionId: near.id, branch: 'near' })
  check('the near child landed on box through merge_branch (typecheck stubbed) and pushed origin', nearMerge.includes('pushed to origin') && !nearMerge.startsWith('refused'), nearMerge)
  // The mac checkout catches up (as a thread there would rebase), then far lands on mac.
  git(macProj, 'pull', '-q', '--ff-only', 'origin', 'master')
  const farWt = join(root, 'far-wt')
  git(macProj, 'worktree', 'add', '-q', '-b', 'far', farWt)
  writeFileSync(join(farWt, 'far.txt'), 'far\n')
  git(farWt, 'add', 'far.txt')
  git(farWt, 'commit', '-q', '-m', 'far: add far.txt')
  const farMerge = await rpc<string>(mac, 'app.mergeBranch', { sessionId: farSid, branch: 'far' })
  check('the far child landed on mac through merge_branch after asking box (as-they-finish: not held) and pushed origin', farMerge.includes('pushed to origin') && !farMerge.startsWith('refused') && !farMerge.includes('HELD'), farMerge)
  check('the far landing was reported to box and recorded under <macId>:<id>', await until('far landed on box', 20_000, async () => (await batch()).landed.includes(farStart.threadId)))
  state = await batch()
  check("the land step's log names the far branch with its host", state.steps[0].log.some((l) => l.includes('far landed on mac')), JSON.stringify(state.steps[0].log))
  check('the box checkout does not have the far commit yet', !existsSync(join(boxProj, 'far.txt')))
  // Both done: the batch ends; its land step fetches origin into the box checkout before the gate.
  await rpc(mac, 'session.markStatus', { sessionId: farSid, status: 'done' })
  await rpc(box, 'session.markStatus', { sessionId: near.id, status: 'done' })
  check('the batch ended: land, gate and release passed', await until('batch finished', 60_000, async () => (await batch()).finishedAt !== null && (await batch()).steps.every((s) => s.status === 'passed')), JSON.stringify((await batch()).steps.map((s) => [s.id, s.status])))
  state = await batch()
  check('the land step fetched origin into the box checkout: the far commit is there', existsSync(join(boxProj, 'far.txt')) && state.steps[0].log.some((l) => l.startsWith('fetched origin: master at')), JSON.stringify(state.steps[0].log))
  check('nothing blocked the end', state.blocked === null, JSON.stringify(state.blocked))
  const archived = await rpc<{ succeeded: string[] }>(box, 'batch.archive', { masterId: master, which: 'done' })
  check('batch.archive done lists the far child and the adopted one in succeeded', archived.succeeded.includes(farStart.threadId) && archived.succeeded.includes(`${macId}:${loose.id}`) && archived.succeeded.includes(near.id), JSON.stringify(archived))
  check('the far child is archived on mac', await until('far archived', 20_000, async () => (await rpc<Meta[]>(mac, 'session.list', { archived: true })).some((s) => s.id === farSid && s.archived)))

  // ── 8. the link drops: linkDown, not a hang ───────────────────────────
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
