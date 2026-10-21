import { createHash } from 'node:crypto'
import { WebSocket } from 'ws'
import type { PeerState } from '@shared/accounts'
import { allows } from '@shared/capabilities'
import type { ServerFrame, ServerPush } from '@shared/contract'
import type { SavedEnvironment } from '@shared/contract-remote'
import { ENVIRONMENTS_PREFIX, listEnvironments, mintTicket, type HostContext } from './environments'

/**
 * The main process's own sockets to the hosts it shares accounts with
 * (thread V). The renderer's links (lib/connection) carry the UI; these
 * carry credentials, which never cross a renderer. One link per saved
 * environment whose key holds admin, kept up with a capped backoff and
 * authenticated by a 30 s ticket minted from the saved key, the same way
 * the renderer connects. A request is one frame with an id and its answer
 * comes back by id; a push from the host (an `account` rotation) goes to
 * `onPush`. The hello frame is checked against the saved environment id.
 */
export interface PeerEvents {
  onOpen?: (id: string) => void
  onClose?: (id: string) => void
  onPush?: (id: string, push: ServerPush) => void
}

export const PEER_BACKOFF_MS = [2_000, 5_000, 15_000, 60_000, 300_000]
export const PEER_REQUEST_TIMEOUT_MS = 30_000
const HELLO_TIMEOUT_MS = 10_000
/** The listener's close code for a revoked key: no retry until the environment is saved again. */
const KEY_REVOKED = 4001

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }

/** A digest of the environment's saved key, never the key: a re-pair that kept the routes still reads as a change. */
function keyFingerprint(store: HostContext['store'], id: string): string | null {
  const raw = store.getSetting(`${ENVIRONMENTS_PREFIX}${id}`)
  if (!raw) return null
  try {
    const key = (JSON.parse(raw) as { key?: unknown }).key
    return typeof key === 'string' ? createHash('sha256').update(key).digest('hex').slice(0, 16) : null
  } catch {
    return null
  }
}

export class PeerLink {
  private ws: WebSocket | null = null
  private readonly pending = new Map<string, Pending>()
  private seq = 0
  private timer: NodeJS.Timeout | null = null
  private closed = false
  attempts = 0
  connected = false
  lastError: string | null = null
  lastSyncAt: number | null = null

  /** Of the key the link was made with (keyFingerprint); a new key means a new link. */
  readonly credential: string | null

  constructor(
    readonly env: SavedEnvironment,
    private readonly ctx: HostContext,
    private readonly events: PeerEvents,
    private readonly log: (line: string) => void = () => {}
  ) {
    this.credential = keyFingerprint(ctx.store, env.id)
  }

  get id(): string {
    return this.env.id
  }

