/**
 * The Mac bridge for real (docs/box.md "The Mac bridge: what a box thread
 * may touch on the Mac"): two isolated headless instances of the BUILT tree
 * (out/main), the way scripts/e2e-harness-sync.ts runs them: each with its
 * own HOME, userData, Aliax vault dir, TMPDIR and fixed port, under xvfb-run
 * and a private D-Bus on Linux. "mac" plays the Mac, "box" plays the box.
 *
 *  - box issues an admin key, mac saves box as an environment: mac's link
 *    registers on box (peer.register) and mac's policy pane lists box
 *  - mac: policy read+run for box, one shared folder seeded with files
 *  - box: a thread whose macBridge.thread setting names mac
 *  - from box's loopback, with the thread's token (computed from the
 *    TEMP_CODE_MAC_TOKEN_SEED this script gives box): mac.listDir, mac.readFile
 *    and mac.fetchFile in the shared folder answer with no prompt; a 5 MiB
 *    fetch crosses as peer.chunk frames and lands byte for byte
 *  - a read outside the shared folder raises a macBridge.request on mac's
 *    own socket; this script denies it through mac's macBridge.decide and box
 *    gets "denied at the Mac"; allowed once with remember, the folder then
 *    reads with no prompt for that thread
 *  - mac.run raises a request showing argv and cwd; allowed through
 *    macBridge.decide, the output comes back; a command printing 20 lines
 *    over 2 s streams them (peer.progress) into its row on box as live
 *    partial tool-call rows before the result, which is complete; a wrong token is refused before
 *    the Mac hears of it; the codex stdio bridge lists the mac tools and reads
 *    a file through them
 *  - remember kinds: a command allowed with remember 'folder' lets a different
 *    command in that folder run with no prompt; one in another folder and a
 *    sudo one in the folder still prompt; macBridge.rules.list/forget
 *  - mac.writeFile: a 3 MiB write into the shared folder lands with no prompt
 *    (staged on box, pulled by mac with peer.pull); a write outside it
 *    prompts on mac, is allowed through macBridge.decide and then lands; the
 *    codex bridge lists mac_write_file; a write given as text lands as UTF-8
 *  - an interactive job: mac.run background: true starts `cat` after the
 *    same card (marked interactive), two lines written with mac.jobWrite read
 *    back through mac.jobRead, mac.jobClose ends its stdin and it exits 0
 *  - policy read refuses commands, off refuses everything; with the host
 *    removed on mac, box answers "Mac offline"
 * Run: bun scripts/e2e-mac-bridge.ts   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app, a real HOME, the real
 * Aliax vault, the gateway marker or the box's live temp-code.service.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_MB_KEEP === '1'
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
  const d = mkdtempSync(join(tmpdir(), 'tc-mac-bridge-e2e-'))
  return Bun.spawnSync(['realpath', d]).stdout.toString().trim() || d
})()
type Inst = {
  name: string
  home: string
  data: string
  tmp: string
  remote: number
  log: string
  proc?: ChildProcess
}
const mk = async (name: string): Promise<Inst> => {
  const inst = {
    name,
    home: join(root, `${name}-home`),
    data: join(root, `${name}-data`),
    tmp: join(root, `${name}-tmp`),
    remote: await freePort(),
    log: join(root, `${name}.log`)
  }
  for (const d of [inst.home, inst.data, inst.tmp]) mkdirSync(d, { recursive: true })
  return inst
}
const mac = await mk('mac')
const box = await mk('box')
const SEED = randomBytes(32).toString('hex')

// ── the Mac's files ─────────────────────────────────────────────────────
const shared = join(mac.home, 'Documents', 'shared')
const privateDir = join(mac.home, 'Private')
mkdirSync(shared, { recursive: true })
mkdirSync(privateDir, { recursive: true })
const NOTE = `notes from the Mac ${randomBytes(4).toString('hex')}\n`
writeFileSync(join(shared, 'notes.md'), NOTE)
const BIG = randomBytes(5 * 1024 * 1024 + 99)
writeFileSync(join(shared, 'big.bin'), BIG)
writeFileSync(join(privateDir, 'secret.txt'), 'private to the Mac\n')
writeFileSync(join(privateDir, 'other.txt'), 'also private\n')
const boxCwd = join(box.home, 'work')
mkdirSync(boxCwd, { recursive: true })

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
      ? [
          'xvfb-run',
          '-a',
          '-s',
          '-screen 0 1280x800x24 -nolisten tcp',
          'dbus-run-session',
          '--',
          electron,
          '.'
        ]
      : [electron, '.']
  const proc = spawn(argv[0], argv.slice(1), {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  })
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  inst.proc = proc
}
const logOf = (inst: Inst): string => (existsSync(inst.log) ? readFileSync(inst.log, 'utf8') : '')
const until = async (
  label: string,
  ms: number,
  test: () => Promise<boolean> | boolean
): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(300)
  }
  log(`timed out: ${label}`)
  return false
}
const portOf = (inst: Inst): number =>
  (JSON.parse(readFileSync(join(inst.data, 'server.json'), 'utf8')) as { port: number }).port

/** One request on the instance's local socket (the implicit admin). */
async function rpc<T = unknown>(inst: Inst, method: string, params: unknown = {}): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${portOf(inst)}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close()
      fail(new Error(`${inst.name}: no answer to ${method}`))
    }, 180_000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'e2e', method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as {
        id?: string
        ok?: boolean
        result?: T
        error?: string
      }
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
const errorOf = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => '(no error)',
    (e: Error) => e.message
  )

