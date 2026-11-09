import { spawn, type ChildProcess } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { AddonState, AddonStatus } from '@shared/contract-addons'
import {
  ADDON_CONNECT_TIMEOUT_MS,
  ADDON_MARK,
  ADDON_MAX_TOOLS,
  ADDON_RESTART_BACKOFF_MS,
  ADDON_RESULT_MAX_BYTES,
  ADDON_STABLE_MS,
  GRANT_REFUSED_LINE,
  grantGapsLine,
  megabytes,
  type AddonCallResult,
  type AddonLaunch,
  type DownstreamTool,
  type ResolvedGrant
} from './addonWire'

/**
 * One downstream MCP server, as the add-on host's utility process holds it
 * (plan-L1Vrd-CMiZJ7.md section 3): connect with the grant main resolves,
 * list the tools, pass calls through whole, restart after a crash with
 * backoff, follow a grant that changes. Nothing here throws out of its own
 * work, and no grant value leaves it except toward the server: every text
 * toward main or a log goes through `redact` first.
 */

/** Each value of 4 characters or more of `secrets` replaced by `…`, longest first. */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = text
  for (const s of [...secrets].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(s).join('…')
  return out
}

export const errorResult = (text: string): AddonCallResult => ({ content: [{ type: 'text', text }], isError: true })

export interface ProcessExit {
  code: number | null
  signal: string | null
}

/**
 * A stdio Transport of the SDK's interface: the SDK's own drops the exit
 * code and caps a message at 10 MB. The server runs in its own process
 * group, so a close takes its children with it.
 */
export class ProcessTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  exit: ProcessExit | null = null
  /** Why the transport closed itself (a message over the cap), else null. */
  reason: string | null = null
  /** stderr's last 20 lines, unredacted: read through redact(). */
  readonly stderr: string[] = []
  private child: ChildProcess | null = null
  private readonly buffer: ReadBuffer
  private stderrTail = ''
  private closed: Promise<void> | null = null
  private exited!: () => void
  private readonly done = new Promise<void>((resolve) => (this.exited = resolve))

  constructor(private readonly opts: { command: string; args: string[]; env: Record<string, string>; cwd: string; maxBufferSize: number }) {
    this.buffer = new ReadBuffer({ maxBufferSize: opts.maxBufferSize })
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      let spawned = false
      const child = spawn(this.opts.command, this.opts.args, { env: this.opts.env, cwd: this.opts.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
      this.child = child
      child.once('spawn', () => {
        spawned = true
        resolve()
      })
      child.on('error', (error) => (spawned ? this.onerror?.(error) : reject(error)))
      child.stdout!.on('data', (chunk: Buffer) => this.read(chunk))
      child.stderr!.on('data', (chunk: Buffer) => this.readStderr(chunk))
      child.stdin!.on('error', () => {})
      child.on('close', (code, signal) => {
        this.exit = { code, signal }
        if (this.stderrTail) this.keepLine(this.stderrTail)
        this.exited()
        if (spawned) this.onclose?.()
      })
    })
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin
    if (!stdin || this.exit) throw new Error('the server is not running')
    if (!stdin.write(serializeMessage(message))) await new Promise<void>((resolve) => stdin.once('drain', resolve))
  }

  close(): Promise<void> {
    if (this.closed) return this.closed
    const child = this.child
    if (!child || this.exit) return (this.closed = Promise.resolve())
    this.signal('SIGTERM')
    const kill = setTimeout(() => this.signal('SIGKILL'), 3_000)
    kill.unref?.()
    return (this.closed = this.done.then(() => clearTimeout(kill)))
  }

  private signal(sig: NodeJS.Signals): void {
    const pid = this.child?.pid
    if (!pid || this.exit) return
    try {
      process.kill(-pid, sig)
    } catch {
      try {
        this.child!.kill(sig)
      } catch {
        // already gone
      }
    }
  }

  private read(chunk: Buffer): void {
    try {
      this.buffer.append(chunk)
    } catch {
      this.reason = `a message over ${megabytes(this.opts.maxBufferSize - 1024 * 1024)}`
      this.signal('SIGKILL')
      return
    }
    for (;;) {
      let message: JSONRPCMessage | null
      try {
        message = this.buffer.readMessage()
      } catch (error) {
        this.onerror?.(error as Error)
        continue
      }
      if (!message) return
      this.onmessage?.(message)
    }
  }

  private readStderr(chunk: Buffer): void {
    const lines = (this.stderrTail + chunk.toString('utf8')).split('\n')
    this.stderrTail = lines.pop() ?? ''
    for (const line of lines) this.keepLine(line)
  }

  private keepLine(line: string): void {
    const trimmed = line.trimEnd()
    if (!trimmed) return
    this.stderr.push(trimmed.slice(0, 2_000))
    if (this.stderr.length > 20) this.stderr.shift()
  }
}

