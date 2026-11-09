/**
 * The add-on registry's runtime, end to end (plan-L1Vrd-CMiZJ7.md section
 * 10; CLAUDE.md "The add-on host"). Isolated headless instances of the BUILT
 * tree, driven over their local sockets, and the fake downstream MCP server
 * (scripts/lib/fakeMcpServer.ts) over stdio and http:
 *
 *  Paired, both isolated (own HOME, own vault, a dead provider), "mac"
 *  (darwin by the seam) linked to "box" (linux, the settings home):
 *   1. a mac thread calls app.addonAdd as the bridge does: the admin card on
 *      mac, allowed there; the row lands on the box written by the thread,
 *      and mac follows it
 *   2. no FAKE_TOKEN in the grants file: needs-grant on both hosts; the value
 *      written: ready on both, and fake__whoami answers its sha256 prefix
 *   3. a person adds fakehttp on the box: needs-grant without the header's
 *      value, refused with a wrong one, ready with the right one; an
 *      SSE-only server reaches ready through the fallback
 *   5. the codex and Muse bridge as codex spawns it: addon_find and
 *      addon_call listed only with TEMP_CODE_ADDONS, the card for a safe
 *      thread, none for a read-only tool on an edits thread, an image passed
 *   6. a crashing server: failed with its exit line, then starting, ready
 *   7. the add-on host killed: respawned while the gateway keeps its pid;
 *      three exits in a minute: down, the gateway still serving, and the
 *      stdio server it lost swept by the process guard
 *   8. the codex first-turn gate with and without add-ons (skipped with one
 *      line where no codex binary is installed)
 *   9. app.addonRemove from the thread that wrote it: no card, gone on both
 *      hosts with its status, no TEMP_CODE_ADDON process of it left
 *  Then, unpaired, an instance on this user's HOME so the Claude CLI runs
 *  (the e2e-merge-review.ts pattern; pairing it would run memory and account
 *  sync against the real home):
 *   4. a real claude-haiku-5-5 thread finds fake__echo with tool search and
 *      calls it, then fake__image; an add-on added while it is idle is called
 *      on its next turn without a new harness; a removed one is gone from
 *      its tool search
 *  10. everything archived, killed and removed (TC_ADDONS_KEEP=1 keeps the
 *      temp dir), no fakeMcpServer process left.
 *
 * Run: bun run script:e2e-addons   (after one `electron-vite build`)
 * --gate skips leg 4 (real Claude on the real HOME) and never launches
 * its unpaired instance. The paired legs use only fake or dead providers.
 * --gate waits for the gate build; no app build runs here. All children
 * are killed on normal exit, signals and uncaught errors.
 * Nothing here touches /Applications/TempCode.app, the real Aliax vault's
 * grants (a TEMP_CODE_ADDON_GRANTS file holds the fake values), the gateway
 * marker or the box's live temp-code.service.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

import { waitForGateBuild } from './lib/gateBuild'
import { hostCli } from './lib/gateCli'
import { proofCleanup } from './lib/proofCleanup'
import { createProcScan, hasEnv, commandMatches } from './lib/procScan'

const REPO = resolve(import.meta.dir, '..')
const GATE = process.argv.includes('--gate')
/** Codex as the app finds it, resolved before any instance gets a temp HOME; its dir leads every instance's PATH. */
const CODEX = hostCli('codex')
const KEEP = process.env.TC_ADDONS_KEEP === '1'
const BUN = process.execPath
const FAKE = join(REPO, 'scripts', 'lib', 'fakeMcpServer.ts')
const BRIDGE = join(REPO, 'scripts', 'app-mcp-bridge.mjs')
const ADDON_HOST_DOWN = 'The add-on host kept exiting; it is tried again in 10 minutes'
const GATE_BUDGET_MS = 250
let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const prefix = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 12)

if (GATE) await waitForGateBuild({ tree: REPO, log })

if (!existsSync(join(REPO, 'out', 'main', 'index.js')) || !existsSync(join(REPO, 'out', 'main', 'addonHost.js'))) {
  console.error('out/main is missing or has no addonHost.js: run electron-vite build first')
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
  const d = mkdtempSync(join(tmpdir(), 'tc-addons-e2e-'))
  return realpathSync(d)
})()
const owned = proofCleanup(root)
const GRANTS = join(root, 'grants.json')
const CALLS = join(root, 'calls.log')
const TOKEN = `fake-token-${Math.random().toString(36).slice(2, 10)}`
const grants: Record<string, { fields: Record<string, string> }> = {}
const writeGrants = (): void => writeFileSync(GRANTS, JSON.stringify(grants))
writeGrants()
const callsLogged = (): { tool?: string; arguments?: Record<string, unknown>; cancelled?: boolean; pid?: number }[] =>
  existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

