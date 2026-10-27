import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { Readable } from 'node:stream'
import {
  fail,
  forward,
  handleControl,
  readBody,
  routeOf,
  scanModel,
  splitPath,
  type AccountSource,
  type Credential,
  type ForwardHooks,
  type ForwardInput,
  type Limit,
  type LimitInfo,
  type Owner,
  type RoutedInfo,
  type RouteScope,
  type ServiceId,
  type UsageReport
} from 'aliax-core'
import { SERVICE_OF, type AccountProvider } from '@shared/accounts'
import { newTrace, upstreamTrace } from './upstream'
import { GatewayControlTimeout } from './gatewayWire'

/**
 * The gateway's byte path, wherever it runs: the listeners, the scope
 * parsing, aliax-core's forward, held 401s, warm rebinding, the per-thread
 * codex ports and the trace line. Everything it needs to know about
 * accounts it asks its `ControlPlane`: in the main process that is
 * `InProcessControl` (gatewayControl.ts, aliax-core's own reads and the
 * server's hooks), in the gateway's utility process the port to main
 * (gatewayChild.ts). The marker, TLS loading and the process around it are
 * the host's (gatewayHost.ts).
 *
 * Two kinds of listener:
 *   - one plain-http port, the marker's `url`: Aliax's shim forwards terminal
 *     traffic here (its TLS port 8789 maps /backend-api/* to /codex/* first),
 *     and the Claude driver's children carry their `~t=…;a=…` scope on this
 *     port's path (ANTHROPIC_BASE_URL keeps a path).
 *   - one https port per codex thread. Codex 0.158+ refuses an http
 *     `chatgpt_base_url`, keeps only its ORIGIN for the sampling call
 *     (<origin>/backend-api/codex/responses) and so loses any path scope; the
 *     port itself is the scope instead. Each thread's listener rewrites what
 *     arrives into the scoped path core already parses.
 */
export const OWNER: Owner = 'temp-code'

/** A scoped request and the account it is about to spend from (or just did). */
export interface ScopedRequest {
  service: string
  serviceId: ServiceId
  thread: string
  /** The account the request spends from (after any substitution or failover). */
  account: string
  /** The account the thread's own scope names. */
  own: string
  /** The request body's `model`, when it had one. */
  model: string | null
  /** On a 401: the upstream body's first bytes, for its error code (never logged, never stored). */
  body?: string
}

/**
 * The host's say over a scoped request's account, on top of core's 429
 * failover: core only moves a thread on a limit, and a dead sign-in answers
 * 401 for good, so the host keeps those accounts out of routing itself.
 */
export interface RoutingHooks {
  /** Before a scoped request goes out: the account to use instead of `account` when that one is out, else null. */
  substitute?: (info: ScopedRequest) => string | null
  /** A scoped request answered 401 under `account`: the account to replay it under, or null to pass the 401 through. */
  onUnauthorized?: (info: ScopedRequest) => string | null
  /** The upstream fetch rejected (no answer at all): the limits log keeps a `network` record of it. */
  onNetwork?: (info: NetworkInfo) => void
  /** A forwarded request went out; the registry starts the thread's provider wait on it. */
  onRequestStart?: (info: RequestInfo) => void
  /** That request is done, however it ended; the wait clears. */
  onRequestEnd?: (info: RequestInfo) => void
}

/** One forwarded request going out (`start`) or done (`end`, answered, failed or cut): the host pairs them per thread. */
export interface RequestInfo {
  id: number
  thread: string | null
  ts: number
}

/** A request that got no upstream answer: the fetch itself failed (DNS, TLS, a reset, a timeout). */
export interface NetworkInfo {
  service: string
  /** The request's path, scope included. */
  path: string
  /** The account the request was scoped to, when it was. */
  account: string | null
  /** The fetch error's message. */
  error: string
}

/** A short, stable stand-in for an account name in logs: six hex digits of its SHA-1. */
export function shortHash(name: string): string {
  return createHash('sha1').update(name).digest('hex').slice(0, 6)
}

/** The trace lines behind TEMP_CODE_GATEWAY_TRACE: one `start` before the
 *  forward and one finish after it, joined by the request's number. */
export interface TraceStart {
  id: number
  method: string
  url: string
  thread: string | null
  account: string | null
  model: string | null
}

