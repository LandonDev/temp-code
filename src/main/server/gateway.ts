import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import {
  claim,
  fail,
  forward,
  handleControl,
  isLive,
  readBody,
  readMarker,
  release,
  routeOf,
  splitPath,
  watchMarker,
  type ForwardHooks,
  type Owner,
  type RouteScope,
  type ServiceId
} from 'aliax-core'
import { SERVICE_OF, type AccountProvider } from '@shared/accounts'
import { setCodexCaCertificate } from './drivers/binaries'
import { loadTls, trustHint, type TlsMaterial } from './tls'

/**
 * temp-code's own loopback gateway. Every Claude and Codex request from a
 * child (or, once we hold the marker, from any terminal via the shim) comes
 * through here, and aliax-core's `forward` swaps the Authorization header for
 * the account Aliax pins. The forwarding, credential refresh and control
 * routes live in core; this file owns the sockets, the counters and the marker
 * rules that decide whether the shim routes to us or to Aliax.
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
const OWNER: Owner = 'temp-code'
/** TEMP_CODE_GATEWAY_TRACE=1: one log line per forwarded request (dev diagnosis). */
const TRACE = process.env.TEMP_CODE_GATEWAY_TRACE === '1'

/** Where the installed app's userData lived before the product rename, and where `dev:prod` still runs. */
const PROD_USER_DATA = join(homedir(), 'Library', 'Application Support', 'temp-code')

/**
 * Rule 2: only the app the user lives in may take the shim. The packaged app
 * and `dev:prod` always claim; a dev instance on its own userData claims only
 * with TEMP_CODE_CLAIM_SHIM=1, so a test run never hijacks live routing.
 */
export function mayClaimShim({
  isPackaged,
  env = process.env
}: {
  isPackaged: boolean
  env?: NodeJS.ProcessEnv
}): boolean {
  const userData = env.TEMP_CODE_USER_DATA
  if (!userData) return isPackaged
  if (resolve(userData) === PROD_USER_DATA) return true
  return env.TEMP_CODE_CLAIM_SHIM === '1'
}

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
}

export interface GatewayOptions {
  /** Whether this instance may write the marker at all (rule 2). */
  claimShim: boolean
  hooks?: ForwardHooks & RoutingHooks
  /** Liveness tick for the marker watcher; tests shorten it. */
  tickMs?: number
  /** Where the app keeps its own certificate when Aliax has none; no TLS without it. */
  dataDir?: string
  /** Test seam: the certificate to serve instead of reading disk. */
  tls?: TlsMaterial | null
}

export interface GatewayStatus {
  running: boolean
  port: number
  /** True while the shim routes to this process. */
  owner: boolean
  /** Who holds the marker instead of us, when someone live does. */
  standby: Owner | null
  routed: Record<string, number>
  error: string | null
  /** Whether codex threads can be given an https origin (null: no certificate). */
  tls: { caPath: string; source: TlsMaterial['source'] } | null
  /** Live per-thread https ports, thread → port. */
  scopedPorts: Record<string, number>
}

export class Gateway {
  private server: Server | null = null
  private port = 0
  private standby: Owner | null = null
  private owner = false
  private stopWatching: (() => void) | null = null
  private lastError: string | null = null
  private readonly routed: Record<string, number> = {}
  private tls: TlsMaterial | null = null
  private readonly scoped = new Map<string, { server: Server; port: number; scope: RouteScope }>()
  /** Threads whose scope's account is out, and the account they spend from instead. */
  private readonly substitutes = new Map<string, string>()

  constructor(private readonly options: GatewayOptions) {}

  /** `http://127.0.0.1:<port>/claude` and friends, for children's base URLs. */
  url(service: 'claude' | 'codex'): string | null {
    return this.server ? `http://127.0.0.1:${this.port}/${service}` : null
  }

  /** The CA a codex child must trust to reach a scoped port; null without TLS. */
  caPath(): string | null {
    return this.tls?.caPath ?? null
  }

