import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { subscribe } from 'node:diagnostics_channel'
import { Pool, fetch as undiciFetch, type Dispatcher } from 'undici'

/**
 * The gateway's upstream connections. aliax-core's `forward` calls one
 * configured fetch for every request it sends on; this module is that fetch.
 *
 * Two paths:
 *   - api.anthropic.com (and the fake provider standing in for it) rides a
 *     keep-alive pool per (origin, account): undici's Pool with HTTP/2 when
 *     the provider negotiates it, a bounded socket count, and a free-socket
 *     TTL kept under the provider's own idle close (the server's
 *     `keep-alive: timeout=` hint, when it sends one, caps ours). A pool
 *     is keyed by the Authorization header's digest, so one account's turns
 *     share sockets and a pre-connect for an account warms that account's
 *     sockets, nobody else's.
 *   - chatgpt.com stays on Electron's `net.fetch`: Cloudflare refuses Node's
 *     TLS there, and Chromium keeps its own pool (and `ses.preconnect`).
 *
 * Every pooled request learns whether its socket had carried a request
 * before: undici publishes `undici:request:create` synchronously inside
 * `dispatch` (so the request object can be tied to the caller's trace
 * record) and `undici:client:sendHeaders` with the socket the bytes went
 * on. The gateway reads the record from `upstreamTrace` for its
 * TEMP_CODE_GATEWAY_TRACE line.
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** What one forwarded request learned about its connection. */
export interface UpstreamTrace {
  /** true: a socket that had carried a request before; false: a fresh connection; null: off the pools (Chromium's stack) or nothing sent yet. */
  reused: boolean | null
  /** TLS ALPN (`h2`, `http/1.1`), `http` for plain, null off the pools. */
  protocol: string | null
  /** The pool key the request rode (origin + account digest), null off the pools. */
  pool: string | null
  /** The request waited in the pool's queue for a busy socket (every socket of the cap was running). */
  queued: boolean
}

export const newTrace = (): UpstreamTrace => ({ reused: null, protocol: null, pool: null, queued: false })

/** Run `fn` with a trace record the upstream fetches inside it fill in. */
export const upstreamTrace = new AsyncLocalStorage<UpstreamTrace>()

export interface UpstreamOptions {
  /** Electron's `net.fetch`, for the origins Node's TLS cannot reach (chatgpt.com); Chromium pools those itself. */
  chromiumFetch: Fetch
  /** Electron's `ses.preconnect` for the same origins; nothing when absent. */
  chromiumPreconnect?: (origin: string) => void
  /** The URL as this instance reaches it (TEMP_CODE_FAKE_PROVIDERS swaps the origin). Identity by default. */
  rewrite?: (url: string) => string
  /** Which original origins ride the pools. Default: api.anthropic.com only. */
  pooled?: (origin: string) => boolean
  /** Sockets per (origin, account) pool; a request past the cap waits for one. Default 32. */
  maxSockets?: number
  /** How long a free socket is kept. Default 90 s; the server's keep-alive hint lowers it. */
  freeSocketTtlMs?: number
  /** A pool untouched this long with nothing running is closed. Default 2 × TTL. */
  idlePoolMs?: number
  /** Least time between two pre-connects of one account. Default 60 s. */
  preconnectEveryMs?: number
  /** Per-request timeouts on the pools (headers, and the gap between body bytes). Default 10 min. */
  requestTimeoutMs?: number
  now?: () => number
}

export type PreconnectOutcome =
  /** A connection was opened. */
  | 'opened'
  /** A free socket was already there; the probe refreshed its TTL. */
  | 'refreshed'
  /** This account pre-connected less than a minute ago. */
  | 'throttled'
  /** The origin is Chromium's; its preconnect was asked. */
  | 'chromium'
  | 'failed'

export interface PoolStatus {
  key: string
  origin: string
  connected: number
  free: number
  running: number
  /** ms since the pool last carried a request. */
  idleMs: number
}

const DEFAULT_POOLED = (origin: string): boolean => origin === 'https://api.anthropic.com'

/** Every provider origin a fake provider (TEMP_CODE_FAKE_PROVIDERS) stands in for. */
const PROVIDER_ORIGIN = /^https:\/\/(api\.anthropic\.com|platform\.claude\.com|claude\.ai|chatgpt\.com|auth\.openai\.com|cursor\.com)/