  /** Try every route once, best first; schedule a retry when none opened. */
  async connect(): Promise<void> {
    if (this.closed || this.ws) return
    for (const route of this.env.routes) {
      try {
        const { ticket } = await mintTicket(this.ctx, this.env.id, route.url)
        await this.open(`${route.url}?ticket=${encodeURIComponent(ticket)}`)
        this.attempts = 0
        this.lastError = null
        this.log(`${this.env.name}: connected over ${route.kind}`)
        this.events.onOpen?.(this.env.id)
        return
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err)
      }
    }
    this.scheduleRetry()
  }

  private open(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      let settled = false
      const hello = setTimeout(() => {
        if (settled) return
        settled = true
        ws.terminate()
        reject(new Error('no hello frame'))
      }, HELLO_TIMEOUT_MS)
      ws.on('message', (data) => {
        let frame: ServerFrame
        try {
          frame = JSON.parse(String(data)) as ServerFrame
        } catch {
          return
        }
        if ('push' in frame) {
          if (frame.push === 'hello') {
            if (settled) return
            settled = true
            clearTimeout(hello)
            if (frame.environmentId !== this.env.id) {
              ws.close(4000, 'wrong host')
              reject(new Error(`${this.env.name} answered as ${frame.environmentId}`))
              return
            }
            this.ws = ws
            this.connected = true
            resolve()
            return
          }
          if (settled && this.ws === ws) this.events.onPush?.(this.env.id, frame)
          return
        }
        const p = this.pending.get(frame.id)
        if (!p) return
        this.pending.delete(frame.id)
        clearTimeout(p.timer)
        if (frame.ok) p.resolve(frame.result)
        else p.reject(new Error(frame.error))
      })
      ws.on('error', (err) => {
        if (settled) {
          this.lastError = err.message
          return
        }
        settled = true
        clearTimeout(hello)
        reject(err)
      })
      ws.on('close', (code, reason) => {
        if (!settled) {
          settled = true
          clearTimeout(hello)
          reject(new Error(`closed before hello (${code} ${reason.toString()})`))
          return
        }
        if (this.ws !== ws) return
        this.ws = null
        this.connected = false
        this.failPending(new Error(`${this.env.name} closed the socket`))
        this.log(`${this.env.name}: closed (${code})`)
        this.events.onClose?.(this.env.id)
        if (code === KEY_REVOKED) this.lastError = 'key revoked'
        else this.scheduleRetry()
      })
    })
  }

  private failPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
      this.pending.delete(id)
    }
  }

  /** One request; `timeoutMs` raises the 30 s default for a call that carries a lot (a harness.file chunk). */
  request<T = unknown>(method: string, params?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    const ws = this.ws
    if (!ws || !this.connected) return Promise.reject(new Error(`${this.env.name} is not connected`))
    const id = `p${++this.seq}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} on ${this.env.name} timed out`))
      }, opts.timeoutMs ?? PEER_REQUEST_TIMEOUT_MS)
      timer.unref()
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  private scheduleRetry(): void {
    if (this.closed || this.timer) return
    const delay = PEER_BACKOFF_MS[Math.min(this.attempts, PEER_BACKOFF_MS.length - 1)]
    this.attempts++
    this.timer = setTimeout(
      () => {
        this.timer = null
        void this.connect()
      },
      delay + Math.random() * 1_000
    )
    this.timer.unref()
  }

  /** Connect now (an explicit retry, or the host is back); nothing changes while a socket is up. */
  retry(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.attempts = 0
    void this.connect()
  }

  state(): PeerState {
    return { name: this.env.name, connected: this.connected, lastSyncAt: this.lastSyncAt, error: this.lastError }
  }

  close(): void {
    this.closed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const ws = this.ws
    this.ws = null
    this.connected = false
    ws?.close(1000, 'bye')
    this.failPending(new Error('link closed'))
  }
}

export class Peers {
  private readonly links = new Map<string, PeerLink>()

  constructor(
    private readonly ctx: HostContext,
    private readonly events: PeerEvents,
    private readonly log: (line: string) => void = (line) => console.log(`[peers] ${line}`)
  ) {}

  /**
   * Match the saved environments: a link per admin host, closed when the host
   * is removed, and rebuilt when its routes or its key change. A re-pair
   * after a revoked key keeps the routes, so the key counts too: the old
   * link stopped retrying on the 4001 close and would stay down for good.
   */
  refresh(): void {
    const wanted = new Map(
      listEnvironments(this.ctx.store)
        .filter((e) => allows(e.caps, 'admin'))
        .map((e) => [e.id, e] as const)
    )
    for (const [id, link] of this.links) {
      if (wanted.has(id)) continue
      link.close()
      this.links.delete(id)
    }
    for (const [id, env] of wanted) {
      const live = this.links.get(id)
      if (live && JSON.stringify(live.env.routes) === JSON.stringify(env.routes) && live.credential === keyFingerprint(this.ctx.store, id)) continue
      if (live) this.log(`${env.name}: ${live.credential === keyFingerprint(this.ctx.store, id) ? 'routes' : 'key'} changed, reconnecting`)
      live?.close()
      const link = new PeerLink(env, this.ctx, this.events, this.log)
      this.links.set(id, link)
      void link.connect()
    }
  }

  get(id: string): PeerLink | undefined {
    return this.links.get(id)
  }

  all(): PeerLink[] {
    return [...this.links.values()]
  }

  states(): Record<string, PeerState> {
    return Object.fromEntries(this.all().map((l) => [l.id, l.state()]))
  }

  close(): void {
    for (const link of this.links.values()) link.close()
    this.links.clear()
  }
}
