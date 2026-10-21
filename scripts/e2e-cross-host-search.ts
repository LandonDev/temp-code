/**
 * Search across two hosts for real: two isolated headless instances of the
 * BUILT tree (out/main), each with its own HOME, userData and fixed remote
 * port, launched the way scripts/e2e-session-move.ts launches them. "mac"
 * and "box" each hold a copy of the same git workspace (shop), with one
 * file at the same relative path on both and the box's copy newer, a
 * thread whose rows are seeded straight into the database with the
 * instance stopped (a database from before the index, so the boot backfill
 * has work), and the box a note. Then:
 *  - each host's session.search answers from the FTS5 index (hits carry a
 *    bm25 rank) once the boot backfill has run; a two-word query needs
 *    both words; a delta row and a row inside a tool call are not hits
 *  - search.project answers with each match's mtime, the box's later
 *  - notes.search finds the box's note and nothing on mac
 *  - box issues an admin key and mac saves box as an environment (the peer
 *    link); then, as the search surface does, the script holds a client
 *    key for box, mints a ticket, upgrades /ws and runs the same query on
 *    box over the remote listener while asking mac on its local socket, so
 *    the two answers can be merged: one query, hits from both hosts, the
 *    shared file at the same relative path on both
 *  - the fence: search.project over the remote socket outside the project
 *    is refused
 * Run: bun scripts/e2e-cross-host-search.ts   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app, a real HOME or the box's
 * live temp-code.service.
 */
import { Database } from 'bun:sqlite'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_CHS_KEEP === '1'
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
  const d = mkdtempSync(join(tmpdir(), 'tc-cross-host-search-e2e-'))
  return spawnSync('realpath', [d]).stdout.toString().trim() || d
})()
type Inst = { name: string; home: string; data: string; tmp: string; remote: number; log: string; proc?: ChildProcess }
const mk = async (name: string): Promise<Inst> => {
  const inst = { name, home: join(root, `${name}-home`), data: join(root, `${name}-data`), tmp: join(root, `${name}-tmp`), remote: await freePort(), log: join(root, `${name}.log`) }
  for (const d of [inst.home, inst.data, inst.tmp]) mkdirSync(d, { recursive: true })
  return inst
}
const mac = await mk('mac')
const box = await mk('box')
const MAC_SHOP = join(mac.home, 'IdeaProjects', 'shop')
const BOX_SHOP = join(root, 'box-work', 'shop')
const MAC_THREAD = 'e2e-search-mac'
const BOX_THREAD = 'e2e-search-box'
const BOX_COLD = 'e2e-search-box-cold'

const put = (path: string, body: string | Buffer): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}
const git = (cwd: string, ...args: string[]): void => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', ...args])
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}
for (const dir of [MAC_SHOP, BOX_SHOP]) {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  put(join(dir, 'README.md'), 'shop\n')
  put(join(dir, 'src', 'gateway.ts'), 'export const gateway = () => "trace the gateway"\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
}
// The box's copy is the newer one; mac's is an hour old.
const hourAgo = new Date(Date.now() - 3_600_000)
utimesSync(join(MAC_SHOP, 'src', 'gateway.ts'), hourAgo, hourAgo)

// ── launch ──────────────────────────────────────────────────────────────
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
    CLAUDE_CONFIG_DIR: join(inst.home, '.claude'),
    CODEX_HOME: join(inst.home, '.codex'),
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
    await sleep(300)
  }
  log(`timed out: ${label}`)
  return false
}
const up = (inst: Inst): Promise<boolean> => until(`${inst.name} up`, 90_000, () => existsSync(join(inst.data, 'server.json')))

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
  await sleep(500)
}
const cleanup = async (): Promise<void> => {
  await stop(mac)
  await stop(box)
  if (!KEEP && failures === 0) rmSync(root, { recursive: true, force: true })
  else log(`left for inspection: ${root}`)
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))

type Hit = { sessionId: string; seq: number; role: string; snippet: string; ts: number; rank?: number }
type SearchResult = { hits: Hit[]; truncated: boolean }
type Match = { path: string; relative: string; line: number; column: number; preview: string; mtime?: number }