/** A provider URL as an instance reaches it: itself, or the fake provider's origin in its place. */
export const fakeProviderRewrite =
  (fake: string | null | undefined) =>
  (url: string): string =>
    fake ? url.replace(PROVIDER_ORIGIN, fake) : url

interface Entry {
  key: string
  origin: string
  pool: Pool
  dispatcher: Dispatcher
  lastUsed: number
}

/** The record the dispatch in flight belongs to, for the synchronous `request:create` window. */
let pending: UpstreamTrace | null = null
/** Whether the dispatch in flight made its request object (false: the pool queued it). */
let created = false
const records = new WeakMap<object, UpstreamTrace>()
/** Sockets that have carried at least one request. */
const used = new WeakSet<object>()
let subscribed = false

function subscribeOnce(): void {
  if (subscribed) return
  subscribed = true
  subscribe('undici:request:create', (message) => {
    const request = (message as { request?: object }).request
    if (!pending) return
    created = true
    if (request) records.set(request, pending)
  })
  subscribe('undici:client:sendHeaders', (message) => {
    const { request, socket } = message as { request?: object; socket?: { alpnProtocol?: string | false; encrypted?: boolean } }
    if (!request || !socket) return
    const record = records.get(request)
    if (!record) return
    record.reused = used.has(socket)
    record.protocol = socket.alpnProtocol || (socket.encrypted ? 'http/1.1' : 'http')
    used.add(socket)
  })
}

/** A short digest of the Authorization header: the pool key's account part. Never the token. */
export function authKey(headers: RequestInit['headers'] | undefined): string {
  let authorization: string | null = null
  if (!headers) authorization = null
  else if (headers instanceof Headers) authorization = headers.get('authorization')
  else if (Array.isArray(headers)) authorization = headers.find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? null
  else authorization = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? null
  if (!authorization) return 'anon'
  return createHash('sha256').update(authorization).digest('hex').slice(0, 12)
}

export class Upstream {
  private readonly pools = new Map<string, Entry>()
  private readonly lastPreconnect = new Map<string, number>()
  private sweeper: NodeJS.Timeout | null = null
  private readonly now: () => number
  private readonly rewrite: (url: string) => string
  private readonly pooled: (origin: string) => boolean
  private readonly maxSockets: number
  private readonly ttl: number
  private readonly idlePoolMs: number
  private readonly preconnectEveryMs: number
  private readonly requestTimeoutMs: number

  constructor(private readonly options: UpstreamOptions) {
    this.now = options.now ?? Date.now
    this.rewrite = options.rewrite ?? ((u) => u)
    this.pooled = options.pooled ?? DEFAULT_POOLED
    this.maxSockets = options.maxSockets ?? 32
    this.ttl = options.freeSocketTtlMs ?? 90_000
    this.idlePoolMs = options.idlePoolMs ?? this.ttl * 2
    this.preconnectEveryMs = options.preconnectEveryMs ?? 60_000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 600_000
    subscribeOnce()
  }

  /** The configured fetch aliax-core forwards through. */
  fetch: Fetch = (input, init) => {
    const origin = originOf(input)
    const target = this.rewrite(input)
    if (!origin || !this.pooled(origin)) return this.options.chromiumFetch(target, init)
    const entry = this.entryFor(new URL(target).origin, authKey(init?.headers))
    return this.send(entry, target, init)
  }

  /**
   * Open a connection for `authorization` at `origin` (an original origin,
   * before any rewrite), or refresh the free one, so the next turn does not
   * pay the handshake. One per account per minute; a `GET /` is the probe
   * (api.anthropic.com answers 404 with 132 bytes in one round trip and the
   * socket stays; a HEAD would make undici drop the socket after it).
   */
  async preconnect(origin: string, authorization: string | null): Promise<PreconnectOutcome> {
    const target = this.rewrite(origin)
    const key = `${new URL(target).origin}|${authKey(authorization ? { authorization } : undefined)}`
    const last = this.lastPreconnect.get(key)
    const now = this.now()
    if (last !== undefined && now - last < this.preconnectEveryMs) return 'throttled'
    this.lastPreconnect.set(key, now)
    if (!this.pooled(origin)) {
      this.options.chromiumPreconnect?.(new URL(target).origin)
      return 'chromium'
    }
    const entry = this.entryFor(new URL(target).origin, authKey(authorization ? { authorization } : undefined))
    const trace = newTrace()
    try {
      const res = await upstreamTrace.run(trace, () =>
        this.send(entry, `${entry.origin}/`, { method: 'GET', headers: authorization ? { authorization } : {} })
      )
      await res.arrayBuffer()
    } catch {
      return 'failed'
    }
    return trace.reused ? 'refreshed' : 'opened'
  }

