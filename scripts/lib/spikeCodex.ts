/**
 * The Codex experiments of the config-dir spike (X0–X5): `codex app-server`
 * under a temp `CODEX_HOME` with the placeholder login, its sampling calls
 * sent to the fake Responses front over https (trusted through
 * `CODEX_CA_CERTIFICATE`, as the app does), set the way the driver sets them
 * (`chatgpt_base_url` in `thread/start`'s config).
 */
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { codexFrontPath, makeNonces, placeholderCodexAuth, skillFile } from './configDirSpike'
import {
  baseEnv,
  ctx,
  errText,
  firstLine,
  gitInit,
  inventory,
  isProbeName,
  judge,
  mkRun,
  noteEnv,
  skip,
  uniq,
  type Evidence,
  type Experiment,
  type RunDirs
} from './spikeContext'
import { listTree, run, sleep, spawnTracked, within, writeTree, type ResponsesRequestRecord } from './spikeFakes'
import type { ChildProcess } from 'node:child_process'

const CODEX_STRIP = /^(CODEX_|OPENAI_)/
const CLIENT = { name: 'temp_code_spike', title: 'temp-code spike', version: '0.0.1' }

interface Note {
  method: string
  params: Record<string, unknown>
}

/** One `codex app-server`, newline JSON-RPC. Approvals are accepted; anything else the server asks is refused. */
class CodexConn {
  proc: ChildProcess
  notes: Note[] = []
  serverRequests: string[] = []
  stderr: string[] = []
  exited: number | null | undefined = undefined
  private pending = new Map<number, { ok: (v: unknown) => void; bad: (e: Error) => void }>()
  private next = 1

  constructor(env: Record<string, string | undefined>, cwd: string) {
    this.proc = spawnTracked(ctx().codexBin!, ['app-server'], { env, cwd })
    createInterface({ input: this.proc.stdout! }).on('line', (line) => {
      let m: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }
      try {
        m = JSON.parse(line)
      } catch {
        return
      }
      if (m.id !== undefined && m.method) {
        this.serverRequests.push(m.method)
        if (m.method.endsWith('requestApproval') || m.method === 'execCommandApproval' || m.method === 'applyPatchApproval') this.write({ jsonrpc: '2.0', id: m.id, result: { decision: 'accept' } })
        else this.write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'the spike does not answer this' } })
      } else if (m.id !== undefined) {
        const p = this.pending.get(Number(m.id))
        if (!p) return
        this.pending.delete(Number(m.id))
        if (m.error) p.bad(new Error(m.error.message ?? 'app-server error'))
        else p.ok(m.result)
      } else if (m.method) this.notes.push({ method: m.method, params: m.params ?? {} })
    })
    createInterface({ input: this.proc.stderr! }).on('line', (l) => {
      if (!l.trim()) return
      this.stderr.push(l.slice(0, 300))
      this.stderr.splice(0, Math.max(0, this.stderr.length - 30))
    })
    this.proc.on('error', () => undefined)
    this.proc.on('exit', (code) => {
      this.exited = code
      for (const p of this.pending.values()) p.bad(new Error(`app-server exited ${code}${this.stderr.length ? `: ${this.stderr.slice(-2).join(' | ')}` : ''}`))
      this.pending.clear()
    })
  }

  private write(m: unknown): void {
    try {
      this.proc.stdin?.write(`${JSON.stringify(m)}\n`)
    } catch {
      // gone
    }
  }

  request<T = Record<string, unknown>>(method: string, params: unknown = {}, ms = 30_000): Promise<T> {
    const id = this.next++
    const p = new Promise<T>((ok, bad) => this.pending.set(id, { ok: ok as (v: unknown) => void, bad }))
    this.write({ jsonrpc: '2.0', id, method, params })
    return within(p, ms, method)
  }

  async waitNote(pred: (n: Note) => boolean, from: number, ms: number): Promise<Note | null> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const hit = this.notes.slice(from).find(pred)
      if (hit) return hit
      if (this.exited !== undefined) return null
      await sleep(100)
    }
    return null
  }

  close(): void {
    if (this.proc.exitCode === null) this.proc.kill('SIGTERM')
  }
}