/** Rows written straight into the database while the instance is stopped:
 *  the log of a thread from before the index existed. */
function seed(inst: Inst, rows: { id: string; cold?: boolean; events: object[] }[]): void {
  const db = new Database(join(inst.data, 'temp-code.db'))
  db.exec(`ATTACH DATABASE '${join(inst.data, 'temp-code-cold.db')}' AS cold`)
  const ins = db.prepare('INSERT INTO events (session_id, seq, ts, payload) VALUES (?, ?, ?, ?)')
  const insCold = db.prepare('INSERT INTO cold.events (session_id, seq, ts, payload) VALUES (?, ?, ?, ?)')
  for (const row of rows) {
    // session.create wrote the thread's first status row: the seeded log replaces it.
    db.prepare('DELETE FROM events WHERE session_id = ?').run(row.id)
    db.prepare('DELETE FROM cold.events WHERE session_id = ?').run(row.id)
    row.events.forEach((e, i) => (row.cold ? insCold : ins).run(row.id, i + 1, Date.now() + i, JSON.stringify(e)))
    if (row.cold) db.prepare('UPDATE sessions SET cold = 1, archived = 1 WHERE id = ?').run(row.id)
  }
  // The index never saw these sessions: the boot backfill has to.
  db.exec('DELETE FROM turn_index')
  db.close()
}

