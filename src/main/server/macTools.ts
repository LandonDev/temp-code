import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { z } from 'zod'
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type Options
} from '@anthropic-ai/claude-agent-sdk'
import type { ClientRequest } from '@shared/contract'
import {
  MAC_APPROVAL_WAIT_MS,
  MAC_BRIDGE_OFFER,
  MAC_FETCH_MAX_BYTES,
  MAC_READ_MAX_BYTES,
  MAC_RUN_DEFAULT_TIMEOUT_MS,
  MAC_RUN_MAX_TIMEOUT_MS,
  MAC_TOOL_DESCRIPTIONS,
  MAC_TOOL_PARAMS,
  type MacBridgeThreadState,
  type MacFetchFileResult,
  type MacFetchFileWire,
  type MacMethod
} from '@shared/contract-macbridge'
import type { SessionMeta } from '@shared/events'
import {
  MAC_JOB_READ_WAIT_MAX_MS,
  MAC_JOB_SIGNALS,
  MAC_JOB_TOOL_DESCRIPTIONS,
  MAC_JOB_TOOL_PARAMS,
  type MacJobPeerMethod
} from '@shared/contract-macjobs'
import { macBridgeLandingDir, type LandingLookup } from './macBridgeLanding'
import type { PeerCalls } from './remote/peerCalls'

/**
 * The box side of the Mac bridge (docs/box.md "The Mac bridge"). A thread
 * whose setting `macBridge.thread.<sessionId>` names a Mac's environment id
 * (or whose ancestor's does) gets four tools: mac_read_file, mac_list_dir,
 * mac_fetch_file and mac_run. Claude reaches them in-process (macToolsMcp);
 * Codex through scripts/app-mcp-bridge.mjs, which calls the loopback
 * `mac.*` methods. That socket is unauthenticated, so every mac.* call
 * carries the thread's own token: an HMAC of the session id under a key
 * made at boot, handed only to that thread's bridge in its environment.
 * Nothing here decides what the Mac allows: the call goes to the Mac over
 * its peer link (remote/peerCalls.ts) and the Mac answers or refuses
 * (remote/macBridge.ts).
 */

export const MAC_THREAD_PREFIX = 'macBridge.thread.'
/** The reply's travel time on top of what the Mac may spend. */
const DEADLINE_SLACK_MS = 30_000

/**
 * Per-thread tokens. TEMP_CODE_MAC_TOKEN_SEED (hex) fixes the key for an
 * isolated instance only (TEMP_CODE_USER_DATA set), so a proof can compute
 * a thread's token; otherwise the key is random per process.
 */
export class MacThreadTokens {
  private readonly key: Buffer
  constructor(seed?: string | null) {
    this.key = seed && /^[0-9a-f]{32,}$/i.test(seed) ? Buffer.from(seed, 'hex') : randomBytes(32)
  }
  static fromEnv(env: NodeJS.ProcessEnv = process.env): MacThreadTokens {
    return new MacThreadTokens(env.TEMP_CODE_USER_DATA ? env.TEMP_CODE_MAC_TOKEN_SEED : null)
  }
  tokenFor(sessionId: string): string {
    return createHmac('sha256', this.key).update(`mac-bridge:${sessionId}`).digest('base64url')
  }
  check(sessionId: string, token: unknown): boolean {
    if (typeof token !== 'string') return false
    const want = Buffer.from(this.tokenFor(sessionId))
    const got = Buffer.from(token)
    return got.length === want.length && timingSafeEqual(got, want)
  }
}

export interface MacToolsDeps {
  store: {
    getSetting(key: string): string | null
    setSetting(key: string, value: string | null): void
  }
  sessions: { get(id: string): SessionMeta | null | undefined }
  landing: LandingLookup
  dataDir: string
  calls: PeerCalls
  tokens: MacThreadTokens
  /** The thread's tool set changed: its harness should come back with (or without) the mac tools. */
  reboot?: (sessionId: string) => void
  log?: (line: string) => void
}

type MacArgs = Record<string, unknown>

/** A file name the landing dir will take: the base name, no separators or control characters. */
export function landingName(name: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what a file name must not carry
  const clean = basename(name)
    .replace(/[\u0000-\u001f/\\]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 200)
  return clean || 'file'
}

export class MacTools {
  private readonly log: (line: string) => void
  constructor(private readonly deps: MacToolsDeps) {
    this.log = deps.log ?? ((line) => console.log(`[mac-tools] ${line}`))
  }

