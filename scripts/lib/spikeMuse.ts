/**
 * The Muse Code experiments of the config-dir spike (M0–M6): `muse serve`
 * through Meta's SDK under a temp `XDG_CONFIG_HOME` in museConfigDirs' shape
 * (`muse/auth.json` with the placeholder login, the shared entries linked to
 * seeded fake targets), every model call sent to the fake Responses front.
 * Until the fake serves Meta's recorded model list (M0b, the Mac leg), the
 * listings run on `--provider echo`, which makes no model call at all.
 */
import { EXPECTED_SCHEMA_FINGERPRINT, spawnMspConnection, type Connection } from '@muse-code/sdk'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { makeNonces, nonceHits, placeholderMuseAuth, redactEvidence, skillFile, type ProbeNonces } from './configDirSpike'
import {
  baseEnv,
  ctx,
  errText,
  firstLine,
  inventory,
  isProbeName,
  judge,
  mkRun,
  noteEnv,
  personalDiff,
  personalListing,
  skip,
  uniq,
  type Evidence,
  type Experiment,
  type RunDirs
} from './spikeContext'
import { ModelsRecorder, listTree, run, sleep, within, writeTree, type ResponsesRequestRecord } from './spikeFakes'

const MUSE_STRIP = /^(XDG_(CONFIG|DATA|STATE|CACHE)_HOME$|MUSE_|TBH_)/
const CLIENT = { name: 'temp_code_spike', version: '0.0.1' }

interface Note {
  method: string
  params: Record<string, unknown>
}

interface MuseHost {
  conn: Connection
  init: Record<string, unknown>
  notes: Note[]
  serverRequests: string[]
  stderr: string[]
  fingerprintWarning: string | null
  close: () => Promise<void>
}

interface MuseOpts {
  /** `--provider echo`: no model call. */
  echo?: boolean
  /** Set TBH_CREDENTIAL_BACKEND=file (default true). */
  fileBackend?: boolean
  /** XDG_CONFIG_HOME; the run's config root by default. */
  config?: string
  /** Keep the person's HOME and config root (M0b); data, state and cache dirs are still the run's. */
  realHome?: boolean
  baseUrl?: string
  args?: string[]
  env?: Record<string, string>
}

async function museOpen(ev: Evidence, r: RunDirs, o: MuseOpts = {}): Promise<MuseHost> {
  const c = ctx()
  const own: Record<string, string> = {
    ...(o.realHome ? {} : { HOME: r.home, XDG_CONFIG_HOME: o.config ?? r.config }),
    XDG_DATA_HOME: join(r.dir, 'data'),
    XDG_STATE_HOME: join(r.dir, 'state'),
    XDG_CACHE_HOME: join(r.dir, 'cache'),
    MUSE_CONTRIBUTOR_MODE: '0',
    ...(o.fileBackend === false ? {} : { TBH_CREDENTIAL_BACKEND: 'file' }),
    ...(o.env ?? {})
  }
  noteEnv(ev, own)
  const inherited = o.realHome ? { ...baseEnv(/^(XDG_(DATA|STATE|CACHE)_HOME$|TBH_)/), ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}) } : baseEnv(MUSE_STRIP)
  const env = { ...inherited, ...own } as Record<string, string>
  const args = [
    'serve',
    ...(o.echo ? ['--provider', 'echo'] : ['-c', `endpoint_transport.base_url=${JSON.stringify(o.baseUrl ?? c.museFront.url)}`]),
    ...(process.platform === 'linux' ? ['--disable-sandbox'] : []),
    ...(o.args ?? [])
  ]
  ev.argv = args
  ev.cli = { path: c.museBin, version: ev.cli?.version ?? null }
  const stderr: string[] = []
  const hs = spawnMspConnection({
    command: c.museBin!,
    args,
    cwd: r.cwd,
    env,
    onStderr: (chunk: string) => {
      for (const l of String(chunk).split('\n')) if (l.trim()) stderr.push(l.slice(0, 300))
      stderr.splice(0, Math.max(0, stderr.length - 30))
    },
    shutdownTimeoutMs: 3_000
  })
  let sp: Awaited<ReturnType<typeof hs.initialize>>
  try {
    sp = await within(hs.initialize({ clientInfo: CLIENT, capabilities: { requestedCapabilities: ['sessionMcp'], experimentalApi: true } } as never), 45_000, 'muse initialize')
  } catch (e) {
    await hs.close().catch(() => undefined)
    throw new Error(`${errText(e)}${stderr.length ? ` [stderr: ${stderr.slice(-2).join(' | ')}]` : ''}`)
  }
  const notes: Note[] = []
  const serverRequests: string[] = []
  sp.connection.onNotification((n) => notes.push({ method: (n as { method: string }).method, params: ((n as { params?: Record<string, unknown> }).params ?? {}) as Record<string, unknown> }))
  sp.connection.onServerRequest(async (req) => {
    serverRequests.push((req as { method: string }).method)
    return {}
  })
  return {
    conn: sp.connection,
    init: sp.initializeResult as unknown as Record<string, unknown>,
    notes,
    serverRequests,
    stderr,
    fingerprintWarning: sp.fingerprintWarning ? sp.fingerprintWarning.message : null,
    close: () => sp.close().then(() => undefined, () => undefined)
  }
}

