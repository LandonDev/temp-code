/**
 * Moving one thread between hosts for real: two isolated headless instances
 * of the BUILT tree (out/main), each with its own HOME, userData, Claude
 * config dir, Codex home, TMPDIR and fixed port, launched the way
 * scripts/e2e-harness-sync.ts launches them (xvfb-run and a private D-Bus on
 * Linux). Each publishes its local socket in <userData>/server.json and this
 * script speaks to it as the implicit admin, as scripts/box/tc-local.mjs does.
 *
 * "mac" holds a workspace at <mac HOME>/IdeaProjects/shop (a git repo with one
 * uncommitted file); "box" holds the same workspace at <box>/work/shop. Both
 * carry a `harness.sync.pathMap` root mapping one onto the other, so every
 * path the move lands is remapped, never left as it was. The thread is seeded
 * on mac with mac stopped (its database written the way the app writes it):
 * a claude root with one answered turn and a native id, a codex subagent
 * whose rows sit in the cold file, a fold, an agent page, the Claude
 * transcript (plus its subagent dir), the Codex rollout (5 MiB, so it crosses
 * in chunks) and a checkpoint. Then:
 *  - box issues an admin key and mac saves box as an environment (the peer link)
 *  - mac → box (`session.move` on mac pushes): the result names the dirty file,
 *    the undo history that stayed and the transcript that moved; box lists
 *    the thread and its subagent with the cwd and plan remapped, its own
 *    workspace and project, every row, the fold's tally; the page, the
 *    transcript under the slug of the box cwd and the rollout land byte for
 *    byte; mac holds a tombstone (no rows, no page, the checkpoint kept), its
 *    clients heard `session-moved` before `session-removed`, and a send to it
 *    there is refused
 *  - box → mac (`session.move` on mac pulls): the same checks the other way,
 *    with the thread back at its Mac cwd under the Mac's own project
 * Run: bun run script:e2e-session-move   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app, a real HOME, the real
 * Aliax vault or the box's live temp-code.service.
 */
import { Database } from 'bun:sqlite'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_SM_KEEP === '1'
let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const slug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9_-]/g, '-')

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
  const d = mkdtempSync(join(tmpdir(), 'tc-session-move-e2e-'))
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
const ROOT_ID = 'e2e-move-root'
const CHILD_ID = 'e2e-move-child'
const CLAUDE_NATIVE = 'b6b0c7e2-1111-4222-8333-944445555666'
const CODEX_NATIVE = '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001'
const ROLLOUT_REL = join('2026', '10', '20', `rollout-2026-10-20T01-02-03-${CODEX_NATIVE}.jsonl`)
const ROLLOUT = randomBytes(5 * 1024 * 1024 + 7)
const TRANSCRIPT = `{"type":"user","cwd":"${MAC_SHOP}","sessionId":"${CLAUDE_NATIVE}"}\n{"type":"assistant","message":"ship it"}\n`
const PAGE = '<!doctype html><h1>move report</h1>'

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
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
}
put(join(MAC_SHOP, 'dirty.txt'), 'not committed\n')

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
    }, 180_000)
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