interface BridgeRequest {
  id: string
  kind: 'read' | 'run' | 'write'
  method: string
  path?: string
  folder?: string
  argv?: string[]
  cwd?: string
  sessionId: string
  hostName: string
  threadTitle: string
  status: string
}
/** mac's own socket, as its renderer holds it: every macBridge.request push. */
async function watchMac(): Promise<{
  next: (pred?: (r: BridgeRequest) => boolean) => Promise<BridgeRequest>
  seen: BridgeRequest[]
  close: () => void
}> {
  const ws = new WebSocket(`ws://127.0.0.1:${portOf(mac)}/`)
  const seen: BridgeRequest[] = []
  await new Promise<void>((ok, fail) => {
    ws.addEventListener('open', () => ok())
    ws.addEventListener('error', () => fail(new Error('mac socket error')))
  })
  ws.addEventListener('message', (ev) => {
    const frame = JSON.parse(String(ev.data)) as { push?: string; request?: BridgeRequest }
    if (frame.push === 'macBridge.request' && frame.request) seen.push(frame.request)
  })
  let cursor = 0
  const next = async (pred: (r: BridgeRequest) => boolean = () => true): Promise<BridgeRequest> => {
    const end = Date.now() + 30_000
    while (Date.now() < end) {
      const i = seen.findIndex((r, idx) => idx >= cursor && pred(r))
      if (i >= 0) {
        cursor = i + 1
        return seen[i]
      }
      await sleep(50)
    }
    throw new Error('no macBridge.request reached the Mac')
  }
  return { next, seen, close: () => ws.close() }
}