async function session(h: MuseHost, cwd: string, model?: string): Promise<string> {
  const res = await within(
    h.conn.command('session/start', { workspaceRoot: realpathSync(cwd), approvalMode: 'allowAll', permissionProfile: ':unrestricted', ...(model ? { modelId: model } : {}) }),
    45_000,
    'session/start'
  )
  const id = (res.session as { sessionId?: string } | undefined)?.sessionId
  if (!id) throw new Error('session/start gave no session id')
  return id
}

interface MuseTurn {
  completed: boolean
  terminal: unknown
  error: string | null
  /** Needles in the session's own notifications (the echo provider's answer lands there). */
  hits: string[]
  requests: ResponsesRequestRecord[]
}

async function turn(h: MuseHost, sessionId: string, input: unknown[], needles: Record<string, string>, ms = 90_000): Promise<MuseTurn> {
  const front = ctx().museFront
  const mark = front.requests.length
  const from = h.notes.length
  try {
    await within(h.conn.command('turn/start', { sessionId, input, ifBusy: 'queue' }), 30_000, 'turn/start')
  } catch (e) {
    return { completed: false, terminal: null, error: errText(e), hits: [], requests: front.since(mark) }
  }
  const end = Date.now() + ms
  let done: Note | undefined
  while (Date.now() < end && !done) {
    done = h.notes.slice(from).find((n) => n.method === 'turn/completed' && n.params.sessionId === sessionId)
    if (!done) await sleep(100)
  }
  const mine = h.notes.slice(from).filter((n) => n.params.sessionId === sessionId)
  return { completed: !!done, terminal: done?.params.terminal ?? null, error: null, hits: nonceHits(JSON.stringify(mine), needles), requests: front.since(mark) }
}

const text = (s: string): unknown[] => [{ type: 'text', text: s }]
const skillPart = (selector: string): unknown[] => [{ type: 'skill', selector }]

async function skillList(h: MuseHost, sessionId: string): Promise<{ selector: string; source: string }[]> {
  const res = await within(h.conn.request('skill/list', { sessionId }), 30_000, 'skill/list')
  return ((res.skills as { selector: string; source: string }[] | undefined) ?? []).map((s) => ({ selector: s.selector, source: s.source }))
}

/** An owned root in museConfigDirs' shape: the placeholder login, settings.json linked to a seeded fake target. */
function museRoot(dir: string, files: Record<string, string> = {}): string {
  writeTree(dir, { 'muse/auth.json': placeholderMuseAuth(), ...files })
  const fakeUser = join(dirname(dir), `${basename(dir)}-fake-user-muse`)
  writeTree(fakeUser, { 'settings.json': '{"schema_version":1}\n' })
  symlinkSync(join(fakeUser, 'settings.json'), join(dir, 'muse', 'settings.json'))
  return dir
}

const useEcho = (): boolean => ctx().museAccepted !== true

function reqHits(reqs: ResponsesRequestRecord[]): string[] {
  return uniq(reqs.filter((r) => r.main).flatMap((r) => [...r.hits.instructions, ...r.hits.input, ...r.hits.tools])).sort()
}

/** Where a nonce showed: the fake's request bodies, or the echo provider's answer. */
const seen = (t: MuseTurn, key: string): boolean => t.hits.includes(key) || reqHits(t.requests).includes(key)