  /** The pre-connect throttle, without a probe: whether one for `key` would go now. Tests and status. */
  lastPreconnectAt(origin: string, authorization: string | null): number | null {
    const key = `${new URL(this.rewrite(origin)).origin}|${authKey(authorization ? { authorization } : undefined)}`
    return this.lastPreconnect.get(key) ?? null
  }

  status(): PoolStatus[] {
    const now = this.now()
    return [...this.pools.values()].map((e) => {
      const s = e.pool.stats
      return { key: e.key, origin: e.origin, connected: s.connected, free: s.free, running: s.running, idleMs: now - e.lastUsed }
    })
  }

  /** Close pools nobody used for `idlePoolMs` with nothing in flight. Runs on a timer; callable for tests. */
  sweep(): number {
    const now = this.now()
    let closed = 0
    for (const [key, e] of this.pools) {
      const s = e.pool.stats
      if (s.running > 0 || s.pending > 0 || s.queued > 0) continue
      if (now - e.lastUsed < this.idlePoolMs) continue
      this.pools.delete(key)
      void e.pool.close().catch(() => {})
      closed++
    }
    if (this.pools.size === 0 && this.sweeper) {
      clearInterval(this.sweeper)
      this.sweeper = null
    }
    return closed
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
    const entries = [...this.pools.values()]
    this.pools.clear()
    await Promise.all(entries.map((e) => e.pool.close().catch(() => {})))
  }

  /** Cut every pool at once, requests in flight included: what a process on its way out does to its sockets. */
  async destroy(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
    const entries = [...this.pools.values()]
    this.pools.clear()
    await Promise.all(entries.map((e) => e.pool.destroy().catch(() => {})))
  }

  private entryFor(origin: string, account: string): Entry {
    const key = `${origin}|${account}`
    let entry = this.pools.get(key)
    if (entry) return entry
    const pool = new Pool(origin, {
      connections: this.maxSockets,
      pipelining: 1,
      keepAliveTimeout: this.ttl,
      keepAliveMaxTimeout: this.ttl,
      keepAliveTimeoutThreshold: 2_000,
      allowH2: true,
      headersTimeout: this.requestTimeoutMs,
      bodyTimeout: this.requestTimeoutMs
    })
    entry = { key, origin, pool, dispatcher: tracing(pool), lastUsed: this.now() }
    this.pools.set(key, entry)
    if (!this.sweeper) {
      this.sweeper = setInterval(() => this.sweep(), Math.max(1_000, Math.min(this.ttl, 60_000)))
      this.sweeper.unref()
    }
    return entry
  }

  private send(entry: Entry, url: string, init: RequestInit | undefined): Promise<Response> {
    entry.lastUsed = this.now()
    const trace = upstreamTrace.getStore()
    if (trace) {
      trace.pool = entry.key
      trace.reused = null
      trace.queued = false
    }
    // undici's RequestInit is the fetch spec's with its own Dispatcher type; the shapes core sends match.
    return undiciFetch(url, { ...(init as object), dispatcher: entry.dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>
  }
}

/**
 * The pool behind a dispatcher that pins the caller's trace record to the
 * request undici is about to create. A request the pool queues (every
 * socket of the cap running) is created later, outside this window: it
 * rides a socket that is busy now, so it counts as reused.
 */
function tracing(pool: Pool): Dispatcher {
  return new Proxy(pool, {
    get(target, prop) {
      if (prop !== 'dispatch') {
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return (opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean => {
        const record = upstreamTrace.getStore() ?? null
        pending = record
        created = false
        try {
          const dispatched = target.dispatch(opts, handler)
          if (record && !created) {
            record.queued = true
            record.reused = true
          }
          return dispatched
        } finally {
          pending = null
        }
      }
    }
  }) as Dispatcher
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}
