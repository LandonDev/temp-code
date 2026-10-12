import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  claim,
  fail,
  forward,
  handleControl,
  isLive,
  readMarker,
  release,
  watchMarker,
  type ForwardHooks,
  type Owner,
  type RouteScope
} from 'aliax-core'
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

export interface GatewayOptions {
  /** Whether this instance may write the marker at all (rule 2). */
  claimShim: boolean
  hooks?: ForwardHooks
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
    // at once and codex falls back to its HTTP stream in the same turn. Left
    // unanswered, the socket hung until codex's connect timeout, four times
    // over, each surfacing as a "Reconnecting… n/5" error row in the thread.
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
    const out = await forward(req, res, {
      ...this.options.hooks,
      onError: (m) => {
        this.lastError = m
        this.options.hooks?.onError?.(m)
      }
    })
    if (TRACE) console.log(`[gateway] ${req.method} ${req.url} → ${out.status ?? 'no upstream'}`)
    if (out.status !== null) this.routed[out.service] = (this.routed[out.service] ?? 0) + 1
  }
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
  const segment = `~t=${encodeURIComponent(scope.thread)};a=${encodeURIComponent(scope.account)}${scope.pin ? ';pin=1' : ''}`
  return `/codex/${segment}${rest}`
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