// ── what the binary says about itself ────────────────────────────────────────

let stringsCache: { env: string[]; keys: string[] } | null = null
/** Environment names and `skills.*` config keys printed in the binary. */
function binaryStrings(): { env: string[]; keys: string[] } {
  if (stringsCache) return stringsCache
  const bin = realBinary()
  if (!bin) return (stringsCache = { env: [], keys: [] })
  const s = readFileSync(bin).toString('latin1')
  const env = uniq([...s.matchAll(/\b(?:MUSE|TBH)_[A-Z0-9_]{3,40}\b/g)].map((m) => m[0])).sort()
  const keys = uniq([...s.matchAll(/\bskills?\.[a-z_]{2,30}\b/g)].map((m) => m[0])).sort()
  return (stringsCache = { env, keys })
}

/** The binary the `muse` wrapper runs: its newest `muse-bin-*` sibling when it is a script. */
function realBinary(): string | null {
  const bin = ctx().museBin
  if (!bin) return null
  const real = realpathSync(bin)
  if (statSync(real).size > 1_000_000) return real
  const dir = dirname(real)
  const sib = readdirSync(dir)
    .filter((f) => f.startsWith('muse-bin-'))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  return sib ?? real
}

// ── experiments ──────────────────────────────────────────────────────────────

async function m0(ev: Evidence): Promise<void> {
  const c = ctx()
  const env = { ...process.env, PATH: c.loginPath }
  const version = await run(c.museBin!, ['--version'], { env, timeoutMs: 60_000 })
  const serveHelp = await run(c.museBin!, ['serve', '--help'], { env, timeoutMs: 60_000 })
  const skillsHelp = await run(c.museBin!, ['skills', '--help'], { env, timeoutMs: 60_000 })
  ev.cli = { path: c.museBin, version: firstLine(version.stdout) }
  ev.commands = ['muse --version', 'muse serve --help', 'muse skills --help']
  const strings = binaryStrings()
  const r = mkRun(ev.id)
  museRoot(r.config)
  let init: Record<string, unknown> | null = null
  let warning: string | null = null
  try {
    const h = await museOpen(ev, r, { echo: true })
    init = h.init
    warning = h.fingerprintWarning
    await h.close()
  } catch (e) {
    init = { error: errText(e) }
  }
  const served = ((init?.schema as { fingerprint?: string } | undefined)?.fingerprint) ?? null
  ev.observed = {
    serveFlags: serveHelp.stdout.split('\n').filter((l) => /skill|plugin|trust|config|provider|-c,/i.test(l)).map((l) => l.trim()),
    skillsHelp: skillsHelp.stdout.split('\n').filter((l) => l.trim()).slice(0, 30).map((l) => l.trim()),
    sdkFingerprint: EXPECTED_SCHEMA_FINGERPRINT,
    servedFingerprint: served,
    fingerprintWarning: warning,
    initializeFields: Object.keys(init ?? {}),
    initializeError: (init?.error as string | undefined) ?? null,
    museHome: init?.museHome ?? null,
    sandboxAvailability: init?.sandboxAvailability ?? null,
    binaryEnvNames: strings.env.filter((x) => /SKILL|PLUGIN|CONFIG|HOME|CREDENTIAL|DIR|BACKEND|CONTRIB/.test(x)),
    binarySkillSettings: strings.keys,
    sessionConfig: 'SessionConfig admits only mcpServers (msp.d.ts SessionStartParams.config)'
  }
  judge(ev, { versioned: version.code === 0, echoHostStarts: !!init && !('error' in init), fingerprintMatches: served ? served === EXPECTED_SCHEMA_FINGERPRINT : null }, `muse ${firstLine(version.stdout)}`)
}