  /** The Mac a thread may reach: its own setting, else the nearest ancestor's. */
  macPeerOf(sessionId: string): { macPeer: string | null; inherited: boolean } {
    let id: string | null = sessionId
    for (let depth = 0; id && depth < 32; depth++) {
      const own = this.deps.store.getSetting(`${MAC_THREAD_PREFIX}${id}`)
      if (own) return { macPeer: own, inherited: id !== sessionId }
      id = this.deps.sessions.get(id)?.parentId ?? null
    }
    return { macPeer: null, inherited: false }
  }

  enabled(sessionId: string): boolean {
    return this.macPeerOf(sessionId).macPeer !== null
  }

  threadState(sessionId: string): MacBridgeThreadState {
    if (!this.deps.sessions.get(sessionId)) throw new Error(`unknown session: ${sessionId}`)
    const { macPeer, inherited } = this.macPeerOf(sessionId)
    return {
      sessionId,
      macPeer,
      inherited,
      online: macPeer !== null && this.deps.calls.online(macPeer, MAC_BRIDGE_OFFER),
      registered: this.deps.calls.registeredIds(MAC_BRIDGE_OFFER)
    }
  }

  setThread(sessionId: string, macPeer: string | null): MacBridgeThreadState {
    if (!this.deps.sessions.get(sessionId)) throw new Error(`unknown session: ${sessionId}`)
    const before = this.macPeerOf(sessionId).macPeer
    this.deps.store.setSetting(`${MAC_THREAD_PREFIX}${sessionId}`, macPeer)
    const after = this.macPeerOf(sessionId).macPeer
    if (before !== after) {
      this.log(`thread=${sessionId}: ${after ? `Mac bridge on (${after})` : 'Mac bridge off'}`)
      this.deps.reboot?.(sessionId)
    }
    return this.threadState(sessionId)
  }

  /** What the codex bridge's environment carries for a thread: the token, only while the bridge is on. */
  bridgeEnv(sessionId: string): Record<string, string> {
    return this.enabled(sessionId)
      ? { TEMP_CODE_MAC_TOKEN: this.deps.tokens.tokenFor(sessionId) }
      : {}
  }

  /** One mac.* call from a thread: the token, the thread's switch, the Mac's link, then the Mac decides. */
  async call(
    sessionId: string,
    token: unknown,
    method: MacMethod,
    args: MacArgs
  ): Promise<unknown> {
    if (method === 'mac.run' && args.background === true) {
      const { background: _background, ...rest } = args
      return this.callJob(sessionId, token, 'mac.jobStart', rest)
    }
    if (!this.deps.tokens.check(sessionId, token))
      throw new Error(`refused: ${method} needs this thread's own token`)
    const session = this.deps.sessions.get(sessionId)
    if (!session) throw new Error(`unknown session: ${sessionId}`)
    const { macPeer } = this.macPeerOf(sessionId)
    if (!macPeer)
      throw new Error('the Mac bridge is off for this thread (turn it on from the thread menu)')
    if (!this.deps.calls.online(macPeer, MAC_BRIDGE_OFFER))
      throw new Error(`Mac offline: ${macPeer} has no live link to this host`)
    if (method === 'mac.run' && !args.argv === !args.command)
      throw new Error('mac.run takes argv or command, one of them')
    const timeoutMs =
      method === 'mac.run'
        ? Math.min(Number(args.timeoutMs) || MAC_RUN_DEFAULT_TIMEOUT_MS, MAC_RUN_MAX_TIMEOUT_MS)
        : 0
    const deadlineMs = MAC_APPROVAL_WAIT_MS + timeoutMs + DEADLINE_SLACK_MS
    const result = await this.deps.calls.call(
      macPeer,
      method,
      { thread: { id: session.id, title: session.title }, args },
      deadlineMs
    )
    if (method !== 'mac.fetchFile') return result
    return this.land(session, result as MacFetchFileWire)
  }