export interface DownstreamDeps {
  launch: AddonLaunch
  baseEnv: Record<string, string>
  cwd: string
  /** Main's answer to the `grant` ask. */
  grant(): Promise<ResolvedGrant>
  status(status: AddonStatus): void
  tools(specDigest: string, tools: DownstreamTool[]): void
  /** An http server refused the grant (401 or 403). */
  unauthorized(): void
  /** A line for the log, already redacted. */
  log(line: string): void
  trace?: boolean
  now?: () => number
  backoffMs?: readonly number[]
  stableMs?: number
  connectTimeoutMs?: number
  maxResultBytes?: number
  fetch?: typeof fetch
}

type Conn = {
  client: Client
  transport: Transport
  kind: 'stdio' | 'http' | 'sse'
  digest: string
  up: number
  /** Closed on purpose: its close is no crash. */
  closing: boolean
  /** Until connect resolves: a close then is the connect's own failure, which its catch reports. */
  dialing: boolean
  /** What its in-flight calls answer once it went down, set before the client rejects them. */
  failure: string | null
}

type SseInit = NonNullable<NonNullable<ConstructorParameters<typeof SSEClientTransport>[1]>['eventSourceInit']>

const isNetworkError = (e: unknown): boolean => e instanceof TypeError || /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|terminated/i.test(String((e as Error)?.message ?? e))

export class Downstream {
  private conn: Conn | null = null
  private state: AddonState = 'starting'
  private detail: string | undefined
  private toolCount = 0
  private kept: ResolvedGrant | null = null
  private rejectedDigest: string | null = null
  private readonly secrets = new Set<string>()
  private chain: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private inflight = 0
  private idleWaiters: (() => void)[] = []
  private closed = false
  private readonly now: () => number

  constructor(private readonly deps: DownstreamDeps) {
    this.now = deps.now ?? Date.now
  }

  get name(): string {
    return this.deps.launch.name
  }

  /** The state as last reported; the tests read it. */
  get current(): { state: AddonState; detail?: string; tools: number } {
    return { state: this.state, ...(this.detail ? { detail: this.detail } : {}), tools: this.toolCount }
  }

  /** The stdio server's pid while one runs. */
  get pid(): number | null {
    return this.conn?.transport instanceof ProcessTransport ? this.conn.transport.pid : null
  }

  start(): void {
    this.serial(() => this.connect())
  }

  /** Close for good: the launch left. No status is sent. */
  close(): Promise<void> {
    this.closed = true
    this.clearTimer()
    return this.serial(() => this.disconnect())
  }

  /** The person asked for a restart: drop the backoff and connect again. */
  restart(): Promise<void> {
    this.clearTimer()
    return this.serial(async () => {
      await this.disconnect()
      this.failures = 0
      await this.connect()
    })
  }

  /** Main dropped the kept grant: ask again and act on the answer (plan section 3, "Grant change"). */
  grantsDropped(): Promise<void> {
    return this.serial(() => this.regrant())
  }

  async call(tool: string, args: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<AddonCallResult> {
    await this.chain
    const conn = this.conn
    if (!conn || this.state !== 'ready') return errorResult(`${this.name} is ${this.state}${this.detail ? `: ${this.detail}` : ''}`)
    this.inflight++
    try {
      const result = await conn.client.callTool({ name: tool, arguments: args }, undefined, { signal: opts.signal, timeout: opts.timeoutMs, resetTimeoutOnProgress: true })
      const bytes = Buffer.byteLength(JSON.stringify(result))
      const max = this.deps.maxResultBytes ?? ADDON_RESULT_MAX_BYTES
      if (bytes > max) return errorResult(`The result was ${megabytes(bytes)}, over the ${megabytes(max)} the app passes on.`)
      const content = Array.isArray(result.content) ? result.content : []
      return {
        content,
        ...(result.isError ? { isError: true } : {}),
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {})
      }
    } catch (error) {
      if (conn.failure) return errorResult(conn.failure)
      const message = this.redact((error as Error)?.message ?? String(error))
      if (conn.kind !== 'stdio' && !conn.closing && isNetworkError(error)) this.crash(conn, `Disconnected: ${message}`)
      return errorResult(message)
    } finally {
      if (--this.inflight === 0) for (const wake of this.idleWaiters.splice(0)) wake()
    }
  }

  // ── the connection ─────────────────────────────────────────────────────

  private serial(op: () => Promise<void>): Promise<void> {
    const next = this.chain.then(op).catch((error) => this.deps.log(`${this.name}: ${this.redact(String((error as Error)?.message ?? error))}`))
    this.chain = next
    return next
  }

