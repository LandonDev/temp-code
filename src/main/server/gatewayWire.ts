import type { Limit, LimitInfo, RoutedInfo, RouteScope, ServiceId, UsageReport } from 'aliax-core'
import type { FailedOverInfo, NetworkInfo, RequestInfo, ResponseInfo, ScopedRequest } from './gatewayCore'

/**
 * What main and the gateway's utility process say to each other over one
 * MessagePortMain (gatewayHost.ts ↔ gatewayChild.ts). Main owns the
 * accounts (the vault, the Keychain, refresh, the pin, the usage cache, the
 * routing hooks); the child owns the sockets. Everything here crosses by
 * structured clone, so it is plain data: headers travel as pairs, errors as
 * their message.
 */

/** One end of the port, whatever carries it: Electron's MessagePortMain, or a pair in a test. */
export interface Wire {
  post(message: WireMessage): void
  onMessage(fn: (message: WireMessage) => void): void
  onClose(fn: () => void): void
  close(): void
}

/** Electron's MessagePortMain as the adapter needs it: a message arrives as `{ data }`. */
export interface PortLike {
  postMessage(message: unknown): void
  on(event: 'message', fn: (e: { data: unknown }) => void): unknown
  on(event: 'close', fn: () => void): unknown
  start(): void
  close(): void
}

export function portWire(port: PortLike): Wire {
  const wire: Wire = {
    post: (message) => port.postMessage(message),
    onMessage: (fn) => void port.on('message', (e) => fn(e.data as WireMessage)),
    onClose: (fn) => void port.on('close', fn),
    close: () => port.close()
  }
  port.start()
  return wire
}

/** An account a 401 took out of routing (or whose sign-in is dead), and when the mark lapses (null: until a report says otherwise). */
export interface OutMark {
  serviceId: ServiceId
  name: string
  until: number | null
}

/** Main's copy of the accounts, as much as the child's forward reads: pushed whole on every change. */
export interface AccountsState {
  profiles: Partial<Record<ServiceId, string[]>>
  pinned: Partial<Record<ServiceId, string | null>>
  /** By `serviceId:name`. */
  reports: Record<string, UsageReport>
  out: OutMark[]
}

export interface StartState {
  /** The plain port to bind; 0 the first time, the same number on every respawn. */
  port: number
  /** Each codex thread's port and scope, rebound on a respawn so its child's base URL stays valid. */
  scoped: { thread: string; port: number; scope: RouteScope }[]
  /** Warm Claude processes and the scope each was adopted for. */
  warm: { id: string; scope: RouteScope | null }[]
  tls: { cert: string; key: string } | null
  seams: {
    /** TEMP_CODE_GATEWAY_TRACE=1 */
    trace: boolean
    /** TEMP_CODE_FAKE_PROVIDERS, as main honours it (isolated instances only). */
    fakeProviders: string | null
    /** TEMP_CODE_GATEWAY_ROLE=owner, as main honours it. */
    role: 'owner' | null
  }
  /** The marker's pid: the liveness answer names it, and the child exits when it is gone. */
  mainPid: number
  accounts: AccountsState
}

/** A forwarded answer's word for main's hooks: only the limit headers they read. */
export type WireResponse = Omit<ResponseInfo, 'headers'> & { headers: [string, string][] }

const KEPT = new Set(['retry-after', 'request-id', 'content-type'])

/** The headers headroom.ts, gatewayObserve.ts and the 429 log read: Anthropic's and OpenAI's limit families and three more. */
export function limitHeaders(headers: Headers): [string, string][] {
  const out: [string, string][] = []
  headers.forEach((value, key) => {
    if (key.startsWith('anthropic-ratelimit') || key.startsWith('x-ratelimit') || KEPT.has(key)) out.push([key, value])
  })
  return out
}