export function traceLine(label: string, stage: 'start', rec: TraceStart): string
export function traceLine(label: string, stage: 'finish', rec: TraceStart & { status: number | null; reused: string; protocol: string | null; ms: number }): string
export function traceLine(label: string, stage: 'start' | 'finish', rec: TraceStart & { status?: number | null; reused?: string; protocol?: string | null; ms?: number }): string {
  const head = `${label} #${rec.id} ${rec.method} ${rec.url}`
  if (stage === 'start') {
    return `${head} start thread=${rec.thread ?? '-'} account=${rec.account ? shortHash(rec.account) : '-'} model=${rec.model ?? '-'}`
  }
  return `${head} → ${rec.status ?? 'no upstream'} reused=${rec.reused}${rec.protocol ? ` ${rec.protocol}` : ''} ${rec.ms}ms`
}

/** Core's word on one upstream answer, before its body streams back. */
export type ResponseInfo = Parameters<NonNullable<ForwardHooks['onResponse']>>[0]
export type FailedOverInfo = Parameters<NonNullable<ForwardHooks['onFailedOver']>>[0]

/**
 * Everything the gateway asks of its host. The account reads are core's
 * AccountSource under the names the host speaks; the rest are the routing
 * hooks. Every ask is async so the same core runs against a host in another
 * process; the reports (`onResponse` and below) are fire and forget.
 */
export interface ControlPlane {
  /** The credential for `service` under `account`, the pinned account's for null. */
  credentialFor(service: string, account: string | null): Promise<Credential | null>
  /** The saved accounts of a service. */
  profilesKnown(serviceId: ServiceId): Promise<string[]>
  /** The account unscoped (terminal) traffic spends from. */
  pinned(serviceId: ServiceId): Promise<string | null>
  /** The usage report on file for one account, however old. */
  usageReport(serviceId: ServiceId, name: string): Promise<UsageReport | undefined>
  /** The /__aliax/usage poll a standby forwards its Refresh to. */
  usage(serviceId: ServiceId, force: boolean): Promise<UsageReport[]>
  substitute(info: ScopedRequest): Promise<string | null>
  onUnauthorized(info: ScopedRequest): Promise<string | null>
  /** A real limit: the account to replay under. Absent, a 429 passes through and nothing is charged (core's rule). */
  pickNext?(info: LimitInfo): Promise<string | null>
  /** A 429 charged one of the account's windows. */
  observeLimit(serviceId: ServiceId, name: string, limit: Limit): void
  /** Unscoped failover moved the pin. */
  pin(serviceId: ServiceId, name: string): Promise<void>
  onResponse(info: ResponseInfo): void
  onRouted(info: RoutedInfo): void
  onFailedOver(info: FailedOverInfo): void
  onError(message: string): void
  /** The upstream fetch rejected; absent on a host that keeps no record. */
  onNetwork?(info: NetworkInfo): void
  onRequestStart?(info: RequestInfo): void
  onRequestEnd?(info: RequestInfo): void
}

export interface GatewayCoreOptions {
  control: ControlPlane
  /** The certificate the codex ports present; no codex ports without it. */
  tls: { cert: Buffer | string; key: Buffer | string } | null
  /** One line per forwarded request (TEMP_CODE_GATEWAY_TRACE=1). */
  trace?: boolean
  /** The prefix of every line this core logs. */
  label?: string
  /** The pid the liveness answer (`/__aliax`) names: the marker's, which is the host's. */
  pid?: number
}

export interface CoreStatus {
  port: number
  routed: Record<string, number>
  error: string | null
  /** Live per-thread https ports, thread → port. */
  scopedPorts: Record<string, number>
}

export class GatewayCore {
  private server: Server | null = null
  private port = 0
  private lastError: string | null = null
  private readonly routed: Record<string, number> = {}
  private readonly scoped = new Map<string, { server: Server; port: number; scope: RouteScope }>()
  /** Codex ports being opened, so two asks for one thread open one port. */
  private readonly opening = new Map<string, Promise<number | null>>()
  /** Threads whose scope's account is out, and the account they spend from instead. */
  private readonly substitutes = new Map<string, string>()
  /** Warm Claude processes by id, and the thread scope each was adopted for (null until adopted). */
  private readonly warm = new Map<string, RouteScope | null>()
  private readonly accounts: AccountSource
  private readonly trace: boolean
  private readonly label: string
  /** Numbers the trace lines, so a start and its finish read together. */
  private requestSeq = 0
  /** Bumped whenever routed or the error changes, for a host that mirrors them. */
  onStats: (() => void) | null = null