/** The environment of a codex run: the inherited one less every CODEX_ and OPENAI_ variable, then `set`. */
function codexEnv(ev: Evidence, r: RunDirs, home: string, set: Record<string, string> = {}): Record<string, string | undefined> {
  const own = { HOME: r.home, CODEX_HOME: home, CODEX_CA_CERTIFICATE: ctx().caPath, ...set }
  noteEnv(ev, own)
  return { ...baseEnv(CODEX_STRIP), ...own }
}

/** An owned home with the placeholder login. */
function codexHome(dir: string, files: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true })
  writeTree(dir, { 'auth.json': placeholderCodexAuth(), ...files })
  return dir
}

async function open(ev: Evidence, r: RunDirs, home: string): Promise<CodexConn> {
  const c = new CodexConn(codexEnv(ev, r, home), r.cwd)
  ev.cli = { path: ctx().codexBin, version: ev.cli?.version ?? null }
  ev.argv = ['app-server']
  await c.request('initialize', { clientInfo: CLIENT })
  return c
}

const threadParams = (cwd: string, model: string): Record<string, unknown> => ({
  cwd,
  model,
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
  config: { chatgpt_base_url: `${ctx().codexFront.url}/backend-api/`, features: { multi_agent: false, multi_agent_v2: false } }
})

async function startThread(c: CodexConn, cwd: string): Promise<string> {
  const res = await c.request<{ thread?: { id?: string } }>('thread/start', threadParams(cwd, await codexModel()))
  if (!res.thread?.id) throw new Error('thread/start gave no thread id')
  return res.thread.id
}

interface TurnOutcome {
  completed: boolean
  status: string | null
  error: string | null
  text: string
  requests: ResponsesRequestRecord[]
}

async function turn(c: CodexConn, threadId: string, input: unknown[], ms = 90_000): Promise<TurnOutcome> {
  const front = ctx().codexFront
  const mark = front.requests.length
  const from = c.notes.length
  try {
    await c.request('turn/start', { threadId, input, effort: 'low' }, 60_000)
  } catch (e) {
    return { completed: false, status: null, error: errText(e), text: '', requests: front.since(mark) }
  }
  const end = await c.waitNote((n) => n.method === 'turn/completed', from, ms)
  const notes = c.notes.slice(from)
  const text = notes
    .filter((n) => n.method === 'item/completed' && (n.params.item as { type?: string } | undefined)?.type === 'agentMessage')
    .map((n) => String((n.params.item as { text?: string }).text ?? ''))
    .join(' ')
  const errors = notes.filter((n) => n.method === 'error').map((n) => firstLine(JSON.stringify(n.params)))
  const turnInfo = (end?.params.turn ?? {}) as { status?: string; error?: unknown }
  return { completed: !!end, status: turnInfo.status ?? null, error: errors[0] ?? (turnInfo.error ? firstLine(JSON.stringify(turnInfo.error)) : null), text: text.slice(0, 200), requests: front.since(mark) }
}

const text = (s: string): unknown[] => [{ type: 'text', text: s, text_elements: [] }]

function reqSummary(reqs: ResponsesRequestRecord[]): Record<string, unknown> & { all: string[]; last: string[] } {
  const main = reqs.filter((r) => r.main)
  return {
    requests: reqs.length,
    paths: uniq(reqs.map((r) => `${r.method} ${r.path}`)),
    bearer: uniq(reqs.map((r) => r.bearer)),
    accountId: uniq(reqs.map((r) => r.accountId)),
    answered: main.map((r) => r.answered),
    all: uniq(main.flatMap((r) => [...r.hits.instructions, ...r.hits.input, ...r.hits.tools])).sort(),
    last: uniq(main.flatMap((r) => r.hits.last)).sort()
  }
}

/** Skill names out of a skills/list answer, whatever its nesting. */
function skillNames(res: unknown): string[] {
  const names: string[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o.name === 'string' && typeof o.path === 'string') names.push(o.name)
      Object.values(o).forEach(walk)
    }
  }
  walk(res)
  return uniq(names).sort()
}