  /** Write a fetched file into the thread's landing dir; a name already there gets a suffix. */
  private async land(
    session: SessionMeta,
    wire: MacFetchFileWire
  ): Promise<MacFetchFileResult & { mtime: number }> {
    if (!wire || typeof wire.dataBase64 !== 'string') throw new Error('the Mac sent no file')
    const data = Buffer.from(wire.dataBase64, 'base64')
    if (data.length !== wire.size || data.length > MAC_FETCH_MAX_BYTES)
      throw new Error('the file arrived damaged')
    const dir = macBridgeLandingDir(session, this.deps.landing, this.deps.dataDir)
    await mkdir(dir, { recursive: true })
    const name = landingName(wire.name)
    const ext = extname(name)
    const stem = name.slice(0, name.length - ext.length)
    let path = join(dir, name)
    for (let n = 1; existsSync(path); n++) path = join(dir, `${stem} (${n})${ext}`)
    await writeFile(path, data, { flag: 'wx' })
    return { path, size: data.length, macPath: wire.name, mtime: wire.mtime }
  }

  /** The contract's mac.* and macBridge.thread.* methods on this host. */
  async handle(
    req: ClientRequest
  ): Promise<{ handled: true; result: unknown } | { handled: false }> {
    if (
      req.method === 'mac.jobWrite' ||
      req.method === 'mac.jobRead' ||
      req.method === 'mac.jobSignal' ||
      req.method === 'mac.jobClose'
    ) {
      const { sessionId, token, ...args } = req.params
      return { handled: true, result: await this.callJob(sessionId, token, req.method, args) }
    }
    switch (req.method) {
      case 'mac.readFile':
      case 'mac.listDir':
      case 'mac.fetchFile':
      case 'mac.run': {
        const { sessionId, token, ...args } = req.params
        return { handled: true, result: await this.call(sessionId, token, req.method, args) }
      }
      case 'macBridge.thread.get':
        return { handled: true, result: this.threadState(req.params.sessionId) }
      case 'macBridge.thread.set':
        return { handled: true, result: this.setThread(req.params.sessionId, req.params.macPeer) }
      default:
        return { handled: false }
    }
  }

  // ── interactive jobs (contract-macjobs.ts; the Mac's remote/macJobs.ts) ──

  /** Threads that started a job on a Mac: told to that Mac when the thread ends. */
  private readonly jobThreads = new Map<string, string>()

  /** One job call from a thread: the same gate as call(), then the Mac answers for its own job. */
  async callJob(
    sessionId: string,
    token: unknown,
    method: Exclude<MacJobPeerMethod, 'mac.jobsEnd'>,
    args: MacArgs
  ): Promise<unknown> {
    if (!this.deps.tokens.check(sessionId, token))
      throw new Error(`refused: ${method} needs this thread's own token`)
    const session = this.deps.sessions.get(sessionId)
    if (!session) throw new Error(`unknown session: ${sessionId}`)
    const { macPeer } = this.macPeerOf(sessionId)
    if (!macPeer)
      throw new Error('the Mac bridge is off for this thread (turn it on from the thread menu)')
    if (!this.deps.calls.online(macPeer, MAC_BRIDGE_OFFER))
      throw new Error(`Mac offline: ${macPeer} has no live link to this host`)
    if (method === 'mac.jobStart' && !args.argv === !args.command)
      throw new Error('mac.run takes argv or command, one of them')
    const deadlineMs =
      method === 'mac.jobStart'
        ? MAC_APPROVAL_WAIT_MS + DEADLINE_SLACK_MS
        : method === 'mac.jobRead'
          ? Math.min(Number(args.waitMs) || 0, MAC_JOB_READ_WAIT_MAX_MS) + DEADLINE_SLACK_MS
          : DEADLINE_SLACK_MS
    const result = await this.deps.calls.call(
      macPeer,
      method,
      { thread: { id: session.id, title: session.title }, args },
      deadlineMs
    )
    if (method === 'mac.jobStart') this.jobThreads.set(sessionId, macPeer)
    return result
  }

  /**
   * Threads ended on this host (archived, deleted, moved away): each one that
   * started a job, or whose ancestor is among them, has its jobs ended on its Mac.
   */
  threadsEnded(ids: readonly string[]): void {
    if (!this.jobThreads.size) return
    const gone = new Set(ids)
    for (const [sid, macPeer] of [...this.jobThreads]) {
      let hit = gone.has(sid)
      for (
        let id = this.deps.sessions.get(sid)?.parentId ?? null, d = 0;
        !hit && id && d < 32;
        d++
      ) {
        hit = gone.has(id)
        id = this.deps.sessions.get(id)?.parentId ?? null
      }
      if (!hit) continue
      this.jobThreads.delete(sid)
      if (!this.deps.calls.online(macPeer, MAC_BRIDGE_OFFER)) continue
      this.deps.calls
        .call(
          macPeer,
          'mac.jobsEnd',
          { thread: { id: sid, title: '' }, args: {} },
          DEADLINE_SLACK_MS
        )
        .then(
          () => this.log(`thread=${sid}: its jobs on ${macPeer} ended`),
          (err: unknown) =>
            this.log(
              `thread=${sid}: ending its jobs on ${macPeer} failed (${err instanceof Error ? err.message : String(err)})`
            )
        )
    }
  }
}