  constructor(private readonly options: GatewayCoreOptions) {
    const c = options.control
    this.trace = options.trace ?? process.env.TEMP_CODE_GATEWAY_TRACE === '1'
    this.label = options.label ?? '[gateway]'
    this.accounts = {
      credentialFor: (service, account) => c.credentialFor(service, account),
      hasProfile: async (serviceId, name) => (await c.profilesKnown(serviceId)).includes(name),
      pinned: (serviceId) => c.pinned(serviceId),
      report: (serviceId, name) => c.usageReport(serviceId, name),
      observeLimit: (serviceId, name, limit) => c.observeLimit(serviceId, name, limit),
      pin: (serviceId, name) => c.pin(serviceId, name)
    }
  }

  /** Bind the plain port: `port` when given (a respawn keeps its number), else any free one. */
  async listen(port = 0): Promise<number> {
    if (this.server) return this.port
    const server = createServer((req, res) => this.serve(req, res))
    this.port = await listen(server, port)
    this.server = server
    return this.port
  }

  get listening(): boolean {
    return this.server !== null
  }

  /** `http://127.0.0.1:<port>/claude` and friends, for children's base URLs. */
  url(service: 'claude' | 'codex'): string | null {
    return this.server ? `http://127.0.0.1:${this.port}/${service}` : null
  }

  /** A warm process is waiting under `id`: unscoped (the pinned account) until a thread adopts it. */
  setWarm(id: string): void {
    this.warm.set(id, this.warm.get(id) ?? null)
  }

  /** The warm process `id` now belongs to the thread `scope` names: its requests spend from that account from here on. */
  adoptWarm(id: string, scope: RouteScope | null): void {
    this.warm.set(id, scope)
  }

  /** The warm process is gone (retired, dead, or its thread's child ended): nothing maps the id any more. */
  releaseWarm(id: string): void {
    this.warm.delete(id)
  }

  /** Warm ids and whether each is adopted, for status. */
  warmIds(): { id: string; thread: string | null }[] {
    return [...this.warm].map(([id, scope]) => ({ id, thread: scope?.thread ?? null }))
  }

  /**
   * The thread's own https port, every request on it scoped to `scope`
   * (account and pin). The same thread keeps its port across reboots of its
   * child; a new scope for a live thread re-points the port. `port` asks for
   * a number (a respawn rebinding what the thread's child already holds);
   * null without a certificate.
   */
  async scopedCodexPort(thread: string, scope: RouteScope, port = 0): Promise<number | null> {
    if (!this.server || !this.options.tls) return null
    const live = this.scoped.get(thread)
    if (live) {
      live.scope = scope
      return live.port
    }
    const opening = this.opening.get(thread)
    if (opening) {
      const opened = await opening
      const entry = this.scoped.get(thread)
      if (entry) entry.scope = scope
      return opened
    }
    const run = this.openScoped(thread, scope, port).finally(() => this.opening.delete(thread))
    this.opening.set(thread, run)
    return run
  }

  private async openScoped(thread: string, scope: RouteScope, port: number): Promise<number | null> {
    const tls = this.options.tls!
    const entry = { server: null as unknown as Server, port: 0, scope }
    const server = createTlsServer({ cert: tls.cert, key: tls.key }, (req, res) => this.serve(req, res, entry))
    // Codex 0.162 first opens a WebSocket to its origin for the sampling
    // stream. The gateway speaks HTTP only (the account swap, limit replay
    // and routed counters live in core's forward), so the upgrade is refused
    // at once and codex falls back to its HTTP stream in the same turn with
    // nothing to show for it (one "upgrade refused" trace line, no rows:
    // measured 2026-10-12 against 0.162.1). Left unanswered, as Aliax's
    // shim did, the socket hangs until codex's connect timeout. The
    // "Reconnecting… n/5" rows threads showed were something else: codex
    // retrying a 401 from its account check (`workspace routing discovery`),
    // which the scoped replay in forwardScoped now answers elsewhere.
    server.on('upgrade', (req, socket) => {
      if (this.trace) console.log(`${this.label} upgrade refused ${req.url}`)
      socket.end('HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\n\r\n')
    })
    entry.server = server
    entry.port = await listen(server, port)
    this.scoped.set(thread, entry)
    return entry.port
  }

