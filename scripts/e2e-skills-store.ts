/**
 * The skills store core for real (CLAUDE.md "Skills: written out on every
 * host"): two isolated headless instances of the BUILT tree on the rig of
 * scripts/e2e-rules-sync.ts. "mac" is darwin by TEMP_CODE_BUILD_PLATFORM and
 * starts with a HOME full of skills; "box" is linux and the settings home.
 *
 *  1. mac imports its four skill roots at boot: copies merged, the newer of
 *     two different copies kept, a native binary and the binary cache left
 *     out, a folder with no SKILL.md and Claude's synced bucket passed over
 *  2. paired, the box holds the same rows, ids and digests (the seed)
 *  3. both hosts write each provider's view out behind a symlink; a skill's
 *     own install path and, once memory sync has run, the Mac's checkout
 *     path are rewritten for the host
 *  4. a box thread writes a new skill with no card; both hosts write it out
 *  5. a rewrite swaps the view atomically under a reader polling every 2 ms;
 *     the unchanged skills keep their inodes
 *  6. rewriting the imported skill raises the card with what changed: a
 *     denial leaves it, an allow writes v2 on both hosts
 *  7. the slash menu lists the store's skill from its written-out folder
 *  8. a removal leaves both hosts' rows and generations
 *  9. mac restarted imports nothing again and reuses its generations
 * 10. no instance logged an uncaught error
 * Run: bun scripts/e2e-skills-store.ts   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app, a real HOME, the real
 * Aliax vault, the gateway marker or the box's live temp-code.service.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_SS_KEEP === '1'
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
  const d = mkdtempSync(join(tmpdir(), 'tc-skills-store-e2e-'))
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

// ── mac's HOME before it starts ─────────────────────────────────────────
const md = (name: string, body = ''): string => `---\nname: ${name}\ndescription: Use ${name}.\n---\n${body}`
const T = Math.floor(Date.now() / 1000) - 3600
const put = (rel: string, content: string | Uint8Array, opts: { age?: number; mode?: number } = {}): void => {
  const path = join(mac.home, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  if (opts.mode) chmodSync(path, opts.mode)
  utimesSync(path, T + (opts.age ?? 0), T + (opts.age ?? 0))
}
put('.claude/skills/alpha/SKILL.md', md('alpha', `Work in ${mac.home}/IdeaProjects/x, then run ~/.claude/skills/alpha/scripts/run.sh.\n`))
put('.claude/skills/alpha/scripts/run.sh', '#!/bin/sh\necho alpha\n', { mode: 0o755 })
put('.agents/skills/beta/SKILL.md', md('beta', 'Shared.\n'))
put('.codex/skills/beta/SKILL.md', md('beta', 'Shared.\n'))
put('.claude/skills/gamma/SKILL.md', md('gamma', 'The older words.\n'), { age: 0 })
put('.agents/skills/gamma/SKILL.md', md('gamma', 'The newer words.\n'), { age: 600 })
put('.claude/skills/delta-bin/SKILL.md', md('delta-bin'))
put('.claude/skills/delta-bin/scripts/bin/linux-x64/tool', 'a cached binary')
put('.claude/skills/delta-bin/tool-mac', Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]))
put('.claude/skills/nosk/notes.md', 'no skill file here')
put('.claude/skills/synced/b/x', 'the CLI\'s own bucket')
put('.config/muse/skills/mu/SKILL.md', md('mu'))

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

let rpcSeq = 0
/** One request on the instance's local socket (the implicit admin). */
async function rpc<T = unknown>(inst: Inst, method: string, params: unknown = {}, timeoutMs = 120_000): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${portOf(inst)}/`)
  const id = `e2e-${++rpcSeq}`
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close()
      fail(new Error(`${inst.name}: no answer to ${method}`))
    }, timeoutMs)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id, method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== id) return
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

interface Skill {
  id: string
  name: string
  workspaceId: string | null
  harnesses: 'all' | string[]
  version: number
  digest: string
  description: string
  writtenBy: { kind: string }
}
const listOf = async (inst: Inst): Promise<Skill[]> => (await rpc<{ skills: Skill[] }>(inst, 'skills.list')).skills
const byName = async (inst: Inst, name: string): Promise<Skill | undefined> => (await listOf(inst)).find((s) => s.name === name && s.workspaceId === null)

/** `<data>/harness/<provider>/<view>`: the symlink, the generation it names, and that generation's folder. */
const viewOf = (inst: Inst, provider: string, view = 'global') => {
  const link = join(inst.data, 'harness', provider, view)
  const gen = existsSync(link) && lstatSync(link).isSymbolicLink() ? readlinkSync(link) : null
  return { link, gen, dir: gen ? join(inst.data, 'harness', provider, gen) : null }
}
const skillsIn = (inst: Inst, provider: string): string[] => {
  const v = viewOf(inst, provider)
  return v.dir && existsSync(join(v.dir, 'skills')) ? readdirSync(join(v.dir, 'skills')).sort() : []
}
const leftovers = (inst: Inst): string[] =>
  ['claude', 'codex', 'muse'].flatMap((p) => (existsSync(join(inst.data, 'harness', p)) ? readdirSync(join(inst.data, 'harness', p)).filter((n) => /\.(tmp|lnk)-/.test(n)) : []))

interface Row {
  seq: number
  event: { type: string; requestId?: string; title?: string; toolName?: string; input?: Record<string, unknown> }
}
const rowsOf = async (inst: Inst, sessionId: string): Promise<Row[]> => {
  const page = await rpc<Row[] | { rows: Row[] }>(inst, 'session.events', { sessionId })
  return Array.isArray(page) ? page : page.rows
}
/** The newest approval card titled `title` on the thread that is not one of `seen`. */
const cardOn = async (inst: Inst, sessionId: string, title: string, seen: Set<string>): Promise<Row['event'] | null> => {
  const rows = await rowsOf(inst, sessionId)
  return rows.map((r) => r.event).find((e) => e.type === 'approval-request' && e.title === title && !seen.has(String(e.requestId))) ?? null
}

function kill(inst: Inst): void {
  if (!inst.proc?.pid) return
  try {
    process.kill(-inst.proc.pid, 'SIGTERM')
  } catch {
    /* gone */
  }
}
const killHard = async (inst: Inst): Promise<void> => {
  kill(inst)
  await sleep(1500)
  try {
    if (inst.proc?.pid) process.kill(-inst.proc.pid, 'SIGKILL')
  } catch {
    /* gone */
  }
}
/** Electron children can outlive their group: anything still carrying this run's userData goes too. */
function killStragglers(): void {
  for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      if (readFileSync(`/proc/${pid}/environ`, 'utf8').includes(`TEMP_CODE_USER_DATA=${root}/`)) process.kill(Number(pid), 'SIGKILL')
    } catch {
      /* not ours, or gone */
    }
  }
}
const cleanup = async (): Promise<void> => {
  await Promise.all([killHard(mac), killHard(box)])
  if (process.platform === 'linux') killStragglers()
  if (!KEEP && failures === 0) rmSync(root, { recursive: true, force: true })
  else log(`left for inspection: ${root}`)
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))

const upOf = (inst: Inst): Promise<boolean> => until(`${inst.name} up`, 90_000, () => existsSync(join(inst.data, 'server.json')))

launch(mac)
launch(box)
try {
  const up = (await upOf(mac)) && (await upOf(box))
  if (!check('both headless instances published their local socket', up)) throw new Error(`no server.json; logs ${mac.log} ${box.log}`)
  log(`logs ${mac.log} ${box.log}`)

  // ── 1. the import ──────────────────────────────────────────────────────
  const imported = await until("mac's import", 30_000, async () => (await listOf(mac)).length >= 5)
  const macRows = await listOf(mac)
  const named = Object.fromEntries(macRows.map((s) => [s.name, s]))
  check('mac imported alpha, beta, gamma, delta-bin and mu, and nothing else', imported && JSON.stringify(Object.keys(named).sort()) === JSON.stringify(['alpha', 'beta', 'delta-bin', 'gamma', 'mu']), Object.keys(named).join(', '))
  check('beta, in .agents and .codex alike, runs on Claude and Codex', JSON.stringify(named.beta?.harnesses) === '["claude","codex"]', JSON.stringify(named.beta?.harnesses))
  check('mu runs on Muse; alpha on Claude', JSON.stringify(named.mu?.harnesses) === '["muse"]' && JSON.stringify(named.alpha?.harnesses) === '["claude"]')
  check('every row is an import', macRows.every((s) => s.writtenBy.kind === 'import'))
  const gamma = named.gamma ? await rpc<{ skill: { files: { path: string; text?: string }[] } }>(mac, 'skills.get', { id: named.gamma.id }) : null
  check('gamma kept the newer of its two copies', !!gamma?.skill.files.find((f) => f.path === 'SKILL.md')?.text?.includes('The newer words.'))
  const delta = named['delta-bin'] ? await rpc<{ skill: { files: { path: string }[] } }>(mac, 'skills.get', { id: named['delta-bin'].id }) : null
  check('delta-bin came without its binary cache or its Mach-O file', JSON.stringify(delta?.skill.files.map((f) => f.path)) === '["SKILL.md"]', JSON.stringify(delta?.skill.files.map((f) => f.path)))

  // ── 2. pair: the box becomes the home and takes the seed ───────────────
  const key = await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'mac (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  await rpc(mac, 'remote.environments.add', { url: `http://127.0.0.1:${box.remote}`, key: key.token, name: 'box' })
  const fingerprint = (rows: Skill[]): string => JSON.stringify(rows.map((s) => [s.name, s.id, s.digest]).sort())
  const seeded = await until('the box holds the seed', 60_000, async () => fingerprint(await listOf(box)) === fingerprint(await listOf(mac)))
  check("the box's rows are mac's: the same names, ids and digests", seeded, fingerprint(await listOf(box)))

  // ── 3. written out on both hosts ──────────────────────────────────────
  for (const inst of [mac, box]) {
    const written = await until(`${inst.name} writes alpha out`, 30_000, () => skillsIn(inst, 'claude').includes('alpha'))
    const claude = viewOf(inst, 'claude')
    check(`${inst.name}: claude/global is a symlink to a generation holding alpha`, written && /^global@[0-9a-f]{12}$/.test(claude.gen ?? ''), String(claude.gen))
    check(`${inst.name}: codex/global holds beta and not mu; muse/global holds mu`, skillsIn(inst, 'codex').includes('beta') && !skillsIn(inst, 'codex').includes('mu') && JSON.stringify(skillsIn(inst, 'muse')) === '["mu"]')
  }
  await rpc(mac, 'memory.sync', {})
  const alphaText = (inst: Inst): string => {
    const v = viewOf(inst, 'claude')
    return v.dir ? readFileSync(join(v.dir, 'skills/alpha/SKILL.md'), 'utf8') : ''
  }
  const mapped = await until("the box rewrites the Mac's checkout path", 60_000, () => alphaText(box).includes(`${box.work}/x`))
  check("on the box, alpha's text names the box's work root once memory sync has run", mapped, alphaText(box))
  for (const inst of [mac, box]) {
    const own = join(inst.data, 'harness/claude/global/skills/alpha/scripts/run.sh')
    check(`${inst.name}: alpha's own install path names the view's folder`, alphaText(inst).includes(own) && existsSync(own), alphaText(inst))
  }

  // ── 4. a new skill from a box thread ──────────────────────────────────
  const thread = await rpc<{ id: string }>(box, 'session.create', { provider: 'claude', title: 'skills on the box', threadType: 'chat', permission: 'auto' })
  const before = viewOf(box, 'claude').gen
  const wrote = await rpc<string>(box, 'app.skillWrite', { sessionId: thread.id, name: 'epsilon', scope: 'global', files: [{ path: 'SKILL.md', text: md('epsilon', 'one\n') }] })
  check('the thread writes epsilon with no card', wrote.startsWith('wrote epsilon v1') && !(await rowsOf(box, thread.id)).some((r) => r.event.type === 'approval-request'), wrote)
  check('a new box generation holds it, the previous one still on disk', skillsIn(box, 'claude').includes('epsilon') && viewOf(box, 'claude').gen !== before && existsSync(join(box.data, 'harness/claude', String(before))))
  check("mac's follow writes it out too", await until('mac writes epsilon out', 60_000, () => skillsIn(mac, 'claude').includes('epsilon')))

  // ── 5. an atomic rewrite under a reader ───────────────────────────────
  const old = viewOf(box, 'claude')
  const reads: string[] = []
  const epsilon = join(box.data, 'harness/claude/global/skills/epsilon/SKILL.md')
  const reader = setInterval(() => {
    try {
      reads.push(readFileSync(epsilon, 'utf8'))
    } catch (err) {
      reads.push(`<${(err as NodeJS.ErrnoException).code}>`)
    }
  }, 2)
  const started = Date.now()
  const rewrote = await rpc<string>(box, 'app.skillWrite', { sessionId: thread.id, name: 'epsilon', scope: 'global', files: [{ path: 'SKILL.md', text: md('epsilon', 'two\n') }] })
  await sleep(Math.max(0, 2000 - (Date.now() - started)))
  clearInterval(reader)
  const [one, two] = [md('epsilon', 'one\n'), md('epsilon', 'two\n')]
  check('the rewrite lands', rewrote.startsWith('wrote epsilon v2'), rewrote)
  check(`every one of ${reads.length} reads through the view was the old text or the new, never missing or partial`, reads.length > 100 && reads.every((r) => r === one || r === two) && reads.at(-1) === two, [...new Set(reads)].slice(0, 3).join(' | '))
  check('no tmp folder or link is left', leftovers(box).length === 0, leftovers(box).join(', '))
  const now = viewOf(box, 'claude')
  check('the unchanged alpha shares its inode across the two generations', !!old.dir && !!now.dir && old.dir !== now.dir && statSync(join(old.dir, 'skills/alpha/SKILL.md')).ino === statSync(join(now.dir!, 'skills/alpha/SKILL.md')).ino)

  // ── 6. the card over the imported alpha ───────────────────────────────
  const alphaBefore = await byName(box, 'alpha')
  const next = [
    { path: 'SKILL.md', text: md('alpha', 'Rewritten by the box thread.\n') },
    { path: 'scripts/run.sh', text: '#!/bin/sh\necho alpha\n', executable: true }
  ]
  const seen = new Set<string>()
  const ask = async (allow: boolean): Promise<string> => {
    const answer = rpc<string>(box, 'app.skillWrite', { sessionId: thread.id, name: 'alpha', scope: 'global', files: next }, 360_000)
    let card: Row['event'] | null = null
    await until('the card', 30_000, async () => !!(card = await cardOn(box, thread.id, 'Change the skill alpha', seen)))
    if (!card) return '(no card)'
    const shown = card as Row['event']
    seen.add(String(shown.requestId))
    check(`the card carries what changed (${allow ? 'allow' : 'deny'})`, typeof shown.input?.changes === 'string' && String(shown.input.changes).includes('SKILL.md changed'), JSON.stringify(shown.input))
    await rpc(box, 'session.approve', { sessionId: thread.id, requestId: shown.requestId, allow })
    return answer
  }
  const denied = await ask(false)
  check('a denial answers that the person declined', denied.startsWith('refused: the person declined'), denied)
  check('alpha keeps its digest on both hosts', (await byName(box, 'alpha'))?.digest === alphaBefore?.digest && (await byName(mac, 'alpha'))?.digest === alphaBefore?.digest)
  const allowed = await ask(true)
  check('an allow writes alpha v2', allowed.startsWith('wrote alpha v2'), allowed)
  check('mac follows alpha to v2', await until('mac at v2', 60_000, async () => (await byName(mac, 'alpha'))?.version === 2))

  // ── 7. the slash menu ─────────────────────────────────────────────────
  const commands = await rpc<{ name: string; path?: string }[]>(box, 'commands.list', { provider: 'claude', cwd: box.work })
  const listed = commands.find((c) => c.name === 'epsilon')
  check("the box's slash menu lists epsilon from the written-out folder", !!listed?.path?.startsWith(join(box.data, 'harness/claude/global@')), JSON.stringify(listed))

  // ── 8. a removal ──────────────────────────────────────────────────────
  const removed = await rpc<string>(box, 'app.skillRemove', { sessionId: thread.id, name: 'epsilon', scope: 'global' })
  check('the thread removes its own skill with no card', removed === 'removed epsilon from every workspace', removed)
  check('gone from the box', !(await byName(box, 'epsilon')) && !skillsIn(box, 'claude').includes('epsilon'))
  check('gone from mac', await until('mac drops epsilon', 60_000, async () => !(await byName(mac, 'epsilon')) && !skillsIn(mac, 'claude').includes('epsilon')))

  // ── 9. mac restarted ──────────────────────────────────────────────────
  const rowsBefore = fingerprint(await listOf(mac))
  const gens = ['claude', 'codex', 'muse'].map((p) => viewOf(mac, p)).map((v) => ({ gen: v.gen, mtime: v.dir ? statSync(v.dir).mtimeMs : 0 }))
  await killHard(mac)
  rmSync(join(mac.data, 'server.json'), { force: true })
  launch(mac)
  const back = await upOf(mac)
  const linked = back ? await until('mac links up again', 60_000, async () => (await rpc<{ home?: { online: boolean } | null }>(mac, 'skills.list')).home?.online === true) : false
  await sleep(3000)
  check('mac restarted imports nothing again', linked && fingerprint(await listOf(mac)) === rowsBefore)
  const gensAfter = ['claude', 'codex', 'muse'].map((p) => viewOf(mac, p)).map((v) => ({ gen: v.gen, mtime: v.dir ? statSync(v.dir).mtimeMs : 0 }))
  check('and reuses its generations, untouched', JSON.stringify(gensAfter) === JSON.stringify(gens), `${JSON.stringify(gens)} → ${JSON.stringify(gensAfter)}`)

  // ── 10. clean logs ────────────────────────────────────────────────────
  check('no instance logged an uncaught error', !/Uncaught|unhandledRejection/.test(logOf(mac) + logOf(box)))
} catch (err) {
  check('the run completed', false, err instanceof Error ? err.message : String(err))
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
