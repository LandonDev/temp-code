import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
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
  type Owner
} from 'aliax-core'

/**
 * temp-code's own loopback gateway. Every Claude and Codex request from a
 * child (or, once we hold the marker, from any terminal via the shim) comes
 * through here, and aliax-core's `forward` swaps the Authorization header for
 * the account Aliax pins. The forwarding, credential refresh and control
 * routes live in core; this file owns the socket, the counters and the marker
 * rules that decide whether the shim routes to us or to Aliax.
 */
const OWNER: Owner = 'temp-code'

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
}

export class Gateway {
  private server: Server | null = null
  private port = 0
  private standby: Owner | null = null
  private owner = false
  private stopWatching: (() => void) | null = null
  private lastError: string | null = null
  private readonly routed: Record<string, number> = {}

  constructor(private readonly options: GatewayOptions) {}

  /** `http://127.0.0.1:<port>/claude` and friends, for children's base URLs. */
  url(service: 'claude' | 'codex'): string | null {
    return this.server ? `http://127.0.0.1:${this.port}/${service}` : null
  }

  async start(): Promise<GatewayStatus> {
    if (this.server) return this.status()
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.lastError = (e as Error).message
        fail(res, 500, this.lastError)
      })
    })
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
    this.port = typeof address === 'object' && address ? address.port : 0
    this.server = server
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

  /** Hand the marker back (only ever our own) and close the socket. */
  async stop(): Promise<void> {
    this.stopWatching?.()
    this.stopWatching = null
    releaseGateway()
    const server = this.server
    this.server = null
    this.port = 0
    this.owner = false
    this.standby = null
    if (server) {
      await new Promise<void>((ok) => server.close(() => ok()))
      server.closeAllConnections?.()
    }
  }

  status(): GatewayStatus {
    return {
      running: this.server !== null,
      port: this.port,
      owner: this.owner,
      standby: this.standby,
      routed: { ...this.routed },
      error: this.lastError
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (await handleControl(req, res, OWNER)) return
    const out = await forward(req, res, {
      ...this.options.hooks,
      onError: (m) => {
        this.lastError = m
        this.options.hooks?.onError?.(m)
      }
    })
    if (out.status !== null) this.routed[out.service] = (this.routed[out.service] ?? 0) + 1
  }
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