  /** Close a thread's port once its child is gone. */
  async releaseScoped(thread: string): Promise<void> {
    await this.opening.get(thread)?.catch(() => null)
    const live = this.scoped.get(thread)
    if (!live) return
    this.scoped.delete(thread)
    await close(live.server)
  }

  status(): CoreStatus {
    return {
      port: this.port,
      routed: { ...this.routed },
      error: this.lastError,
      scopedPorts: Object.fromEntries([...this.scoped].map(([t, s]) => [t, s.port]))
    }
  }

  /** Close every socket; streams in flight are cut. */
  async close(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = 0
    const scoped = [...this.scoped.values()]
    this.scoped.clear()
    await Promise.all([...(server ? [close(server)] : []), ...scoped.map((s) => close(s.server))])
  }

  private serve(req: IncomingMessage, res: ServerResponse, entry?: { scope: RouteScope }): void {
    this.handle(req, res, entry?.scope).catch((e) => {
      this.noteError((e as Error).message)
      if (e instanceof GatewayControlTimeout && e.method === 'credentialFor') {
        this.options.control.onError(e.message)
        const parsed = splitPath(req.url ?? '/')
        this.options.control.onNetwork?.({ service: parsed.service, path: req.url ?? '/', account: parsed.scope?.account ?? null, error: e.message })
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'credential_timeout', message: 'The gateway could not get a credential in time' } }))
      } else fail(res, 500, (e as Error).message)
    })
  }

  private noteError(message: string): void {
    this.lastError = message
    this.onStats?.()
  }

  private async handle(req: IncomingMessage, res: ServerResponse, scope?: RouteScope): Promise<void> {
    if (scope) req.url = scopedCodexPath(req.url ?? '/', scope)
    else req.url = rebindWarmPath(req.url ?? '/', (id) => this.warm.get(id))
    const c = this.options.control
    if (await handleControl(req, res, OWNER, { pid: this.options.pid, usage: (serviceId, force) => c.usage(serviceId, force) })) return
    const parsed = splitPath(req.url ?? '/')
    const serviceId = SERVICE_OF[parsed.service as AccountProvider] as ServiceId | undefined
    const rec: TraceStart = {
      id: ++this.requestSeq,
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      thread: parsed.scope?.thread ?? null,
      account: parsed.scope?.account ?? null,
      model: parsed.scope?.model ?? null
    }
    const startedAt = Date.now()
    if (this.trace) console.log(traceLine(this.label, 'start', rec))
    const request: RequestInfo = { id: rec.id, thread: rec.thread, ts: startedAt }
    c.onRequestStart?.(request)
    // The upstream fetch fills the trace record in: whether the request rode
    // a socket that had carried one before, and over which protocol.
    const trace = newTrace()
    let out: Awaited<ReturnType<typeof forward>>
    try {
      out = await upstreamTrace.run(trace, () =>
        parsed.scope && serviceId ? this.forwardScoped(req, res, parsed.service, serviceId, parsed.scope) : this.forward(req, res)
      )
    } finally {
      c.onRequestEnd?.(request)
    }
    if (this.trace) {
      const reused = trace.reused === null ? 'n/a' : trace.queued ? 'true (queued)' : String(trace.reused)
      console.log(traceLine(this.label, 'finish', { ...rec, status: out.status, reused, protocol: trace.protocol, ms: Date.now() - startedAt }))
    }
    if (out.status !== null) {
      this.routed[out.service] = (this.routed[out.service] ?? 0) + 1
      this.onStats?.()
    }
  }

  private forward(req: IncomingMessage, res: ServerResponse, onResponse?: ForwardHooks['onResponse'], input?: ForwardInput): ReturnType<typeof forward> {
    const c = this.options.control
    const url = req.url ?? '/'
    return forward(
      req,
      res,
      {
        accounts: this.accounts,
        ...(c.pickNext ? { pickNext: (info: LimitInfo) => c.pickNext!(info) } : {}),
        onRouted: (info) => c.onRouted(info),
        onFailedOver: (info) => c.onFailedOver(info),
        onResponse: (info) => {
          onResponse?.(info)
          c.onResponse(info)
        },
        onError: (m) => {
          this.noteError(m)
          c.onError(m)
          // No upstream answer at all: the host's limits log keeps the record.
          const parsed = splitPath(url)
          c.onNetwork?.({ service: parsed.service, path: url, account: parsed.scope?.account ?? null, error: m })
        }
      },
      input
    )
  }

  /**
   * A scoped request spends from the account its scope names (or where core's
   * 429 failover moved the thread) unless the host says that account is out:
   * then it goes out under the substitute, as a pin, so core drops any
   * override it held for the thread. A 401 is held back and the same bytes
   * replay once under whatever the host names next; with nothing to name the
   * 401 goes through as it came.
   */
  private async forwardScoped(req: IncomingMessage, res: ServerResponse, service: string, serviceId: ServiceId, scope: RouteScope): ReturnType<typeof forward> {
    const c = this.options.control
    const url = req.url ?? '/'
    // One Buffer, kept for the replays; the model is read off its first bytes
    // (a side call on another model), else off the scope the driver wrote.
    const body = ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : await readBody(req)
    const model = scanModel(body) ?? scope.model ?? null
    const info = (account: string, body?: string): ScopedRequest => ({ service, serviceId, thread: scope.thread, account, own: scope.account, model, ...(body !== undefined ? { body } : {}) })
    let substitute = await c.substitute(info(routeOf(scope.thread) ?? scope.account))
    for (let attempt = 0; ; attempt++) {
      const effective: RouteScope = substitute ? { thread: scope.thread, account: substitute, pin: true } : scope
      this.noteSubstitute(service, serviceId, scope, substitute)
      let answered: string | null = null
      const held = new HeldResponse(res)
      const out = await this.forward(
        replay(req, rescope(url, effective), body),
        held as unknown as ServerResponse,
        (i) => {
          answered = i.account
        },
        { body, model }
      )
      if (held.status === 401) {
        // Every 401 marks its account; only the first replays.
        const next = await c.onUnauthorized(info(answered ?? effective.account, held.heldText()))
        if (attempt === 0 && next && next !== effective.account) {
          substitute = next
          continue
        }
      }
      held.flush()
      return out
    }
  }

  /** The thread's row follows the account it spends from, once per change. */
  private noteSubstitute(service: string, serviceId: ServiceId, scope: RouteScope, substitute: string | null): void {
    const was = this.substitutes.get(scope.thread) ?? null
    if (was === substitute) return
    if (substitute) this.substitutes.set(scope.thread, substitute)
    else this.substitutes.delete(scope.thread)
    this.options.control.onRouted({ service, serviceId, thread: scope.thread, account: substitute ?? scope.account })
  }
}

