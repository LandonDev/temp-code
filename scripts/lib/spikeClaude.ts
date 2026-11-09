/**
 * The Claude Code experiments of the config-dir spike (C0–C3e): every CLI
 * runs through the Agent SDK's `query()` with a spawn hook that spawns as
 * the driver's warm pool does, under a temp config root and a temp HOME,
 * against the fake Anthropic unless a run's real half says otherwise.
 */
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChildProcess } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { WarmPool, shapeDiff, warmKey, type WarmSpec } from '../../src/main/server/drivers/warm'
import {
  CLAUDE_AUTH_PLACEHOLDER,
  PLACEHOLDERS,
  claudeCredentialVariants,
  makeNonces,
  probePluginTree,
  scopeSegmentOf,
  skillFile,
  treeDiff,
  type ProbeNonces
} from './configDirSpike'
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
import { bashCall, listTree, run, skillCall, sleep, spawnTracked, toolEndingWith, within, writeTree, type AnthropicRequestRecord } from './spikeFakes'

const CLAUDE_STRIP = /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_CONFIG_DIR$|CLAUDE_AGENT_SDK|DISABLE_AUTOUPDATER$)/

/** The environment of a Claude run: the inherited one less every Claude and Anthropic variable, then `set`. */
function claudeEnv(ev: Evidence, r: RunDirs, set: Record<string, string>, opts: { realHome?: boolean; unset?: string[] } = {}): Record<string, string | undefined> {
  const env = baseEnv(CLAUDE_STRIP)
  for (const k of opts.unset ?? []) delete env[k]
  const own: Record<string, string> = { ...(opts.realHome ? {} : { HOME: r.home }), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', ...set }
  noteEnv(ev, own, opts.unset)
  return { ...env, ...own }
}

const tokenEnv = (r: RunDirs, baseUrl = ctx().anth.url): Record<string, string> => ({ CLAUDE_CONFIG_DIR: r.config, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: CLAUDE_AUTH_PLACEHOLDER })

// ── one CLI under the SDK ────────────────────────────────────────────────────

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = []
  private done = false
  push(m: SDKUserMessage): void {
    const w = this.waiters.shift()
    if (w) w({ value: m, done: false })
    else this.items.push(m)
  }
  end(): void {
    this.done = true
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true })
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () =>
        this.items.length
          ? Promise.resolve({ value: this.items.shift()!, done: false })
          : this.done
            ? Promise.resolve({ value: undefined, done: true })
            : new Promise((ok) => this.waiters.push(ok))
    }
  }
}