type Inst = { name: string; home: string; data: string; tmp: string; work: string; remote: number; log: string; proc?: ChildProcess }
const mk = async (name: string, realHome = false): Promise<Inst> => {
  const inst = {
    name,
    home: realHome ? homedir() : join(root, `${name}-home`),
    data: join(root, `${name}-data`),
    tmp: join(root, `${name}-tmp`),
    work: join(root, `${name}-work`),
    remote: await freePort(),
    log: join(root, `${name}.log`)
  }
  for (const d of [inst.data, inst.tmp, inst.work, ...(realHome ? [] : [inst.home])]) mkdirSync(d, { recursive: true })
  return inst
}

/** This shell's environment less every TEMP_CODE_* and CLAUDE* key: the box service's hub token and this thread's marks stay out of a proof instance. */
const baseEnv = (): Record<string, string> => {
  const env = Object.fromEntries(Object.entries(process.env as Record<string, string>).filter(([k]) => !k.startsWith('TEMP_CODE_') && !k.startsWith('CLAUDE') && k !== 'ANTHROPIC_BASE_URL'))
  // The gate's children inherit a sparse PATH: codex's own dir leads it, so the instances spawn the codex leg 8 found.
  if (CODEX) env.PATH = [dirname(CODEX), env.PATH].filter(Boolean).join(':')
  return env
}