async function m0b(ev: Evidence): Promise<void> {
  const c = ctx()
  if (!c.upstream) return skip(ev, 'needs --upstream (the Mac leg)')
  const r = mkRun(ev.id)
  const rec = await new ModelsRecorder(['https://api.meta.ai', 'https://api.meta.ai/v1']).start()
  const before = personalListing()
  try {
    // The person's own login, its catalog fetched afresh (the run's data dirs hold no cached one): the
    // default credential backend first, then the file one (the person's ~/.config/muse/auth.json).
    const attempts: Record<string, unknown>[] = []
    let models: string | number = 0
    for (const fileBackend of [false, true]) {
      const h = await museOpen(ev, r, { realHome: true, fileBackend, baseUrl: rec.url })
      try {
        const res = await within(h.conn.request('model/list', {}), 60_000, 'model/list')
        models = ((res.models as unknown[] | undefined) ?? []).length
      } catch (e) {
        models = `error: ${errText(e)}`
      } finally {
        await h.close()
      }
      attempts.push({ backend: fileBackend ? 'file' : 'default', models, recorded: !!rec.answer })
      if (rec.answer) break
    }
    ev.observed = { attempts, tried: rec.tried, refused: rec.refused, models, answeredBy: rec.answer?.origin ?? null, personalDirs: personalDiff(before, personalListing()) }
    if (rec.answer) {
      const body = JSON.stringify(redactEvidence(JSON.parse(rec.answer.body)), null, 2)
      mkdirSync(dirname(c.museModelsPath), { recursive: true })
      writeFileSync(c.museModelsPath, `${body}\n`)
      c.museFront.museModels = body
      ev.observed.fixture = c.museModelsPath
    }
    judge(ev, { recorded: !!rec.answer, modelListServed: typeof models === 'number' && models > 0 })
  } finally {
    rec.close()
  }
}

async function m0c(ev: Evidence): Promise<void> {
  const c = ctx()
  if (!c.museFront.museModels) {
    c.museAccepted = false
    return skip(ev, 'no recorded model list yet (M0b records it on the Mac); the listings run on --provider echo')
  }
  const r = mkRun(ev.id)
  museRoot(r.config)
  const nonce = `tcnonce-${ev.id}-shell`
  c.museFront.reset(ev.id, { shellOutput: nonce })
  const h = await museOpen(ev, r)
  try {
    const res = await within(h.conn.request('model/list', {}), 60_000, 'model/list')
    const models = (res.models as { modelId: string; isDefault?: boolean }[] | undefined) ?? []
    const model = models.find((m) => m.isDefault)?.modelId ?? models[0]?.modelId
    const sid = await session(h, r.cwd, model)
    const t1 = await turn(h, sid, text('Reply with ok.'), { ok: 'ok' })
    c.museFront.script = [{ shell: `echo ${nonce}` }]
    const t2 = await turn(h, sid, text('Run the probe command.'), { shellOutput: nonce })
    const ran = reqHits(t2.requests).includes('shellOutput')
    ev.observed = { models: models.map((m) => m.modelId), model, textTurn: { completed: t1.completed, terminal: t1.terminal, paths: uniq(t1.requests.map((q) => `${q.method} ${q.path}`)) }, shellTurn: { completed: t2.completed, answered: t2.requests.map((q) => q.answered), roles: uniq(t2.requests.map((q) => q.role ?? '-')), tools: uniq(t2.requests.filter((q) => q.main).flatMap((q) => q.toolShapes)), ran }, serverRequests: uniq(h.serverRequests), stderr: h.stderr.slice(-5) }
    c.museAccepted = models.length > 0 && t1.completed && t2.completed && ran
    judge(ev, { modelsListed: models.length > 0, textTurn: t1.completed, functionCallRan: ran }, c.museAccepted ? 'the fake is accepted' : 'fake not accepted: the listings run on --provider echo')
  } finally {
    await h.close()
  }
}