let modelCache: string | null = null
/** A model the catalog lists, the smallest one when it names one. */
async function codexModel(): Promise<string> {
  if (modelCache) return modelCache
  const c = ctx()
  if (c.codexModel) return (modelCache = c.codexModel)
  const r = mkRun('codex-model')
  const ev = { env: {}, unset: [] } as unknown as Evidence
  const conn = new CodexConn(codexEnv(ev, r, codexHome(join(r.dir, 'home-codex'))), r.cwd)
  try {
    await conn.request('initialize', { clientInfo: CLIENT })
    const res = await conn.request<{ data?: { model?: string; id?: string }[] }>('model/list', {})
    const ids = (res.data ?? []).map((m) => m.model ?? m.id ?? '').filter(Boolean)
    modelCache = ids.find((x) => /mini/.test(x)) ?? ids.find((x) => /spark/.test(x)) ?? ids[0] ?? 'gpt-5.5'
  } finally {
    conn.close()
  }
  return modelCache
}

// ── experiments ──────────────────────────────────────────────────────────────

async function x0(ev: Evidence): Promise<void> {
  const c = ctx()
  const bin = c.codexBin!
  const version = await run(bin, ['--version'], { timeoutMs: 30_000 })
  const help = await run(bin, ['app-server', '--help'], { timeoutMs: 30_000 })
  const out = join(c.root, ev.id, 'schema')
  mkdirSync(out, { recursive: true })
  const gen = await run(bin, ['app-server', 'generate-json-schema', '--out', out], { timeoutMs: 60_000 })
  ev.cli = { path: bin, version: firstLine(version.stdout) }
  ev.commands = ['codex --version', 'codex app-server --help', `codex app-server generate-json-schema --out ${out}`]
  const methods: string[] = []
  const keys = new Set<string>()
  const clientReq = join(out, 'ClientRequest.json')
  if (existsSync(clientReq)) {
    const doc = JSON.parse(await Bun.file(clientReq).text()) as { oneOf?: { properties?: { method?: { enum?: string[]; const?: string } } }[] }
    for (const v of doc.oneOf ?? []) methods.push(...(v.properties?.method?.enum ?? (v.properties?.method?.const ? [v.properties.method.const] : [])))
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk)
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (/skill|prompt|plugin|hook|extra_?roots/i.test(k)) keys.add(k)
        walk(x)
      }
    }
    for (const f of readdirSync(out, { recursive: true }) as string[]) if (f.endsWith('.json')) walk(JSON.parse(await Bun.file(join(out, f)).text()))
  }
  const relevant = methods.filter((m) => /skill|prompt|plugin|hook|config/i.test(m))
  ev.observed = {
    helpFlags: help.stdout.split('\n').filter((l) => /^\s+-/.test(l)).map((l) => l.trim()),
    schemaGenerated: gen.code === 0,
    methods: methods.length,
    relevantMethods: relevant,
    schemaKeys: [...keys].sort(),
    model: await codexModel()
  }
  judge(ev, { schema: gen.code === 0, skillsList: relevant.includes('skills/list'), extraRoots: relevant.includes('skills/extraRoots/set'), hooksList: relevant.includes('hooks/list') }, `codex ${firstLine(version.stdout)}`)
}

async function x0b(ev: Evidence): Promise<void> {
  const c = ctx()
  const r = mkRun(ev.id)
  await gitInit(r.cwd)
  const home = codexHome(join(r.dir, 'codex-home'))
  const nonce = `tcnonce-${ev.id}-shell`
  c.codexFront.reset(ev.id, { shellOutput: nonce })
  const conn = await open(ev, r, home)
  try {
    const thread = await startThread(conn, r.cwd)
    const t1 = await turn(conn, thread, text('Reply with ok.'))
    c.codexFront.script = [{ shell: `echo ${nonce}` }]
    const t2 = await turn(conn, thread, text('Run the probe command.'))
    const s2 = reqSummary(t2.requests)
    ev.observed = { textTurn: { ...t1, requests: undefined, ...reqSummary(t1.requests) }, shellTurn: { ...t2, requests: undefined, ...s2 }, serverRequests: uniq(conn.serverRequests), stderr: conn.stderr.slice(-5) }
    const accepted = t1.completed && t1.text.includes('ok') && t2.completed && s2.all.includes('shellOutput')
    c.codexAccepted = accepted
    judge(ev, { textTurn: t1.completed && t1.text.includes('ok'), functionCallRan: t2.completed && s2.all.includes('shellOutput') }, accepted ? 'the fake is accepted' : 'fake not accepted: X1–X5 rest on listings')
  } finally {
    conn.close()
  }
}