/**
 * The response forward writes to while the request may still replay: a 401
 * is kept whole (it is small) until the caller decides, anything else goes
 * straight through. Mirrors the surface forward and `fail` use.
 */
export class HeldResponse {
  status: number | null = null
  private held: { headers: Record<string, string>; chunks: Buffer[] } | null = null
  private through = false

  constructor(private readonly res: ServerResponse) {}

  get headersSent(): boolean {
    return this.through ? this.res.headersSent : this.held !== null
  }

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status
    if (status === 401) this.held = { headers, chunks: [] }
    else {
      this.through = true
      this.res.writeHead(status, headers)
    }
    return this
  }

  write(chunk: Buffer | string): boolean {
    if (this.held) {
      this.held.chunks.push(Buffer.from(chunk))
      return true
    }
    return this.res.write(chunk)
  }

  once(event: string, fn: () => void): this {
    if (this.held) fn()
    else this.res.once(event, fn)
    return this
  }

  end(data?: Buffer | string): this {
    if (this.held) {
      if (data) this.held.chunks.push(Buffer.from(data))
      return this
    }
    this.res.end(data)
    return this
  }

  /** The held 401 body so far, capped, for its error code. */
  heldText(): string | undefined {
    if (!this.held) return undefined
    return Buffer.concat(this.held.chunks).subarray(0, 4096).toString('utf8')
  }

  /** Send what was held, if anything was. */
  flush(): void {
    if (!this.held) return
    const { headers, chunks } = this.held
    this.held = null
    this.through = true
    this.res.writeHead(401, headers)
    this.res.end(Buffer.concat(chunks))
  }
}