async function m1(ev: Evidence): Promise<void> {
  const r = mkRun(ev.id)
  const n = makeNonces(ev.id)
  const extra = join(r.dir, 'extra')
  writeTree(extra, { 'tc-xroot-skill/SKILL.md': skillFile('tc-xroot-skill', n.skillDesc, n.skillBody) })
  writeTree(r.cwd, {
    '.muse/skills/tc-ws-muse-skill/SKILL.md': skillFile('tc-ws-muse-skill', n.lateDesc, n.lateBody),
    '.agents/skills/tc-ws-agents-skill/SKILL.md': skillFile('tc-ws-agents-skill', n.goneDesc, n.goneBody),
    '.claude/skills/tc-ws-claude-skill/SKILL.md': skillFile('tc-ws-claude-skill', n.editedDesc, n.editedBody)
  })
  museRoot(r.config)
  const strings = binaryStrings()
  const keys = uniq([...strings.keys.filter((k) => /path|dir|root|extra|search|load|location/.test(k)), 'skills.paths', 'skills.dirs', 'skills.extra_dirs', 'skills.roots', 'skills.extra_roots'])
  const envNames = strings.env.filter((x) => /SKILL/.test(x))
  const routes: { route: string; opts: MuseOpts }[] = [
    { route: 'none', opts: {} },
    { route: '--trust-workspace', opts: { args: ['--trust-workspace'] } },
    ...keys.map((k) => ({ route: `-c ${k}`, opts: { args: ['-c', `${k}=${JSON.stringify([extra])}`] } })),
    ...envNames.map((name) => ({ route: `env ${name}`, opts: { env: { [name]: extra } } }))
  ]
  const results: Record<string, unknown>[] = []
  for (const { route, opts } of routes) {
    try {
      const h = await museOpen(ev, r, { echo: true, ...opts })
      try {
        const sid = await session(h, r.cwd)
        const listed = (await skillList(h, sid)).filter((s) => isProbeName(s.selector))
        results.push({ route, accepted: true, listed })
      } finally {
        await h.close()
      }
    } catch (e) {
      results.push({ route, accepted: false, error: errText(e).slice(0, 200) })
    }
  }
  ev.env = { MUSE_CONTRIBUTOR_MODE: '0', TBH_CREDENTIAL_BACKEND: 'file' }
  ev.observed = { routes: results }
  const extraListed = results.some((x) => ((x.listed as { selector: string }[] | undefined) ?? []).some((s) => s.selector.includes('tc-xroot-skill')))
  const ws = (results.find((x) => x.route === '--trust-workspace')?.listed as { selector: string }[] | undefined) ?? []
  judge(ev, { appOwnedDirRoute: extraListed, trustWorkspaceLoadsMuse: ws.some((s) => s.selector.includes('tc-ws-muse-skill')), trustWorkspaceLoadsAgents: ws.some((s) => s.selector.includes('tc-ws-agents-skill')), trustWorkspaceLoadsClaude: ws.some((s) => s.selector.includes('tc-ws-claude-skill')) }, `${routes.length} routes tried`)
}

async function m2(ev: Evidence): Promise<void> {
  const c = ctx()
  const out: Record<string, unknown> = {}
  for (const [label, fileBackend] of [['file', true], ['default', false]] as const) {
    const r = mkRun(`${ev.id}-${label}`)
    museRoot(r.config)
    c.museFront.reset(`${ev.id}-${label}`, {})
    const mark = c.museFront.requests.length
    const t0 = Date.now()
    try {
      const h = await museOpen(ev, r, { fileBackend })
      let modelList: string
      try {
        modelList = await within(h.conn.request('model/list', {}), 30_000, 'model/list').then((x) => `${((x.models as unknown[] | undefined) ?? []).length} models`, (e) => `error: ${errText(e)}`)
        await sleep(1_000)
      } finally {
        await h.close()
      }
      const reqs = c.museFront.since(mark)
      out[label] = { requests: reqs.map((q) => `${q.method} ${q.path}`), bearer: uniq(reqs.map((q) => q.bearer)), modelList, ms: Date.now() - t0 }
    } catch (e) {
      out[label] = { error: errText(e) }
    }
  }
  ev.observed = out
  const bearer = (k: string): string[] => ((out[k] as { bearer?: string[] }).bearer ?? [])
  judge(ev, { fileBackendReadsRootLogin: bearer('file').includes('placeholder'), defaultReadsRootLogin: bearer('default').length ? bearer('default').includes('placeholder') && !bearer('default').includes('other') : null }, `default backend sent ${bearer('default').join('/') || 'nothing'}`)
}

/** M3/M4's setup: an owned root holding tc-probe-skill and tc-gone-skill, the host on the fake or echo. */
function skillRoot(ev: Evidence, label = ''): { r: RunDirs; n: ProbeNonces; skills: string } {
  const r = mkRun(`${ev.id}${label}`)
  const n = makeNonces(`${ev.id}${label}`)
  museRoot(r.config, { 'muse/skills/tc-probe-skill/SKILL.md': skillFile('tc-probe-skill', n.skillDesc, n.skillBody), 'muse/skills/tc-gone-skill/SKILL.md': skillFile('tc-gone-skill', n.goneDesc, n.goneBody) })
  return { r, n, skills: join(r.config, 'muse', 'skills') }
}