const fakeNote = (): string => (ctx().codexAccepted === false ? 'fake not accepted: listings only' : '')

async function x1(ev: Evidence): Promise<void> {
  const c = ctx()
  const r = mkRun(ev.id)
  await gitInit(r.cwd)
  const n = makeNonces(ev.id)
  const flat = join(r.dir, 'extra-flat')
  const nested = join(r.dir, 'extra-nested')
  writeTree(flat, { 'tc-xroot-skill/SKILL.md': skillFile('tc-xroot-skill', n.skillDesc, n.skillBody) })
  writeTree(nested, { 'skills/tc-xroot2-skill/SKILL.md': skillFile('tc-xroot2-skill', n.lateDesc, n.lateBody) })
  const home = codexHome(join(r.dir, 'codex-home'))
  c.codexFront.reset(ev.id, { flatDesc: n.skillDesc, flatBody: n.skillBody, nestedDesc: n.lateDesc, nestedBody: n.lateBody })
  const conn = await open(ev, r, home)
  try {
    const set = await conn.request('skills/extraRoots/set', { extraRoots: [flat, nested] }).then(() => 'ok', (e) => errText(e))
    const listed = await conn.request('skills/list', { cwds: [r.cwd], forceReload: true }).then(skillNames, (e) => [`error: ${errText(e)}`])
    const config = await conn.request<{ config?: Record<string, unknown> }>('config/read', {}).then((x) => Object.keys(x.config ?? x).filter((k) => /skill/i.test(k)), (e) => [`error: ${errText(e)}`])
    const thread = await startThread(conn, r.cwd)
    const t1 = await turn(conn, thread, text('Reply with ok.'))
    const t2 = await turn(conn, thread, [{ type: 'skill', name: 'tc-xroot-skill', path: join(flat, 'tc-xroot-skill', 'SKILL.md') }, ...text('Use the skill.')])
    const s1 = reqSummary(t1.requests)
    const s2 = reqSummary(t2.requests)
    ev.observed = { extraRootsSet: set, skillsList: listed.filter(isProbeName), configSkillKeys: config, listingTurn: s1, skillPartTurn: s2, completed: [t1.completed, t2.completed], errors: [t1.error, t2.error] }
    judge(ev, {
      extraRootsAccepted: set === 'ok',
      flatListed: listed.includes('tc-xroot-skill'),
      nestedListed: listed.includes('tc-xroot2-skill'),
      flatInPrompt: c.codexAccepted === false ? null : s1.all.includes('flatDesc'),
      bodyBySkillPart: c.codexAccepted === false ? null : s2.all.includes('flatBody')
    }, fakeNote())
  } finally {
    conn.close()
  }
}

async function x2a(ev: Evidence): Promise<void> {
  const c = ctx()
  const r = mkRun(ev.id)
  await gitInit(r.cwd)
  const home = join(r.dir, 'codex-home')
  mkdirSync(home, { recursive: true })
  c.codexFront.reset(ev.id, {})
  const conn = new CodexConn(codexEnv(ev, r, home), r.cwd)
  ev.cli = { path: c.codexBin, version: null }
  try {
    const init = await conn.request('initialize', { clientInfo: CLIENT }).then(() => 'ok', (e) => errText(e))
    const account = await conn.request('account/read', {}).then((x) => JSON.stringify(x).slice(0, 200), (e) => `error: ${errText(e)}`)
    let thread: string | null = null
    const start = await startThread(conn, r.cwd).then((id) => ((thread = id), 'ok'), (e) => errText(e))
    const t = thread ? await turn(conn, thread, text('Reply with ok.'), 60_000) : null
    ev.observed = { initialize: init, account, threadStart: start, turn: t ? { ...t, requests: undefined, ...reqSummary(t.requests) } : null, stderr: conn.stderr.slice(-5) }
    c.codexHomes[ev.id] = { home, tempHome: r.home }
    judge(ev, { initializes: init === 'ok', threadStarts: start === 'ok', turnCompletes: t ? t.completed && !t.error : null })
  } finally {
    conn.close()
  }
}

