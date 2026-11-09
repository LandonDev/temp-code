/**
 * Skills into the drivers, end to end (CLAUDE.md "Skills: written out on
 * every host"; plan-JBpcLz-eGMhp.md §9). One isolated headless instance of
 * the BUILT tree (out/main) with its own userData, tmp and remote port, real
 * CLIs, the host's accounts through its gateway (the merge-review rig: this
 * user's HOME so the CLIs can sign in), driven over its local socket:
 *
 *   1. a probe skill (global, every harness) written over skills.set says
 *      to answer one probe word; the instance's Claude scope pointer names a
 *      generation that holds it;
 *   2. Claude: a claude-haiku-5-5 chat answers the word, its Skill call names
 *      the skill with no prefix, and the CLI's CLAUDE_CONFIG_DIR is the
 *      owned root whose skills/<probe> resolves into the store;
 *   3. live: the skill rewritten, the same thread's next turn answers the
 *      new word;
 *   4. warm: with a warm Claude process waiting, a rewrite and a second
 *      thread: the pool adopts (no miss) and the reply has the newest word;
 *   5. Codex (the cheapest codex row, pinned to each codex account in turn
 *      past a 401 token_expired): the word, then a rewrite reaches the next
 *      turn. No codex CLI or no account that answers is `missing proof`,
 *      never a pass; the Mac's leg needs codex 0.164 or newer;
 *   6. Muse (where the catalog lists a Muse model; the box's is empty): a
 *      thread on an account (its `muse serve` reads the file backend) and
 *      one on the CLI's own login (on a vault with no Muse account), each
 *      answering the word and the rewrite;
 *   7. harness.status names no skill set;
 *   8. the skill removed, the threads archived, the instance's process
 *      group killed and then any process still carrying its userData.
 *
 * Nothing here writes into a home skill folder, runs against the person's
 * userData or touches the installed app.
 * Run: bun scripts/e2e-skills-drivers.ts [--host box|mac]   (build first: electron-vite build)
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_SD_KEEP === '1'
const hostArg = process.argv.indexOf('--host')
const HOST = (hostArg > 0 ? process.argv[hostArg + 1] : process.platform === 'darwin' ? 'mac' : 'box') as 'box' | 'mac'
let failures = 0
const missing: string[] = []
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const skip = (leg: string, why: string): void => console.log(`SKIP  ${leg}: ${why}`)
const missingProof = (leg: string, why: string): void => {
  missing.push(leg)
  console.log(`MISSING PROOF  ${leg}: ${why}`)
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

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tc-skills-drivers-')))
const data = join(root, 'data')
const tmp = join(root, 'tmp')
const work = join(root, 'work')
const emptyVault = join(root, 'empty-vault')
const logFile = join(root, 'app.log')
for (const d of [data, tmp, work, emptyVault]) mkdirSync(d, { recursive: true })
const SKILL = 'tc-e2e-probe'
const nonce = randomBytes(3).toString('hex')
const word = (n: number): string => `PROBE-N${n}-${nonce}`

// ── the instance ──────────────────────────────────────────────────────
let proc: ChildProcess | undefined
async function launch(extra: Record<string, string> = {}): Promise<void> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TMPDIR: tmp,
    TEMP_CODE_USER_DATA: data,
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_REMOTE_PORT: String(await freePort()),
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_WORK_ROOT: work,
    NODE_ENV: 'production',
    ...extra
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TEMP_CODE_DEBUG_PORT
  rmSync(join(data, 'server.json'), { force: true })
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  const argv =
    process.platform === 'linux'
      ? ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.']
      : [electron, '.']
  proc = spawn(argv[0], argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(logFile, c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(logFile, c))
}
const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(400)
  }
  log(`timed out: ${label}`)
  return false
}
const portOf = (): number => (JSON.parse(readFileSync(join(data, 'server.json'), 'utf8')) as { port: number }).port

/** One request on the instance's local socket (the implicit admin). */
async function rpc<T = unknown>(method: string, params: unknown = {}, timeoutMs = 180_000): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${portOf()}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close()
      fail(new Error(`no answer to ${method}`))
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
      fail(new Error(`socket error on ${method}`))
    })
  })
}

