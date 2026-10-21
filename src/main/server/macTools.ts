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
  MAC_TOOL_PARAMS,
  MacHomeSchema,
  macToolDescriptions,
  type MacBridgeThreadState,
  type MacFetchFileResult,
  type MacFetchFileWire,
  type MacMethod,
  type MacRunArgs
} from '@shared/contract-macbridge'
import type { SessionMeta } from '@shared/events'
import { macBridgeLandingDir, type LandingLookup } from './macBridgeLanding'
import type { MacRunLive } from './macRunLive'
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
/** The home each Mac last named in peer.register, kept so a thread started while it is offline still knows it. */
export const MAC_HOME_PREFIX = 'macBridge.home.'
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
  /** A running mac.run's output, live on the thread's tool row (macRunLive.ts). */
  live?: MacRunLive
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

  /**
   * The home directory of the Mac a thread reaches: what it named in its
   * live peer.register, else what it named last time (kept in settings), else
   * null (an older Mac, or one never seen).
   */
  macHomeOf(sessionId: string): string | null {
    const { macPeer } = this.macPeerOf(sessionId)
    if (!macPeer) return null
    const key = `${MAC_HOME_PREFIX}${macPeer}`
    const live = this.deps.calls.homeOf(macPeer)
    if (live) {
      if (this.deps.store.getSetting(key) !== live) this.deps.store.setSetting(key, live)
      return live
    }
    const kept = MacHomeSchema.safeParse(this.deps.store.getSetting(key))
    return kept.success ? kept.data : null
  }

  /** What the codex bridge's environment carries for a thread: the token (and the Mac's home), only while the bridge is on. */
  bridgeEnv(sessionId: string): Record<string, string> {
    if (!this.enabled(sessionId)) return {}
    const home = this.macHomeOf(sessionId)
    return {
      TEMP_CODE_MAC_TOKEN: this.deps.tokens.tokenFor(sessionId),
      ...(home ? { TEMP_CODE_MAC_HOME: home } : {})
    }
  }

  /** One mac.* call from a thread: the token, the thread's switch, the Mac's link, then the Mac decides. */
  async call(
    sessionId: string,
    token: unknown,
    method: MacMethod,
    args: MacArgs,
    opts: { callId?: string } = {}
  ): Promise<unknown> {
    // mac.run may name its tool row (the loopback's callId param); it never travels to the Mac.
    let rowId = opts.callId
    if (method === 'mac.run' && 'callId' in args) {
      const { callId, ...rest } = args
      if (typeof callId === 'string') rowId ??= callId
      args = rest
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
    const live =
      method === 'mac.run' ? this.deps.live?.open(session.id, args as MacRunArgs, rowId) : undefined
    let result: unknown
    try {
      result = await this.deps.calls.call(
        macPeer,
        method,
        { thread: { id: session.id, title: session.title }, args },
        deadlineMs,
        live ? { onProgress: live.progress } : {}
      )
    } finally {
      live?.close()
    }
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
}

/** claude.ts reaches the live instance through here (index.ts sets it). */
export const macToolsHooks: { current: MacTools | null; tokens: MacThreadTokens | null } = {
  current: null,
  tokens: null
}

const text = (t: string): { content: [{ type: 'text'; text: string }] } => ({
  content: [{ type: 'text', text: t }]
})

// `x` is the MCP call's extra: its _meta names the CLI's tool_use id (toolUseIdOf).
const callTool = (session: SessionMeta, method: MacMethod) => async (args: MacArgs, x: unknown) => {
  const tools = macToolsHooks.current
  const tokens = macToolsHooks.tokens
  if (!tools || !tokens) return { ...text('error: the Mac bridge is not ready'), isError: true }
  try {
    return text(
      JSON.stringify(
        await tools.call(session.id, tokens.tokenFor(session.id), method, args, {
          callId: toolUseIdOf(x)
        })
      )
    )
  } catch (err) {
    return { ...text(`error: ${err instanceof Error ? err.message : String(err)}`), isError: true }
  }
}

/** The tool_use id the Claude CLI puts on an MCP call (`_meta["claudecode/toolUseId"]`): the row a mac_run streams into. */
export function toolUseIdOf(extra: unknown): string | undefined {
  const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta
  const id = meta?.['claudecode/toolUseId']
  return typeof id === 'string' && id ? id : undefined
}

export const MAC_TOOL_NAMES = [
  'mac_read_file',
  'mac_list_dir',
  'mac_fetch_file',
  'mac_run'
] as const
export const MAC_TOOLS = MAC_TOOL_NAMES.map((n) => `mcp__mac__${n}`)

/** The Mac's four tools for one Claude thread (in-process; the token never leaves this process). */
export function macToolsMcp(
  session: SessionMeta,
  home: string | null = macToolsHooks.current?.macHomeOf(session.id) ?? null
): McpSdkServerConfigWithInstance {
  const p = MAC_TOOL_PARAMS
  const d = macToolDescriptions(home)
  return createSdkMcpServer({
    name: 'mac',
    version: '0.1.0',
    tools: [
      tool(
        'mac_read_file',
        d.mac_read_file,
        {
          path: z.string().describe(p.path),
          maxBytes: z.number().int().min(1).max(MAC_READ_MAX_BYTES).optional().describe(p.maxBytes)
        },
        callTool(session, 'mac.readFile')
      ),
      tool(
        'mac_list_dir',
        d.mac_list_dir,
        { path: z.string().describe(p.path) },
        callTool(session, 'mac.listDir')
      ),
      tool(
        'mac_fetch_file',
        d.mac_fetch_file,
        { path: z.string().describe(p.path) },
        callTool(session, 'mac.fetchFile')
      ),
      tool(
        'mac_run',
        d.mac_run,
        {
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