/** The adopted process as the SDK gets it, stdin held until `until` (claudeWarm.ts holdStdin). */
function holdStdin(proc: ChildProcess, until: Promise<void>): ChildProcess {
  const stdin = proc.stdin
  if (!stdin) return proc
  const held = new PassThrough()
  void until.then(() => held.pipe(stdin))
  stdin.on('error', (e) => held.destroy(e))
  return new Proxy(proc, {
    get(target, prop) {
      if (prop === 'stdin') return held
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

interface ClaudeOpts {
  env: Record<string, string | undefined>
  cwd: string
  /** The CLI: a path, or null for the SDK's bundled one. */
  cli: string | null
  plugins?: { type: 'local'; path: string; skipMcpDiscovery?: boolean }[]
  pluginDelivery?: 'argv' | 'initialize'
  additionalDirectories?: string[]
  resume?: string
  model?: string
  /** A warm process for this spec, or null to spawn cold. */
  adopt?: (spec: WarmSpec) => ChildProcess | null
}

type Init = Awaited<ReturnType<Query['initializationResult']>>

class ClaudeRun {
  q!: Query
  init: Record<string, unknown> | null = null
  spec: WarmSpec | null = null
  proc: ChildProcess | null = null
  adopted = false
  stderr: string[] = []
  error: Error | null = null
  sessionId: string | null = null
  private input = new InputQueue()
  private waiters: ((m: SDKMessage | Error) => void)[] = []
  private abort = new AbortController()

  static start(o: ClaudeOpts): ClaudeRun {
    const s = new ClaudeRun()
    const tail = (d: unknown): void => {
      for (const line of String(d).split('\n')) if (line.trim()) s.stderr.push(line.slice(0, 300))
      s.stderr.splice(0, Math.max(0, s.stderr.length - 30))
    }
    const options: Options = {
      abortController: s.abort,
      ...(o.cli ? { pathToClaudeCodeExecutable: o.cli } : {}),
      env: o.env,
      cwd: o.cwd,
      model: o.model ?? 'claude-haiku-5-5',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      ...(o.plugins ? { plugins: o.plugins } : {}),
      ...(o.pluginDelivery ? { pluginDelivery: o.pluginDelivery } : {}),
      ...(o.additionalDirectories ? { additionalDirectories: o.additionalDirectories } : {}),
      ...(o.resume ? { resume: o.resume } : {}),
      spawnClaudeCodeProcess: (so) => {
        const spec: WarmSpec = { command: so.command, args: so.args, cwd: so.cwd, env: so.env }
        s.spec = spec
        const warm = o.adopt?.(spec) ?? null
        if (warm) {
          s.adopted = true
          s.proc = warm
          return warm as never
        }
        const p = spawnTracked(so.command, so.args, { cwd: so.cwd, env: so.env })
        p.stderr?.on('data', tail)
        p.on('error', () => undefined)
        s.proc = p
        return p as never
      }
    }
    s.q = query({ prompt: s.input, options })
    void s.pump()
    return s
  }

  private async pump(): Promise<void> {
    try {
      for await (const m of this.q) {
        const rec = m as unknown as Record<string, unknown>
        if (m.type === 'system' && rec.subtype === 'init') {
          this.init = rec
          this.sessionId = (rec.session_id as string) ?? this.sessionId
        }
        if (m.type === 'result') {
          this.sessionId = (rec.session_id as string) ?? this.sessionId
          this.waiters.shift()?.(m)
        }
      }
    } catch (e) {
      this.error = e as Error
    }
    for (const w of this.waiters.splice(0)) w(this.error ?? new Error(`the CLI ended${this.stderr.length ? `: ${this.stderr.slice(-2).join(' | ')}` : ''}`))
  }

  async initResult(ms = 60_000): Promise<Init> {
    return await within(this.q.initializationResult(), ms, `initialize${this.stderr.length ? ` (${this.stderr.slice(-1)[0]})` : ''}`)
  }

  /** One turn: the result and every request the fake took meanwhile. */
  async turn(text: string, ms = 120_000): Promise<{ result: Record<string, unknown>; requests: AnthropicRequestRecord[] }> {
    if (this.error) throw this.error
    const mark = ctx().anth.requests.length
    const done = new Promise<SDKMessage | Error>((ok) => this.waiters.push(ok))
    this.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' } as SDKUserMessage)
    const r = await within(done, ms, `turn "${text.slice(0, 40)}"`)
    if (r instanceof Error) throw r
    const res = r as unknown as Record<string, unknown>
    return {
      result: { subtype: res.subtype, is_error: res.is_error, text: firstLine(res.result).slice(0, 160), num_turns: res.num_turns },
      requests: ctx().anth.since(mark)
    }
  }

  async close(): Promise<void> {
    this.input.end()
    this.abort.abort()
    await sleep(300)
    if (this.proc && this.proc.exitCode === null) this.proc.kill('SIGTERM')
  }
}

// ── reading what the CLI said ────────────────────────────────────────────────

const commandNames = (init: Init | null): string[] => ((init?.commands ?? []) as { name: string }[]).map((c) => c.name)
const agentNames = (init: Init | null): string[] => ((init?.agents ?? []) as { name: string }[]).map((a) => a.name)
/** The listed name of `base`: bare or plugin-qualified. */
const named = (names: string[], base: string): string | undefined => names.find((n) => n === base || n.endsWith(`:${base}`))

function initView(m: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!m) return null
  const list = (k: string): string[] => ((m[k] as string[] | undefined) ?? []).filter((x) => typeof x === 'string')
  return {
    claude_code_version: m.claude_code_version,
    apiKeySource: m.apiKeySource,
    model: m.model,
    betas: m.betas ?? null,
    fast_mode_state: m.fast_mode_state ?? null,
    skills: list('skills').filter(isProbeName),
    skillsTotal: list('skills').length,
    slash_commands: list('slash_commands').filter(isProbeName),
    agents: list('agents').filter(isProbeName),
    plugins: ((m.plugins as { name: string; path: string }[] | undefined) ?? []).map((p) => ({ name: p.name, path: p.path })),
    mcp_servers: ((m.mcp_servers as { name: string; status: string; source?: string }[] | undefined) ?? []).filter((s) => /tc|probe|plugin/.test(s.name)),
    tools: list('tools').filter((t) => /^mcp__|^Skill$|^Agent$|^Task$/.test(t))
  }
}

const accountView = (a: unknown): Record<string, unknown> | null => {
  if (!a || typeof a !== 'object') return null
  const x = a as Record<string, unknown>
  const email = typeof x.email === 'string' ? (PLACEHOLDERS.has(x.email) ? x.email : 'present') : null
  return { email, organization: x.organization ? 'present' : null, subscriptionType: x.subscriptionType ?? null, tokenSource: x.tokenSource ?? null, apiKeySource: x.apiKeySource ?? null }
}

/** One turn's requests: paths, and the union of each body part's needles over its main requests. */
function turnSummary(reqs: AnthropicRequestRecord[]): Record<string, unknown> & { last: string[]; fresh: string[]; tools: string[]; system: string[]; messages: string[] } {
  const main = reqs.filter((r) => r.main)
  const u = (k: keyof AnthropicRequestRecord['hits']): string[] => uniq(main.flatMap((r) => r.hits[k])).sort()
  return {
    requests: reqs.length,
    main: main.length,
    paths: uniq(reqs.map((r) => `${r.method} ${r.path}`)),
    credentialsSent: uniq(reqs.map((r) => `${r.auth}:${r.token}`)),
    betas: uniq(reqs.flatMap((r) => r.betas)).sort(),
    answered: main.map((r) => r.answered),
    probeTools: uniq(main.flatMap((r) => r.tools)),
    system: u('system'),
    tools: u('tools'),
    messages: u('messages'),
    last: u('last'),
    fresh: u('fresh')
  }
}

function needlesOf(n: ProbeNonces, extra: Record<string, string> = {}): Record<string, string> {
  const names = ['tc-probe-skill', 'tc-gone-skill', 'tc-late-skill', 'tc-probe-cmd', 'tc-probe-agent', 'tc_probe_echo', 'tc-dup-skill', 'tc-adddir-skill']
  return { ...n, ...Object.fromEntries(names.map((x) => [`name:${x}`, x])), ...extra }
}

function makePlugin(dir: string, n: ProbeNonces, opts: { manifest?: boolean; name?: string; mcpNonce: string; hookMarker: string; extra?: Record<string, string> }): string {
  writeTree(dir, {
    ...probePluginTree(n, { manifest: opts.manifest, name: opts.name, hookMarker: opts.hookMarker, mcp: { command: process.execPath, args: [ctx().mcpScript, opts.mcpNonce] } }),
    ...(opts.extra ?? {})
  })
  return dir
}

/** The change set: add tc-late-skill, edit tc-probe-skill's two nonces, remove tc-gone-skill. */
function applyChangeSet(skillsDir: string, n: ProbeNonces): void {
  writeTree(skillsDir, { 'tc-late-skill/SKILL.md': skillFile('tc-late-skill', n.lateDesc, n.lateBody), 'tc-probe-skill/SKILL.md': skillFile('tc-probe-skill', n.editedDesc, n.editedBody) })
  rmSync(join(skillsDir, 'tc-gone-skill'), { recursive: true, force: true })
}

const cliInfo = (cli: string | null): Evidence['cli'] => {
  const c = ctx().claude
  return cli === null ? { path: c.bundled, version: c.bundledVersion } : { path: cli, version: cli === c.login ? c.loginVersion : cli === c.choice ? c.choiceVersion : null }
}

function probePool(ev: Evidence): WarmPool<ChildProcess> {
  const log: string[] = []
  ev.observed.poolLog = log
  return new WarmPool<ChildProcess>({
    driver: 'probe',
    rebind: [],
    replaceAfterMs: 60_000,
    retireAfterMs: 600_000,
    log: (l) => log.push(l),
    spawn: async (_id, spec, onExit) => {
      const p = spawnTracked(spec.command, spec.args, { cwd: spec.cwd, env: spec.env })
      p.stderr?.resume()
      p.on('error', () => undefined)
      p.once('exit', onExit)
      return p
    },
    kill: (p) => {
      if (p.exitCode === null) p.kill('SIGTERM')
    }
  })
}

/**
 * Capture the spec of `capture` with a cold session, keep a process of that
 * shape warm, run `between`, then adopt it with `adoptWith` (the same options
 * unless a run says otherwise). Whether the keys matched and the adoption's
 * latency come back with the session.
 */
async function warmAdopt(
  ev: Evidence,
  capture: ClaudeOpts,
  adoptWith: ClaudeOpts = capture,
  between: () => Promise<void> = async () => undefined
): Promise<{ s: ClaudeRun; init: Init; keysEqual: boolean; latencyMs: number; specA: WarmSpec; pool: WarmPool<ChildProcess> }> {
  const pool = probePool(ev)
  const a = ClaudeRun.start(capture)
  try {
    await a.initResult()
  } finally {
    await a.close()
  }
  const specA = a.spec
  if (!specA) throw new Error('no spec captured')
  pool.noteStart(specA)
  await pool.settled()
  // The warm CLI boots and waits on its stdin.
  await sleep(3_000)
  await between()
  let keysEqual = false
  const t0 = Date.now()
  const s = ClaudeRun.start({
    ...adoptWith,
    adopt: (spec) => {
      keysEqual = pool.keyOf(spec) === pool.keyOf(specA)
      const w = pool.adopt(spec)
      return w ? holdStdin(w.proc, Promise.resolve()) : null
    }
  })
  const init = await s.initResult()
  return { s, init, keysEqual, latencyMs: Date.now() - t0, specA, pool }
}

// ── C1: plugins and other dirs ───────────────────────────────────────────────

interface PluginRunOptions {
  delivery: 'argv' | 'initialize'
  skipMcp?: boolean
  manifest?: boolean
  cli?: string | null
  label: string
}

/** C1a's four turns on one session: what loads from the probe plugin, and how. */
async function pluginRun(ev: Evidence, o: PluginRunOptions): Promise<{ observed: Record<string, unknown>; checks: Record<string, boolean | null> }> {
  const c = ctx()
  const r = mkRun(`${ev.id}-${o.label}`)
  const n = makeNonces(`${ev.id}${o.label}`)
  const mcpNonce = `tcnonce-${ev.id}${o.label}-mcp`
  const marker = join(r.dir, 'hook-fired')
  const plugin = makePlugin(join(r.dir, 'plugin'), n, { manifest: o.manifest, mcpNonce, hookMarker: marker })
  const env = claudeEnv(ev, r, tokenEnv(r))
  c.anth.reset(`${ev.id}-${o.label}`, needlesOf(n, { mcp: mcpNonce }))
  const cli = o.cli === undefined ? c.claude.choice : o.cli
  ev.cli = cliInfo(cli)
  const s = ClaudeRun.start({ env, cwd: r.cwd, cli, plugins: [{ type: 'local', path: plugin, ...(o.skipMcp ? { skipMcpDiscovery: true } : {}) }], pluginDelivery: o.delivery })
  const observed: Record<string, unknown> = {}
  try {
    const init = await s.initResult()
    if (s.spec) c.specs[`${ev.id}-${o.label}`] = { spec: s.spec, delivery: o.delivery, root: r.config }
    observed.argv = s.spec?.args ?? null
    const names = commandNames(init)
    const skill = named(names, 'tc-probe-skill')
    const cmd = named(names, 'tc-probe-cmd')
    observed.initialize = {
      commands: names.filter(isProbeName),
      agents: agentNames(init).filter(isProbeName),
      plugins_applied: (init as { plugins_applied?: boolean }).plugins_applied ?? null,
      argvHasPluginPath: !!s.spec?.args.some((a) => a.includes(plugin)),
      awaitInitialize: !!s.spec?.args.includes('--await-initialize')
    }
    const t1 = await s.turn(`/${skill ?? 'tc-probe-skill'}`)
    observed.initMessage = initView(s.init)
    observed.mcpStatus = (await within(s.q.mcpServerStatus(), 30_000, 'mcpServerStatus')).map((x) => ({ name: x.name, status: x.status }))
    // Turn 1 loaded tc-probe-skill; a skill already loaded in a conversation is not sent again, so the tool calls the other one.
    const toolSkill = ((s.init?.skills as string[] | undefined) ?? []).find((x) => /tc-gone-skill$/.test(x)) ?? named(names, 'tc-gone-skill') ?? 'tc-gone-skill'
    c.anth.script = [{ tool: skillCall(toolSkill) }]
    const t2 = await s.turn('Use the probe skill.')
    const t3 = await s.turn(`/${cmd ?? 'tc-probe-cmd'}`)
    c.anth.script = [{ tool: toolEndingWith('tc_probe_echo', { word: 'probe' }) }]
    const t4 = await s.turn('Call the probe tool.')
    const turns = { slashSkill: turnSummary(t1.requests), skillTool: turnSummary(t2.requests), slashCommand: turnSummary(t3.requests), mcpTool: turnSummary(t4.requests) }
    observed.turns = turns
    observed.results = [t1.result, t2.result, t3.result, t4.result]
    observed.hookFired = existsSync(marker)
    observed.skillNames = { slash: skill ?? null, tool: toolSkill }
    const listed = !!skill || ((s.init?.skills as string[] | undefined) ?? []).some((x) => /tc-probe-skill$/.test(x))
    const mcpPresent = turns.mcpTool.probeTools.some((t) => t.endsWith('tc_probe_echo'))
    return {
      observed,
      checks: {
        skillListed: listed,
        skillBySlash: turns.slashSkill.fresh.includes('skillBody'),
        skillByTool: turns.skillTool.fresh.includes('goneBody'),
        command: turns.slashCommand.fresh.includes('cmd'),
        agent: turns.slashSkill.fresh.includes('agent') || turns.slashSkill.tools.includes('agent'),
        ...(o.skipMcp ? { mcpAbsent: !mcpPresent } : { mcp: mcpPresent && turns.mcpTool.fresh.includes('mcp') }),
        hook: existsSync(marker)
      }
    }
  } finally {
    observed.stderr = s.stderr.slice(-5)
    await s.close()
  }
}

async function c1(ev: Evidence, o: Omit<PluginRunOptions, 'label'>): Promise<void> {
  const { observed, checks } = await pluginRun(ev, { ...o, label: '' })
  ev.argv = (observed.argv as string[] | null) ?? null
  Object.assign(ev.observed, observed)
  judge(ev, checks, `names ${JSON.stringify(observed.skillNames)}`)
}

/** A plain session with an owned root and one directory added: what it lists and expands. */
async function c1e(ev: Evidence): Promise<void> {
  const c = ctx()
  const r = mkRun(ev.id)
  const n = makeNonces(ev.id)
  const added = join(r.dir, 'added')
  writeTree(added, { '.claude/skills/tc-adddir-skill/SKILL.md': skillFile('tc-adddir-skill', n.skillDesc, n.skillBody) })
  const env = claudeEnv(ev, r, tokenEnv(r))
  c.anth.reset(ev.id, needlesOf(n))
  ev.cli = cliInfo(c.claude.choice)
  const s = ClaudeRun.start({ env, cwd: r.cwd, cli: c.claude.choice, additionalDirectories: [added] })
  try {
    const init = await s.initResult()
    ev.argv = s.spec?.args ?? null
    const name = named(commandNames(init), 'tc-adddir-skill')
    const t = await s.turn(`/${name ?? 'tc-adddir-skill'}`)
    ev.observed = { commands: commandNames(init).filter(isProbeName), turn: turnSummary(t.requests), result: t.result, initMessage: initView(s.init), argvAddDir: s.spec?.args.filter((a) => a === '--add-dir' || a === added) }
    judge(ev, { listed: !!name, expanded: turnSummary(t.requests).fresh.includes('skillBody') }, 'write access under --add-dir is not observable under bypassPermissions; the SDK documents it as a working-directory root')
  } finally {
    await s.close()
  }
}

/** The same skill name in the owned root and in the plugin. */
async function c1f(ev: Evidence): Promise<void> {
  const c = ctx()
  const r = mkRun(ev.id)
  const user = makeNonces(`${ev.id}user`)
  const plug = makeNonces(`${ev.id}plug`)
  writeTree(r.config, { 'skills/tc-dup-skill/SKILL.md': skillFile('tc-dup-skill', user.skillDesc, user.skillBody) })
  const plugin = makePlugin(join(r.dir, 'plugin'), plug, { mcpNonce: 'none', hookMarker: join(r.dir, 'hook'), extra: { 'skills/tc-dup-skill/SKILL.md': skillFile('tc-dup-skill', plug.skillDesc, plug.skillBody) } })
  const env = claudeEnv(ev, r, tokenEnv(r))
  c.anth.reset(ev.id, { userDesc: user.skillDesc, userBody: user.skillBody, pluginDesc: plug.skillDesc, pluginBody: plug.skillBody })
  ev.cli = cliInfo(c.claude.choice)
  const s = ClaudeRun.start({ env, cwd: r.cwd, cli: c.claude.choice, plugins: [{ type: 'local', path: plugin }], pluginDelivery: 'initialize' })
  try {
    const init = await s.initResult()
    const names = commandNames(init).filter((x) => x.includes('tc-dup-skill'))
    const t = await s.turn('/tc-dup-skill')
    const sum = turnSummary(t.requests)
    const t2 = names.find((x) => x.includes(':')) ? turnSummary((await s.turn(`/${names.find((x) => x.includes(':'))}`)).requests) : null
    ev.observed = { listed: names, bare: sum, qualified: t2, listing: initView(s.init)?.skills }
    judge(ev, { bothListed: names.length >= 2, bareExpandsUser: sum.fresh.includes('userBody'), bareExpandsPlugin: sum.fresh.includes('pluginBody'), qualifiedExpandsPlugin: t2 ? t2.fresh.includes('pluginBody') : null }, `listed ${names.join(', ')}`)
  } finally {
    await s.close()
  }
}

async function c1g(ev: Evidence): Promise<void> {
  if (!ctx().claude.bundled) return skip(ev, "the SDK's bundled CLI is not installed here")
  const argv = await pluginRun(ev, { delivery: 'argv', cli: null, label: 'argv' })
  const init = await pluginRun(ev, { delivery: 'initialize', cli: null, label: 'initialize' })
  ev.observed.argv = argv.observed
  ev.observed.initialize = init.observed
  const both: Record<string, boolean | null> = {}
  for (const [k, v] of Object.entries(argv.checks)) both[`argv.${k}`] = v
  for (const [k, v] of Object.entries(init.checks)) both[`initialize.${k}`] = v
  judge(ev, both, `bundled ${ctx().claude.bundledVersion}`)
}

// ── C2: an owned config root ─────────────────────────────────────────────────

/** Mac: no Claude Keychain item holds a refresh grant. Elsewhere: the person's credentials file holds none. Read in memory, never kept. */
async function refreshGrantGuard(): Promise<{ pass: boolean; items: number; reason: string; services: string[] }> {
  if (process.platform === 'darwin') {
    const services = await claudeKeychainServices()
    for (const svc of services) {
      const r = await run('security', ['find-generic-password', '-s', svc, '-w'], { timeoutMs: 15_000 })
      if (r.code !== 0) return { pass: false, items: services.length, reason: 'a Keychain read failed', services }
      let grant = false
      try {
        grant = !!(JSON.parse(r.stdout) as { claudeAiOauth?: { refreshToken?: string } }).claudeAiOauth?.refreshToken
      } catch {
        return { pass: false, items: services.length, reason: 'a Keychain item did not parse', services }
      }
      if (grant) return { pass: false, items: services.length, reason: 'a Keychain item holds a refresh grant', services }
    }
    return { pass: true, items: services.length, reason: 'no item holds a refresh grant', services }
  }
  const file = join(homedir(), '.claude', '.credentials.json')
  if (!existsSync(file)) return { pass: true, items: 0, reason: 'no credentials file', services: [] }
  try {
    const grant = !!(JSON.parse(readFileSync(file, 'utf8')) as { claudeAiOauth?: { refreshToken?: string } }).claudeAiOauth?.refreshToken
    return grant ? { pass: false, items: 1, reason: '~/.claude/.credentials.json holds a refresh grant', services: [] } : { pass: true, items: 1, reason: 'the credentials file holds no refresh grant', services: [] }
  } catch {
    return { pass: false, items: 1, reason: 'the credentials file did not parse', services: [] }
  }
}

/** Names of the Claude Keychain services, from attributes only. */
async function claudeKeychainServices(): Promise<string[]> {
  if (process.platform !== 'darwin') return []
  const r = await run('security', ['dump-keychain'], { timeoutMs: 30_000 })
  return uniq([...r.stdout.matchAll(/"svce"<blob>="(Claude Code-credentials[^"]*)"/g)].map((m) => m[1])).sort()
}

async function c2a(ev: Evidence): Promise<void> {
  const c = ctx()
  const guard = await refreshGrantGuard()
  ev.observed.guard = { result: guard.pass ? 'pass' : 'skip', items: guard.items, reason: guard.reason }
  if (!guard.pass) return skip(ev, `the refresh-grant guard: ${guard.reason}`)
  const r = mkRun(ev.id)
  const v = claudeCredentialVariants({ configDir: r.config, baseUrl: c.anth.url }).C2a
  const env = claudeEnv(ev, r, v.env, { realHome: true, unset: v.unset })
  c.anth.reset(ev.id, {})
  ev.cli = cliInfo(c.claude.choice)
  const before = personalListing()
  const servicesBefore = await claudeKeychainServices()
  const s = ClaudeRun.start({ env, cwd: r.cwd, cli: c.claude.choice })
  try {
    const init = await s.initResult()
    let t: Awaited<ReturnType<ClaudeRun['turn']>> | null = null
    let turnError: string | null = null
    try {
      t = await s.turn('Reply with ok.', 45_000)
    } catch (e) {
      turnError = errText(e)
    }
    const reqs = t?.requests ?? []
    ev.observed = {
      ...ev.observed,
      account: accountView((init as { account?: unknown }).account),
      apiKeySource: s.init?.apiKeySource ?? null,
      turn: t ? { result: t.result, ...turnSummary(reqs) } : { error: turnError },
      ownedRoot: inventory(listTree(r.config)),
      credentialsFileInRoot: existsSync(join(r.config, '.credentials.json')),
      keychainServices: process.platform === 'darwin' ? { before: servicesBefore, after: await claudeKeychainServices() } : null,
      personalDirs: personalDiff(before, personalListing())
    }
    const attempted = reqs.some((q) => q.main)
    const realCredential = reqs.some((q) => q.token === 'other')
    judge(ev, { turnAttempted: attempted, realCredentialResolved: attempted ? realCredential : null }, `apiKeySource ${String(s.init?.apiKeySource ?? '-')}`)
  } finally {
    await s.close()
  }
}

/** A real turn through the dev instance's gateway, for the credential variant `id`. */
async function realClaude(ev: Evidence, id: 'C2b' | 'C2c' | 'C2d', model: string): Promise<Record<string, unknown>> {
  const c = ctx()
  if (!c.upstream || !c.dev) return { skipped: 'needs --upstream and --dev-user-data (the Mac leg)' }
  const account = c.claudeAccountOverride ?? c.dev.claudeAccount
  if (!account) return { skipped: 'no Claude account on the dev instance' }
  const r = mkRun(`${ev.id}-real-${model.replace(/[^a-z0-9]/gi, '')}`)
  const base = `http://127.0.0.1:${c.dev.gatewayPort}/claude/${scopeSegmentOf({ thread: `tc-spike-${ev.id}-${c.run}`, account, model: model.replace('[1m]', '') })}`
  const v = claudeCredentialVariants({ configDir: r.config, baseUrl: base })[id]
  writeTree(r.config, v.files)
  const env = claudeEnv(ev, r, v.env, { unset: v.unset })
  const s = ClaudeRun.start({ env, cwd: r.cwd, cli: c.claude.choice, model })
  try {
    const init = await s.initResult()
    const t = await s.turn('Reply with the single word ok.', 180_000)
    const models = await within(s.q.supportedModels(), 30_000, 'supportedModels').catch((e) => errText(e))
    const usage = await within(s.q.getContextUsage({ detail: 'summary' } as never), 30_000, 'getContextUsage').catch((e) => errText(e))
    const numbers = typeof usage === 'object' && usage ? Object.fromEntries(Object.entries(usage as Record<string, unknown>).filter(([, x]) => typeof x === 'number')) : usage
    return {
      model,
      result: t.result,
      ok: t.result.is_error === false,
      apiKeySource: s.init?.apiKeySource ?? null,
      account: accountView((init as { account?: unknown }).account),
      fastMode: Array.isArray(models) ? models.filter((m) => (m as { supportsFastMode?: boolean }).supportsFastMode).map((m) => (m as { value: string }).value) : models,
      models: Array.isArray(models) ? models.length : null,
      contextUsage: numbers,
      leaks: inventory(listTree(r.home)),
      ownedRoot: inventory(listTree(r.config, 2))
    }
  } catch (e) {
    return { model, error: errText(e), stderr: s.stderr.slice(-3) }
  } finally {
    await s.close()
  }
}

/** C2b–d: the fake half (what the CLI sends), then the real half on the Mac. */
async function c2Variant(ev: Evidence, id: 'C2b' | 'C2c' | 'C2d'): Promise<void> {
  const c = ctx()
  const r = mkRun(ev.id)
  const v = claudeCredentialVariants({ configDir: r.config, baseUrl: c.anth.url })[id]
  writeTree(r.config, v.files)
  const env = claudeEnv(ev, r, v.env, { unset: v.unset })
  c.anth.reset(ev.id, {})
  ev.cli = cliInfo(c.claude.choice)
  ev.observed.summary = v.summary
  const s = ClaudeRun.start({ env, cwd: r.cwd, cli: c.claude.choice })
  try {
    const init = await s.initResult()
    if (s.spec) c.specs[ev.id] = { spec: s.spec, delivery: 'none', root: r.config }
    ev.argv = s.spec?.args ?? null
    const t = await s.turn('Reply with ok.', 60_000)
    const models = await within(s.q.supportedModels(), 30_000, 'supportedModels').catch(() => [])
    const sum = turnSummary(t.requests)
    ev.observed.fake = {
      result: t.result,
      ...sum,
      apiKeySource: s.init?.apiKeySource ?? null,
      account: accountView((init as { account?: unknown }).account),
      oauthBeta: sum.betas.some((b) => b.startsWith('oauth')),
      fastModeOffered: (models as { supportsFastMode?: boolean }[]).some((m) => m.supportsFastMode),
      fast_mode_state: s.init?.fast_mode_state ?? null,
      leaks: inventory(listTree(r.home)),
      ownedRoot: inventory(listTree(r.config, 2))
    }
    const placeholder = t.requests.some((q) => q.main && q.token === 'placeholder')
    await s.close()
    ev.observed.real = await realClaude(ev, id, 'claude-haiku-5-5')
    if (id === 'C2b') ev.observed.real1m = await realClaude(ev, id, 'claude-sonnet-5-5[1m]')
    const real = ev.observed.real as { ok?: boolean; skipped?: string }
    judge(ev, { placeholderSent: placeholder, subscriptionBeta: sum.betas.some((b) => b.startsWith('oauth')), realTurn: real.skipped ? null : !!real.ok }, `apiKeySource ${String(s.init?.apiKeySource ?? '-')}`)
  } finally {
    await s.close()
  }
}

/** C2e: an owned root whose shared entries link into a fake home. */
async function c2e(ev: Evidence): Promise<void> {
  const c = ctx()
  const r = mkRun(ev.id)
  const n = makeNonces(ev.id)
  const fake = join(r.dir, 'fakehome')
  const encoded = realpathSync(r.cwd).replace(/[^A-Za-z0-9]/g, '-')
  const marker = `tcnonce-${ev.id}-envmarker`
  writeTree(fake, {
    [`.claude/projects/${encoded}/memory/MEMORY.md`]: `# Memory\n\n- The probe remembers ${n.skillDesc}.\n`,
    '.claude/CLAUDE.md': `# Instructions\n\nThe probe instruction word is ${n.skillBody}.\n`,
    '.claude/settings.json': `${JSON.stringify({ env: { TC_ENV_MARKER: marker } }, null, 2)}\n`,
    '.claude/plugins/.keep': '',
    '.claude.json': `${JSON.stringify({ hasCompletedOnboarding: true }, null, 2)}\n`
  })
  const links = { projects: '.claude/projects', 'CLAUDE.md': '.claude/CLAUDE.md', 'settings.json': '.claude/settings.json', plugins: '.claude/plugins', '.claude.json': '.claude.json' }
  for (const [name, target] of Object.entries(links)) symlinkSync(join(fake, target), join(r.config, name))
  writeTree(r.config, { 'skills/tc-probe-skill/SKILL.md': skillFile('tc-probe-skill', n.lateDesc, n.lateBody) })
  const seeded = new Set(readdirSync(r.config))
  const env = claudeEnv(ev, r, tokenEnv(r))
  c.anth.reset(ev.id, { memory: n.skillDesc, claudeMd: n.skillBody, envMarker: marker, ownSkill: n.lateDesc })
  ev.cli = cliInfo(c.claude.choice)
  const s = ClaudeRun.start({ env, cwd: r.cwd, cli: c.claude.choice })
  try {
    await s.initResult()
    c.anth.script = [{ tool: bashCall('echo "$TC_ENV_MARKER"') }]
    const t = await s.turn('Print the marker.')
    const t2 = await s.turn('Reply with ok.')
    const sum = turnSummary([...t.requests, ...t2.requests])
    const transcripts = existsSync(join(r.config, 'projects')) ? listTree(realpathSync(join(r.config, 'projects')), 3).filter((e) => e.path.endsWith('.jsonl')) : []
    const linkState = Object.fromEntries(Object.keys(links).map((name) => {
      const p = join(r.config, name)
      return [name, existsSync(p) || lstatSyncSafe(p) ? (lstatSync(p).isSymbolicLink() ? 'link' : lstatSync(p).isDirectory() ? 'replaced by a dir' : 'replaced by a file') : 'gone']
    }))
    ev.observed = {
      turn: sum,
      results: [t.result, t2.result],
      transcriptsUnderLinkedProjects: transcripts.map((e) => e.path),
      transcriptRealDir: existsSync(join(r.config, 'projects')) ? realpathSync(join(r.config, 'projects')) : null,
      links: linkState,
      createdInRoot: inventory(listTree(r.config, 1).filter((e) => !seeded.has(e.path))),
      leaks: inventory(listTree(r.home))
    }
    judge(ev, {
      memory: sum.system.includes('memory') || sum.messages.includes('memory'),
      claudeMd: sum.system.includes('claudeMd') || sum.messages.includes('claudeMd'),
      settingsEnv: sum.messages.includes('envMarker'),
      ownSkill: sum.system.includes('ownSkill') || sum.messages.includes('ownSkill') || sum.tools.includes('ownSkill'),
      transcriptInFakeHome: transcripts.length > 0,
      linksSurvived: Object.values(linkState).every((x) => x === 'link')
    })
  } finally {
    await s.close()
  }
}

const lstatSyncSafe = (p: string): boolean => {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/** C2f: a warm process under an owned root, initialized over stdin at adoption. */
async function c2f(ev: Evidence): Promise<void> {
  const c = ctx()
  const half = async (label: string, baseUrl: string, model: string): Promise<Record<string, unknown>> => {
    const r = mkRun(`${ev.id}-${label}`)
    const n = makeNonces(`${ev.id}${label}`)
    const plugin = makePlugin(join(r.dir, 'plugin'), n, { mcpNonce: 'none', hookMarker: join(r.dir, 'hook') })
    const env = claudeEnv(ev, r, tokenEnv(r, baseUrl))
    if (label === 'fake') c.anth.reset(ev.id, needlesOf(n))
    const o: ClaudeOpts = { env, cwd: r.cwd, cli: c.claude.choice, model, plugins: [{ type: 'local', path: plugin }], pluginDelivery: 'initialize' }
    const w = await warmAdopt(ev, o)
    try {
      const skillName = ((w.s.init?.skills as string[] | undefined) ?? []).find((x) => /tc-probe-skill$/.test(x)) ?? named(commandNames(w.init), 'tc-probe-skill') ?? 'tc-probe-skill'
      if (label === 'fake') c.anth.script = [{ tool: skillCall(skillName) }]
      const t = await w.s.turn(label === 'fake' ? 'Use the probe skill.' : `Use the ${skillName} skill, then reply with the word it gives you.`, 180_000)
      const sum = turnSummary(t.requests)
      return {
        adopted: w.s.adopted,
        keysEqual: w.keysEqual,
        latencyMs: w.latencyMs,
        plugins_applied: (w.init as { plugins_applied?: boolean }).plugins_applied ?? null,
        listed: commandNames(w.init).filter(isProbeName),
        result: t.result,
        skillBody: label === 'fake' ? sum.messages.includes('skillBody') : String(t.result.text ?? '').includes(n.skillBody)
      }
    } finally {
      await w.s.close()
      w.pool.close()
    }
  }
  ev.cli = cliInfo(c.claude.choice)
  const fake = await half('fake', c.anth.url, 'claude-haiku-5-5')
  ev.observed.fake = fake
  if (c.upstream && c.dev && (c.claudeAccountOverride ?? c.dev.claudeAccount)) {
    const account = (c.claudeAccountOverride ?? c.dev.claudeAccount)!
    const base = `http://127.0.0.1:${c.dev.gatewayPort}/claude/${scopeSegmentOf({ thread: `tc-spike-${ev.id}-${c.run}`, account, model: 'claude-haiku-5-5' })}`
    ev.observed.real = await half('real', base, 'claude-haiku-5-5').catch((e) => ({ error: errText(e) }))
  } else ev.observed.real = { skipped: 'needs --upstream and --dev-user-data (the Mac leg)' }
  const real = ev.observed.real as { adopted?: boolean; skillBody?: boolean; skipped?: string }
  judge(ev, { adopted: !!fake.adopted, pluginsApplied: fake.plugins_applied === true, skillInvoked: !!fake.skillBody, realAdopted: real.skipped ? null : !!real.adopted, realSkill: real.skipped ? null : !!real.skillBody }, `adoption ${fake.latencyMs} ms`)
}

/** C2g: a session resumed under another root, empty, then with its projects linked. */
async function c2g(ev: Evidence): Promise<void> {
  const c = ctx()
  const r = mkRun(ev.id)
  const history = `tcnonce-${ev.id}-history`
  const A = join(r.dir, 'rootA')
  const B = join(r.dir, 'rootB')
  const B2 = join(r.dir, 'rootB2')
  for (const d of [A, B, B2]) mkdirSync(d, { recursive: true })
  c.anth.reset(ev.id, { history })
  ev.cli = cliInfo(c.claude.choice)
  const envFor = (root: string): Record<string, string | undefined> => claudeEnv(ev, r, { ...tokenEnv(r), CLAUDE_CONFIG_DIR: root })
  const s1 = ClaudeRun.start({ env: envFor(A), cwd: r.cwd, cli: c.claude.choice })
  let sid: string | null = null
  try {
    await s1.initResult()
    await s1.turn(`Remember the word ${history}.`)
    sid = s1.sessionId
  } finally {
    await s1.close()
  }
  if (!sid) throw new Error('no session id from the first session')
  symlinkSync(join(A, 'projects'), join(B2, 'projects'))
  const resume = async (root: string): Promise<Record<string, unknown>> => {
    const s = ClaudeRun.start({ env: envFor(root), cwd: r.cwd, cli: c.claude.choice, resume: sid! })
    try {
      await s.initResult()
      const t = await s.turn('Reply with ok.', 60_000)
      const sum = turnSummary(t.requests)
      return { result: t.result, historyInRequest: sum.messages.includes('history'), sameSession: s.sessionId === sid }
    } catch (e) {
      return { error: errText(e), stderr: s.stderr.slice(-3) }
    } finally {
      await s.close()
    }
  }
  const empty = await resume(B)
  const linked = await resume(B2)
  ev.observed = { sessionId: sid, underEmptyRoot: empty, underLinkedProjects: linked, rootA: inventory(listTree(A, 2)) }
  judge(ev, { resumesUnderEmptyRoot: empty.historyInRequest === true, resumesWithLinkedProjects: linked.historyInRequest === true })
}

// ── C3: freshness ────────────────────────────────────────────────────────────

/** After each step: the listed commands and one `/tc-probe-skill` turn's listing and body. */
async function freshnessStep(s: ClaudeRun, label: string, skillCmd: string): Promise<Record<string, unknown>> {
  const commands = (await within(s.q.supportedCommands(), 30_000, 'supportedCommands')).map((x) => x.name).filter(isProbeName)
  const t = await s.turn(`/${skillCmd}`)
  const sum = turnSummary(t.requests)
  const seen = (k: string): boolean => sum.system.includes(k) || sum.fresh.includes(k) || sum.tools.includes(k)
  return {
    step: label,
    commands,
    late: commands.some((x) => x.endsWith('tc-late-skill')) || seen('lateDesc'),
    gone: !commands.some((x) => x.endsWith('tc-gone-skill')),
    edited: sum.fresh.includes('editedBody'),
    original: sum.fresh.includes('skillBody'),
    listingHits: uniq([...sum.system, ...sum.fresh].filter((x) => /Desc$/.test(x)))
  }
}

/** The step at which each change of the set first shows, null when none did. */
function firsts(steps: Record<string, unknown>[]): Record<string, string | null> {
  const at = (k: string): string | null => (steps.find((x) => x[k] === true)?.step as string | undefined) ?? null
  return { add: at('late'), edit: at('edited'), remove: at('gone') }
}

/** C3a/C3b: a live session through the change set, step by step, then a fresh process. */
async function c3live(ev: Evidence, where: 'plugin' | 'root'): Promise<void> {
  const c = ctx()
  const r = mkRun(ev.id)
  const n = makeNonces(ev.id)
  const plugin = join(r.dir, 'plugin')
  if (where === 'plugin') makePlugin(plugin, n, { mcpNonce: 'none', hookMarker: join(r.dir, 'hook') })
  else writeTree(r.config, { 'skills/tc-probe-skill/SKILL.md': skillFile('tc-probe-skill', n.skillDesc, n.skillBody), 'skills/tc-gone-skill/SKILL.md': skillFile('tc-gone-skill', n.goneDesc, n.goneBody) })
  const skillsDir = where === 'plugin' ? join(plugin, 'skills') : join(r.config, 'skills')
  const env = claudeEnv(ev, r, tokenEnv(r))
  c.anth.reset(ev.id, needlesOf(n))
  ev.cli = cliInfo(c.claude.choice)
  const o: ClaudeOpts = { env, cwd: r.cwd, cli: c.claude.choice, ...(where === 'plugin' ? { plugins: [{ type: 'local' as const, path: plugin }], pluginDelivery: 'argv' as const } : {}) }
  const s = ClaudeRun.start(o)
  const steps: Record<string, unknown>[] = []
  try {
    const init = await s.initResult()
    const skillCmd = named(commandNames(init), 'tc-probe-skill') ?? 'tc-probe-skill'
    const first = await s.turn(`/${skillCmd}`)
    ev.observed.turn1 = turnSummary(first.requests)
    applyChangeSet(skillsDir, n)
    await sleep(2_000)
    steps.push(await freshnessStep(s, 'nothing', skillCmd))
    const rs = await within(s.q.reloadSkills(), 30_000, 'reloadSkills')
    ev.observed.reloadSkills = rs.skills.map((x) => x.name).filter(isProbeName)
    steps.push(await freshnessStep(s, 'reloadSkills', skillCmd))
    const held = await within(s.q.reloadPlugins({ holdOnCacheImpact: true }), 30_000, 'reloadPlugins(hold)')
    ev.observed.reloadPluginsHold = { held: held.held ?? null, cache_impact: held.cache_impact ?? null, commands: held.commands.map((x) => x.name).filter(isProbeName), error_count: held.error_count }
    steps.push(await freshnessStep(s, 'reloadPlugins(hold)', skillCmd))
    if (held.held) {
      const forced = await within(s.q.reloadPlugins(), 30_000, 'reloadPlugins')
      ev.observed.reloadPlugins = { commands: forced.commands.map((x) => x.name).filter(isProbeName), error_count: forced.error_count }
      steps.push(await freshnessStep(s, 'reloadPlugins', skillCmd))
    }
  } finally {
    await s.close()
  }
  const fresh = ClaudeRun.start(o)
  try {
    const init = await fresh.initResult()
    steps.push(await freshnessStep(fresh, 'next spawn', named(commandNames(init), 'tc-probe-skill') ?? 'tc-probe-skill'))
  } finally {
    await fresh.close()
  }
  ev.observed.steps = steps
  const f = firsts(steps)
  ev.observed.firstShownAt = f
  judge(ev, { liveAdd: !!f.add && f.add !== 'next spawn', liveEdit: !!f.edit && f.edit !== 'next spawn', liveRemove: !!f.remove && f.remove !== 'next spawn', nextSpawnAll: steps.at(-1)?.late === true && steps.at(-1)?.edited === true && steps.at(-1)?.gone === true }, `first at ${JSON.stringify(f)}`)
}

/** C3c: a warm process spawned before the change set, adopted after it, per delivery mode. */
async function c3c(ev: Evidence): Promise<void> {
  const c = ctx()
  ev.cli = cliInfo(c.claude.choice)
  const checks: Record<string, boolean | null> = {}
  for (const delivery of ['argv', 'initialize'] as const) {
    const r = mkRun(`${ev.id}-${delivery}`)
    const n = makeNonces(`${ev.id}${delivery}`)
    const plugin = makePlugin(join(r.dir, 'plugin'), n, { mcpNonce: 'none', hookMarker: join(r.dir, 'hook') })
    const env = claudeEnv(ev, r, tokenEnv(r))
    c.anth.reset(`${ev.id}-${delivery}`, needlesOf(n))
    const o: ClaudeOpts = { env, cwd: r.cwd, cli: c.claude.choice, plugins: [{ type: 'local', path: plugin }], pluginDelivery: delivery }
    const w = await warmAdopt(ev, o, o, async () => {
      applyChangeSet(join(plugin, 'skills'), n)
      await sleep(1_000)
    })
    try {
      const step = await freshnessStep(w.s, 'adopted after the change', named(commandNames(w.init), 'tc-probe-skill') ?? 'tc-probe-skill')
      ev.observed[delivery] = { adopted: w.s.adopted, keysEqual: w.keysEqual, latencyMs: w.latencyMs, ...step }
      checks[`${delivery}.adopted`] = w.s.adopted
      checks[`${delivery}.servesChange`] = step.late === true && step.edited === true && step.gone === true
    } finally {
      await w.s.close()
      w.pool.close()
    }
  }
  judge(ev, checks)
}

/** C3d: a process spawned for plugin set P1 (initialize delivery), adopted by a query naming P2. */
async function c3d(ev: Evidence): Promise<void> {
  const c = ctx()
  const r = mkRun(ev.id)
  const n1 = makeNonces(`${ev.id}p1`)
  const n2 = makeNonces(`${ev.id}p2`)
  const p1 = makePlugin(join(r.dir, 'p1'), n1, { name: 'tc-store-one', mcpNonce: 'none', hookMarker: join(r.dir, 'hook1') })
  const p2 = makePlugin(join(r.dir, 'p2'), n2, { name: 'tc-store-two', mcpNonce: 'none', hookMarker: join(r.dir, 'hook2') })
  const env = claudeEnv(ev, r, tokenEnv(r))
  c.anth.reset(ev.id, { p1Desc: n1.skillDesc, p1Body: n1.skillBody, p2Desc: n2.skillDesc, p2Body: n2.skillBody })
  ev.cli = cliInfo(c.claude.choice)
  const base: ClaudeOpts = { env, cwd: r.cwd, cli: c.claude.choice, pluginDelivery: 'initialize' }
  const w = await warmAdopt(ev, { ...base, plugins: [{ type: 'local', path: p1 }] }, { ...base, plugins: [{ type: 'local', path: p2 }] })
  try {
    const names = commandNames(w.init).filter(isProbeName)
    const skillCmd = names.find((x) => x.endsWith('tc-probe-skill')) ?? 'tc-probe-skill'
    const t = await w.s.turn(`/${skillCmd}`)
    const sum = turnSummary(t.requests)
    ev.observed = {
      ...ev.observed,
      adopted: w.s.adopted,
      keysEqual: w.keysEqual,
      plugins_applied: (w.init as { plugins_applied?: boolean }).plugins_applied ?? null,
      commands: names,
      plugins: initView(w.s.init)?.plugins,
      hits: { system: sum.system, fresh: sum.fresh }
    }
    judge(ev, { adopted: w.s.adopted, p2Applied: (w.init as { plugins_applied?: boolean }).plugins_applied === true, servesP2: sum.fresh.includes('p2Body'), servesP1: sum.fresh.includes('p1Body') })
  } finally {
    await w.s.close()
    w.pool.close()
  }
}

/** C3e: the argv and warm key per delivery mode and per owned root, side by side. */
async function c3e(ev: Evidence): Promise<void> {
  const specs = ctx().specs
  const rows = Object.entries(specs).map(([id, x]) => ({
    id,
    delivery: x.delivery,
    root: x.root,
    argv: x.spec.args,
    shapeLength: warmKey(x.spec).length,
    shapeHash: Bun.hash(warmKey(x.spec)).toString(16),
    envNames: Object.keys(x.spec.env).filter((k) => /^(CLAUDE|ANTHROPIC|HOME$)/.test(k)).sort()
  }))
  if (rows.length < 2) return skip(ev, 'needs the specs C1a, C1b and C2b recorded in the same run')
  const pairs: Record<string, string[]> = {}
  const ids = Object.keys(specs)
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs[`${ids[i]} vs ${ids[j]}`] = shapeDiff(specs[ids[i]].spec, specs[ids[j]].spec)
  ev.observed = { specs: rows, differences: pairs }
  const argvHasPath = rows.filter((x) => x.delivery === 'argv').every((x) => x.argv.includes('--plugin-dir'))
  const initHasNoPath = rows.filter((x) => x.delivery === 'initialize').every((x) => !x.argv.includes('--plugin-dir') && x.argv.includes('--await-initialize'))
  judge(ev, { argvCarriesPluginDir: argvHasPath, initializeKeepsArgvFlat: initHasNoPath }, 'the owned root rides the env (CLAUDE_CONFIG_DIR), so it splits the warm key per root')
}

// ── C0 and the registry ──────────────────────────────────────────────────────

async function c0(ev: Evidence): Promise<void> {
  const c = ctx().claude
  ev.cli = { path: c.choice ?? c.bundled, version: c.choiceVersion }
  ev.observed = { login: { path: c.login, version: c.loginVersion }, bundled: { path: c.bundled, version: c.bundledVersion }, runs: c.choice ? 'login PATH' : 'bundled', rule: 'the newer of the login-PATH claude and the SDK bundled CLI (binaries.ts resolveClaude)' }
  ev.status = 'ok'
  ev.verdict = `runs ${c.choiceVersion ?? c.bundledVersion} (${c.choice ? 'login PATH' : 'bundled'}); login ${c.loginVersion ?? 'none'}, bundled ${c.bundledVersion ?? 'none'}`
}

export function claudeExperiments(): Experiment[] {
  const e = (id: string, title: string, fn: (ev: Evidence) => Promise<void>): Experiment => ({ id, harness: 'claude', title, run: fn })
  return [
    e('C0', 'CLI versions', c0),
    e('C1a', 'plugin dir, argv delivery', (ev) => c1(ev, { delivery: 'argv' })),
    e('C1b', 'plugin dir, initialize delivery', (ev) => c1(ev, { delivery: 'initialize' })),
    e('C1c', 'plugin dir, initialize, skipMcpDiscovery', (ev) => c1(ev, { delivery: 'initialize', skipMcp: true })),
    e('C1d', 'plugin dir without a manifest', (ev) => c1(ev, { delivery: 'initialize', manifest: false })),
    e('C1e', '--add-dir with .claude/skills', c1e),
    e('C1f', 'the same skill in the root and the plugin', c1f),
    e('C1g', "C1a and C1b on the SDK's bundled CLI", c1g),
    e('C2a', 'owned root, no credential, real HOME', c2a),
    e('C2b', 'owned root, ANTHROPIC_AUTH_TOKEN', (ev) => c2Variant(ev, 'C2b')),
    e('C2c', 'owned root, CLAUDE_CODE_OAUTH_TOKEN', (ev) => c2Variant(ev, 'C2c')),
    e('C2d', 'owned root, .credentials.json', (ev) => c2Variant(ev, 'C2d')),
    e('C2e', 'owned root linking into a home', c2e),
    e('C2f', 'warm adoption under an owned root', c2f),
    e('C2g', 'resume across roots', c2g),
    e('C3a', 'freshness: plugin skills in a live session', (ev) => c3live(ev, 'plugin')),
    e('C3b', 'freshness: root skills in a live session', (ev) => c3live(ev, 'root')),
    e('C3c', 'freshness: a warm process spawned before the change', c3c),
    e('C3d', 'one warm process, another plugin set', c3d),
    e('C3e', 'argv and warm key side by side', c3e)
  ]
}

/** C0 again at the end: a CLI that updated mid-run. */
export async function claudeVersionsAtEnd(): Promise<{ login: string | null }> {
  const c = ctx().claude
  const r = c.login ? await run(c.login, ['--version'], { timeoutMs: 30_000 }) : null
  return { login: r && r.code === 0 ? firstLine(r.stdout) : null }
}

export { treeDiff }