function launch(inst: Inst, opts: { platform: 'darwin' | 'linux'; isolated: boolean }): void {
  const env: Record<string, string> = {
    ...baseEnv(),
    HOME: inst.home,
    TMPDIR: inst.tmp,
    TEMP_CODE_USER_DATA: inst.data,
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_REMOTE_PORT: String(inst.remote),
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_WORK_ROOT: inst.work,
    TEMP_CODE_E2E_STATUS: '1',
    TEMP_CODE_BUILD_PLATFORM: opts.platform,
    TEMP_CODE_ADDON_GRANTS: GRANTS,
    TEMP_CODE_ADDON_TRACE: '1',
    NODE_ENV: 'production',
    SHELL: '/bin/bash',
    ...(opts.isolated
      ? { TEMP_CODE_ALIAX_DATA_DIR: join(inst.data, 'aliax'), TEMP_CODE_FAKE_PROVIDERS: 'http://127.0.0.1:9', AGENT_CLI_CREDENTIAL_STORE: 'file' }
      : {})
  }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  const argv =
    process.platform === 'linux'
      ? ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.']
      : [electron, '.']
  const proc = spawn(argv[0]!, argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  owned.track(proc, true)
  inst.proc = proc
}
const logOf = (inst: Inst): string => (existsSync(inst.log) ? readFileSync(inst.log, 'utf8') : '')
const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(250)
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

/** A socket kept open on the instance: every `addon-status` push it hears, in order. */
function statusPushes(inst: Inst): { seen: Record<string, { state: string; detail?: string }>[]; close(): void } {
  const seen: Record<string, { state: string; detail?: string }>[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${portOf(inst)}/`)
  ws.addEventListener('message', (ev) => {
    const frame = JSON.parse(String(ev.data)) as { push?: string; status?: Record<string, { state: string; detail?: string }> }
    if (frame.push === 'addon-status' && frame.status) seen.push(frame.status)
  })
  return { seen, close: () => ws.close() }
}


interface Meta {
  id: string
  status: string
}
interface Row {
  seq: number
  event: { type: string; name?: string; callId?: string; input?: Record<string, unknown>; output?: string; requestId?: string; toolName?: string; title?: string; status?: string; text?: string; delta?: boolean }
}
interface AddonRowWire {
  id: string
  name: string
  workspaceId: string | null
  writtenBy: { kind: string; sessionId?: string }
}
interface AddonsList {
  addons: AddonRowWire[]
  status: Record<string, { state: string; tools: number; detail?: string }>
}
const list = (inst: Inst): Promise<AddonsList> => rpc<AddonsList>(inst, 'addons.list', {})
const statusOf = async (inst: Inst, name: string): Promise<{ state: string; tools: number; detail?: string } | null> => {
  const l = await list(inst)
  const row = l.addons.find((a) => a.name === name)
  return row ? (l.status[row.id] ?? null) : null
}
const events = (inst: Inst, sessionId: string): Promise<Row[]> => rpc<Row[]>(inst, 'session.events', { sessionId, afterSeq: 0 })
/** The next approval card on a thread, then its answer. */
async function answerCard(inst: Inst, sessionId: string, allow: boolean, after = 0): Promise<Row['event'] | null> {
  let card: Row | undefined
  await until(`a card on ${sessionId}`, 60_000, async () => {
    card = (await events(inst, sessionId)).find((r) => r.seq > after && r.event.type === 'approval-request')
    return !!card
  })
  if (!card) return null
  await rpc(inst, 'session.approve', { sessionId, requestId: card.event.requestId, allow })
  return card.event
}
const lastSeq = async (inst: Inst, sessionId: string): Promise<number> => (await events(inst, sessionId)).reduce((m, r) => Math.max(m, r.seq), 0)
const text = (r: { content: { type: string; text?: string }[] }): string => r.content.map((c) => c.text ?? `[${c.type}]`).join('\n')

const procScan = createProcScan()
/** The processes carrying TEMP_CODE_ADDON=<id> on this machine. */
const addonProcesses = (addonId: string): number[] => procScan.processes().filter((row) => hasEnv(row, `TEMP_CODE_ADDON=${addonId}`)).map((row) => row.pid)
/** The fake servers whose command line names this run's temp dir. */
const fakeProcesses = (): number[] => procScan.processes().filter((row) => commandMatches(row, 'fakeMcpServer', root)).map((row) => row.pid)

/** The codex stdio bridge, as codex spawns it: an MCP client on its stdio. */
function bridge(inst: Inst, sessionId: string, addons: boolean) {
  const proc = spawn(BUN, [BRIDGE], {
    env: { PATH: process.env.PATH ?? '', TEMP_CODE_PORT: String(portOf(inst)), TEMP_CODE_SESSION: sessionId, ...(addons ? { TEMP_CODE_ADDONS: '1' } : {}) },
    stdio: ['pipe', 'pipe', 'inherit']
  })
  owned.track(proc)
  let buf = ''
  let next = 1
  const waiting = new Map<number, (m: { result?: unknown; error?: { message: string } }) => void>()
  proc.stdout!.on('data', (c: Buffer) => {
    buf += c.toString()
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      const m = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } }
      if (m.id !== undefined) waiting.get(m.id)?.(m)
    }
  })
  const request = <T>(method: string, params: unknown = {}): Promise<T> =>
    new Promise((ok, fail) => {
      const id = next++
      waiting.set(id, (m) => (m.error ? fail(new Error(m.error.message)) : ok(m.result as T)))
      proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  return {
    request,
    tools: async () => (await request<{ tools: { name: string }[] }>('tools/list')).tools.map((t) => t.name),
    call: (name: string, args: unknown) => request<{ content: { type: string; text?: string; data?: string }[]; isError?: boolean }>('tools/call', { name, arguments: args }),
    close: () => proc.kill()
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
async function down(inst: Inst): Promise<void> {
  kill(inst)
  await sleep(1500)
  try {
    if (inst.proc?.pid) process.kill(-inst.proc.pid, 'SIGKILL')
  } catch {
    /* gone */
  }
}

// ── the fake http servers ───────────────────────────────────────────────
const http = spawn(BUN, [FAKE, '--http', '0', '--sse', '0', '--require', 'X-Api-Key=right-value', '--log', CALLS], { stdio: ['ignore', 'pipe', 'inherit'] })
owned.track(http)
const ports = await new Promise<{ http: number; sse: number }>((ok) => http.stdout!.once('data', (d: Buffer) => ok(JSON.parse(d.toString()))))
const stdioSpec = () => ({ transport: 'stdio' as const, command: BUN, args: [FAKE, '--stdio', '--log', CALLS], env: ['FAKE_TOKEN'], auth: 'fields' as const })

const mac = await mk('mac')
const box = await mk('box')
const instances: Inst[] = [mac, box]
const cleanup = async (): Promise<void> => {
  for (const inst of instances) kill(inst)
  await sleep(1500)
  for (const inst of instances) await down(inst)
  http.kill()
  owned.stop()
  for (const pid of fakeProcesses()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
}

try {
  // ── the pair ─────────────────────────────────────────────────────────
  const macProj = join(mac.work, 'proj')
  const boxProj = join(box.work, 'proj')
  for (const dir of [macProj, boxProj]) {
    mkdirSync(dir, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'master', dir])
  }
  launch(mac, { platform: 'darwin', isolated: true })
  launch(box, { platform: 'linux', isolated: true })
  const up =
    (await until('mac up', 90_000, () => existsSync(join(mac.data, 'server.json')))) && (await until('box up', 90_000, () => existsSync(join(box.data, 'server.json'))))
  if (!check('both headless instances published their local socket', up)) throw new Error(`no server.json; logs ${mac.log} ${box.log}`)
  const macId = (await rpc<{ environmentId: string }>(mac, 'remote.status')).environmentId
  const boxWs = await rpc<{ id: string }>(box, 'workspace.create', { path: boxProj, name: 'proj' })
  const boxProject = await rpc<{ id: string }>(box, 'project.create', { workspaceId: boxWs.id, name: 'proj', mode: 'local' })
  const macWs = await rpc<{ id: string }>(mac, 'workspace.create', { path: macProj, name: 'proj' })
  const macProject = await rpc<{ id: string }>(mac, 'project.create', { workspaceId: macWs.id, name: 'proj', mode: 'local' })
  const key = await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'mac (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  await rpc(mac, 'remote.environments.add', { url: `http://127.0.0.1:${box.remote}`, key: key.token, name: 'box' })
  check("box logged mac's registration", await until('mac registers on box', 60_000, () => logOf(box).includes(`[peer-calls] ${macId} registered`)))
  check('the two workspaces of one folder name are linked', await until('linked', 60_000, async () => {
    const [m, b] = await Promise.all([rpc<{ id: string; linkId?: string | null }[]>(mac, 'workspace.list'), rpc<{ id: string; linkId?: string | null }[]>(box, 'workspace.list')])
    const mw = m.find((w) => w.id === macWs.id)
    return !!mw?.linkId && mw.linkId === b.find((w) => w.id === boxWs.id)?.linkId
  }))

  // The route to the box's copy follows RulesSync's record of the box's workspaces, a push behind the stamp.
  check("mac routes the linked workspace's add-ons to the box", await until('the home is the box', 60_000, async () => (await rpc<{ home: { name: string } | null }>(mac, 'addons.list', { workspaceId: macWs.id })).home?.name === 'box'))

  // ── 1. a mac thread adds fake: the admin card, the row on the box ────
  const macThread = await rpc<Meta>(mac, 'session.create', { provider: 'claude', projectId: macProject.id, title: 'Adds the fake add-on', threadType: 'chat', permission: 'auto' })
  const adding = rpc<string>(mac, 'app.addonAdd', { sessionId: macThread.id, name: 'fake', description: 'A fake add-on for the proof', ...stdioSpec() }, 120_000)
  const card = await answerCard(mac, macThread.id, true)
  const input = (card?.input ?? {}) as Record<string, string>
  check('the card is on mac with the schema\'s title and input', card?.toolName === 'addon_add' && card.title === 'Add the add-on fake' && input.where === 'proj' && input.needs === 'Values for FAKE_TOKEN' && input.runs?.includes('fakeMcpServer.ts'), JSON.stringify(card))
  const added = JSON.parse(await adding) as { id: string; state: string; detail?: string }
  check('addon_add answers needs-grant with the gap', added.state === 'needs-grant' && added.detail === 'Needs values for FAKE_TOKEN', JSON.stringify(added))
  const onBox = (await list(box)).addons.find((a) => a.name === 'fake')
  if (!check('the box holds the row in its workspace, written by the mac thread', onBox?.workspaceId === boxWs.id && onBox.writtenBy.kind === 'thread' && onBox.writtenBy.sessionId === macThread.id, JSON.stringify(onBox ?? (await list(box)).addons)))
    throw new Error('no row on the box')
  check("mac's list has it after the follow", await until('mac follows', 30_000, async () => (await list(mac)).addons.some((a) => a.id === onBox?.id)))
  const fakeId = onBox!.id

  // ── 2. the grant: needs-grant on both, then ready on both ─────────────
  const needs = await until('needs-grant on both', 30_000, async () => (await statusOf(mac, 'fake'))?.state === 'needs-grant' && (await statusOf(box, 'fake'))?.state === 'needs-grant')
  check('both hosts read needs-grant: Needs values for FAKE_TOKEN', needs && (await statusOf(box, 'fake'))?.detail === 'Needs values for FAKE_TOKEN')
  grants.fake = { fields: { FAKE_TOKEN: TOKEN } }
  writeGrants()
  const ready = await until('ready on both', 30_000, async () => (await statusOf(mac, 'fake'))?.state === 'ready' && (await statusOf(box, 'fake'))?.state === 'ready')
  check('the value written: both hosts ready with the fake\'s tools', ready && (await statusOf(box, 'fake'))?.tools === 12, JSON.stringify(await statusOf(box, 'fake')))
  const boxAuto = await rpc<Meta>(box, 'session.create', { provider: 'claude', projectId: boxProject.id, title: 'Calls add-ons', threadType: 'chat', permission: 'auto' })
  const who = await rpc<{ content: { type: string; text?: string }[] }>(box, 'app.addonCall', { sessionId: boxAuto.id, tool: 'fake__whoami' })
  check('fake__whoami answers the sha256 prefix of the value: the env arrived', text(who) === prefix(TOKEN), text(who))

  // ── 3. http: needs-grant, refused, ready; SSE through the fallback ───
  const httpSpec = (port: number, path: string) => ({ transport: 'http', url: `http://127.0.0.1:${port}/${path}`, headers: ['X-Api-Key'], auth: 'fields' })
  await rpc(box, 'addons.set', { addon: { name: 'fakehttp', workspaceId: null, spec: httpSpec(ports.http, 'mcp') } })
  check('fakehttp with no value: Needs values for X-Api-Key', await until('fakehttp needs a value', 30_000, async () => (await statusOf(box, 'fakehttp'))?.detail === 'Needs values for X-Api-Key'))
  grants.fakehttp = { fields: { 'X-Api-Key': 'wrong-value' } }
  writeGrants()
  check('a wrong value: The server refused the grant', await until('refused', 30_000, async () => (await statusOf(box, 'fakehttp'))?.detail === 'The server refused the grant'))
  grants.fakehttp = { fields: { 'X-Api-Key': 'right-value' } }
  writeGrants()
  check('the right value: ready', await until('fakehttp ready', 30_000, async () => (await statusOf(box, 'fakehttp'))?.state === 'ready'))
  grants.fakesse = { fields: { 'X-Api-Key': 'right-value' } }
  writeGrants()
  await rpc(box, 'addons.set', { addon: { name: 'fakesse', workspaceId: null, spec: httpSpec(ports.sse, 'sse') } })
  check('an SSE-only server reaches ready through the fallback', await until('fakesse ready', 30_000, async () => (await statusOf(box, 'fakesse'))?.state === 'ready'))

  // ── 5. the codex and Muse bridge ──────────────────────────────────────
  const boxSafe = await rpc<Meta>(box, 'session.create', { provider: 'claude', projectId: boxProject.id, title: 'Asks for each call', threadType: 'chat', permission: 'safe' })
  const boxEdits = await rpc<Meta>(box, 'session.create', { provider: 'claude', projectId: boxProject.id, title: 'Asks for writes', threadType: 'chat', permission: 'edits' })
  const plain = bridge(box, boxSafe.id, false)
  const listedPlain = await plain.tools()
  plain.close()
  check('a bridge spawned without the flag lists addon_list but neither finder', listedPlain.includes('addon_list') && !listedPlain.includes('addon_find') && !listedPlain.includes('addon_call'))
  const safe = bridge(box, boxSafe.id, true)
  await safe.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
  const listed = await safe.tools()
  check('with TEMP_CODE_ADDONS the bridge lists addon_find and addon_call', listed.includes('addon_find') && listed.includes('addon_call'))
  const found = JSON.parse(text(await safe.call('addon_find', { query: 'echo' }))) as { tool: string; inputSchema: unknown }[]
  check('addon_find echo answers fake__echo with its schema', found[0]?.tool === 'fake__echo' && !!found[0].inputSchema, JSON.stringify(found))
  const before = await lastSeq(box, boxSafe.id)
  const echoing = safe.call('addon_call', { tool: 'fake__echo', arguments: { text: 'via the bridge' } })
  const bridgeCard = await answerCard(box, boxSafe.id, true, before)
  check('a safe thread\'s call raises the card Use echo from fake', bridgeCard?.toolName === 'fake__echo' && bridgeCard.title === 'Use echo from fake', JSON.stringify(bridgeCard))
  check('the call comes back', text(await echoing) === 'via the bridge')
  safe.close()
  const edits = bridge(box, boxEdits.id, true)
  const read = await edits.call('addon_call', { tool: 'fake__read', arguments: { key: 'k' } })
  const editsCards = (await events(box, boxEdits.id)).filter((r) => r.event.type === 'approval-request')
  check('an edits thread runs a read-only tool with no card', text(read) === 'read k' && editsCards.length === 0, JSON.stringify({ read, editsCards }))
  edits.close()
  const auto = bridge(box, boxAuto.id, true)
  const image = await auto.call('addon_call', { tool: 'fake__image' })
  check('addon_call passes the image part whole', image.content[0]?.type === 'image' && !!image.content[0].data, JSON.stringify(image).slice(0, 200))
  auto.close()

  // ── 6. a crash: failed with its line, then starting, then ready ──────
  const pushes = statusPushes(box)
  await sleep(300)
  const crashed = await rpc<{ content: { text?: string }[]; isError?: boolean }>(box, 'app.addonCall', { sessionId: boxAuto.id, tool: 'fake__crash' })
  check('the crashing call answers its exit line', !!crashed.isError && text(crashed as never) === 'Exited (code 3): fake crashing on purpose', JSON.stringify(crashed))
  const t0 = Date.now()
  const back = await until('fake ready after the crash', 15_000, async () => (await statusOf(box, 'fake'))?.state === 'ready')
  const states = pushes.seen.map((s) => s[fakeId]?.state).filter((s, i, a) => s && s !== a[i - 1])
  pushes.close()
  check('the pushes read failed, starting, ready', JSON.stringify(states) === JSON.stringify(['failed', 'starting', 'ready']), JSON.stringify(states))
  check('ready again within 5 s', back && Date.now() - t0 < 5_000, `${Date.now() - t0} ms`)
  log(`restart after a crash: ${Date.now() - t0} ms`)
  check('fake__echo answers again', text(await rpc(box, 'app.addonCall', { sessionId: boxAuto.id, tool: 'fake__echo', arguments: { text: 'again' } })) === 'again')

  // ── 7. the add-on host itself ─────────────────────────────────────────
  type Doctor = { addonHost: { pid: number | null; restarts: number; down: boolean }; gateway: { pid: number; port: number } }
  const doctor = (): Promise<Doctor> => rpc<Doctor>(box, 'doctor.get')
  const first = await doctor()
  const { ppidOf } = procScan
  const lost = addonProcesses(fakeId).filter((pid) => ppidOf(pid) === first.addonHost.pid)
  process.kill(first.addonHost.pid!, 'SIGKILL')
  const respawned = await until('a new add-on host', 30_000, async () => {
    const d = await doctor()
    return !!d.addonHost.pid && d.addonHost.pid !== first.addonHost.pid
  })
  const second = await doctor()
  check('a killed add-on host is respawned, the gateway untouched', respawned && second.gateway.pid === first.gateway.pid, JSON.stringify({ first, second }))
  check('its add-ons are ready again', await until('ready after the respawn', 30_000, async () => (await statusOf(box, 'fakehttp'))?.state === 'ready' && (await statusOf(box, 'fake'))?.state === 'ready'))
  for (let i = 0; i < 2; i++) {
    const d = await doctor()
    if (d.addonHost.pid) process.kill(d.addonHost.pid, 'SIGKILL')
    await until('the next host', 20_000, async () => {
      const n = await doctor()
      return n.addonHost.down || (!!n.addonHost.pid && n.addonHost.pid !== d.addonHost.pid)
    })
  }
  const third = await doctor()
  check('three exits in a minute: the host is down', third.addonHost.down && third.addonHost.pid === null, JSON.stringify(third.addonHost))
  check('every add-on reads failed: the host kept exiting', (await statusOf(box, 'fakehttp'))?.detail === ADDON_HOST_DOWN && (await statusOf(box, 'fake'))?.detail === ADDON_HOST_DOWN)
  const gatewayAnswers = await fetch(`http://127.0.0.1:${third.gateway.port}/`).then((r) => r.status > 0, () => false)
  check('the gateway still serves, on its pid', gatewayAnswers && third.gateway.pid === first.gateway.pid)
  log(`stdio servers the killed hosts left: ${lost.length}; the guard sweeps them after its 60 s grace`)

  // ── 8. the codex first-turn gate ──────────────────────────────────────
  const codex = CODEX
  if (!codex) log('SKIP  the codex first-turn gate: no codex binary on this host')
  else {
    const gateOf = (sessionId: string): number | null => {
      const stalls = join(mac.data, 'logs', 'stalls.log')
      const line = existsSync(stalls) ? readFileSync(stalls, 'utf8').split('\n').find((l) => l.includes(`send session=${sessionId} `)) : undefined
      const m = line ? /delivered=\d+\(mcp=(\d+)\)/.exec(line) : null
      return m ? Number(m[1]) : null
    }
    const bareProj = join(mac.work, 'bare')
    mkdirSync(bareProj, { recursive: true })
    const bareWs = await rpc<{ id: string }>(mac, 'workspace.create', { path: bareProj, name: 'bare' })
    const bareProject = await rpc<{ id: string }>(mac, 'project.create', { workspaceId: bareWs.id, name: 'bare', mode: 'local' })
    const measure = async (projectId: string): Promise<number[]> => {
      const out: number[] = []
      for (let i = 0; i < 3; i++) {
        const s = await rpc<Meta>(mac, 'session.create', { provider: 'codex', projectId, threadType: 'chat', permission: 'auto', firstMessage: 'hi' })
        if (await until('the gate line', 60_000, () => gateOf(s.id) !== null)) out.push(gateOf(s.id)!)
      }
      return out
    }
    const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN
    const withAddons = await measure(macProject.id)
    const without = await measure(bareProject.id)
    log(`codex mcp gate: with add-ons ${withAddons.join(', ')} ms (median ${median(withAddons)}), without ${without.join(', ')} ms (median ${median(without)})`)
    check(`the gate grows by at most ${GATE_BUDGET_MS} ms with add-ons in scope`, withAddons.length === 3 && without.length === 3 && median(withAddons) - median(without) <= GATE_BUDGET_MS)
  }

  // ── 9. removal from the thread that wrote it ──────────────────────────
  const removedAt = await lastSeq(mac, macThread.id)
  const removed = JSON.parse(await rpc<string>(mac, 'app.addonRemove', { sessionId: macThread.id, name: 'fake' })) as { removed: string }
  const removeCards = (await events(mac, macThread.id)).filter((r) => r.seq > removedAt && r.event.type === 'approval-request')
  check('app.addonRemove from the writing thread asks nothing', removed.removed === 'fake' && removeCards.length === 0, JSON.stringify(removeCards))
  check('gone from both lists, its status with it', await until('gone on both', 30_000, async () => {
    const [m, b] = await Promise.all([list(mac), list(box)])
    return !m.addons.some((a) => a.id === fakeId) && !b.addons.some((a) => a.id === fakeId) && !(fakeId in m.status) && !(fakeId in b.status)
  }))
  const swept = await until('no TEMP_CODE_ADDON process of fake', 120_000, () => addonProcesses(fakeId).length === 0)
  check('no process carrying its TEMP_CODE_ADDON is left', swept, JSON.stringify(addonProcesses(fakeId)))
  if (lost.length) log(logOf(box).includes('[guard] orphan thread=addon:') ? 'the box\'s guard swept the server the dead host left' : 'the server the dead host left exited when its stdin closed; the guard had nothing to sweep')

  await down(mac)
  await down(box)

  // ── 4. the Claude lane, on this user's HOME, unpaired ─────────────────
  if (GATE) console.log('SKIP  leg 4: real claude-haiku-5-5 turn on the real HOME')
  else {
    const claude = await mk('claude', true)
    instances.push(claude)
    const claudeProj = join(claude.work, 'proj')
    mkdirSync(claudeProj, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'master', claudeProj])
    launch(claude, { platform: 'linux', isolated: false })
    if (!check('the Claude instance published its local socket', await until('claude up', 90_000, () => existsSync(join(claude.data, 'server.json'))))) throw new Error(`no server.json; log ${claude.log}`)
    const cWs = await rpc<{ id: string }>(claude, 'workspace.create', { path: claudeProj, name: 'proj' })
    const cProject = await rpc<{ id: string }>(claude, 'project.create', { workspaceId: cWs.id, name: 'proj', mode: 'local' })
    await rpc(claude, 'addons.set', { addon: { name: 'fake', workspaceId: cWs.id, description: 'A fake add-on for the proof: echo, image', spec: stdioSpec() } })
    check('fake is ready on the Claude instance', await until('fake ready', 30_000, async () => (await statusOf(claude, 'fake'))?.state === 'ready'))
    const nonce = Math.random().toString(36).slice(2, 8)
    const thread = await rpc<Meta>(claude, 'session.create', { provider: 'claude', model: 'claude-haiku-5-5', projectId: cProject.id, title: 'Uses the fake add-on', threadType: 'chat', permission: 'auto' })
    const settled = (after: number): Promise<boolean> =>
      until('the turn settles', 240_000, async () =>
        (await events(claude, thread.id)).some((r) => r.seq > after && (r.event.type === 'turn-complete' || (r.event.type === 'status' && (r.event.status === 'idle' || r.event.status === 'error'))))
      )
    const turn = async (message: string): Promise<Row[]> => {
      const after = await lastSeq(claude, thread.id)
      await rpc(claude, 'session.send', { sessionId: thread.id, text: message })
      await settled(after + 1)
      return (await events(claude, thread.id)).filter((r) => r.seq > after)
    }
    const callsTo = (rows: Row[], name: string) => rows.filter((r) => r.event.type === 'tool-call' && r.event.name === name && !(r.event as { partial?: boolean }).partial)
    const resultsOf = (rows: Row[], name: string) => {
      const ids = new Set(callsTo(rows, name).map((r) => r.event.callId))
      return rows.filter((r) => r.event.type === 'tool-result' && ids.has(r.event.callId)).map((r) => r.event.output ?? '')
    }
    const one = await turn(
      `Use tool search to find the fake add-on's echo tool, call it with the text "ping-${nonce}", then find and call the fake add-on's image tool. Reply with one word: done.`
    )
    check('the thread called mcp__app__fake__echo', callsTo(one, 'mcp__app__fake__echo').length > 0, JSON.stringify(one.filter((r) => r.event.type === 'tool-call').map((r) => r.event.name)))
    check("the fake's log has the nonce", callsLogged().some((c) => c.tool === 'echo' && String(c.arguments?.text) === `ping-${nonce}`))
    check("the image tool's result holds an image part", resultsOf(one, 'mcp__app__fake__image').some((o) => o.includes('[image]')), JSON.stringify(resultsOf(one, 'mcp__app__fake__image')))
    await rpc(claude, 'addons.set', { addon: { name: 'late', workspaceId: cWs.id, description: 'Added while the thread was idle', spec: stdioSpec() } })
    grants.late = { fields: { FAKE_TOKEN: TOKEN } }
    writeGrants()
    check('late is ready', await until('late ready', 30_000, async () => (await statusOf(claude, 'late'))?.state === 'ready'))
    const two = await turn(`A new add-on named "late" was just added. Use tool search to find its echo tool and call it with the text "pong-${nonce}". Reply with one word: done.`)
    check('the next turn called mcp__app__late__echo', callsTo(two, 'mcp__app__late__echo').length > 0, JSON.stringify(two.filter((r) => r.event.type === 'tool-call').map((r) => r.event.name)))
    check("the fake's log has the second nonce", callsLogged().some((c) => c.tool === 'echo' && String(c.arguments?.text) === `pong-${nonce}`))
    const stalls = join(claude.data, 'logs', 'stalls.log')
    const spans = existsSync(stalls) ? readFileSync(stalls, 'utf8').split('\n').filter((l) => l.includes(`send session=${thread.id} `)) : []
    const handle = /handle=\d+\((\w+)/.exec(spans[1] ?? '')?.[1] ?? null
    log(`the second send's handle: ${handle ?? 'not in stalls.log'} (live = the same harness, the tool reached it live)`)
    if (handle) check('the late add-on reached the live harness (no respawn)', handle === 'live', spans[1] ?? '')
    await rpc(claude, 'addons.remove', { id: (await list(claude)).addons.find((a) => a.name === 'fake')!.id })
    const three = await turn('Use tool search to look for a tool named mcp__app__fake__echo. Reply with exactly FOUND if it exists, otherwise MISSING.')
    const reply = three.filter((r) => r.event.type === 'assistant-text' && !r.event.delta).map((r) => r.event.text ?? '').join(' ')
    check("a removed add-on is gone from the thread's tool search", callsTo(three, 'mcp__app__fake__echo').length === 0 && /MISSING/.test(reply), reply)
    await rpc(claude, 'session.archive', { sessionId: thread.id }).catch(() => {})
  }
} catch (err) {
  check('the run completed', false, err instanceof Error ? err.message : String(err))
} finally {
  await cleanup()
  check('no fakeMcpServer process is left', await until('fakes gone', 10_000, () => fakeProcesses().length === 0), JSON.stringify(fakeProcesses()))
  if (!KEEP && failures === 0) rmSync(root, { recursive: true, force: true })
  else log(`left for inspection: ${root}`)
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