async function x2c(ev: Evidence): Promise<void> {
  const c = ctx()
  const r = mkRun(ev.id)
  await gitInit(r.cwd)
  const home = codexHome(join(r.dir, 'codex-home'))
  c.codexFront.reset(ev.id, {})
  const conn = await open(ev, r, home)
  try {
    const thread = await startThread(conn, r.cwd)
    const t = await turn(conn, thread, text('Reply with ok.'))
    ev.observed.fake = { ...t, requests: undefined, ...reqSummary(t.requests), serverRequests: uniq(conn.serverRequests) }
  } finally {
    conn.close()
  }
  c.codexHomes[ev.id] = { home, tempHome: r.home }
  ev.observed.real = await realCodex(ev).catch((e) => ({ error: errText(e) }))
  const fake = ev.observed.fake as { bearer: string[]; accountId: string[]; completed: boolean }
  const real = ev.observed.real as { ok?: boolean; skipped?: string }
  judge(ev, { placeholderBearer: fake.bearer.includes('placeholder') && !fake.bearer.includes('other'), placeholderAccount: fake.accountId.includes('placeholder'), fakeTurn: fake.completed, realTurn: real.skipped ? null : !!real.ok })
}

/** The front forwards to the dev gateway's scope, which swaps in the account's token. */
async function realCodex(ev: Evidence): Promise<Record<string, unknown>> {
  const c = ctx()
  if (!c.upstream || !c.dev) return { skipped: 'needs --upstream and --dev-user-data (the Mac leg)' }
  const account = c.codexAccountOverride ?? c.dev.codexAccount
  if (!account) return { skipped: 'no Codex account on the dev instance' }
  const model = await codexModel()
  const scope = { thread: `tc-spike-${ev.id}-${c.run}`, account, model }
  const r = mkRun(`${ev.id}-real`)
  await gitInit(r.cwd)
  const home = codexHome(join(r.dir, 'codex-home'))
  c.codexFront.reset(`${ev.id}-real`, {})
  c.codexFront.forward = (url) => `http://127.0.0.1:${c.dev!.gatewayPort}${codexFrontPath(url, scope)}`
  const conn = await open(ev, r, home)
  try {
    const thread = await startThread(conn, r.cwd)
    const t = await turn(conn, thread, text('Reply with the single word ok.'), 180_000)
    return { model, ok: t.completed && !t.error, status: t.status, error: t.error, text: t.text, paths: uniq(t.requests.map((q) => `${q.method} ${q.path}`)), leaks: inventory(listTree(r.home)), home: inventory(listTree(home, 2)) }
  } finally {
    conn.close()
    c.codexFront.forward = null
  }
}

async function x2d(ev: Evidence): Promise<void> {
  const c = ctx()
  const r = mkRun(ev.id)
  await gitInit(r.cwd)
  const history = `tcnonce-${ev.id}-history`
  const A = codexHome(join(r.dir, 'homeA'))
  c.codexFront.reset(ev.id, { history })
  const c1 = await open(ev, r, A)
  let thread: string
  try {
    thread = await startThread(c1, r.cwd)
    await turn(c1, thread, text(`Remember the word ${history}.`))
  } finally {
    c1.close()
  }
  await sleep(500)
  const resume = async (home: string): Promise<Record<string, unknown>> => {
    const conn = await open(ev, r, home)
    try {
      const res = await conn.request('thread/resume', { threadId: thread, ...threadParams(r.cwd, await codexModel()) }).then(() => 'ok', (e) => errText(e))
      if (res !== 'ok') return { resume: res }
      const t = await turn(conn, thread, text('Reply with ok.'))
      return { resume: res, historyInRequest: reqSummary(t.requests).all.includes('history'), completed: t.completed }
    } finally {
      conn.close()
    }
  }
  const B = codexHome(join(r.dir, 'homeB'))
  const empty = await resume(B)
  const B2 = codexHome(join(r.dir, 'homeB2'))
  const linked: string[] = []
  for (const name of readdirSync(A)) {
    if (name === 'sessions' || /\.sqlite/.test(name)) {
      symlinkSync(join(A, name), join(B2, name))
      linked.push(name)
    }
  }
  const withLinks = await resume(B2)
  c.codexHomes[ev.id] = { home: A, tempHome: r.home }
  ev.observed = { thread, underEmptyHome: empty, linked, withLinkedSessions: withLinks, homeA: inventory(listTree(A, 3)) }
  judge(ev, { resumesUnderEmptyHome: empty.resume === 'ok' && empty.historyInRequest === true, resumesWithLinks: withLinks.resume === 'ok' && withLinks.historyInRequest === true }, fakeNote())
}