  /**
   * An https origin of the thread's own, every request on it scoped to
   * `scope` (account and pin). The same thread keeps its port across reboots
   * of its child; a new scope for a live thread re-points the port. Null
   * without a certificate.
   */
  async scopedCodexUrl(thread: string, scope: RouteScope): Promise<string | null> {
    if (!this.server || !this.tls) return null
    const live = this.scoped.get(thread)
    if (live) {
      live.scope = scope
      return `https://127.0.0.1:${live.port}/codex`
    }
    const entry = { server: null as unknown as Server, port: 0, scope }
    const server = createTlsServer({ cert: this.tls.cert, key: this.tls.key }, (req, res) => {
      this.handle(req, res, entry.scope).catch((e) => {
        this.lastError = (e as Error).message
        fail(res, 500, this.lastError)
      })
    })
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
      if (TRACE) console.log(`[gateway] upgrade refused ${req.url}`)
      socket.end('HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\n\r\n')
    })
    entry.server = server
    entry.port = await listen(server)
    this.scoped.set(thread, entry)
    return `https://127.0.0.1:${entry.port}/codex`
  }

  /** Close a thread's port once its child is gone. */
  async releaseScoped(thread: string): Promise<void> {
    const live = this.scoped.get(thread)
    if (!live) return
    this.scoped.delete(thread)
    await close(live.server)
  }

  async start(): Promise<GatewayStatus> {
    if (this.server) return this.status()
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.lastError = (e as Error).message
        fail(res, 500, this.lastError)
      })
    })
    this.port = await listen(server)
    this.server = server
    this.tls = this.options.tls !== undefined ? this.options.tls : await this.loadTls()
    setCodexCaCertificate(this.tls?.caPath ?? null)
    if (this.options.claimShim) {
      this.claimIfFree()
      // Rule 4: notice Aliax or another temp-code arriving or leaving, and a dead owner on the tick.
      this.stopWatching = watchMarker(() => this.claimIfFree(), { tickMs: this.options.tickMs })
    }
    return this.status()
  }

  /**
   * Rules 3 and 4: take the marker unless another live temp-code holds it.
   * Aliax always yields to us (it serves in standby); a dead or missing
   * owner is ours to replace. Returns whether the shim routes to us now.
   */
  claimIfFree(): boolean {
    if (!this.server || !this.options.claimShim) return false
    const current = readMarker()
    const was = this.standby
    if (isLive(current) && current.pid !== process.pid && current.owner === OWNER) {
      this.standby = OWNER
      this.owner = false
    } else {
      this.standby = null
      this.owner = true
      // Our own live marker needs no rewrite; that would only wake other watchers.
      if (current?.pid !== process.pid || current.port !== this.port) {
        claim(OWNER, this.port)
        console.log(`[gateway] claimed the shim on :${this.port}${current && current.pid !== process.pid ? ` (was ${current.owner} pid ${current.pid})` : ''}`)
      }
    }
    if (was !== this.standby && this.standby) console.log(`[gateway] standby: another ${this.standby} holds the shim`)
    return this.owner
  }

  private async loadTls(): Promise<TlsMaterial | null> {
    if (!this.options.dataDir) return null
    try {
      const tls = await loadTls(this.options.dataDir)
      if (tls?.source === 'app') {
        console.log(`[gateway] serving https with the app's own CA (${tls.caPath}); a terminal codex pointed here needs it trusted once: ${trustHint(tls.caPath)}`)
      }
      return tls
    } catch (e) {
      this.lastError = `no TLS certificate: ${(e as Error).message}`
      console.warn(`[gateway] ${this.lastError}; codex 0.158+ cannot be routed`)
      return null
    }
  }

  /** Hand the marker back (only ever our own) and close every socket. */
  async stop(): Promise<void> {
    this.stopWatching?.()
    this.stopWatching = null
    releaseGateway()
    const server = this.server
    this.server = null
    this.port = 0
    this.owner = false
    this.standby = null
    const scoped = [...this.scoped.values()]
    this.scoped.clear()
    setCodexCaCertificate(null)
    await Promise.all([...(server ? [close(server)] : []), ...scoped.map((s) => close(s.server))])
  }

  status(): GatewayStatus {
    return {
      running: this.server !== null,
      port: this.port,
      owner: this.owner,
      standby: this.standby,
      routed: { ...this.routed },
      error: this.lastError,
      tls: this.tls ? { caPath: this.tls.caPath, source: this.tls.source } : null,
      scopedPorts: Object.fromEntries([...this.scoped].map(([t, s]) => [t, s.port]))
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse, scope?: RouteScope): Promise<void> {
    if (scope) req.url = scopedCodexPath(req.url ?? '/', scope)
    if (await handleControl(req, res, OWNER)) return
    const parsed = splitPath(req.url ?? '/')
    const serviceId = SERVICE_OF[parsed.service as AccountProvider] as ServiceId | undefined
    const out =
      parsed.scope && serviceId && this.options.hooks?.substitute
        ? await this.forwardScoped(req, res, parsed.service, serviceId, parsed.scope)
        : await this.forward(req, res)
    if (TRACE) console.log(`[gateway] ${req.method} ${req.url} → ${out.status ?? 'no upstream'}`)
    if (out.status !== null) this.routed[out.service] = (this.routed[out.service] ?? 0) + 1
  }

  private forward(req: IncomingMessage, res: ServerResponse, onResponse?: ForwardHooks['onResponse']): ReturnType<typeof forward> {
    return forward(req, res, {
      ...this.options.hooks,
      onResponse: (info) => {
        onResponse?.(info)
        this.options.hooks?.onResponse?.(info)
      },
      onError: (m) => {
        this.lastError = m
        this.options.hooks?.onError?.(m)
      }
    })
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
    const hooks = this.options.hooks!
    const url = req.url ?? '/'
    const body = ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : await readBody(req)
    const model = modelOf(body)
    const info = (account: string): ScopedRequest => ({ service, serviceId, thread: scope.thread, account, own: scope.account, model })
    let substitute = hooks.substitute!(info(routeOf(scope.thread) ?? scope.account))
    for (let attempt = 0; ; attempt++) {
      const effective: RouteScope = substitute ? { thread: scope.thread, account: substitute, pin: true } : scope
      this.noteSubstitute(service, serviceId, scope, substitute)
      let answered: string | null = null
      const held = new HeldResponse(res)
      const out = await this.forward(replay(req, rescope(url, effective), body), held as unknown as ServerResponse, (i) => {
        answered = i.account
      })
      if (held.status === 401 && hooks.onUnauthorized) {
        // Every 401 marks its account; only the first replays.
        const next = hooks.onUnauthorized(info(answered ?? effective.account))
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
    this.options.hooks?.onRouted?.({ service, serviceId, thread: scope.thread, account: substitute ?? scope.account })
  }
}

/**
 * The response forward writes to while the request may still replay: a 401
 * is kept whole (it is small) until the caller decides, anything else goes
 * straight through. Mirrors the surface forward and `fail` use.
 */
class HeldResponse {
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

const modelOf = (body: Buffer | undefined): string | null => {
  if (!body || body.length === 0) return null
  try {
    const model = JSON.parse(body.toString('utf8'))?.model
    return typeof model === 'string' ? model : null
  } catch {
    return null
  }
}

const scopeSegment = (scope: RouteScope): string =>
  `~t=${encodeURIComponent(scope.thread)};a=${encodeURIComponent(scope.account)}${scope.pin ? ';pin=1' : ''}`

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

async function listen(server: Server): Promise<number> {
  // Long model turns must not be cut off by an idle timer.
  server.requestTimeout = 0
  server.headersTimeout = 0
  server.setTimeout(0)
  await new Promise<void>((ok, bad) => {
    server.once('error', bad)
    // Loopback only: never reachable from the network.
    server.listen(0, '127.0.0.1', ok)
  })
  const address = server.address()
  return typeof address === 'object' && address ? address.port : 0
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((ok) => server.close(() => ok()))
  server.closeAllConnections?.()
}

let current: Gateway | null = null

/** The running gateway, for drivers that need its URL. */
export const gateway = (): Gateway | null => current

export async function startGateway(options: GatewayOptions): Promise<Gateway> {
  current = new Gateway(options)
  await current.start()
  return current
}

/**
 * Rule 5: give the marker back on the way out. Synchronous, so it fits an
 * `exit` handler; core only touches a marker that names this very process,
 * and restores Aliax's when that pid still runs.
 */
export function releaseGateway(): void {
  try {
    release(OWNER)
  } catch {
    // a stuck marker only means shells route nowhere until Aliax reclaims; not fatal on the way out
  }
}