launch(mac)
launch(box)
try {
  if (!check('both headless instances published their local socket', (await up(mac)) && (await up(box)))) throw new Error(`no server.json; logs ${mac.log} ${box.log}`)
  const macEnv = (await rpc<{ environmentId: string }>(mac, 'remote.status')).environmentId
  const boxEnv = (await rpc<{ environmentId: string }>(box, 'remote.status')).environmentId
  log(`mac ${macEnv}, box ${boxEnv} on :${box.remote}; logs ${mac.log} ${box.log}`)

  // ── the same workspace on both hosts, one thread each (two on box) ─────
  const macWs = await rpc<{ id: string }>(mac, 'workspace.create', { path: MAC_SHOP, name: 'shop' })
  const macProj = await rpc<{ id: string; cwd: string }>(mac, 'project.create', { workspaceId: macWs.id, name: 'shop', mode: 'local' })
  const boxWs = await rpc<{ id: string }>(box, 'workspace.create', { path: BOX_SHOP, name: 'shop' })
  const boxProj = await rpc<{ id: string; cwd: string }>(box, 'project.create', { workspaceId: boxWs.id, name: 'shop', mode: 'local' })
  await rpc(mac, 'session.create', { id: MAC_THREAD, projectId: macProj.id, provider: 'claude', title: 'Gateway trace on the Mac', threadType: 'chat' })
  await rpc(box, 'session.create', { id: BOX_THREAD, projectId: boxProj.id, provider: 'codex', title: 'Box thread', threadType: 'chat' })
  await rpc(box, 'session.create', { id: BOX_COLD, projectId: boxProj.id, provider: 'claude', title: 'Archived box thread', threadType: 'chat' })
  await rpc(box, 'notes.upsert', { note: { id: 'e2e-note', title: 'Gateway notes', body: 'the gateway trace flag is TEMP_CODE_GATEWAY_TRACE', sourceCwd: BOX_SHOP } })

  // ── seed the logs with both stopped, the way the app stores them ───────
  await stop(mac)
  await stop(box)
  seed(mac, [
    {
      id: MAC_THREAD,
      events: [
        { type: 'user-text', text: 'please trace the gateway on the mac' },
        { type: 'assistant-text', text: 'gate', delta: true },
        { type: 'tool-call', callId: 'c1', name: 'Bash', input: { command: 'ls' } },
        { type: 'assistant-text', text: 'nested gateway inside a tool call', delta: false, parentCallId: 'c1' },
        { type: 'tool-result', callId: 'c1', output: 'ok', isError: false },
        { type: 'assistant-text', text: 'the gateway trace is on, see the mac log', delta: false },
        { type: 'turn-complete', costUsd: 0.01 }
      ]
    }
  ])
  seed(box, [
    {
      id: BOX_THREAD,
      events: [
        { type: 'user-text', text: 'what does the gateway do on the box' },
        { type: 'assistant-text', text: 'it forwards every provider call; the trace flag logs one line each', delta: false }
      ]
    },
    {
      id: BOX_COLD,
      cold: true,
      events: [{ type: 'user-text', text: 'an archived gateway question' }]
    }
  ])
  launch(mac)
  launch(box)
  if (!check('both came back on the seeded databases', (await up(mac)) && (await up(box)))) throw new Error('restart failed')

  // ── each host indexes its own rows at boot and answers from the index ──
  const indexed = async (inst: Inst, id: string): Promise<boolean> => {
    const r = await rpc<SearchResult>(inst, 'session.search', { query: 'gateway' })
    return r.hits.some((h) => h.sessionId === id && typeof h.rank === 'number')
  }
  check('mac: the boot backfill indexed the seeded thread (hits carry bm25)', await until('mac indexed', 60_000, () => indexed(mac, MAC_THREAD)))
  check('box: the boot backfill indexed the seeded thread', await until('box indexed', 60_000, () => indexed(box, BOX_THREAD)))
  const macHits = await rpc<SearchResult>(mac, 'session.search', { query: 'gateway' })
  check(
    'mac: the user turn and the answer are hits; the delta and the row inside the tool call are not',
    macHits.hits.map((h) => h.seq).sort().join() === '1,6',
    JSON.stringify(macHits.hits.map((h) => [h.seq, h.snippet]))
  )
  check('mac: the snippet is the row text, the role its author', macHits.hits.find((h) => h.seq === 1)?.snippet === 'please trace the gateway on the mac' && macHits.hits.find((h) => h.seq === 1)?.role === 'user')
  const twoWords = await rpc<SearchResult>(mac, 'session.search', { query: 'trace mac' })
  check('mac: a two-word query needs both words in the row', twoWords.hits.map((h) => h.seq).sort().join() === '1,6', JSON.stringify(twoWords.hits.map((h) => h.seq)))
  const prefix = await rpc<SearchResult>(mac, 'session.search', { query: 'gatew' })
  check('mac: the last word matches as a prefix', prefix.hits.length === 2)
  const boxHot = await rpc<SearchResult>(box, 'session.search', { query: 'gateway' })
  const boxAll = await rpc<SearchResult>(box, 'session.search', { query: 'gateway', archived: true })
  check('box: the archived thread is found only with archived: true, from the cold file\'s index', !boxHot.hits.some((h) => h.sessionId === BOX_COLD) && boxAll.hits.some((h) => h.sessionId === BOX_COLD && typeof h.rank === 'number'))

  // ── files on both copies, with their mtimes ────────────────────────────
  const macFiles = await rpc<{ matches: Match[] }>(mac, 'search.project', { options: { cwd: MAC_SHOP, query: 'gateway' } })
  const boxFiles = await rpc<{ matches: Match[] }>(box, 'search.project', { options: { cwd: BOX_SHOP, query: 'gateway' } })
  const macGw = macFiles.matches.find((m) => m.relative === 'src/gateway.ts')
  const boxGw = boxFiles.matches.find((m) => m.relative === 'src/gateway.ts')
  check('search.project: the same relative path on both hosts, each match with its mtime, the box\'s later', !!macGw?.mtime && !!boxGw?.mtime && boxGw.mtime > macGw.mtime, `${macGw?.mtime} < ${boxGw?.mtime}`)

  // ── notes ──────────────────────────────────────────────────────────────
  const boxNotes = await rpc<{ hits: { id: string; title: string; snippet: string; sourceCwd?: string }[] }>(box, 'notes.search', { query: 'gateway' })
  const macNotes = await rpc<{ hits: unknown[] }>(mac, 'notes.search', { query: 'gateway' })
  check('notes.search: the box\'s note with its snippet and cwd; nothing on mac', boxNotes.hits.length === 1 && boxNotes.hits[0].snippet.includes('gateway trace flag') && boxNotes.hits[0].sourceCwd === BOX_SHOP && macNotes.hits.length === 0)

  // ── peer the hosts: box issues an admin key, mac saves box ─────────────
  const admin = await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'mac (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  await rpc(mac, 'remote.environments.add', { url: `http://127.0.0.1:${box.remote}`, key: admin.token, name: 'box' })
  const linked = await until('the peer link is up', 60_000, async () => {
    const s = await rpc<{ environments: { connected: boolean }[] }>(mac, 'harness.status')
    return s.environments[0]?.connected === true
  })
  check('mac holds a peer link to box', linked)

  // ── one query, both hosts: box over the remote listener as the surface does ──
  const client = await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'search surface (e2e)', audience: 'client', caps: ['read'] })
  const base = `http://127.0.0.1:${box.remote}`
  const ticket = await fetch(`${base}/api/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${client.token}` } }).then((r) => r.json() as Promise<{ ticket: string }>)
  const remote = await new Promise<{ request: (method: string, params: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>; close: () => void }>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?ticket=${ticket.ticket}`)
    const waiters = new Map<string, (f: { ok: boolean; result?: unknown; error?: string }) => void>()
    let next = 1
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: unknown; error?: string }
      if (frame.id && waiters.has(frame.id)) {
        waiters.get(frame.id)!({ ok: !!frame.ok, result: frame.result, error: frame.error })
        waiters.delete(frame.id)
      }
    })
    ws.addEventListener('open', () =>
      resolve({
        request: (method, params) =>
          new Promise((ok) => {
            const id = String(next++)
            waiters.set(id, ok)
            ws.send(JSON.stringify({ id, method, params }))
          }),
        close: () => ws.close()
      })
    )
    ws.addEventListener('error', () => reject(new Error('remote socket failed')))
  })
  const [onMac, onBox] = await Promise.all([
    rpc<SearchResult>(mac, 'session.search', { query: 'gateway', limit: 200 }),
    remote.request('session.search', { query: 'gateway', limit: 200 })
  ])
  const boxRemoteHits = (onBox.result as SearchResult | undefined)?.hits ?? []
  check('the same query answered by both hosts at once: mac on its socket, box over its remote listener', onBox.ok && onMac.hits.length === 2 && boxRemoteHits.length === 1 && boxRemoteHits.every((h) => typeof h.rank === 'number'), onBox.error ?? '')
  const merged = [...onMac.hits.map((h) => ({ host: 'mac', ...h })), ...boxRemoteHits.map((h) => ({ host: 'box', ...h }))].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
  check('merged by rank, both hosts in the list', new Set(merged.map((h) => h.host)).size === 2, merged.map((h) => `${h.host}:${h.sessionId}:${h.seq}`).join(' '))
  const boxRemoteFiles = await remote.request('search.project', { options: { cwd: BOX_SHOP, query: 'gateway' } })
  const remoteGw = ((boxRemoteFiles.result as { matches: Match[] } | undefined)?.matches ?? []).find((m) => m.relative === 'src/gateway.ts')
  check('the box\'s copy of the shared file over the remote listener, with its mtime (the newer one)', boxRemoteFiles.ok && !!remoteGw?.mtime && remoteGw.mtime === boxGw?.mtime)
  const outside = await remote.request('search.project', { options: { cwd: root, query: 'gateway' } })
  check('the fence: search.project outside the project is refused over the remote listener', !outside.ok && /forbidden/.test(outside.error ?? ''), outside.error ?? 'answered')
  const remoteNotes = await remote.request('notes.search', { query: 'gateway' })
  check('notes.search over the remote listener (a read key)', remoteNotes.ok && (remoteNotes.result as { hits: unknown[] }).hits.length === 1)
  remote.close()
} catch (error) {
  check('run completed', false, error instanceof Error ? error.message : String(error))
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