async function x2e(ev: Evidence): Promise<void> {
  const homes = ctx().codexHomes
  if (!Object.keys(homes).length) return skip(ev, 'needs X2a–X2d in the same run')
  const seeded = new Set(['auth.json'])
  ev.observed = Object.fromEntries(
    Object.entries(homes).map(([id, h]) => [id, { created: inventory(listTree(h.home, 2).filter((e) => !seeded.has(e.path))), leaks: inventory(listTree(h.tempHome, 3)) }])
  )
  const leaks = Object.values(ev.observed).some((x) => (x as { leaks: string[] }).leaks.length > 0)
  judge(ev, { inventoried: true, noLeaks: !leaks })
}

async function x3(ev: Evidence): Promise<void> {
  const c = ctx()
  const r = mkRun(ev.id)
  await gitInit(r.cwd)
  const n = makeNonces(ev.id)
  const home = codexHome(join(r.dir, 'codex-home'), {
    'skills/tc-probe-skill/SKILL.md': skillFile('tc-probe-skill', n.skillDesc, n.skillBody),
    'skills/tc-gone-skill/SKILL.md': skillFile('tc-gone-skill', n.goneDesc, n.goneBody)
  })
  c.codexFront.reset(ev.id, { ...n })
  const skillInput = [{ type: 'skill', name: 'tc-probe-skill', path: join(home, 'skills', 'tc-probe-skill', 'SKILL.md') }, ...text('Use the skill.')]
  const look = async (conn: CodexConn, thread: string, label: string): Promise<Record<string, unknown>> => {
    const cached = await conn.request('skills/list', { cwds: [r.cwd] }).then(skillNames, (e) => [`error: ${errText(e)}`])
    const reloaded = await conn.request('skills/list', { cwds: [r.cwd], forceReload: true }).then(skillNames, (e) => [`error: ${errText(e)}`])
    const t = await turn(conn, thread, skillInput)
    const s = reqSummary(t.requests)
    return {
      step: label,
      cached: cached.filter(isProbeName),
      reloaded: reloaded.filter(isProbeName),
      late: reloaded.includes('tc-late-skill') || s.all.includes('lateDesc'),
      gone: !reloaded.includes('tc-gone-skill'),
      lateInPrompt: s.all.includes('lateDesc'),
      goneInPrompt: s.all.includes('goneDesc'),
      edited: s.all.includes('editedBody'),
      original: s.all.includes('skillBody')
    }
  }
  const live = await open(ev, r, home)
  const warm = await open(ev, r, home)
  try {
    const thread = await startThread(live, r.cwd)
    ev.observed.turn1 = reqSummary((await turn(live, thread, text('Reply with ok.'))).requests)
    const from = live.notes.length
    writeTree(join(home, 'skills'), { 'tc-late-skill/SKILL.md': skillFile('tc-late-skill', n.lateDesc, n.lateBody), 'tc-probe-skill/SKILL.md': skillFile('tc-probe-skill', n.editedDesc, n.editedBody) })
    rmSync(join(home, 'skills', 'tc-gone-skill'), { recursive: true, force: true })
    await sleep(2_000)
    ev.observed.skillsChanged = live.notes.slice(from).some((x) => x.method === 'skills/changed')
    const steps = [await look(live, thread, 'running thread')]
    const wThread = await startThread(warm, r.cwd)
    steps.push(await look(warm, wThread, 'warm app-server'))
    const fresh = await open(ev, r, home)
    try {
      steps.push(await look(fresh, await startThread(fresh, r.cwd), 'fresh app-server'))
    } finally {
      fresh.close()
    }
    ev.observed.steps = steps
    judge(ev, {
      skillsChangedNotified: ev.observed.skillsChanged === true,
      runningServesEdit: steps[0].edited === true,
      runningListsAdd: steps[0].late === true,
      warmServesAll: steps[1].edited === true && steps[1].late === true && steps[1].gone === true,
      freshServesAll: steps[2].edited === true && steps[2].late === true && steps[2].gone === true
    }, fakeNote())
  } finally {
    live.close()
    warm.close()
  }
}