/** box's own socket subscribed to a thread, as a renderer holds it: every live row (event and events pushes). */
async function watchThread(
  sessionId: string
): Promise<{ rows: { seq: number; event: Record<string, unknown> }[]; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${portOf(box)}/`)
  const rows: { seq: number; event: Record<string, unknown> }[] = []
  await new Promise<void>((ok, fail) => {
    ws.addEventListener('open', () => ok())
    ws.addEventListener('error', () => fail(new Error('box socket error')))
  })
  ws.addEventListener('message', (ev) => {
    const frame = JSON.parse(String(ev.data)) as {
      push?: string
      row?: { sessionId: string; seq: number; event: Record<string, unknown> }
      sessionId?: string
      rows?: { sessionId: string; seq: number; event: Record<string, unknown> }[]
    }
    if (frame.push === 'event' && frame.row?.sessionId === sessionId) rows.push(frame.row)
    if (frame.push === 'events' && frame.sessionId === sessionId) rows.push(...(frame.rows ?? []))
  })
  ws.send(JSON.stringify({ id: 'sub', method: 'session.subscribe', params: { sessionId } }))
  await sleep(200)
  return { rows, close: () => ws.close() }
}

/** The codex stdio bridge for the thread, as codex would spawn it: initialize, tools/list, one tools/call. */
async function codexBridge(
  sessionId: string,
  token: string,
  path: string
): Promise<{ tools: string[]; text: string }> {
  const child = spawn('node', [join(REPO, 'scripts', 'app-mcp-bridge.mjs')], {
    env: {
      PATH: process.env.PATH ?? '',
      TEMP_CODE_PORT: String(portOf(box)),
      TEMP_CODE_SESSION: sessionId,
      TEMP_CODE_MAC_TOKEN: token
    },
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
    const list = (await ask(2, 'tools/list', {})) as { tools: { name: string }[] }
    const call = (await ask(3, 'tools/call', { name: 'mac_read_file', arguments: { path } })) as {
      content: { text: string }[]
    }
    return { tools: list.tools.map((t) => t.name), text: call?.content?.[0]?.text ?? '' }
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

interface HostPolicy {
  environmentId: string
  name: string
  policy: string
  shared: string[]
  registered: boolean
}

launch(mac)
launch(box, { TEMP_CODE_MAC_TOKEN_SEED: SEED })
try {
  const up =
    (await until('mac up', 90_000, () => existsSync(join(mac.data, 'server.json')))) &&
    (await until('box up', 90_000, () => existsSync(join(box.data, 'server.json'))))
  if (!check('both headless instances published their local socket', up))
    throw new Error(`no server.json; logs ${mac.log} ${box.log}`)
  const macId = (await rpc<{ environmentId: string }>(mac, 'remote.status')).environmentId
  const boxStatus = await rpc<{ environmentId: string; port: number; running: boolean }>(
    box,
    'remote.status'
  )
  const boxId = boxStatus.environmentId
  log(`mac ${macId}, box ${boxId} on :${box.remote}; logs ${mac.log} ${box.log}`)

  // ── 1. pair: box issues an admin key, mac saves box; mac's link registers ──
  const key = await rpc<{ token: string }>(box, 'remote.keys.create', {
    name: 'mac (e2e)',
    audience: 'client',
    caps: ['read', 'operate', 'approve', 'admin']
  })
  await rpc(mac, 'remote.environments.add', {
    url: `http://127.0.0.1:${box.remote}`,
    key: key.token,
    name: 'box'
  })
  const registered = await until(
    'mac registers on box',
    60_000,
    async () => (await rpc<HostPolicy[]>(mac, 'macBridge.policy.get'))[0]?.registered === true
  )
  check('mac: its link to box registered the bridge (peer.register)', registered)
  check(
    "box logged the registration under the Mac's id",
    logOf(box).includes(`[peer-calls] ${macId} registered (offers mac-bridge`)
  )
  const before = await rpc<HostPolicy[]>(mac, 'macBridge.policy.get')
  check(
    'mac: the policy for a new host is off with no shared folders',
    before[0]?.environmentId === boxId &&
      before[0].policy === 'off' &&
      before[0].shared.length === 0,
    JSON.stringify(before)
  )

  // ── 2. a box thread with the bridge on ───────────────────────────────
  const thread = await rpc<{ id: string }>(box, 'session.create', {
    provider: 'claude',
    cwd: boxCwd,
    title: 'mac bridge e2e',
    threadType: 'chat'
  })
  const sid = thread.id
  const token = createHmac('sha256', Buffer.from(SEED, 'hex'))
    .update(`mac-bridge:${sid}`)
    .digest('base64url')
  const off = await errorOf(rpc(box, 'mac.listDir', { sessionId: sid, token, path: shared }))
  check('box: a thread without the switch is refused', off.includes('off for this thread'), off)
  const state = await rpc<{ macPeer: string; online: boolean; registered: string[] }>(
    box,
    'macBridge.thread.set',
    { sessionId: sid, macPeer: macId }
  )
  check(
    'box: macBridge.thread.set names mac, and mac is online',
    state.macPeer === macId && state.online && state.registered.includes(macId),
    JSON.stringify(state)
  )

  // ── 3. policy off: refused at the Mac ────────────────────────────────
  const refusedOff = await errorOf(rpc(box, 'mac.listDir', { sessionId: sid, token, path: shared }))
  check(
    'policy off (the default): the Mac refuses',
    refusedOff.includes('off for this host'),
    refusedOff
  )
  await rpc(mac, 'macBridge.policy.set', { environmentId: boxId, policy: 'read+run' })
  const homeShare = await errorOf(
    rpc(mac, 'macBridge.shared.set', { environmentId: boxId, folders: [mac.home] })
  )
  check(
    'mac: the home directory cannot be shared',
    homeShare.includes('whole home directory'),
    homeShare
  )
  const rootShare = await errorOf(
    rpc(mac, 'macBridge.shared.set', { environmentId: boxId, folders: ['/'] })
  )
  check('mac: / cannot be shared', rootShare.includes('whole home directory or disk'), rootShare)
  const after = await rpc<HostPolicy[]>(mac, 'macBridge.shared.set', {
    environmentId: boxId,
    folders: [shared]
  })
  check(
    'mac: read+run with one shared folder',
    after[0]?.policy === 'read+run' && after[0].shared[0] === shared,
    JSON.stringify(after)
  )

  // ── 4. the shared folder: no prompt ──────────────────────────────────
  const watcher = await watchMac()
  const listing = await rpc<{ entries: { name: string; kind: string; size: number }[] }>(
    box,
    'mac.listDir',
    { sessionId: sid, token, path: shared }
  )
  check(
    'mac.listDir in the shared folder',
    listing.entries.map((e) => `${e.name}:${e.kind}`).join(',') === 'big.bin:file,notes.md:file',
    JSON.stringify(listing)
  )
  const read = await rpc<{ content: string; encoding: string; truncated: boolean }>(
    box,
    'mac.readFile',
    { sessionId: sid, token, path: join(shared, 'notes.md') }
  )
  check(
    'mac.readFile in the shared folder',
    read.content === NOTE && read.encoding === 'utf8' && !read.truncated,
    JSON.stringify(read)
  )
  const fetched = await rpc<{ path: string; size: number }>(box, 'mac.fetchFile', {
    sessionId: sid,
    token,
    path: join(shared, 'notes.md')
  })
  check(
    "mac.fetchFile lands the file in the thread's landing dir on box",
    fetched.path === join(box.data, 'attachments', sid, 'notes.md') &&
      readFileSync(fetched.path, 'utf8') === NOTE,
    JSON.stringify(fetched)
  )
  const bigFetched = await rpc<{ path: string; size: number }>(box, 'mac.fetchFile', {
    sessionId: sid,
    token,
    path: join(shared, 'big.bin')
  })
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
  check(
    'a 5 MiB fetch crosses as peer.chunk frames and lands byte for byte',
    bigFetched.size === BIG.length && sha(readFileSync(bigFetched.path)) === sha(BIG)
  )
  check('none of that asked the Mac', watcher.seen.length === 0, JSON.stringify(watcher.seen))

  // ── 5. outside the shared folder: the Mac asks; deny, then allow + remember ──
  const outsidePath = join(privateDir, 'secret.txt')
  const denied = errorOf(rpc(box, 'mac.readFile', { sessionId: sid, token, path: outsidePath }))
  const ask1 = await watcher.next()
  check(
    'a read outside the shared folder prompts on the Mac, naming host, thread, path and folder',
    ask1.kind === 'read' &&
      ask1.path === outsidePath &&
      ask1.folder === privateDir &&
      ask1.sessionId === sid &&
      ask1.hostName === 'box' &&
      ask1.threadTitle === 'mac bridge e2e',
    JSON.stringify(ask1)
  )
  await rpc(mac, 'macBridge.decide', { id: ask1.id, allow: false })
  const deniedMsg = await denied
  check(
    "denied through mac's macBridge.decide: box gets an error",
    deniedMsg.includes('denied at the Mac'),
    deniedMsg
  )
  const allowed = rpc<{ content: string }>(box, 'mac.readFile', {
    sessionId: sid,
    token,
    path: outsidePath
  })
  const ask2 = await watcher.next()
  await rpc(mac, 'macBridge.decide', { id: ask2.id, allow: true, remember: true })
  check(
    'allowed once with remember: the read answers',
    (await allowed).content === 'private to the Mac\n'
  )
  const seenBefore = watcher.seen.length
  const remembered = await rpc<{ content: string }>(box, 'mac.readFile', {
    sessionId: sid,
    token,
    path: join(privateDir, 'other.txt')
  })
  check(
    'the remembered folder reads with no prompt for this thread',
    remembered.content === 'also private\n' && watcher.seen.length === seenBefore
  )

  // ── 6. a command: always asked, argv and cwd shown, output back ──────
  const argv = ['/bin/sh', '-c', 'echo "ran in $(pwd) as $(id -un)"; echo to-stderr >&2']
  const ran = rpc<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>(
    box,
    'mac.run',
    { sessionId: sid, token, argv, cwd: shared }
  )
  const ask3 = await watcher.next((r) => r.kind === 'run' && r.status === 'pending')
  check(
    'mac.run prompts on the Mac with the exact argv and cwd',
    JSON.stringify(ask3.argv) === JSON.stringify(argv) &&
      ask3.cwd === shared &&
      ask3.status === 'pending',
    JSON.stringify(ask3)
  )
  await rpc(mac, 'macBridge.decide', { id: ask3.id, allow: true })
  const out = await ran
  check(
    'allowed: the command ran on the Mac and its output came back',
    out.exitCode === 0 &&
      out.stdout.startsWith(`ran in ${shared} as `) &&
      out.stderr === 'to-stderr\n' &&
      !out.timedOut,
    JSON.stringify(out)
  )
  const runDenied = errorOf(
    rpc(box, 'mac.run', { sessionId: sid, token, command: 'touch should-not-exist', cwd: shared })
  )
  const ask4 = await watcher.next((r) => r.kind === 'run' && r.status === 'pending')
  await rpc(mac, 'macBridge.decide', { id: ask4.id, allow: false })
  check(
    'a denied command never runs',
    (await runDenied).includes('denied at the Mac') && !existsSync(join(shared, 'should-not-exist'))
  )

  // ── 6b. remember kinds: 'folder' admits the folder, not another, never sudo ──
  {
    const pendingRun = (r: BridgeRequest): boolean => r.kind === 'run' && r.status === 'pending'
    const first = rpc<{ stdout: string }>(box, 'mac.run', {
      sessionId: sid,
      token,
      argv: ['/bin/echo', 'first'],
      cwd: shared
    })
    const card = (await watcher.next(
      (r) => pendingRun(r) && r.argv?.[1] === 'first'
    )) as BridgeRequest & {
      folder?: string
      program?: string
    }
    check(
      "a run card offers its cwd as the 'folder' rule and its program",
      card.folder === shared && card.program === 'echo',
      JSON.stringify(card)
    )
    await rpc(mac, 'macBridge.decide', { id: card.id, allow: true, remember: 'folder' })
    check("allowed with remember 'folder': it ran", (await first).stdout === 'first\n')
    // A different command in the same folder: answers with no decide from us.
    const again = await rpc<{ stdout: string }>(box, 'mac.run', {
      sessionId: sid,
      token,
      command: 'printf "second in %s" "$(basename "$PWD")"',
      cwd: shared
    })
    check(
      'a different command in the remembered folder ran without a prompt',
      again.stdout === 'second in shared',
      JSON.stringify(again)
    )
    check(
      'and still showed on the Mac, as running',
      await until('the remembered run shows as running', 10_000, () =>
        watcher.seen.some(
          (r) =>
            r.status === 'running' &&
            !!(r as { command?: string }).command?.startsWith('printf "second')
        )
      )
    )
    // Another folder asks.
    const elsewhere = errorOf(
      rpc(box, 'mac.run', { sessionId: sid, token, argv: ['/bin/echo', 'x'], cwd: privateDir })
    )
    const askOther = await watcher.next((r) => pendingRun(r) && r.cwd === privateDir)
    check(
      'a command in another folder prompts',
      askOther.cwd === privateDir,
      JSON.stringify(askOther)
    )
    await rpc(mac, 'macBridge.decide', { id: askOther.id, allow: false })
    check('(denied)', (await elsewhere).includes('denied at the Mac'))
    // sudo in the remembered folder still asks, and offers nothing to remember.
    const sudo = errorOf(
      rpc(box, 'mac.run', { sessionId: sid, token, command: 'sudo -n true', cwd: shared })
    )
    const askSudo = (await watcher.next(
      (r) => pendingRun(r) && (r as { command?: string }).command === 'sudo -n true'
    )) as BridgeRequest & { alwaysAsk?: string }
    check(
      'a sudo command in the remembered folder still prompts, marked always-ask',
      askSudo.cwd === shared && askSudo.alwaysAsk === 'sudo',
      JSON.stringify(askSudo)
    )
    await rpc(mac, 'macBridge.decide', { id: askSudo.id, allow: false })
    check('(denied)', (await sudo).includes('denied at the Mac'))
    // The rule is listed; forgetting it brings the prompt back.
    const rules = await rpc<{ kind: string; folder?: string; uses: number; id: string }[]>(
      mac,
      'macBridge.rules.list',
      { sessionId: sid }
    )
    const folderRule = rules.find((r) => r.kind === 'folder')
    check(
      "macBridge.rules.list names the thread's folder rule (and its earlier read folder)",
      folderRule?.folder === shared &&
        folderRule.uses === 1 &&
        rules.some((r) => r.kind === 'read-folder' && r.folder === privateDir),
      JSON.stringify(rules)
    )
    const left = await rpc<unknown[]>(mac, 'macBridge.rules.forget', {
      sessionId: sid,
      ruleId: folderRule?.id
    })
    check('macBridge.rules.forget drops that one rule', left.length === rules.length - 1)
    const afterForget = errorOf(
      rpc(box, 'mac.run', { sessionId: sid, token, argv: ['/bin/echo', 'y'], cwd: shared })
    )
    const askAgain = await watcher.next((r) => pendingRun(r) && r.argv?.[1] === 'y')
    await rpc(mac, 'macBridge.decide', { id: askAgain.id, allow: false })
    check('forgotten: the same folder prompts again', (await afterForget).includes('denied'))
    await rpc(mac, 'macBridge.rules.forget', { sessionId: sid })
    check(
      'forget all: nothing left for the thread',
      (await rpc<unknown[]>(mac, 'macBridge.rules.list', { sessionId: sid })).length === 0
    )
  }
  // ── 6c. mac_run streams: the output grows in the thread's row while it runs ──
  const live = await watchThread(sid)
  const STEPS = Array.from({ length: 20 }, (_, i) => `build step ${i + 1}`)
  const streamArgv = [
    '/bin/sh',
    '-c',
    'for i in $(seq 1 20); do echo "build step $i"; sleep 0.1; done'
  ]
  let partialsBeforeResult = -1
  const streamed = rpc<{ exitCode: number; stdout: string; truncated: boolean }>(box, 'mac.run', {
    sessionId: sid,
    token,
    argv: streamArgv,
    cwd: shared,
    callId: 'e2e-stream-run'
  }).then((r) => {
    partialsBeforeResult = live.rows.filter(
      (r) => r.event.partial === true && r.event.callId === 'e2e-stream-run'
    ).length
    return r
  })
  const ask5 = await watcher.next((r) => r.kind === 'run' && r.status === 'pending')
  await rpc(mac, 'macBridge.decide', { id: ask5.id, allow: true })
  const streamOut = await streamed
  const partials = live.rows.filter(
    (r) => r.event.partial === true && r.event.callId === 'e2e-stream-run'
  )
  const outputs = partials.map(
    (r) => ((r.event.preview as { output?: string } | undefined)?.output ?? '') as string
  )
  live.close()
  log(
    `${partials.length} live row(s) for the streamed run, ${partialsBeforeResult} before its result`
  )
  check(
    'mac.run streams: at least 3 live progress rows reached the thread before the result',
    partialsBeforeResult >= 3,
    `${partialsBeforeResult} before the result`
  )
  check(
    'each live row is a broadcast-only partial tool-call with a shell preview, growing by whole lines',
    partials.every(
      (r) =>
        r.seq === -1 &&
        r.event.type === 'tool-call' &&
        (r.event.preview as { kind?: string } | undefined)?.kind === 'shell'
    ) &&
      outputs.every((o, i) => o.endsWith('\n') && (i === 0 || o.startsWith(outputs[i - 1]))) &&
      outputs.every((o) => streamOut.stdout.startsWith(o)),
    JSON.stringify(outputs.slice(0, 3))
  )
  check(
    'and the final result carries the whole output',
    streamOut.exitCode === 0 &&
      !streamOut.truncated &&
      streamOut.stdout === STEPS.map((l) => `${l}\n`).join(''),
    JSON.stringify(streamOut).slice(0, 300)
  )

  // ── 7. the token ─────────────────────────────────────────────────────
  const seenBeforeToken = watcher.seen.length
  const wrong = await errorOf(
    rpc(box, 'mac.readFile', {
      sessionId: sid,
      token: 'not-the-token',
      path: join(shared, 'notes.md')
    })
  )
  check('a wrong token is refused on box', wrong.includes("needs this thread's own token"), wrong)
  const other = await rpc<{ id: string }>(box, 'session.create', {
    provider: 'claude',
    cwd: boxCwd,
    title: 'another thread',
    threadType: 'chat'
  })
  const borrowed = await errorOf(
    rpc(box, 'mac.readFile', { sessionId: other.id, token, path: join(shared, 'notes.md') })
  )
  check("another thread cannot use this thread's token", borrowed.includes('own token'), borrowed)
  check('neither reached the Mac', watcher.seen.length === seenBeforeToken)

  // ── 8. the codex stdio bridge ────────────────────────────────────────
  const codex = await codexBridge(sid, token, join(shared, 'notes.md'))
  check(
    'the codex bridge lists the four mac tools with the token',
    ['mac_read_file', 'mac_list_dir', 'mac_fetch_file', 'mac_run'].every((t) =>
      codex.tools.includes(t)
    ),
    codex.tools.join(',')
  )
  check(
    'and reads a Mac file through mac_read_file',
    codex.text.includes(JSON.stringify(NOTE).slice(1, -1)),
    codex.text.slice(0, 200)
  )

  // ── 8b. mac.writeFile: in the shared folder no prompt, outside asks ────
  const seenBeforeWrite = watcher.seen.length
  const WRITE = randomBytes(3 * 1024 * 1024 + 7)
  const written = await rpc<{ path: string; bytes: number; created: boolean }>(
    box,
    'mac.writeFile',
    {
      sessionId: sid,
      token,
      path: join(shared, 'from-box', 'out.bin'),
      dataBase64: WRITE.toString('base64')
    }
  )
  check(
    'a 3 MiB mac.writeFile into the shared folder lands byte for byte with no prompt',
    written.path === join(shared, 'from-box', 'out.bin') &&
      written.bytes === WRITE.length &&
      written.created &&
      sha(readFileSync(join(shared, 'from-box', 'out.bin'))) === sha(WRITE) &&
      watcher.seen.length === seenBeforeWrite,
    JSON.stringify(written)
  )
  const clash = await errorOf(
    rpc(box, 'mac.writeFile', {
      sessionId: sid,
      token,
      path: join(shared, 'notes.md'),
      dataBase64: Buffer.from('clobber').toString('base64')
    })
  )
  check(
    'mode create refuses an existing file and leaves it alone',
    clash.includes('file exists') && readFileSync(join(shared, 'notes.md'), 'utf8') === NOTE,
    clash
  )
  const TEXT = '# from the box ✓\nplain UTF-8, no base64\n'
  const textWritten = await rpc<{ path: string; bytes: number }>(box, 'mac.writeFile', {
    sessionId: sid,
    token,
    path: join(shared, 'from-box', 'note.md'),
    text: TEXT
  })
  check(
    'a mac.writeFile with text lands as its UTF-8 bytes, no prompt',
    textWritten.bytes === Buffer.byteLength(TEXT) &&
      readFileSync(join(shared, 'from-box', 'note.md'), 'utf8') === TEXT &&
      watcher.seen.length === seenBeforeWrite,
    JSON.stringify(textWritten)
  )
  const bothGiven = await errorOf(
    rpc(box, 'mac.writeFile', {
      sessionId: sid,
      token,
      path: join(shared, 'from-box', 'both.txt'),
      text: 'a',
      dataBase64: 'YQ=='
    })
  )
  check(
    'text and dataBase64 together are refused on box',
    bothGiven.includes('exactly one') && !existsSync(join(shared, 'from-box', 'both.txt')),
    bothGiven
  )
  const outsideWrite = join(mac.home, 'Elsewhere', 'written.txt')
  const pendingWrite = rpc<{ path: string; created: boolean }>(box, 'mac.writeFile', {
    sessionId: sid,
    token,
    path: outsideWrite,
    dataBase64: Buffer.from('written from the box\n').toString('base64')
  })
  const askWrite = await watcher.next((r) => r.kind === 'write')
  check(
    'a write outside the shared folder prompts on the Mac with its path and folder',
    askWrite.method === 'mac.writeFile' &&
      askWrite.path === outsideWrite &&
      askWrite.folder === join(mac.home, 'Elsewhere') &&
      !existsSync(outsideWrite),
    JSON.stringify(askWrite)
  )
  await rpc(mac, 'macBridge.decide', { id: askWrite.id, allow: true })
  const landed = await pendingWrite
  check(
    'allowed through macBridge.decide: the write lands',
    landed.path === outsideWrite &&
      landed.created &&
      readFileSync(outsideWrite, 'utf8') === 'written from the box\n',
    JSON.stringify(landed)
  )
  check(
    'codex bridge lists mac_write_file',
    codex.tools.includes('mac_write_file'),
    codex.tools.join(',')
  )
  // ── 8c. an interactive job: cat, two lines in, read back, stdin closed, exit 0 ──
  const jobStart = rpc<{ jobId: string; pty: boolean }>(box, 'mac.run', {
    sessionId: sid,
    token,
    argv: ['cat'],
    cwd: shared,
    background: true
  })
  const askJob = await watcher.next((r) => r.kind === 'run' && r.status === 'pending')
  check(
    'mac.run background: true prompts with the argv and cwd, marked interactive',
    JSON.stringify(askJob.argv) === '["cat"]' &&
      askJob.cwd === shared &&
      (askJob as { interactive?: boolean }).interactive === true,
    JSON.stringify(askJob)
  )
  await rpc(mac, 'macBridge.decide', { id: askJob.id, allow: true })
  const job = await jobStart
  check('the job started and answered its id at once', /^job_/.test(job.jobId), JSON.stringify(job))
  log(`job ${job.jobId}: ${job.pty ? 'in a terminal (node-pty)' : 'on pipes'}`)
  const b64 = (t: string): string => Buffer.from(t).toString('base64')
  await rpc(box, 'mac.jobWrite', { sessionId: sid, token, jobId: job.jobId, dataBase64: b64('first line\n') })
  await rpc(box, 'mac.jobWrite', { sessionId: sid, token, jobId: job.jobId, dataBase64: b64('second line\n') })
  type JobRead = { output: string; nextOffset: number; running: boolean; exitCode: number | null }
  let jobText = ''
  let jobOffset = 0
  let jobLast: JobRead | null = null
  const readJob = async (done: () => boolean): Promise<boolean> => {
    for (let i = 0; i < 40; i++) {
      jobLast = await rpc<JobRead>(box, 'mac.jobRead', {
        sessionId: sid,
        token,
        jobId: job.jobId,
        afterOffset: jobOffset,
        waitMs: 500
      })
      jobText += jobLast.output
      jobOffset = jobLast.nextOffset
      if (done()) return true
    }
    return false
  }
  check(
    'mac.jobRead reads both lines back',
    await readJob(() => jobText.includes('first line') && jobText.includes('second line')),
    JSON.stringify(jobText)
  )
  const otherRead = await errorOf(
    rpc(box, 'mac.jobRead', { sessionId: other.id, token: 'x', jobId: job.jobId })
  )
  check("another thread cannot read this thread's job", otherRead.includes('own token'), otherRead)
  await rpc(box, 'mac.jobClose', { sessionId: sid, token, jobId: job.jobId })
  check(
    'mac.jobClose ends its stdin and cat exits 0',
    (await readJob(() => jobLast?.running === false)) && jobLast?.exitCode === 0,
    JSON.stringify(jobLast)
  )
  check(
    'mac logged the job, never what it wrote',
    logOf(mac).includes(`job ${job.jobId} ran: exit 0`) && !logOf(mac).includes('first line')
  )

  // ── 9. policy read, then off ─────────────────────────────────────────
  await rpc(mac, 'macBridge.policy.set', { environmentId: boxId, policy: 'read' })
  const readOnly = await errorOf(rpc(box, 'mac.run', { sessionId: sid, token, argv: ['true'] }))
  check('policy read: commands refused at the Mac', readOnly.includes('not run commands'), readOnly)
  await rpc(mac, 'macBridge.policy.set', { environmentId: boxId, policy: 'off' })
  const offAgain = await errorOf(
    rpc(box, 'mac.readFile', { sessionId: sid, token, path: join(shared, 'notes.md') })
  )
  check('policy off: reads refused at the Mac', offAgain.includes('off for this host'), offAgain)
  const macLog = logOf(mac)
  check(
    "mac logged one line per call, naming host, thread and decision, never a file's contents",
    macLog.includes(`[mac-bridge] box (${boxId}) thread=${sid} mac.readFile → allowed (shared)`) &&
      macLog.includes('mac.run → denied') &&
      !macLog.includes(NOTE.trim()) &&
      !macLog.includes('private to the Mac')
  )
  check(
    'mac logged one line per write (host, thread, path, bytes), never the contents',
    macLog.includes(
      `[mac-bridge] box (${boxId}) thread=${sid} mac.writeFile path=${join(shared, 'from-box', 'out.bin')} bytes=${WRITE.length} mode=create → written (shared)`
    ) &&
      macLog.includes(
        `mac.writeFile path=${outsideWrite} bytes=21 mode=create → written (asked)`
      ) &&
      !macLog.includes('written from the box')
  )

  // ── 10. the link goes: Mac offline ───────────────────────────────────
  watcher.close()
  await rpc(mac, 'remote.environments.remove', { id: boxId })
  const gone = await until(
    'box sees mac go',
    30_000,
    async () =>
      !(await rpc<{ online: boolean }>(box, 'macBridge.thread.get', { sessionId: sid })).online
  )
  check('mac removed box: the thread shows mac offline', gone)
  const offline = await errorOf(rpc(box, 'mac.listDir', { sessionId: sid, token, path: shared }))
  check('and a call answers "Mac offline"', offline.includes('Mac offline'), offline)
} catch (err) {
  console.error('ERROR', err instanceof Error ? err.message : err)
  failures++
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