/** Stop the instance: its process group, then any process still carrying its userData. */
async function stop(): Promise<void> {
  if (proc?.pid) {
    try {
      process.kill(-proc.pid, 'SIGTERM')
    } catch {
      /* gone */
    }
  }
  await sleep(1500)
  if (proc?.pid) {
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  for (const pid of pidsCarrying(`TEMP_CODE_USER_DATA=${data}`)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  proc = undefined
}

// ── process environments: /proc on Linux, ps -Eww on the Mac ────────────
interface ProcEnv {
  pid: number
  command: string
  env: Map<string, string>
}
function processEnvs(): ProcEnv[] {
  if (process.platform === 'linux') {
    const out: ProcEnv[] = []
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try {
        const env = new Map<string, string>()
        for (const kv of readFileSync(`/proc/${name}/environ`, 'utf8').split('\0')) {
          const i = kv.indexOf('=')
          if (i > 0) env.set(kv.slice(0, i), kv.slice(i + 1))
        }
        out.push({ pid: Number(name), command: readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').join(' '), env })
      } catch {
        // gone, or another user's
      }
    }
    return out
  }
  // The Mac: `ps -Eww` prints each process's environment after its command line.
  const text = execFileSync('ps', ['-Eww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return text.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m) return []
    const env = new Map<string, string>()
    for (const kv of m[2].matchAll(/(?:^|\s)([A-Z_][A-Z0-9_]*)=(\S*)/g)) env.set(kv[1], kv[2])
    return [{ pid: Number(m[1]), command: m[2], env }]
  })
}
const pidsCarrying = (marker: string): number[] => {
  const [k, v] = [marker.slice(0, marker.indexOf('=')), marker.slice(marker.indexOf('=') + 1)]
  return processEnvs()
    .filter((p) => p.env.get(k) === v && p.pid !== process.pid)
    .map((p) => p.pid)
}
const ofInstance = (): ProcEnv[] => processEnvs().filter((p) => p.env.get('TEMP_CODE_USER_DATA') === data && p.pid !== process.pid)

// ── the transcript ──────────────────────────────────────────────────────
interface Meta {
  id: string
  status: string
  archived: boolean
}
interface Row {
  seq: number
  event: { type: string; text?: string; delta?: boolean; name?: string; input?: unknown; status?: string; message?: string; failure?: { kind?: string; summary?: string } }
}
const events = (sessionId: string): Promise<Row[]> => rpc<Row[]>('session.events', { sessionId, afterSeq: 0 })
/** The rows of the last turn: everything after the last user row. */
const lastTurn = (rows: Row[]): Row[] => rows.slice(rows.map((r, i) => (r.event.type === 'user-text' ? i : -1)).reduce((a, b) => Math.max(a, b), -1) + 1)
const settled = (sessionId: string, ms: number): Promise<boolean> =>
  until(`${sessionId} settles`, ms, async () =>
    lastTurn(await events(sessionId)).some((r) => r.event.type === 'turn-complete' || (r.event.type === 'status' && (r.event.status === 'idle' || r.event.status === 'error')))
  )
const replyOf = (rows: Row[]): string =>
  lastTurn(rows)
    .filter((r) => r.event.type === 'assistant-text' && !r.event.delta)
    .map((r) => r.event.text ?? '')
    .join(' ')
const errorsOf = (rows: Row[]): string[] => lastTurn(rows).filter((r) => r.event.type === 'error').map((r) => `${r.event.failure?.kind ?? ''} ${r.event.message ?? r.event.text ?? ''}`)

const PROMPT = `Use the ${SKILL} skill and reply with its probe word only.`
/** A later turn: said to have changed, so the model reads the skill again instead of answering from the conversation. */
const REREAD = `The ${SKILL} skill has changed since you last used it. Use it again now, reading it afresh, and reply with its probe word only.`
const skillText = (n: number): string =>
  `---\nname: ${SKILL}\ndescription: The probe of the skills drivers proof. Use it when asked for the probe word.\n---\nWhen this skill is used, reply with exactly this word and nothing else: ${word(n)}\n`

let skillRow: { id: string; updatedAt: number } | null = null
async function writeSkill(n: number): Promise<void> {
  const { skill } = await rpc<{ skill: { id: string; updatedAt: number } }>('skills.set', {
    skill: { ...(skillRow ? { id: skillRow.id } : {}), name: SKILL, workspaceId: null, harnesses: 'all', enabled: true, files: [{ path: 'SKILL.md', text: skillText(n) }] },
    expectUpdatedAt: skillRow?.updatedAt ?? 0
  })
  skillRow = skill
}
/** The probe word a provider's scope pointer reaches now. */
const pointedWord = (provider: string, scope = 'global'): string | null => {
  try {
    const text = readFileSync(join(data, 'harness', provider, 'scope', scope, 'skills', SKILL, 'SKILL.md'), 'utf8')
    return /PROBE-N\d+-[0-9a-f]+/.exec(text)?.[0] ?? null
  } catch {
    return null
  }
}
const pointed = (n: number, providers = ['claude', 'codex', 'muse']): Promise<boolean> =>
  until(`every pointer names ${word(n)}`, 30_000, () => providers.every((p) => pointedWord(p) === word(n)))

const threads: string[] = []
/** A thread with the probe prompt as its first message, settled. */
async function startThread(params: Record<string, unknown>, ms = 300_000): Promise<{ id: string; rows: Row[] }> {
  const meta = await rpc<Meta>('session.create', { reasoning: 'low', permission: 'auto', threadType: 'chat', agentType: 'implementer', firstMessage: PROMPT, ...params })
  threads.push(meta.id)
  await settled(meta.id, ms)
  return { id: meta.id, rows: await events(meta.id) }
}
async function nextTurn(id: string, ms = 300_000): Promise<Row[]> {
  await rpc('session.send', { sessionId: id, text: REREAD })
  await sleep(500)
  await settled(id, ms)
  return events(id)
}

interface WarmStatus {
  driver: string
  warm: unknown[]
  adopted: number
  misses: Record<string, number>
}
const claudeWarm = async (): Promise<WarmStatus | undefined> => (await rpc<WarmStatus[]>('harness.warm')).find((w) => w.driver === 'claude')
const missCount = (w: WarmStatus | undefined): number => Object.values(w?.misses ?? {}).reduce((a, b) => a + b, 0)

/** The login shell's answer to a command (null when it fails). */
const loginShell = (cmd: string): string | null => {
  try {
    return execFileSync(process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), ['-lc', cmd], { encoding: 'utf8', timeout: 20_000 }).trim()
  } catch {
    return null
  }
}

const cleanup = async (): Promise<void> => {
  try {
    if (skillRow) await rpc('skills.remove', { id: skillRow.id, expectUpdatedAt: skillRow.updatedAt }, 20_000)
    for (const id of threads) await rpc('session.archive', { sessionId: id, archived: true }, 20_000).catch(() => {})
  } catch {
    // the instance is gone already
  }
  await stop()
  if (!KEEP && failures === 0) rmSync(root, { recursive: true, force: true })
  else log(`left for inspection: ${root}`)
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))

try {
  console.log(`skills drivers proof on the ${HOST}, run ${nonce}; log ${logFile}`)
  await launch()
  if (!check('the headless instance published its local socket', await until('instance up', 120_000, () => existsSync(join(data, 'server.json'))))) {
    throw new Error(`no server.json; log ${logFile}`)
  }

  // ── 1. the probe skill, written out for every harness ───────────────
  await writeSkill(1)
  check('the probe skill is written out and every scope pointer reaches it', await pointed(1), ['claude', 'codex', 'muse'].map((p) => `${p}:${pointedWord(p)}`).join(' '))

  // ── 2. Claude ────────────────────────────────────────────────────────
  const claudeCwd = join(work, 'chat')
  mkdirSync(claudeCwd, { recursive: true })
  const claude = await startThread({ provider: 'claude', model: 'claude-haiku-5-5', cwd: claudeCwd, workspaceId: null, title: 'skills probe (claude)' })
  check('claude: the reply holds the probe word', replyOf(claude.rows).includes(word(1)), `${replyOf(claude.rows).slice(0, 200)} ${errorsOf(claude.rows).join(' | ')}`)
  // The streamed head of a call carries no input yet; the settled row does.
  const skillCalls = claude.rows.filter((r) => r.event.type === 'tool-call' && r.event.name === 'Skill' && r.event.input !== undefined).map((r) => JSON.stringify(r.event.input))
  check('claude: the Skill call names the skill by its bare name', skillCalls.some((c) => c.includes(`"${SKILL}"`)) && !skillCalls.some((c) => c.includes(`:${SKILL}`)), skillCalls.join(' | '))
  const cli = ofInstance().find((p) => p.env.has('CLAUDE_CONFIG_DIR') && /claude/.test(p.command))
  const configDir = cli?.env.get('CLAUDE_CONFIG_DIR')
  const ownedRoot = join(data, 'harness', 'claude-config', 'global')
  check('claude: the CLI runs under the owned root of its scope', configDir === ownedRoot, `${configDir} (pid ${cli?.pid})`)
  let resolved = ''
  try {
    resolved = realpathSync(join(ownedRoot, 'skills', SKILL))
  } catch {
    // checked below
  }
  check("claude: the owned root's skill resolves into the store", resolved.startsWith(realpathSync(join(data, 'harness', 'claude'))) && resolved.includes('/global@'), resolved)

  // ── 3. live: the next turn reads the rewrite ────────────────────────
  await writeSkill(2)
  await pointed(2)
  const second = await nextTurn(claude.id)
  check('claude: a rewrite reaches the same thread at its next turn', replyOf(second).includes(word(2)), `${replyOf(second).slice(0, 200)} ${errorsOf(second).join(' | ')}`)

  // ── 4. warm: a write churns no warm process ─────────────────────────
  const waiting = await until('a warm claude process waits', 60_000, async () => ((await claudeWarm())?.warm.length ?? 0) > 0)
  if (!waiting) {
    check('claude: a warm process of the thread\'s shape waits (warming needs this instance\'s own gateway route)', false, JSON.stringify(await claudeWarm()))
  } else {
    const before = await claudeWarm()
    await writeSkill(3)
    await pointed(3)
    const third = await startThread({ provider: 'claude', model: 'claude-haiku-5-5', cwd: claudeCwd, workspaceId: null, title: 'skills probe (warm)' })
    const after = await claudeWarm()
    check('claude: the second thread adopted the warm process, no miss', (after?.adopted ?? 0) === (before?.adopted ?? 0) + 1 && missCount(after) === missCount(before), `${JSON.stringify(before)} → ${JSON.stringify(after)}`)
    check('claude: the adopted process answers the newest word', replyOf(third.rows).includes(word(3)), `${replyOf(third.rows).slice(0, 200)} ${errorsOf(third.rows).join(' | ')}`)
  }
  let current = waiting ? 3 : 2

  // ── 5. Codex ─────────────────────────────────────────────────────────
  const codexVersion = loginShell('codex --version')
  const catalog = await rpc<Record<string, { models?: { id: string }[] }>>('catalog.get')
  const codexModels = (catalog.codex?.models ?? []).map((m) => m.id)
  const codexModel = ['gpt-5.6-luna', 'gpt-6-luna', 'gpt-5.3-codex-spark', 'gpt-6-astra'].find((m) => codexModels.includes(m)) ?? codexModels.at(-1)
  const accounts = await rpc<{ providers: Record<string, { profiles: { name: string }[] }> }>('accounts.list')
  const codexAccounts = (accounts.providers.codex?.profiles ?? []).map((p) => p.name)
  log(`codex: ${codexVersion ?? 'no CLI'}, model ${codexModel ?? 'none'}, ${codexAccounts.length} accounts`)
  if (!codexVersion) missingProof('codex', 'no codex CLI on the login PATH of this host')
  else if (!codexModel) missingProof('codex', 'the catalog lists no codex model')
  else if (codexAccounts.length === 0) missingProof('codex', 'no codex account on this host')
  else {
    const repo = join(work, 'codex-proj')
    mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'master', repo])
    writeFileSync(join(repo, 'README.md'), 'codex probe\n')
    const ws = await rpc<{ id: string }>('workspace.create', { path: repo, name: 'skills-probe' })
    const project = await rpc<{ id: string }>('project.create', { workspaceId: ws.id, name: 'Probe', mode: 'local' })
    let green = false
    for (const account of codexAccounts) {
      await rpc('project.setAccounts', { projectId: project.id, pins: { codex: account } })
      const t = await startThread({ provider: 'codex', model: codexModel, projectId: project.id, title: `skills probe (codex, ${account})` })
      const errs = errorsOf(t.rows)
      if (errs.some((e) => /token_expired|401/.test(e))) {
        log(`codex: ${account} answered 401 (a dev instance never refreshes codex tokens); next account`)
        continue
      }
      check(`codex (${account}): the reply holds the probe word`, replyOf(t.rows).includes(word(current)), `${replyOf(t.rows).slice(0, 200)} ${errs.join(' | ')}`)
      current++
      await writeSkill(current)
      await pointed(current)
      const next = await nextTurn(t.id)
      green = check(`codex (${account}): a rewrite reaches the next turn of the same thread`, replyOf(next).includes(word(current)), `${replyOf(next).slice(0, 200)} ${errorsOf(next).join(' | ')}`) && replyOf(t.rows).includes(word(current - 1))
      break
    }
    if (!green && failures === 0) missingProof('codex', 'every codex account answered 401 token_expired')
    const [major, minor] = (/(\d+)\.(\d+)/.exec(codexVersion) ?? []).slice(1).map(Number)
    if (green && HOST === 'mac') check('codex: the Mac leg ran on codex 0.164 or newer', major > 0 || minor >= 164, codexVersion)
  }

  // ── 6. Muse ──────────────────────────────────────────────────────────
  const museModels = (catalog.muse?.models ?? []).map((m) => m.id)
  const museModel = ['muse-spark-1.3', 'muse-wonder-1.0'].find((m) => museModels.includes(m)) ?? museModels[0]
  const museAccounts = (accounts.providers.muse?.profiles ?? []).map((p) => p.name)
  const museLeg = async (label: string, expectFile: boolean): Promise<void> => {
    const cwd = join(work, `muse-${label}`)
    mkdirSync(cwd, { recursive: true })
    const t = await startThread({ provider: 'muse', model: museModel, cwd, workspaceId: null, title: `skills probe (muse, ${label})` })
    check(`muse (${label}): the reply holds the probe word`, replyOf(t.rows).includes(word(current)), `${replyOf(t.rows).slice(0, 200)} ${errorsOf(t.rows).join(' | ')}`)
    const serve = ofInstance().find((p) => /muse/.test(p.command) && / serve/.test(p.command))
    const xdg = serve?.env.get('XDG_CONFIG_HOME') ?? ''
    check(`muse (${label}): \`muse serve\` runs under its ${expectFile ? 'account' : 'own'} dir${expectFile ? ' with the file backend' : ''}`, xdg.includes(`muse-accounts/${expectFile ? 'accounts' : 'own'}/`) && (serve?.env.get('TBH_CREDENTIAL_BACKEND') === 'file') === expectFile, `${xdg} ${serve?.env.get('TBH_CREDENTIAL_BACKEND')}`)
    current++
    await writeSkill(current)
    await pointed(current)
    const next = await nextTurn(t.id)
    check(`muse (${label}): a rewrite reaches the next turn of the same thread`, replyOf(next).includes(word(current)), `${replyOf(next).slice(0, 200)} ${errorsOf(next).join(' | ')}`)
  }
  if (!museModel) skip('muse', HOST === 'box' ? 'Meta serves this host an empty catalog (docs/box.md "Muse Code on the box")' : 'the catalog lists no Muse model')
  else if (!loginShell('muse --version')) skip('muse', 'no muse CLI on the login PATH')
  else {
    if (museAccounts.length) await museLeg('account', true)
    else skip('muse (account)', 'this host holds no Muse account')
    // The own dir: a vault with no Muse account, so the thread runs on the CLI's own login.
    if (museAccounts.length) {
      await stop()
      await launch({ TEMP_CODE_ALIAX_DATA_DIR: emptyVault })
      await until('instance up again', 120_000, () => existsSync(join(data, 'server.json')))
    }
    await museLeg('own', false)
  }

  // ── 7. harness sync carries no skill set ────────────────────────────
  const hs = await rpc<{ environments: { sets: Record<string, number> | null }[] }>('harness.status')
  check('harness.status names no skill set', hs.environments.every((e) => !Object.keys(e.sets ?? {}).some((k) => /skills/i.test(k))), JSON.stringify(hs.environments.map((e) => e.sets)))
} catch (err) {
  console.error('ERROR', err instanceof Error ? err.message : err)
  failures++
} finally {
  await cleanup()
}
const left = pidsCarrying(`TEMP_CODE_USER_DATA=${data}`)
check('nothing of the instance is left running', left.length === 0, left.join(','))
console.log(failures === 0 ? (missing.length ? `\nPASS with missing proof: ${missing.join(', ')}` : '\nALL PASS') : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