async function x4(ev: Evidence): Promise<void> {
  const c = ctx()
  const r = mkRun(ev.id)
  await gitInit(r.cwd)
  const marker = join(r.dir, 'hook-fired')
  const home = codexHome(join(r.dir, 'codex-home'), {
    'hooks.json': `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch ${marker}` }] }] } }, null, 2)}\n`
  })
  c.codexFront.reset(ev.id, {})
  const once = async (): Promise<Record<string, unknown>> => {
    rmSync(marker, { force: true })
    const conn = await open(ev, r, home)
    try {
      const listed = await conn.request('hooks/list', { cwds: [r.cwd] }).catch((e) => ({ error: errText(e) }))
      const hooks: Record<string, unknown>[] = []
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) return v.forEach(walk)
        if (v && typeof v === 'object') {
          const o = v as Record<string, unknown>
          if (typeof o.eventName === 'string') hooks.push(Object.fromEntries(Object.entries(o).filter(([k]) => /eventName|enabled|trust|currentHash|source|key|path/i.test(k))))
          Object.values(o).forEach(walk)
        }
      }
      walk(listed)
      const thread = await startThread(conn, r.cwd)
      const t = await turn(conn, thread, text('Reply with ok.'))
      await sleep(500)
      return { hooks, fired: existsSync(marker), completed: t.completed }
    } finally {
      conn.close()
    }
  }
  const untrusted = await once()
  const hash = (untrusted.hooks as { eventName: string; currentHash?: string }[]).find((h) => /userPromptSubmit/i.test(h.eventName))?.currentHash
  const row = hash ? `[hooks.state."${join(home, 'hooks.json')}:user_prompt_submit:0:0"]\ntrusted_hash = "${hash}"\n` : null
  if (row) writeFileSync(join(home, 'config.toml'), row)
  const trusted = row ? await once() : null
  ev.observed = { untrusted, trustRow: row, trusted }
  judge(ev, { listed: (untrusted.hooks as unknown[]).length > 0, firesUntrusted: untrusted.fired === true, firesTrusted: trusted ? trusted.fired === true : null }, fakeNote())
}

async function x5(ev: Evidence): Promise<void> {
  const c = ctx()
  const r = mkRun(ev.id)
  await gitInit(r.cwd)
  const nonce = `tcnonce-${ev.id}-prompt`
  const home = codexHome(join(r.dir, 'codex-home'), { 'prompts/tc-probe.md': `---\ndescription: Probe prompt\n---\nSay the word ${nonce}.\n` })
  c.codexFront.reset(ev.id, { prompt: nonce })
  const conn = await open(ev, r, home)
  try {
    const listed = await conn.request('skills/list', { cwds: [r.cwd], forceReload: true }).then(skillNames, (e) => [`error: ${errText(e)}`])
    const thread = await startThread(conn, r.cwd)
    const t = await turn(conn, thread, text('/prompts:tc-probe'))
    const s = reqSummary(t.requests)
    ev.observed = { skillsList: listed.filter(isProbeName), turn: s, completed: t.completed }
    judge(ev, { listedAsSkill: listed.some((x) => x.includes('tc-probe')), expandedInTurn: c.codexAccepted === false ? null : s.all.includes('prompt') }, 'the method list names no prompts method (X0)')
  } finally {
    conn.close()
  }
}

export function codexExperiments(): Experiment[] {
  const e = (id: string, title: string, fn: (ev: Evidence) => Promise<void>): Experiment => ({
    id,
    harness: 'codex',
    title,
    run: async (ev) => {
      if (!ctx().codexBin) return skip(ev, 'codex is not on the login PATH')
      await fn(ev)
    }
  })
  return [
    e('X0', 'codex version, app-server schema', x0),
    e('X0b', 'the fake Responses front accepted', x0b),
    e('X1', 'skill roots outside CODEX_HOME', x1),
    e('X2a', 'empty CODEX_HOME, no login', x2a),
    e('X2c', 'placeholder login, fake and real', x2c),
    e('X2d', 'resume across homes', x2d),
    e('X2e', 'what codex writes under an owned home', x2e),
    e('X3', 'freshness of skills in CODEX_HOME', x3),
    e('X4', 'hooks.json under an owned home', x4),
    e('X5', 'custom prompts', x5)
  ]
}