async function m3(ev: Evidence): Promise<void> {
  const c = ctx()
  const { r, n } = skillRoot(ev)
  c.museFront.reset(ev.id, { ...n })
  const h = await museOpen(ev, r, { echo: useEcho() })
  try {
    const sid = await session(h, r.cwd)
    const listed = await skillList(h, sid)
    const probe = listed.find((s) => s.selector.endsWith('tc-probe-skill'))
    const t = probe ? await turn(h, sid, skillPart(probe.selector), { ...n }) : null
    ev.observed = { provider: useEcho() ? 'echo' : 'fake', listed: listed.filter((s) => isProbeName(s.selector)), turn: t ? { completed: t.completed, error: t.error, hits: t.hits, requestHits: reqHits(t.requests) } : null }
    judge(ev, { listed: !!probe, resolved: t ? t.completed && !t.error : null, bodyReached: t ? seen(t, 'skillBody') : null }, `provider ${useEcho() ? 'echo' : 'fake'}`)
  } finally {
    await h.close()
  }
}

async function m4(ev: Evidence): Promise<void> {
  const c = ctx()
  const { r, n, skills } = skillRoot(ev)
  c.museFront.reset(ev.id, { ...n })
  const look = async (h: MuseHost, sid: string, label: string): Promise<Record<string, unknown>> => {
    const listed = (await skillList(h, sid)).map((s) => s.selector)
    const sel = listed.find((x) => x.endsWith('tc-probe-skill'))
    const t = sel ? await turn(h, sid, skillPart(sel), { ...n }) : null
    return {
      step: label,
      listed: listed.filter(isProbeName),
      late: listed.some((x) => x.endsWith('tc-late-skill')),
      gone: !listed.some((x) => x.endsWith('tc-gone-skill')),
      edited: t ? seen(t, 'editedBody') : null,
      original: t ? seen(t, 'skillBody') : null,
      error: t?.error ?? null
    }
  }
  const h = await museOpen(ev, r, { echo: useEcho() })
  const steps: Record<string, unknown>[] = []
  try {
    const s1 = await session(h, r.cwd)
    steps.push(await look(h, s1, 'before the change'))
    const from = h.notes.length
    writeTree(skills, { 'tc-late-skill/SKILL.md': skillFile('tc-late-skill', n.lateDesc, n.lateBody), 'tc-probe-skill/SKILL.md': skillFile('tc-probe-skill', n.editedDesc, n.editedBody) })
    rmSync(join(skills, 'tc-gone-skill'), { recursive: true, force: true })
    await sleep(3_000)
    ev.observed.skillChanged = h.notes.slice(from).filter((x) => x.method === 'skill/changed').length
    steps.push(await look(h, s1, 'running session'))
    steps.push(await look(h, await session(h, r.cwd), 'new session, same serve'))
  } finally {
    await h.close()
  }
  const fresh = await museOpen(ev, r, { echo: useEcho() })
  try {
    steps.push(await look(fresh, await session(fresh, r.cwd), 'fresh serve'))
  } finally {
    await fresh.close()
  }
  ev.observed.provider = useEcho() ? 'echo' : 'fake'
  ev.observed.steps = steps
  const [, running, sameServe, freshServe] = steps
  judge(ev, {
    skillChangedNotified: (ev.observed.skillChanged as number) > 0,
    runningListsChange: running.late === true && running.gone === true,
    runningServesEdit: running.edited,
    newSessionServesAll: sameServe.late === true && sameServe.gone === true && sameServe.edited !== false,
    freshServeServesAll: freshServe.late === true && freshServe.gone === true && freshServe.edited !== false
  }, `provider ${ev.observed.provider}`)
}