/** claude.ts reaches the live instance through here (index.ts sets it). */
export const macToolsHooks: { current: MacTools | null; tokens: MacThreadTokens | null } = {
  current: null,
  tokens: null
}

const text = (t: string): { content: [{ type: 'text'; text: string }] } => ({
  content: [{ type: 'text', text: t }]
})

const callTool = (session: SessionMeta, method: MacMethod) => async (args: MacArgs) => {
  const tools = macToolsHooks.current
  const tokens = macToolsHooks.tokens
  if (!tools || !tokens) return { ...text('error: the Mac bridge is not ready'), isError: true }
  try {
    return text(
      JSON.stringify(await tools.call(session.id, tokens.tokenFor(session.id), method, args))
    )
  } catch (err) {
    return { ...text(`error: ${err instanceof Error ? err.message : String(err)}`), isError: true }
  }
}

export const MAC_TOOL_NAMES = [
  'mac_read_file',
  'mac_list_dir',
  'mac_fetch_file',
  'mac_run'
] as const
export const MAC_TOOLS = MAC_TOOL_NAMES.map((n) => `mcp__mac__${n}`)

/** The Mac's four tools for one Claude thread (in-process; the token never leaves this process). */
export function macToolsMcp(session: SessionMeta): McpSdkServerConfigWithInstance {
  const p = MAC_TOOL_PARAMS
  return createSdkMcpServer({
    name: 'mac',
    version: '0.1.0',
    tools: [
      ...macJobTools(session),
      tool(
        'mac_read_file',
        MAC_TOOL_DESCRIPTIONS.mac_read_file,
        {
          path: z.string().describe(p.path),
          maxBytes: z.number().int().min(1).max(MAC_READ_MAX_BYTES).optional().describe(p.maxBytes)
        },
        callTool(session, 'mac.readFile')
      ),
      tool(
        'mac_list_dir',
        MAC_TOOL_DESCRIPTIONS.mac_list_dir,
        { path: z.string().describe(p.path) },
        callTool(session, 'mac.listDir')
      ),
      tool(
        'mac_fetch_file',
        MAC_TOOL_DESCRIPTIONS.mac_fetch_file,
        { path: z.string().describe(p.path) },
        callTool(session, 'mac.fetchFile')
      ),
      tool(
        'mac_run',
        MAC_TOOL_DESCRIPTIONS.mac_run,
        {
          background: z.boolean().optional().describe(MAC_JOB_TOOL_PARAMS.background),
          argv: z.array(z.string()).min(1).optional().describe(p.argv),
          command: z.string().optional().describe(p.command),
          cwd: z.string().optional().describe(p.cwd),
          timeoutMs: z
            .number()
            .int()
            .min(1_000)
            .max(MAC_RUN_MAX_TIMEOUT_MS)
            .optional()
            .describe(p.timeoutMs)
        },
        callTool(session, 'mac.run')
      )
    ]
  })
}

/** Add the Mac's tools to a Claude thread's options when its bridge is on (claude.ts, after the options are built). */
export function withMacTools(options: Options, session: SessionMeta): Options {
  if (!macToolsHooks.current?.enabled(session.id)) return options
  options.mcpServers = { ...(options.mcpServers ?? {}), mac: macToolsMcp(session) }
  // Allowed on the box without a prompt: the Mac asks for itself (every command, every path outside what it shares).
  options.allowedTools = [...(options.allowedTools ?? []), ...MAC_TOOLS]
  options.allowedTools.push(...MAC_JOB_TOOLS)
  return options
}

/** What rebootWhenSettled needs of the registry. */
export interface RebootRegistry {
  get(id: string): SessionMeta | null
  onMeta(listener: (session: SessionMeta) => void): () => void
  setPermission(sessionId: string, permission: SessionMeta['permission']): Promise<void>
}

/**
 * Bring a thread's harness back with its new tool set: drop the process the
 * way a permission change does (the next send resumes it), but never under a
 * running turn: a live thread is dropped when it settles.
 */