  private async askGrant(): Promise<ResolvedGrant | null> {
    try {
      const grant = await this.deps.grant()
      if (grant.ok) for (const value of [...Object.values(grant.env), ...Object.values(grant.headers)]) this.keepSecret(value)
      return grant
    } catch (error) {
      this.fail(`Could not read its grant: ${this.redact((error as Error)?.message ?? String(error))}`)
      return null
    }
  }

  private keepSecret(value: string): void {
    this.secrets.add(value)
    const bearer = /^bearer\s+(.+)$/i.exec(value)
    if (bearer) this.secrets.add(bearer[1]!)
  }

  private redact(text: string): string {
    return redact(text, this.secrets)
  }

  private async connect(): Promise<void> {
    if (this.closed) return
    this.report('starting')
    this.kept ??= await this.askGrant()
    const grant = this.kept
    if (!grant) return
    if (!grant.ok) return this.report('needs-grant', grantGapsLine(grant.gaps))
    if (grant.digest === this.rejectedDigest) return this.report('needs-grant', GRANT_REFUSED_LINE)
    const { launch } = this.deps
    const conn: Conn = { client: this.newClient(), transport: null as unknown as Transport, kind: 'stdio', digest: grant.digest, up: 0, closing: false, dialing: true, failure: null }
    this.conn = conn
    const connectMs = this.deps.connectTimeoutMs ?? ADDON_CONNECT_TIMEOUT_MS
    const timer = setTimeout(() => {
      // Close the transport only: the connect below rejects and its catch reports this.
      conn.failure = `Did not answer in ${Math.round(connectMs / 1000)} s`
      conn.closing = true
      void conn.transport?.close().catch(() => {})
    }, connectMs)
    try {
      if (launch.spec.transport === 'stdio') await this.dialStdio(conn, grant)
      else await this.dialHttp(conn, launch.spec.url)
      conn.dialing = false
      const tools = await this.listAll(conn)
      clearTimeout(timer)
      if (this.conn !== conn) return
      conn.up = this.now()
      this.trace(`connected over ${conn.kind}, ${tools.total} tools`)
      this.publish(conn, tools)
    } catch (error) {
      clearTimeout(timer)
      if (this.conn !== conn || this.closed) return
      if (this.state === 'needs-grant') return
      const why = conn.failure ?? `Could not ${launch.spec.transport === 'stdio' ? 'start' : 'connect'}: ${this.redact((error as Error)?.message ?? String(error))}`
      await this.dropConn(conn)
      this.fail(why)
    }
  }

  private newClient(): Client {
    const client: Client = new Client(
      { name: 'temp-code', version: '1' },
      { capabilities: {}, listChanged: { tools: { autoRefresh: false, debounceMs: 50, onChanged: () => void this.relist(client) } } }
    )
    client.onerror = (error) => this.trace(`error: ${this.redact(error.message)}`)
    return client
  }

  private async dialStdio(conn: Conn, grant: Extract<ResolvedGrant, { ok: true }>): Promise<void> {
    const spec = this.deps.launch.spec
    if (spec.transport !== 'stdio') return
    const transport = new ProcessTransport({
      command: spec.command,
      args: spec.args,
      env: { ...this.deps.baseEnv, ...grant.env, [ADDON_MARK]: this.deps.launch.id },
      cwd: this.deps.cwd,
      maxBufferSize: (this.deps.maxResultBytes ?? ADDON_RESULT_MAX_BYTES) + 1024 * 1024
    })
    conn.transport = transport
    transport.onclose = () => {
      if (conn.closing) return
      const line = transport.stderr.at(-1)
      const exit = transport.exit
      const how = transport.reason ? `Disconnected: ${transport.reason}` : exit?.signal ? `Exited (signal ${exit.signal})` : `Exited (code ${exit?.code ?? 'unknown'})`
      const detail = line && !transport.reason ? `${how}: ${this.redact(line)}` : how
      if (conn.dialing) conn.failure = detail
      else this.crash(conn, detail)
    }
    await conn.client.connect(transport)
  }

