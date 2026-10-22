/**
 * One project across hosts, for real (CLAUDE.md "One project across hosts",
 * docs/box.md "One project across hosts"): two isolated headless instances
 * of the BUILT tree, the rig of scripts/e2e-cross-host-threads.ts ("mac"
 * plays the Mac, "box" plays the box; provider calls go to a dead loopback
 * origin, so every turn fails fast and settles).
 *
 *  - box issues an admin key, mac saves box: mac's link registers on box
 *  - a workspace of the same folder name on each host, and a project of
 *    the same name in each: the linker on mac (the host holding the link)
 *    stamps both copies with one `wl_…` and one `pl_…` id
 *  - a box thread in a project mac has no copy of calls app.startThread
 *    with environmentId mac: mac creates the copy in its linked workspace,
 *    stamps the box's link id on it, and the thread lands in it (projectId
 *    set); a second start reuses the copy; a box workspace mac has no
 *    checkout of still starts in mac's work root with cwdNote
 *  - a settings edit on the box (the home) reaches mac's copy; a mac edit of
 *    the linked project lands on the box and mac's copy follows; with the
 *    box down the mac edit is refused naming the host
 *  - a `@thread:` reference from a mac thread to a box thread yields the
 *    digest; app.listAgents on the box names a child spawned on mac with
 *    its host
 * Run: bun scripts/e2e-linked-projects.ts   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app, a real HOME, the real
 * Aliax vault, the gateway marker or the box's live temp-code.service.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_LP_KEEP === '1'
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
  const d = mkdtempSync(join(tmpdir(), 'tc-linked-projects-e2e-'))
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
// One checkout of the same folder name on each host (no GitHub remote: the
// folder-name rule links them), and a folder only the box has.
const boxProj = join(box.work, 'proj')
const macProj = join(mac.work, 'proj')
const boxOnly = join(box.work, 'boxonly')
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@x', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@x' } }).trim()
for (const dir of [boxProj, macProj, boxOnly]) {
  mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'master', dir])
  writeFileSync(join(dir, 'README'), 'proof\n')
  git(dir, 'add', 'README')
  git(dir, 'commit', '-q', '-m', 'initial')
}

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
    // Both instances run here on Linux; the seam makes the instance that plays the Mac say so, so the box is the settings home.
    TEMP_CODE_BUILD_PLATFORM: inst.name === 'mac' ? 'darwin' : 'linux',
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
  projectId: string | null
  workspaceId: string | null
  cwd: string
  status: string
  title: string
}
interface Ws {
  id: string
  path: string
  linkId?: string | null
}
interface Proj {
  id: string
  workspaceId: string
  name: string
  cwd: string
  linkId?: string | null
  preamble?: string | null
  archived: boolean
}
const sessionsOf = (inst: Inst): Promise<Meta[]> => rpc<Meta[]>(inst, 'session.list')
const workspacesOf = (inst: Inst): Promise<Ws[]> => rpc<Ws[]>(inst, 'workspace.list')
const projectsOf = (inst: Inst): Promise<Proj[]> => rpc<Proj[]>(inst, 'project.list')
const eventsOf = (inst: Inst, sessionId: string): Promise<{ seq: number; event: { type: string; text?: string; attachments?: { kind: string; environmentId?: string; path: string }[] } }[]> =>
  rpc(inst, 'session.events', { sessionId, afterSeq: 0 })

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

  // ── 1. the catalog on each host, then pair ─────────────────────────────
  const boxWs = await rpc<Ws>(box, 'workspace.create', { path: boxProj, name: 'proj' })
  const boxProject = await rpc<Proj>(box, 'project.create', { workspaceId: boxWs.id, name: 'Proj', mode: 'local' })
  const macWs = await rpc<Ws>(mac, 'workspace.create', { path: macProj, name: 'proj' })
  const macProject = await rpc<Proj>(mac, 'project.create', { workspaceId: macWs.id, name: 'proj', mode: 'local' })
  const boxOnlyWs = await rpc<Ws>(box, 'workspace.create', { path: boxOnly, name: 'boxonly' })
  const boxOnlyProject = await rpc<Proj>(box, 'project.create', { workspaceId: boxOnlyWs.id, name: 'boxonly', mode: 'local' })
  const key = await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'mac (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  await rpc(mac, 'remote.environments.add', { url: `http://127.0.0.1:${box.remote}`, key: key.token, name: 'box' })
  const registered = await until('mac registers on box', 60_000, () => logOf(box).includes(`[peer-calls] ${macId} registered`))
  check("box logged mac's registration", registered)

  // ── 2. the linker stamps both copies ──────────────────────────────────
  const linked = await until('both copies linked', 60_000, async () => {
    const [mw, bw, mp, bp] = await Promise.all([workspacesOf(mac), workspacesOf(box), projectsOf(mac), projectsOf(box)])
    const mwRow = mw.find((w) => w.id === macWs.id)
    const bwRow = bw.find((w) => w.id === boxWs.id)
    const mpRow = mp.find((p) => p.id === macProject.id)
    const bpRow = bp.find((p) => p.id === boxProject.id)
    return !!mwRow?.linkId && mwRow.linkId === bwRow?.linkId && !!mpRow?.linkId && mpRow.linkId === bpRow?.linkId
  })
  check('the workspaces of one folder name and the projects of one name carry one link id on both hosts', linked)
  const macRows = { ws: (await workspacesOf(mac)).find((w) => w.id === macWs.id)!, p: (await projectsOf(mac)).find((p) => p.id === macProject.id)! }
  check('the ids are wl_ and pl_ prefixed', !!macRows.ws.linkId?.startsWith('wl_') && !!macRows.p.linkId?.startsWith('pl_'), JSON.stringify(macRows))
  const boxOnlyRow = (await workspacesOf(box)).find((w) => w.id === boxOnlyWs.id)
  check('a workspace with no partner stays unlinked', !boxOnlyRow?.linkId, JSON.stringify(boxOnlyRow))

  // ── 3. a far start into a project with no copy creates and links it ───
  const boxAlpha = await rpc<Proj>(box, 'project.create', { workspaceId: boxWs.id, name: 'alpha', mode: 'local' })
  const alphaCaller = await rpc<Meta>(box, 'session.create', { provider: 'claude', projectId: boxAlpha.id, title: 'alpha on the box', threadType: 'chat', permission: 'auto' })
  const started = await rpc<{ threadId: string; cwd: string; cwdNote?: string } | string>(box, 'app.startThread', {
    sessionId: alphaCaller.id,
    environmentId: 'mac',
    threadType: 'chat',
    provider: 'claude',
    firstMessage: 'hello from alpha',
    title: 'alpha, started from the box'
  })
  if (typeof started === 'string') throw new Error(started)
  const farSid = started.threadId.split(':')[1]
  const macAlpha = (await projectsOf(mac)).find((p) => p.name === 'alpha')
  const boxAlphaRow = (await projectsOf(box)).find((p) => p.id === boxAlpha.id)
  check('mac created the copy in its linked workspace and stamped the link id', !!macAlpha && macAlpha.workspaceId === macWs.id && macAlpha.cwd === macProj && !!macAlpha.linkId && macAlpha.linkId === boxAlphaRow?.linkId, JSON.stringify({ macAlpha, boxAlphaRow }))
  const farMeta = (await sessionsOf(mac)).find((s) => s.id === farSid)
  check("the thread landed in that project (projectId set, the copy's cwd)", !!farMeta && farMeta.projectId === macAlpha?.id && farMeta.cwd === macProj && !started.cwdNote, JSON.stringify({ farMeta, started }))
  const again = await rpc<{ threadId: string } | string>(box, 'app.startThread', { sessionId: alphaCaller.id, environmentId: 'mac', threadType: 'chat', provider: 'claude', firstMessage: 'again', title: 'alpha again' })
  const alphaCopies = (await projectsOf(mac)).filter((p) => p.name === 'alpha')
  check('a second start reuses the copy', typeof again === 'object' && alphaCopies.length === 1 && (await sessionsOf(mac)).find((s) => s.id === again.threadId.split(':')[1])?.projectId === macAlpha?.id, JSON.stringify(alphaCopies))
  const boxOnlyCaller = await rpc<Meta>(box, 'session.create', { provider: 'claude', projectId: boxOnlyProject.id, title: 'boxonly thread', threadType: 'chat', permission: 'auto' })
  const missing = await rpc<{ cwd: string; cwdNote?: string } | string>(box, 'app.startThread', { sessionId: boxOnlyCaller.id, environmentId: macId, threadType: 'chat', provider: 'claude', firstMessage: 'x' })
  check("a workspace mac has no checkout of starts in mac's work root and says so", typeof missing === 'object' && missing.cwd === mac.work && !!missing.cwdNote?.includes('no checkout'), JSON.stringify(missing))

  // ── 4. settings live on the box ───────────────────────────────────────
  await rpc(box, 'project.setPreamble', { projectId: boxProject.id, preamble: 'rules from the box', enabled: true })
  const followed = await until("mac's copy follows the box edit", 60_000, async () => (await projectsOf(mac)).find((p) => p.id === macProject.id)?.preamble === 'rules from the box')
  check("a settings edit on the box reaches mac's copy", followed)
  await rpc(mac, 'project.setPreamble', { projectId: macProject.id, preamble: 'rules from the mac', enabled: true })
  const onBox = (await projectsOf(box)).find((p) => p.id === boxProject.id)
  check('a mac edit of the linked project lands on the box', onBox?.preamble === 'rules from the mac', JSON.stringify(onBox))
  const onMac = (await projectsOf(mac)).find((p) => p.id === macProject.id)
  check("and mac's copy carries it too", onMac?.preamble === 'rules from the mac', JSON.stringify(onMac))
  const bundle = await rpc<{ name: string; preamble: string | null; updatedAt: number | null }>(mac, 'project.settings.get', { projectId: macProject.id })
  check('project.settings.get on mac answers the bundle with the stamp', bundle.preamble === 'rules from the mac' && typeof bundle.updatedAt === 'number', JSON.stringify(bundle))

  // ── 5. threads see each other ─────────────────────────────────────────
  const macThread = await rpc<Meta>(mac, 'session.create', { provider: 'claude', projectId: macProject.id, title: 'mac thread', threadType: 'chat', permission: 'auto' })
  await rpc(mac, 'session.send', {
    sessionId: macThread.id,
    text: 'look at @thread:' + `${boxId}:${alphaCaller.id}`,
    attachments: [{ kind: 'thread', path: `thread:${alphaCaller.id}`, name: 'alpha on the box', sessionId: alphaCaller.id, environmentId: boxId }]
  })
  const digested = await until('the foreign reference is resolved', 60_000, async () => {
    const rows = await eventsOf(mac, macThread.id)
    return rows.some((r) => r.event.type === 'user-text' && r.event.attachments?.some((a) => a.kind === 'thread' && a.environmentId === boxId))
  })
  check('a @thread: reference to a box thread rides the mac turn with its host', digested)
  const spawned = JSON.parse(await rpc<string>(box, 'app.spawnAgent', { sessionId: alphaCaller.id, environmentId: 'mac', provider: 'claude', agentType: 'explorer', task: 'look around\non the Mac' })) as { agentId?: string }
  const listed = JSON.parse(await rpc<string>(box, 'app.listAgents', { sessionId: alphaCaller.id })) as { agentId: string; host?: string }[]
  check('app.listAgents on the box names the child spawned on mac with its host', !!spawned.agentId && listed.some((a) => a.agentId === spawned.agentId && a.host === macId), JSON.stringify(listed))

  // ── 6. the box goes down: a mac edit is refused, nothing written ──────
  kill(box)
  const down = await until('mac sees the box link drop', 60_000, () => logOf(mac).includes('offline') || logOf(mac).includes('link down') || logOf(mac).includes('closed'))
  log(`box killed; link drop seen: ${down}`)
  const refused = await errorOf(rpc(mac, 'project.setPreamble', { projectId: macProject.id, preamble: 'while the box is down', enabled: true }))
  check('a mac edit with the box down is refused naming the host', refused.startsWith('refused: settings of') && refused.includes('live on box') && refused.includes('offline'), refused)
  const stillOnMac = (await projectsOf(mac)).find((p) => p.id === macProject.id)
  check('nothing was written on mac', stillOnMac?.preamble === 'rules from the mac', JSON.stringify(stillOnMac))
} catch (err) {
  check('the run completed', false, err instanceof Error ? err.message : String(err))
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
