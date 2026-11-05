/**
 * The orchestration rules agree on the Mac and the box, for real (docs/box.md
 * "Orchestration rules and thread defaults: one copy, on the box"): two
 * isolated headless instances of the BUILT tree, the rig of
 * scripts/e2e-linked-projects.ts ("mac" plays the Mac, "box" plays the box,
 * the settings home). Only mac serves Muse Code models
 * (TEMP_CODE_PROBED_CATALOG answers its probe), as on the real pair, where
 * Meta gives the box an empty catalog.
 *
 *  - mac saves box: the rules sync seeds the box's copy and the two hosts
 *    exchange catalogs
 *  - a rule set on mac for a model only mac runs (Muse Wonder Full) is
 *    stored on the box and reads back the same on both hosts
 *  - a box thread's spawn_agent table lists it under mac; spawned with no
 *    host it is refused naming `environmentId: "mac"`; with it, the box
 *    sends it to mac (before this fix the box refused it either way)
 *  - a rule set on the box reaches mac
 *  - mac restarted keeps both rules and still names the box as the home
 *  - with the box down a mac write is refused naming the box, nothing is
 *    written on mac, and rules.get says the home is offline (what the
 *    Orchestration page reads to turn its controls off)
 * Run: bun scripts/e2e-rules-sync.ts   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app, a real HOME, the real
 * Aliax vault, the gateway marker or the box's live temp-code.service.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_RS_KEEP === '1'
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
  const d = mkdtempSync(join(tmpdir(), 'tc-rules-sync-e2e-'))
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

const FULL = 'muse-wonder-full-1.0'
const museCatalog = join(root, 'mac-muse.json')
writeFileSync(
  museCatalog,
  JSON.stringify({
    muse: {
      label: 'Muse Code',
      defaultModel: 'muse-spark-1.3',
      models: [
        { id: 'muse-wonder-1.0', label: 'Muse Wonder 1.0', reasoning: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoning: 'max' },
        { id: FULL, label: 'Muse Wonder Full 1.0', reasoning: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoning: 'max' },
        { id: 'muse-spark-1.3', label: 'Muse Spark 1.3', reasoning: ['low', 'medium', 'high'], defaultReasoning: 'medium' }
      ]
    }
  })
)

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
    // Both run here; the seam makes the one that plays the Mac say so, so the box is the settings home.
    TEMP_CODE_BUILD_PLATFORM: inst.name === 'mac' ? 'darwin' : 'linux',
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: '/bin/bash'
  }
  if (inst.name === 'mac') env.TEMP_CODE_PROBED_CATALOG = museCatalog
  else env.TEMP_CODE_PROBED_CATALOG = join(root, 'box-muse.json')
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
// The box's probe answers an empty Muse list, as Meta answers the real box.
writeFileSync(join(root, 'box-muse.json'), JSON.stringify({ muse: { label: 'Muse Code', defaultModel: 'muse-spark-1.3', models: [] } }))

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
async function rpc<T = unknown>(inst: Inst, method: string, params: unknown = {}, timeoutMs = 120_000): Promise<T> {
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

interface Policy {
  approved: boolean | 'orchestrators'
  minReasoning?: string
  maxReasoning?: string
}
interface Rules {
  conduct: Record<string, unknown> & { maxParallel: number }
  models: Record<string, Policy>
  routing: unknown[]
}
interface RulesAnswer {
  rules: Rules
  overridden: boolean
  home?: { name: string; online: boolean } | null
}
const rulesOf = (inst: Inst): Promise<RulesAnswer> => rpc<RulesAnswer>(inst, 'rules.get', { workspaceId: null })

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
const cleanup = async (): Promise<void> => {
  await Promise.all([killHard(mac), killHard(box)])
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
  const macId = (await rpc<{ environmentId: string }>(mac, 'remote.status')).environmentId
  const boxId = (await rpc<{ environmentId: string }>(box, 'remote.status')).environmentId
  log(`mac ${macId}, box ${boxId} on :${box.remote}; logs ${mac.log} ${box.log}`)
  const served = await until("mac's probe answered its Muse rows", 30_000, async () => {
    const catalog = await rpc<{ muse?: { models: { id: string }[] } }>(mac, 'catalog.get')
    return !!catalog.muse?.models.some((m) => m.id === FULL)
  })
  check('mac serves Muse Wonder Full and the box serves no Muse row', served && !(await rpc<{ muse?: { models: unknown[] } }>(box, 'catalog.get')).muse?.models.length)

  // ── 1. pair: the box becomes the home ─────────────────────────────────
  const key = await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'mac (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  await rpc(mac, 'remote.environments.add', { url: `http://127.0.0.1:${box.remote}`, key: key.token, name: 'box' })
  const homed = await until("mac's rules follow the box", 60_000, async () => (await rulesOf(mac)).home?.name === 'box')
  check('rules.get on mac names the box as the home, online', homed && (await rulesOf(mac)).home?.online === true, JSON.stringify((await rulesOf(mac)).home))
  check('rules.get on the box names no home: its copy is the one', !(await rulesOf(box)).home)

  // ── 2. a rule for a model only mac runs, set on mac ───────────────────
  const base = (await rulesOf(mac)).rules
  const withFull: Rules = { ...base, models: { ...base.models, [`muse:${FULL}`]: { approved: true, minReasoning: 'low', maxReasoning: 'xhigh' } } }
  await rpc(mac, 'rules.set', { workspaceId: null, rules: withFull })
  const onBox = (await rulesOf(box)).rules.models[`muse:${FULL}`]
  check('the box stores the rule for a model its own catalog lacks', onBox?.approved === true && onBox.minReasoning === 'low' && onBox.maxReasoning === 'xhigh', JSON.stringify(onBox))
  const [m1, b1] = [await rulesOf(mac), await rulesOf(box)]
  check('the two hosts read the same rules', JSON.stringify(m1.rules) === JSON.stringify(b1.rules))

  // ── 3. a box thread reaches the model on mac ──────────────────────────
  const caller = await rpc<{ id: string }>(box, 'session.create', { provider: 'claude', title: 'council on the box', threadType: 'chat', permission: 'auto' })
  const pointed = await until('the box knows what mac runs', 60_000, async () => {
    const reply = await rpc<string>(box, 'app.spawnAgent', { sessionId: caller.id, model: FULL, agentType: 'reviewer', task: 'review', useWorktree: false })
    return reply.startsWith('refused:') && reply.includes('environmentId: "mac" to spawn it there')
  })
  check('spawned with no host, the box names the host that runs it', pointed)
  const there = await rpc<string>(box, 'app.spawnAgent', { sessionId: caller.id, model: FULL, reasoning: 'max', environmentId: 'mac', agentType: 'reviewer', task: 'review the diff', useWorktree: false })
  const accepted = !there.startsWith('refused')
  check('with environmentId "mac" the box sends it to mac', accepted, there.slice(0, 400))
  if (accepted) {
    const onMac = await until('the agent lands on mac', 30_000, async () =>
      (await rpc<{ provider: string; model: string; reasoning: string }[]>(mac, 'session.list')).some((s) => s.provider === 'muse' && s.model === FULL)
    )
    const row = (await rpc<{ provider: string; model: string; reasoning: string }[]>(mac, 'session.list')).find((s) => s.model === FULL)
    check("mac runs it on Muse Code, its effort held to the rule's highest", onMac && row?.reasoning === 'xhigh', JSON.stringify(row))
  }

  // ── 4. a rule set on the box reaches mac ──────────────────────────────
  const boxRules = (await rulesOf(box)).rules
  await rpc(box, 'rules.set', { workspaceId: null, rules: { ...boxRules, conduct: { ...boxRules.conduct, maxParallel: 8 } } })
  const followed = await until('mac follows the box edit', 60_000, async () => (await rulesOf(mac)).rules.conduct.maxParallel === 8)
  check('a box edit reaches mac', followed)

  // ── 5. mac restarted ──────────────────────────────────────────────────
  await killHard(mac)
  rmSync(join(mac.data, 'server.json'), { force: true })
  launch(mac)
  const back = await upOf(mac)
  const again = back ? await until('mac links up again', 60_000, async () => (await rulesOf(mac)).home?.online === true) : false
  const after = back ? await rulesOf(mac) : null
  check(
    'mac restarted keeps both rules and names the box as the home',
    again && after?.rules.conduct.maxParallel === 8 && after.rules.models[`muse:${FULL}`]?.approved === true,
    JSON.stringify(after?.home)
  )

  // ── 6. the box goes down ──────────────────────────────────────────────
  await killHard(box)
  const offline = await until('mac sees the box offline', 60_000, async () => (await rulesOf(mac)).home?.online === false)
  check('rules.get on mac says the home is offline', offline)
  const current = (await rulesOf(mac)).rules
  const refused = await errorOf(rpc(mac, 'rules.set', { workspaceId: null, rules: { ...current, conduct: { ...current.conduct, maxParallel: 16 } } }))
  check('a mac write with the box down is refused naming the box', refused.startsWith('refused:') && refused.includes('live on box') && refused.includes('offline'), refused)
  check('nothing was written on mac', (await rulesOf(mac)).rules.conduct.maxParallel === 8)
  check('no instance logged an uncaught error', !/Uncaught|unhandledRejection/.test(logOf(mac) + logOf(box)))
} catch (err) {
  check('the run completed', false, err instanceof Error ? err.message : String(err))
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