export function rebootWhenSettled(
  registry: RebootRegistry,
  sessionId: string,
  live: (status: SessionMeta['status']) => boolean
): void {
  const drop = (): void => {
    const meta = registry.get(sessionId)
    if (meta) void registry.setPermission(sessionId, meta.permission)
  }
  const meta = registry.get(sessionId)
  if (!meta) return
  if (!live(meta.status)) return drop()
  const off = registry.onMeta((m) => {
    if (m.id !== sessionId || live(m.status)) return
    off()
    drop()
  })
}

// ── interactive jobs: the Claude side of mac_job_* (the codex bridge has its copy) ──

export const MAC_JOB_TOOL_NAMES = ['mac_job_write', 'mac_job_read', 'mac_job_signal'] as const
export const MAC_JOB_TOOLS = MAC_JOB_TOOL_NAMES.map((n) => `mcp__mac__${n}`)

type JobCall = (
  method: Exclude<MacJobPeerMethod, 'mac.jobsEnd' | 'mac.jobStart'>,
  args: MacArgs
) => Promise<unknown>

/** One mac_job_* tool call, as both bridges map it: write is text or base64, then close when asked. */
export async function runJobTool(name: string, args: MacArgs, call: JobCall): Promise<unknown> {
  const jobId = args.jobId
  switch (name) {
    case 'mac_job_write': {
      const hasText = typeof args.text === 'string'
      const hasData = typeof args.dataBase64 === 'string'
      if (hasText && hasData) throw new Error('mac_job_write takes text or dataBase64, not both')
      if (!hasText && !hasData && args.close !== true)
        throw new Error('mac_job_write needs text, dataBase64 or close: true')
      const out: Record<string, unknown> = { jobId }
      if (hasText || hasData) {
        const dataBase64 = hasText
          ? Buffer.from(args.text as string, 'utf8').toString('base64')
          : (args.dataBase64 as string)
        Object.assign(out, await call('mac.jobWrite', { jobId, dataBase64 }))
      }
      if (args.close === true) Object.assign(out, await call('mac.jobClose', { jobId }))
      return out
    }
    case 'mac_job_read':
      return call('mac.jobRead', {
        jobId,
        ...(args.afterOffset !== undefined ? { afterOffset: args.afterOffset } : {}),
        ...(args.waitMs !== undefined ? { waitMs: args.waitMs } : {})
      })
    case 'mac_job_signal':
      return call('mac.jobSignal', { jobId, signal: args.signal })
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

const callJobTool = (session: SessionMeta, name: string) => async (args: MacArgs) => {
  const tools = macToolsHooks.current
  const tokens = macToolsHooks.tokens
  if (!tools || !tokens) return { ...text('error: the Mac bridge is not ready'), isError: true }
  try {
    const token = tokens.tokenFor(session.id)
    const result = await runJobTool(name, args, (method, a) =>
      tools.callJob(session.id, token, method, a)
    )
    return text(JSON.stringify(result))
  } catch (err) {
    return { ...text(`error: ${err instanceof Error ? err.message : String(err)}`), isError: true }
  }
}

/** The three job tools, served by the same in-process `mac` server. */
function macJobTools(session: SessionMeta) {
  const p = MAC_JOB_TOOL_PARAMS
  const jobId = z.string().describe(p.jobId)
  return [
    tool(
      'mac_job_write',
      MAC_JOB_TOOL_DESCRIPTIONS.mac_job_write,
      {
        jobId,
        text: z.string().optional().describe(p.text),
        dataBase64: z.string().optional().describe(p.dataBase64),
        close: z.boolean().optional().describe(p.close)
      },
      callJobTool(session, 'mac_job_write')
    ),
    tool(
      'mac_job_read',
      MAC_JOB_TOOL_DESCRIPTIONS.mac_job_read,
      {
        jobId,
        afterOffset: z.number().int().min(0).optional().describe(p.afterOffset),
        waitMs: z.number().int().min(0).max(MAC_JOB_READ_WAIT_MAX_MS).optional().describe(p.waitMs)
      },
      callJobTool(session, 'mac_job_read')
    ),
    tool(
      'mac_job_signal',
      MAC_JOB_TOOL_DESCRIPTIONS.mac_job_signal,
      { jobId, signal: z.enum(MAC_JOB_SIGNALS).describe(p.signal) },
      callJobTool(session, 'mac_job_signal')
    )
  ]
}