  private async dialHttp(conn: Conn, url: string): Promise<void> {
    const base = this.deps.fetch ?? fetch
    const withGrant = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers)
      if (this.kept?.ok) for (const [k, v] of Object.entries(this.kept.headers)) headers.set(k, v)
      const res = await base(input, { ...init, headers })
      if ((res.status === 401 || res.status === 403) && !conn.closing) queueMicrotask(() => void this.refused(conn))
      return res
    }
    const watch = (transport: Transport) => {
      conn.transport = transport
      transport.onclose = () => {
        if (!conn.closing && !conn.dialing) this.crash(conn, 'Disconnected: the server closed the connection')
      }
    }
    const streamable = new StreamableHTTPClientTransport(new URL(url), { fetch: withGrant })
    watch(streamable)
    conn.kind = 'http'
    try {
      await conn.client.connect(streamable)
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      if (conn.closing || (code !== 404 && code !== 405)) throw error
      // An older server: the SSE transport, kept for the add-on's life.
      streamable.onclose = () => {}
      await streamable.close().catch(() => {})
      conn.client = this.newClient()
      conn.kind = 'sse'
      const sse = new SSEClientTransport(new URL(url), { fetch: withGrant, eventSourceInit: { fetch: withGrant } as SseInit })
      watch(sse)
      await conn.client.connect(sse)
    }
  }

  private async listAll(conn: Conn): Promise<{ tools: DownstreamTool[]; total: number }> {
    const tools: DownstreamTool[] = []
    let total = 0
    let cursor: string | undefined
    for (let page = 0; page < 1_000; page++) {
      const answer = await conn.client.listTools(cursor ? { cursor } : undefined)
      for (const t of answer.tools) {
        total++
        if (tools.length >= ADDON_MAX_TOOLS) continue
        const readOnly = t.annotations?.readOnlyHint
        tools.push({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema as Record<string, unknown>, ...(readOnly !== undefined ? { readOnly } : {}) })
      }
      cursor = answer.nextCursor
      if (!cursor) break
    }
    return { tools, total }
  }

  private publish(conn: Conn, listed: { tools: DownstreamTool[]; total: number }): void {
    if (this.conn !== conn) return
    this.deps.tools(this.deps.launch.specDigest, listed.tools)
    this.report('ready', listed.total > listed.tools.length ? `${listed.tools.length} of ${listed.total} tools listed` : undefined, listed.tools.length)
  }

  private async relist(client: Client): Promise<void> {
    const conn = this.conn
    if (!conn || conn.client !== client || this.state !== 'ready') return
    try {
      const listed = await this.listAll(conn)
      this.trace(`tools changed, ${listed.total} tools`)
      this.publish(conn, listed)
    } catch (error) {
      this.trace(`relist failed: ${this.redact((error as Error)?.message ?? String(error))}`)
    }
  }

  private async regrant(): Promise<void> {
    if (this.closed) return
    this.kept = null
    const grant = await this.askGrant()
    if (!grant) return
    this.kept = grant
    const conn = this.conn
    if (!conn) {
      if (this.state === 'needs-grant') {
        if (grant.ok && grant.digest === this.rejectedDigest) return this.report('needs-grant', GRANT_REFUSED_LINE)
        await this.connect()
      }
      return
    }
    if (!grant.ok) {
      await this.disconnect()
      return this.report('needs-grant', grantGapsLine(grant.gaps))
    }
    if (grant.digest === conn.digest) return
    if (conn.kind !== 'stdio') {
      conn.digest = grant.digest
      return
    }
    await this.idle()
    await this.disconnect()
    await this.connect()
  }

  private idle(): Promise<void> {
    return this.inflight === 0 ? Promise.resolve() : new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private async refused(conn: Conn): Promise<void> {
    if (this.conn !== conn || conn.closing) return
    this.rejectedDigest = conn.digest
    conn.failure = GRANT_REFUSED_LINE
    this.report('needs-grant', GRANT_REFUSED_LINE)
    this.trace('the server refused the grant')
    await this.dropConn(conn)
    this.deps.unauthorized()
  }

  /** A connection that went down on its own: failed, then a restart after the backoff. */
  private crash(conn: Conn, detail: string): void {
    if (this.conn !== conn || conn.closing || this.closed) return
    conn.failure = detail
    if (conn.up && this.now() - conn.up >= (this.deps.stableMs ?? ADDON_STABLE_MS)) this.failures = 0
    this.trace(detail)
    void this.dropConn(conn)
    this.fail(detail)
  }

  private fail(detail: string): void {
    if (this.closed) return
    this.report('failed', detail)
    const steps = this.deps.backoffMs ?? ADDON_RESTART_BACKOFF_MS
    const delay = steps[Math.min(this.failures, steps.length - 1)]!
    this.failures++
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.serial(() => this.connect())
    }, delay)
    this.timer.unref?.()
  }

  private async dropConn(conn: Conn): Promise<void> {
    if (this.conn === conn) this.conn = null
    conn.closing = true
    await conn.client.close().catch(() => {})
    await conn.transport?.close().catch(() => {})
  }

  private async disconnect(): Promise<void> {
    const conn = this.conn
    if (conn) await this.dropConn(conn)
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private report(state: AddonState, detail?: string, tools = 0): void {
    if (this.closed) return
    this.state = state
    this.detail = detail === undefined ? undefined : this.redact(detail)
    this.toolCount = state === 'ready' ? tools : 0
    this.deps.status({ state, tools: this.toolCount, ...(this.detail ? { detail: this.detail } : {}), at: this.now() })
  }

  private trace(line: string): void {
    if (this.deps.trace) this.deps.log(`${this.name}: ${this.redact(line)}`)
  }
}