/** A request forward can read again: the original's line and headers over a buffered body. */
function replay(req: IncomingMessage, url: string, body: Buffer | undefined): IncomingMessage {
  return Object.assign(Readable.from(body ? [body] : []), { url, method: req.method, headers: req.headers }) as unknown as IncomingMessage
}

const scopeSegment = (scope: RouteScope): string =>
  `~t=${encodeURIComponent(scope.thread)};a=${encodeURIComponent(scope.account)}${scope.pin ? ';pin=1' : ''}${scope.model ? `;m=${encodeURIComponent(scope.model)}` : ''}`

/** The same scoped path under another scope: `/codex/~t=T;a=A/rest` → `/codex/~t=T;a=B;pin=1/rest`. */
export function rescope(url: string, scope: RouteScope): string {
  const slash = url.indexOf('/', 1)
  const service = url.slice(1, slash === -1 ? undefined : slash)
  const rest = slash === -1 ? '' : url.slice(slash)
  if (!rest.startsWith('/~')) return url
  const end = rest.indexOf('/', 1)
  return `/${service}/${scopeSegment(scope)}${end === -1 ? '' : rest.slice(end)}`
}

/**
 * A warm process's path, `/claude/~w=<id>/<rest>`, as core parses it: the
 * adopted scope's segment in place of the warm one, or no segment at all
 * (unscoped: the pinned account) while nothing has adopted the id or the id
 * is unknown. Any other path is left alone.
 */
export function rebindWarmPath(url: string, scopeOf: (id: string) => RouteScope | null | undefined): string {
  const slash = url.indexOf('/', 1)
  const service = url.slice(1, slash === -1 ? undefined : slash)
  const rest = slash === -1 ? '' : url.slice(slash)
  if (!rest.startsWith('/~w=')) return url
  const end = rest.indexOf('/', 1)
  const id = decodeURIComponent(rest.slice(4, end === -1 ? undefined : end))
  const tail = end === -1 ? '' : rest.slice(end)
  const scope = scopeOf(id)
  return scope ? `/${service}/${scopeSegment(scope)}${tail}` : `/${service}${tail}`
}

/**
 * What a codex 0.158+ child sends a scoped port, rewritten into the path
 * core parses (`/codex/~t=…;a=…[;pin=1]/<upstream>`):
 *   /backend-api/codex/responses    the sampling call, addressed to the ORIGIN
 *   /backend-api/wham/…             account endpoints, same
 *   /codex/api/codex/accounts/check the base (with its /codex path) plus what
 *                                   core already maps onto /wham
 *   /codex/~t=…/…                   an older codex that kept a path scope: left alone
 * Control paths (/__aliax) pass through unscoped.
 */
export function scopedCodexPath(url: string, scope: RouteScope): string {
  if (url === '/__aliax' || url.startsWith('/__aliax/') || url.startsWith('/__aliax?')) return url
  let rest = url
  if (rest === '/backend-api' || rest.startsWith('/backend-api/')) rest = rest.slice('/backend-api'.length)
  else if (rest === '/codex' || rest.startsWith('/codex/')) rest = rest.slice('/codex'.length)
  if (rest.startsWith('/~')) return `/codex${rest}`
  return `/codex/${scopeSegment(scope)}${rest}`
}

async function listen(server: Server, port: number): Promise<number> {
  // Long model turns must not be cut off by an idle timer.
  server.requestTimeout = 0
  server.headersTimeout = 0
  server.setTimeout(0)
  await new Promise<void>((ok, bad) => {
    server.once('error', bad)
    // Loopback only: never reachable from the network.
    server.listen(port, '127.0.0.1', ok)
  })
  const address = server.address()
  return typeof address === 'object' && address ? address.port : 0
}

async function close(server: Server): Promise<void> {
  const closed = new Promise<void>((ok) => server.close(() => ok()))
  // Keep-alive and streaming sockets would hold close() open: cut them now.
  server.closeAllConnections?.()
  await closed
}