async function m5(ev: Evidence): Promise<void> {
  const c = ctx()
  const r = mkRun(ev.id)
  museRoot(r.config)
  c.museFront.reset(ev.id, {})
  const h = await museOpen(ev, r, { echo: useEcho() })
  let sid: string
  try {
    sid = await session(h, r.cwd)
    await turn(h, sid, text('Reply with ok.'), {})
  } finally {
    await h.close()
  }
  const tree = (d: string): string[] => inventory(listTree(d, 4))
  const B = museRoot(join(r.dir, 'configB'))
  let resumed: string
  try {
    const hb = await museOpen(ev, r, { echo: useEcho(), config: B })
    try {
      resumed = await within(hb.conn.command('session/resume', { sessionId: sid, permissionProfile: ':unrestricted' }), 30_000, 'session/resume').then(() => 'ok', (e) => errText(e))
    } finally {
      await hb.close()
    }
  } catch (e) {
    resumed = errText(e)
  }
  ev.observed = { config: tree(r.config), data: tree(join(r.dir, 'data')), state: tree(join(r.dir, 'state')), cache: tree(join(r.dir, 'cache')), home: tree(r.home), resumeUnderRootB: resumed, provider: useEcho() ? 'echo' : 'fake' }
  judge(ev, { sessionsOutsideConfigRoot: listTree(r.config, 6).every((e) => !/session/i.test(e.path)), noHomeLeaks: listTree(r.home).length === 0, resumesUnderRootB: resumed === 'ok' })
}

async function m6(ev: Evidence): Promise<void> {
  const c = ctx()
  const { r, n } = skillRoot(ev)
  const out: Record<string, unknown> = {}
  if (c.museAccepted) {
    c.museFront.reset(ev.id, { ownedRoot: r.config, ...n })
    const h = await museOpen(ev, r)
    try {
      const sid = await session(h, r.cwd)
      c.museFront.script = [{ shell: 'echo "XDG=$XDG_CONFIG_HOME"' }]
      const t = await turn(h, sid, text('Run the probe command.'), {})
      out.toolSeesOwnedRoot = reqHits(t.requests).includes('ownedRoot')
    } finally {
      await h.close()
    }
  } else out.toolSeesOwnedRoot = 'skipped: the fake is not accepted'
  const env = { ...process.env, PATH: c.loginPath }
  const probe = async (xdg: string | undefined): Promise<Record<string, unknown>> => {
    const e = { ...env } as Record<string, string | undefined>
    if (xdg) e.XDG_CONFIG_HOME = xdg
    const git = await run('git', ['config', '--global', 'user.name'], { env: e, timeoutMs: 15_000 })
    const gh = await run('gh', ['auth', 'status'], { env: e, timeoutMs: 30_000 })
    return { git: { exit: git.code, found: git.stdout.trim().length > 0 }, gh: { exit: gh.code, loggedIn: gh.code === 0 && /Logged in to /.test(gh.stdout + gh.stderr) } }
  }
  out.asIs = await probe(process.env.XDG_CONFIG_HOME)
  out.ownedRoot = await probe(r.config)
  ev.commands = ['git config --global user.name', 'gh auth status']
  ev.observed = out
  const asIs = out.asIs as { git: { found: boolean }; gh: { loggedIn: boolean } }
  const owned = out.ownedRoot as { git: { found: boolean }; gh: { loggedIn: boolean } }
  judge(ev, { toolSeesOwnedRoot: typeof out.toolSeesOwnedRoot === 'boolean' ? out.toolSeesOwnedRoot : null, gitKeepsConfig: asIs.git.found ? owned.git.found : null, ghKeepsLogin: asIs.gh.loggedIn ? owned.gh.loggedIn : null })
}

export function museExperiments(): Experiment[] {
  const e = (id: string, title: string, fn: (ev: Evidence) => Promise<void>): Experiment => ({
    id,
    harness: 'muse',
    title,
    run: async (ev) => {
      if (!ctx().museBin) return skip(ev, 'muse is not on the login PATH')
      await fn(ev)
    }
  })
  return [
    e('M0', 'muse version, serve flags, fingerprint, routes', m0),
    e('M0b', "record Meta's model list (Mac)", m0b),
    e('M0c', 'the fake Responses front accepted', m0c),
    e('M1', 'skill roots outside XDG_CONFIG_HOME', m1),
    e('M2', 'which login a thread reads', m2),
    e('M3', 'skills in the owned root', m3),
    e('M4', 'freshness of skills in the owned root', m4),
    e('M5', 'what moves with the config root', m5),
    e('M6', "tool processes and the moved root", m6)
  ]
}

/** The recorded models, when the branch has them. */
export function loadMuseModels(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}