/** A client socket that records the pushes it hears (session-moved, session-removed). */
function listen(inst: Inst): { pushes: string[]; close: () => void; ready: Promise<void> } {
  const { port } = JSON.parse(readFileSync(join(inst.data, 'server.json'), 'utf8')) as { port: number }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  const pushes: string[] = []
  const ready = new Promise<void>((ok) => ws.addEventListener('open', () => ok()))
  ws.addEventListener('message', (ev) => {
    const frame = JSON.parse(String(ev.data)) as { push?: string; to?: string; sessionIds?: string[] }
    if (frame.push === 'session-moved') pushes.push(`moved:${frame.sessionIds?.join(',')}:${frame.to}`)
    if (frame.push === 'session-removed') pushes.push(`removed:${frame.sessionIds?.join(',')}`)
  })
  return { pushes, close: () => ws.close(), ready }
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

const dbOf = (inst: Inst): Database => new Database(join(inst.data, 'temp-code.db'), { readonly: true })
const rowOf = (inst: Inst, id: string): Record<string, unknown> | null => {
  const db = dbOf(inst)
  try {
    return (db.query('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | null) ?? null
  } finally {
    db.close()
  }
}

interface Meta {
  id: string
  parentId: string | null
  projectId: string | null
  workspaceId: string | null
  cwd: string
  planPath: string | null
  nativeId: string | null
  tasks?: { done: number; total: number } | null
}
interface MoveResult {
  sessionIds: string[]
  cwd: string
  events: number
  files: number
  transcript: string
  dirty: string[]
  checkpointsStayed: boolean
  pendingRelease?: boolean
}

/** Every row of a thread, as the host serves it. */
const eventsOf = async (inst: Inst, sessionId: string): Promise<{ seq: number; event: { type: string; text?: string } }[]> =>
  rpc(inst, 'session.events', { sessionId, afterSeq: 0 })
const findIn = async (inst: Inst, id: string): Promise<Meta | undefined> => {
  const live = await rpc<Meta[]>(inst, 'session.list', {})
  const archived = await rpc<Meta[]>(inst, 'session.list', { archived: true })
  return [...live, ...archived].find((s) => s.id === id)
}

launch(mac)
launch(box)
try {
  if (!check('both headless instances published their local socket', (await up(mac)) && (await up(box)))) throw new Error(`no server.json; logs ${mac.log} ${box.log}`)
  const macEnv = (await rpc<{ environmentId: string }>(mac, 'remote.status')).environmentId
  const boxEnv = (await rpc<{ environmentId: string }>(box, 'remote.status')).environmentId
  log(`mac ${macEnv}, box ${boxEnv} on :${box.remote}; logs ${mac.log} ${box.log}`)

  // ── the catalog on both hosts, and the path map both read ──────────────
  const pathMap = { roots: { [MAC_SHOP]: BOX_SHOP }, prefixes: {} }
  await rpc(mac, 'harness.settings.set', { pathMap })
  await rpc(box, 'harness.settings.set', { pathMap })
  const macWs = await rpc<{ id: string }>(mac, 'workspace.create', { path: MAC_SHOP, name: 'shop' })
  const macProj = await rpc<{ id: string; cwd: string }>(mac, 'project.create', { workspaceId: macWs.id, name: 'shop', mode: 'local' })
  const boxWs = await rpc<{ id: string }>(box, 'workspace.create', { path: BOX_SHOP, name: 'shop' })
  const boxProj = await rpc<{ id: string; cwd: string }>(box, 'project.create', { workspaceId: boxWs.id, name: 'shop', mode: 'local' })
  log(`mac project ${macProj.id} at ${macProj.cwd}; box project ${boxProj.id} at ${boxProj.cwd}`)
  await rpc(mac, 'session.create', { id: ROOT_ID, projectId: macProj.id, provider: 'claude', title: 'Move me', threadType: 'chat' })
  await rpc(mac, 'session.create', { id: CHILD_ID, projectId: macProj.id, parentId: ROOT_ID, provider: 'codex', title: 'Subagent' })

  // ── seed the answered turn with mac stopped, the way the app stores it ──
  await stop(mac)
  {
    const db = new Database(join(mac.data, 'temp-code.db'))
    db.exec(`ATTACH DATABASE '${join(mac.data, 'temp-code-cold.db')}' AS cold`)
    const ins = db.prepare('INSERT INTO events (session_id, seq, ts, payload) VALUES (?, ?, ?, ?)')
    const insCold = db.prepare('INSERT INTO cold.events (session_id, seq, ts, payload) VALUES (?, ?, ?, ?)')
    const turn = [
      { type: 'user-text', text: 'What should we ship?' },
      { type: 'tool-call', callId: 'c1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool-result', callId: 'c1', output: 'README.md\ndirty.txt', isError: false },
      { type: 'assistant-text', text: 'Ship the README. '.repeat(20_000), delta: false },
      { type: 'turn-complete', costUsd: 0.02 },
      { type: 'status', status: 'idle' }
    ]
    turn.forEach((e, i) => ins.run(ROOT_ID, i + 1, Date.now() + i, JSON.stringify(e)))
    const sub = [
      { type: 'user-text', text: 'check the build' },
      { type: 'assistant-text', text: 'the build is green', delta: false }
    ]
    sub.forEach((e, i) => insCold.run(CHILD_ID, i + 1, Date.now() + i, JSON.stringify(e)))
    db.prepare('UPDATE sessions SET cold = 1 WHERE id = ?').run(CHILD_ID)
    db.prepare('UPDATE sessions SET native_id = ?, plan_path = ? WHERE id = ?').run(CLAUDE_NATIVE, join(MAC_SHOP, '.temp-code', 'plans', 'move.md'), ROOT_ID)
    db.prepare('UPDATE sessions SET native_id = ? WHERE id = ?').run(CODEX_NATIVE, CHILD_ID)
    db.prepare(
      `INSERT OR REPLACE INTO session_folds (session_id, folded_seq, fold_version, tasks_done, tasks_total, tasks_current, goal, can_continue) VALUES (?, ?, 1, 2, 5, 'ship', NULL, 0)`
    ).run(ROOT_ID, turn.length)
    db.close()
  }
  put(join(MAC_SHOP, '.temp-code', 'plans', 'move.md'), '# plan\n')
  put(join(mac.data, 'html-renders', ROOT_ID, 'report.html'), PAGE)
  const macClaude = join(mac.home, '.claude', 'projects', slug(MAC_SHOP))
  put(join(macClaude, `${CLAUDE_NATIVE}.jsonl`), TRANSCRIPT)
  put(join(macClaude, CLAUDE_NATIVE, 'subagents', 'agent-1.jsonl'), '{"sub":true}\n')
  put(join(mac.home, '.codex', 'sessions', ROLLOUT_REL), ROLLOUT)
  put(join(mac.data, 'checkpoints', ROOT_ID, 'manifest.json'), JSON.stringify({ cwd: MAC_SHOP }))
  launch(mac)
  if (!check('mac came back on the seeded database', await up(mac))) throw new Error('mac did not restart')
  const before = await eventsOf(mac, ROOT_ID)
  check('mac serves the seeded thread: 6 rows, the subagent\'s 2 from the cold file', before.length === 6 && (await eventsOf(mac, CHILD_ID)).length === 2)

  // ── pair: box issues an admin key, mac saves box ──────────────────────
  const key = await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'mac (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  await rpc(mac, 'remote.environments.add', { url: `http://127.0.0.1:${box.remote}`, key: key.token, name: 'box' })
  const linked = await until('the peer link is up', 60_000, async () => {
    const s = await rpc<{ environments: { connected: boolean }[] }>(mac, 'harness.status')
    return s.environments[0]?.connected === true
  })
  if (!check('mac holds an admin peer link to box', linked)) throw new Error('no peer link')

  // ── mac → box ──────────────────────────────────────────────────────────
  const macPushes = listen(mac)
  await macPushes.ready
  const t0 = Date.now()
  const there = await rpc<MoveResult>(mac, 'session.move', { sessionId: ROOT_ID, to: boxEnv })
  log(`mac → box in ${Date.now() - t0} ms: ${JSON.stringify({ ...there, dirty: there.dirty })}`)
  check('the result: the subtree, every row, the transcript moved, the dirty file and the undo history named', JSON.stringify(there.sessionIds) === JSON.stringify([ROOT_ID, CHILD_ID]) && there.events === 8 && there.transcript === 'moved' && there.dirty.includes('dirty.txt') && there.checkpointsStayed && !there.pendingRelease && there.cwd === BOX_SHOP)
  const onBox = await findIn(box, ROOT_ID)
  check('box lists the thread at its own path, workspace and project', onBox?.cwd === BOX_SHOP && onBox.workspaceId === boxWs.id && onBox.projectId === boxProj.id, JSON.stringify(onBox))
  check('box: the absolute plan path remapped, the native id kept', onBox?.planPath === join(BOX_SHOP, '.temp-code', 'plans', 'move.md') && onBox.nativeId === CLAUDE_NATIVE)
  check('box: the fold landed (its tally is on the meta)', onBox?.tasks?.total === 5 && onBox.tasks.done === 2, JSON.stringify(onBox?.tasks))
  const childOnBox = await findIn(box, CHILD_ID)
  check('box: the subagent came along under its root', childOnBox?.parentId === ROOT_ID && childOnBox.cwd === BOX_SHOP && childOnBox.nativeId === CODEX_NATIVE)
  const boxRows = await eventsOf(box, ROOT_ID)
  check('box serves every row of both, seqs and bodies intact', boxRows.length === 6 && JSON.stringify(boxRows.map((r) => r.seq)) === JSON.stringify(before.map((r) => r.seq)) && boxRows[3].event.text === before[3].event.text && (await eventsOf(box, CHILD_ID)).length === 2)
  check('box: the agent page landed', readFileSync(join(box.data, 'html-renders', ROOT_ID, 'report.html'), 'utf8') === PAGE)
  const boxClaude = join(box.home, '.claude', 'projects', slug(BOX_SHOP))
  check('box: the Claude transcript landed under the slug of the box cwd, its subagent dir too', readFileSync(join(boxClaude, `${CLAUDE_NATIVE}.jsonl`), 'utf8') === TRANSCRIPT && existsSync(join(boxClaude, CLAUDE_NATIVE, 'subagents', 'agent-1.jsonl')))
  check('box: the 5 MiB Codex rollout crossed in chunks, byte for byte', sha(readFileSync(join(box.home, '.codex', 'sessions', ROLLOUT_REL))) === sha(ROLLOUT))
  check('box: no checkpoints came along', !existsSync(join(box.data, 'checkpoints', ROOT_ID)))
  const tomb = rowOf(mac, ROOT_ID)
  check('mac keeps a tombstone: the row, moved_to box, archived, nothing else listed', tomb?.moved_to === boxEnv && tomb.archived === 1 && (await findIn(mac, ROOT_ID)) === undefined && rowOf(mac, CHILD_ID)?.moved_to === boxEnv)
  {
    const db = dbOf(mac)
    db.exec(`ATTACH DATABASE '${join(mac.data, 'temp-code-cold.db')}' AS cold`)
    const n = (db.query(`SELECT (SELECT count(*) FROM events WHERE session_id IN (?1, ?2)) + (SELECT count(*) FROM cold.events WHERE session_id IN (?1, ?2)) AS n`).get(ROOT_ID, CHILD_ID) as { n: number }).n
    db.close()
    check('mac: the rows, fold and page are gone; the checkpoint stays', n === 0 && !existsSync(join(mac.data, 'html-renders', ROOT_ID)) && existsSync(join(mac.data, 'checkpoints', ROOT_ID)))
  }
  await until('mac pushes arrive', 5_000, () => macPushes.pushes.length >= 2)
  check('mac clients heard session-moved before session-removed', macPushes.pushes[0] === `moved:${ROOT_ID},${CHILD_ID}:${boxEnv}` && macPushes.pushes[1] === `removed:${ROOT_ID},${CHILD_ID}`, JSON.stringify(macPushes.pushes))
  macPushes.close()
  const refused = await rpc(mac, 'session.send', { sessionId: ROOT_ID, text: 'still here?' }).then(() => null, (e: Error) => e.message)
  check('mac refuses a send to the thread it gave away', !!refused && /unknown session/.test(refused), refused ?? 'accepted')

  // ── box → mac ──────────────────────────────────────────────────────────
  const boxPushes = listen(box)
  await boxPushes.ready
  const t1 = Date.now()
  const back = await rpc<MoveResult>(mac, 'session.move', { sessionId: ROOT_ID, from: boxEnv, to: macEnv })
  log(`box → mac in ${Date.now() - t1} ms`)
  check('the pull: the subtree and every row, the transcript moved, a clean tree, no undo history there', back.events === 8 && back.transcript === 'moved' && back.dirty.length === 0 && !back.checkpointsStayed && back.sessionIds.length === 2 && back.cwd === MAC_SHOP)
  const home = await findIn(mac, ROOT_ID)
  check('mac lists the thread back at its Mac path, workspace and project', home?.cwd === MAC_SHOP && home.workspaceId === macWs.id && home.projectId === macProj.id, JSON.stringify(home))
  check('mac: the plan path back on the Mac, the fold back', home?.planPath === join(MAC_SHOP, '.temp-code', 'plans', 'move.md') && home.tasks?.total === 5)
  const macRows = await eventsOf(mac, ROOT_ID)
  check('mac serves every row again, seqs intact', macRows.length === 6 && macRows[3].event.text === before[3].event.text && (await eventsOf(mac, CHILD_ID)).length === 2)
  check('mac: the page and the transcript are back', readFileSync(join(mac.data, 'html-renders', ROOT_ID, 'report.html'), 'utf8') === PAGE && readFileSync(join(macClaude, `${CLAUDE_NATIVE}.jsonl`), 'utf8') === TRANSCRIPT)
  check('box keeps a tombstone now, pointing at mac', rowOf(box, ROOT_ID)?.moved_to === macEnv && (await findIn(box, ROOT_ID)) === undefined && !existsSync(join(box.data, 'html-renders', ROOT_ID)))
  await until('box pushes arrive', 5_000, () => boxPushes.pushes.length >= 2)
  check('box clients heard session-moved (to mac) before session-removed', boxPushes.pushes[0] === `moved:${ROOT_ID},${CHILD_ID}:${macEnv}` && boxPushes.pushes[1] === `removed:${ROOT_ID},${CHILD_ID}`, JSON.stringify(boxPushes.pushes))
  boxPushes.close()
  const third = await rpc<MoveResult>(mac, 'session.move', { sessionId: ROOT_ID, to: boxEnv })
  check('and it moves again (the box tombstone gives way to the new landing)', third.events === 8 && (await findIn(box, ROOT_ID))?.cwd === BOX_SHOP)
} catch (err) {
  console.error('ERROR', err instanceof Error ? err.message : err)
  failures++
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