/** What main asks the child, answered with `reply`. */
export type ChildCall =
  | { m: 'warm.adopt'; id: string; scope: RouteScope | null }
  | { m: 'scoped.open'; thread: string; scope: RouteScope }
  | { m: 'scoped.close'; thread: string }
  | { m: 'preconnect'; provider: string; account: string | null }

/** What the child asks main, answered with `reply`. */
export type MainCall =
  | { m: 'credentialFor'; service: string; account: string | null }
  | { m: 'substitute'; info: ScopedRequest }
  | { m: 'onUnauthorized'; info: ScopedRequest }
  | { m: 'pickNext'; info: LimitInfo }
  | { m: 'usage'; serviceId: ServiceId; force: boolean }

/** What the child tells main, unanswered. */
export type ChildEvent =
  | { e: 'response'; info: WireResponse }
  | { e: 'routed'; info: RoutedInfo }
  | { e: 'failedOver'; info: FailedOverInfo }
  | { e: 'error'; message: string }
  | { e: 'network'; info: NetworkInfo }
  | { e: 'request'; phase: 'start' | 'end'; info: RequestInfo }
  | { e: 'observeLimit'; serviceId: ServiceId; name: string; limit: Limit }
  | { e: 'pin'; serviceId: ServiceId; name: string }

export type Reply = { t: 'reply'; id: number; ok: true; value: unknown } | { t: 'reply'; id: number; ok: false; error: string }

export type WireMessage =
  // main → child
  | { t: 'start'; state: StartState }
  | { t: 'accounts'; state: AccountsState }
  | { t: 'out'; out: OutMark[] }
  /** Forget cached credentials of one service (`claude`, `codex`), or all for null. */
  | { t: 'credentials.drop'; service: string | null }
  | { t: 'warm.set'; id: string }
  | { t: 'warm.release'; id: string }
  | { t: 'ask'; id: number; call: ChildCall | MainCall }
  // child → main
  | { t: 'ready'; pid: number; port: number; scoped: { thread: string; port: number }[] }
  | { t: 'stats'; routed: Record<string, number>; error: string | null }
  | { t: 'event'; event: ChildEvent }
  // both ways
  | Reply

/** The other end went away while an ask was out. */
export class WireGone extends Error {
  constructor() {
    super('the gateway process went away')
  }
}

export class GatewayControlTimeout extends Error {
  constructor(public readonly method: string, public readonly timeoutMs: number) {
    super(`${method === 'credentialFor' ? 'credential_timeout' : 'gateway_control_timeout'}: Gateway control ${method} timed out after ${timeoutMs} ms`)
    this.name = 'GatewayControlTimeout'
  }
}

/** Asks by id over one wire, each settled by its reply or deadline. */
export class Calls<C> {
  private next = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly wire: Pick<Wire, 'post'>) {}

  call<T>(call: C, { timeoutMs = 30_000 }: { timeoutMs?: number } = {}): Promise<T> {
    const id = this.next++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new GatewayControlTimeout((call as { m: string }).m, timeoutMs))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      try {
        this.wire.post({ t: 'ask', id, call } as WireMessage)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  settle(reply: Reply): void {
    const p = this.pending.get(reply.id)
    if (!p) return
    this.pending.delete(reply.id)
    clearTimeout(p.timer)
    if (reply.ok) p.resolve(reply.value)
    else p.reject(new Error(reply.error))
  }

  failAll(error: Error): void {
    const all = [...this.pending.values()]
    this.pending.clear()
    for (const p of all) {
      clearTimeout(p.timer)
      p.reject(error)
    }
  }
}

/** Answer one ask on `wire`: the handler's value, or its error's message. */
export function answer(wire: Pick<Wire, 'post'>, id: number, run: () => Promise<unknown>): void {
  run().then(
    (value) => wire.post({ t: 'reply', id, ok: true, value: value ?? null }),
    (e) => wire.post({ t: 'reply', id, ok: false, error: (e as Error)?.message ?? String(e) })
  )
}
