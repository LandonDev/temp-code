import { EventEmitter } from 'node:events'
import { hostname } from 'node:os'
import { ZodError } from 'zod'
import type { WebSocket } from 'ws'
import { CONTRACT_VERSION, type Principal } from '@shared/capabilities'
import type { ServerPush } from '@shared/contract'
import type { MacBridgePush } from '@shared/contract-macbridge'
import {
  RELAY_CALL_MS,
  RELAY_FRAMES_MAX_BYTES,
  RELAY_HEARTBEAT_MS,
  RELAY_OFFER,
  RELAY_SOCKET_BUFFER_MAX,
  RelayCloseArgsSchema,
  RelayFacadeArgsSchema,
  RelayFrameArgsSchema,
  RelayOpenArgsSchema,
  isRelayPeerMethod,
  type MacPresence,
  type RelayCallParams,
  type RelayFacadeResult,
  type RelayOpenResult,
  type RelayPeerMethod
} from '@shared/contract-relay'
import type { BuildFacts } from '@shared/deployDrift'
import type { PresenceSource } from '../../presence'
import { FacadeError, callFacade, type FacadeContext } from './facade'
import { servePeerCall, type LinkRequest } from './peerCalls'
import type { Notice } from './notifier'

/**
 * The host side of the relay (docs/box.md "The relay: the phone and the
 * API reach the Mac through the box"). The box opens a lane for a phone
 * with `relay.open`, forwards every request frame as `relay.frame` and
 * closes it with `relay.close`, all as `peer.call` pushes down this host's
 * own link. Each lane is a `RelaySocket`: a WebSocket-shaped object this
 * host's ordinary `attach()` serves under a remote principal carrying the
 * box key's caps, so the fence, the capability gate and the coalescer run
 * here as for any remote caller. What `attach()` writes to the socket goes
 * back to the box in order as `relay.frames` requests (its own hello is
 * swallowed: the box composed one before the lane opened). `relay.facade`
 * runs one /mcp tool here for a bot on the box.
 *
 * The host also publishes its presence (screen, power) on every change and
 * every RELAY_HEARTBEAT_MS as `peer.presence`, and sends each notice of a
 * local thread as `relay.notice` when it has no delivery of its own.
 */

const SWALLOW_HELLO = 'hello'

/** The seam between attach() and the link. attach() reads readyState, OPEN and bufferedAmount, calls send(string) and listens to message and close; nothing else. */
export class RelaySocket extends EventEmitter {
  readonly OPEN = 1 as const
  readyState: 0 | 1 | 2 | 3 = 1
  /** Bytes queued for the box, in-flight batch included: attach()'s backpressure line reads it. */
  bufferedAmount = 0
  private readonly queue: { text: string; bytes: number }[] = []
  private inflight = false
  private first = true
  private retrying: NodeJS.Timeout | null = null

  constructor(
    readonly socketId: string,
    private readonly flush: (frames: string[]) => Promise<void>,
    private readonly onOverflow: () => void,
    private readonly opts: { maxBytes?: number; frameBytes?: number; retryMs?: number; log?: (line: string) => void } = {}
  ) {
    super()
  }

  /** attach()'s sendFrame lands here: the host's own hello is swallowed; the rest queue and flush in order, one request in flight. */
  send(text: string | Buffer): void {
    if (this.readyState !== 1) return
    const str = typeof text === 'string' ? text : text.toString('utf8')
    if (this.first) {
      this.first = false
      if (isHello(str)) return
    }
    const bytes = Buffer.byteLength(str)
    this.queue.push({ text: str, bytes })
    this.bufferedAmount += bytes
    if (this.bufferedAmount > (this.opts.maxBytes ?? RELAY_SOCKET_BUFFER_MAX)) {
      this.opts.log?.(`${this.socketId}: ${this.bufferedAmount} bytes queued, closing (backpressure)`)
      this.onOverflow()
      this.close('backpressure')
      return
    }
    this.pump()
  }

  /** The box's relay.frame: emits 'message' with the frame's JSON text, as ws does. */
  receive(frame: unknown): void {
    if (this.readyState !== 1) return
    this.emit('message', JSON.stringify(frame), false)
  }

  /** The box's relay.close, or the host's own end: readyState 3, 'close' once. */
  close(reason: string): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.queue.length = 0
    this.bufferedAmount = 0
    if (this.retrying) clearTimeout(this.retrying)
    this.retrying = null
    this.emit('close', 1000, Buffer.from(reason))
  }

  private pump(): void {
    if (this.inflight || this.retrying || this.readyState !== 1 || this.queue.length === 0) return
    const limit = this.opts.frameBytes ?? RELAY_FRAMES_MAX_BYTES
    const batch: { text: string; bytes: number }[] = [this.queue[0]]
    let total = batch[0].bytes
    for (let i = 1; i < this.queue.length && total + this.queue[i].bytes <= limit; i++) {
      batch.push(this.queue[i])
      total += this.queue[i].bytes
    }
    this.inflight = true
    const attempt = (retried: boolean): void => {
      this.flush(batch.map((b) => b.text)).then(
        () => {
          this.inflight = false
          if (this.readyState !== 1) return
          this.queue.splice(0, batch.length)
          this.bufferedAmount -= total
          this.pump()
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          if (this.readyState !== 1) return
          if (/unknown socket/i.test(message)) {
            this.inflight = false
            this.opts.log?.(`${this.socketId}: the carrier dropped the lane (${message})`)
            this.close('carrier closed')
            return
          }
          if (retried) {
            this.inflight = false
            this.opts.log?.(`${this.socketId}: frames not taken twice (${message}), closing`)
            this.close('carrier failed')
            return
          }
          this.opts.log?.(`${this.socketId}: frames not taken (${message}), retrying once`)
          this.retrying = setTimeout(() => {
            this.retrying = null
            if (this.readyState === 1) attempt(true)
          }, this.opts.retryMs ?? 1_000)
          this.retrying.unref?.()
        }
      )
    }
    attempt(false)
  }
}

/** The contract attach() holds the socket to; a member attach() starts using that is missing here fails the typecheck. */
type AttachSocket = Pick<WebSocket, 'readyState' | 'OPEN' | 'bufferedAmount' | 'send'> & {
  on(event: 'message', listener: (data: Buffer | string, isBinary: boolean) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown
}
const _attachShape: AttachSocket = null as unknown as RelaySocket
void _attachShape

function isHello(text: string): boolean {
  try {
    const frame = JSON.parse(text) as { push?: string }
    return frame?.push === SWALLOW_HELLO
  } catch {
    return false
  }
}

export interface RelayServerDeps {
  environmentId: string
  /** index.ts attach(ws, principal, 'remote'): the lane served as any remote socket. */
  attach: (ws: RelaySocket, principal: Principal & { kind: 'remote' }) => void
  /** How to send on the link to a host, while it is up. */
  link: (envId: string) => LinkRequest | null
  /** The saved hosts (remote.environments), by id and name. */
  environments: () => { id: string; name: string }[]
  presence: PresenceSource
  /** The facade's context without the caller (registry, origin null): a relayed tool runs here. */
  facade: () => Omit<FacadeContext, 'principal'>
  /** The host has its own delivery (APNs key or hub): notices stay here. */
  deliversNotices: () => boolean
  /** What this host runs (buildInfo.ts), for the box's host row. */
  build?: BuildFacts
  hostname?: string
  heartbeatMs?: number
  retryMs?: number
  now?: () => number
  log?: (line: string) => void
}

export interface RelayRegistration {
  name: string
  presence: MacPresence
  build?: BuildFacts
}

export class RelayServer {
  private readonly sockets = new Map<string, RelaySocket>()
  private readonly heartbeats = new Map<string, NodeJS.Timeout>()
  private readonly offPresence: () => void
  private readonly log: (line: string) => void
  private closed = false

  constructor(private readonly deps: RelayServerDeps) {
    this.log = deps.log ?? ((line) => console.log(`[relay] ${line}`))
    this.offPresence = deps.presence.onChange((p) => this.publish(p))
  }

  /** peer.register's extra fields for macBridge.linkUp. */
  registration(): RelayRegistration {
    return {
      name: this.deps.hostname ?? hostname(),
      presence: this.deps.presence.snapshot(),
      ...(this.deps.build ? { build: this.deps.build } : {})
    }
  }

  /** peer.call relay.* → the handler; everything else false. */
  onPeerPush(envId: string, push: ServerPush): boolean {
    if (push.push !== 'peer.call' || !isRelayPeerMethod(push.method)) return false
    const request = this.deps.link(envId)
    if (!request) return true
    void servePeerCall(
      push as Extract<MacBridgePush, { push: 'peer.call' }>,
      envId,
      (method, params, ctx) => this.handle(method as RelayPeerMethod, params as RelayCallParams, ctx),
      request,
      this.log
    )
    return true
  }

  async handle(method: RelayPeerMethod, params: RelayCallParams, ctx: { from: string }): Promise<unknown> {
    const env = this.deps.environments().find((e) => e.id === ctx.from)
    if (!env) throw new Error('this host does not know that host')
    if (params?.from !== ctx.from) throw new Error('the call names another host as its carrier')
    const args = params.args as Record<string, unknown>
    switch (method) {
      case 'relay.open': {
        const a = RelayOpenArgsSchema.parse(args)
        const key = this.key(env.id, a.socketId)
        if (this.sockets.has(key)) throw new Error(`socket ${a.socketId} is already open`)
        const request = this.deps.link(env.id)
        if (!request) throw new Error('the link is down')
        const socket = new RelaySocket(
          a.socketId,
          (frames) =>
            request(
              'relay.frames',
              { from: this.deps.environmentId, socketId: a.socketId, frames: frames.map((f) => JSON.parse(f) as unknown) },
              { timeoutMs: RELAY_CALL_MS }
            ).then(() => undefined),
          () => void this.tellClosed(env.id, a.socketId, 'backpressure'),
          { retryMs: this.deps.retryMs, log: this.log }
        )
        socket.on('close', () => this.sockets.delete(key))
        this.sockets.set(key, socket)
        const principal: Principal & { kind: 'remote' } = {
          kind: 'remote',
          keyId: a.principal.keyId,
          name: `${a.principal.name} via ${env.name}`,
          audience: a.principal.audience,
          caps: a.principal.caps
        }
        this.deps.attach(socket, principal)
        this.log(`${env.name}: lane ${a.socketId} open for key ${a.principal.keyId} (${a.principal.caps.join(',')})`)
        const result: RelayOpenResult = { ok: true, contract: CONTRACT_VERSION }
        return result
      }
      case 'relay.frame': {
        const a = RelayFrameArgsSchema.parse(args)
        const socket = this.sockets.get(this.key(env.id, a.socketId))
        if (!socket) throw new Error(`unknown socket ${a.socketId}`)
        socket.receive(a.frame)
        return { ok: true }
      }
      case 'relay.close': {
        const a = RelayCloseArgsSchema.parse(args)
        const key = this.key(env.id, a.socketId)
        const socket = this.sockets.get(key)
        if (socket) {
          this.sockets.delete(key)
          socket.close(a.reason)
          this.log(`${env.name}: lane ${a.socketId} closed (${a.reason})`)
        }
        return { ok: true }
      }
      case 'relay.facade': {
        const a = RelayFacadeArgsSchema.parse(args)
        const principal: Principal & { kind: 'remote' } = {
          kind: 'remote',
          keyId: a.principal.keyId,
          name: `${a.principal.name} via ${env.name}`,
          audience: a.principal.audience,
          caps: a.principal.caps
        }
        try {
          const result = await callFacade({ ...this.deps.facade(), principal }, a.name, a.arguments ?? {})
          const out: RelayFacadeResult = { ok: true, result }
          return out
        } catch (err) {
          if (err instanceof FacadeError) {
            const out: RelayFacadeResult = { ok: false, code: err.code, message: err.message }
            return out
          }
          if (err instanceof ZodError) {
            const out: RelayFacadeResult = {
              ok: false,
              code: 'invalid',
              message: `invalid arguments: ${err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`
            }
            return out
          }
          throw err
        }
      }
    }
  }

  /** A link opened: the presence heartbeat for it starts. */
  linkUp(envId: string): void {
    if (this.closed) return
    this.clearHeartbeat(envId)
    const timer = setInterval(() => void this.send(envId, this.deps.presence.snapshot()), this.deps.heartbeatMs ?? RELAY_HEARTBEAT_MS)
    timer.unref?.()
    this.heartbeats.set(envId, timer)
  }

  /** A link closed: its heartbeat stops and its lanes close (the box closes the phones' sockets itself). */
  linkDown(envId: string): void {
    this.clearHeartbeat(envId)
    for (const [key, socket] of [...this.sockets]) {
      if (!key.startsWith(`${envId}\u0000`)) continue
      this.sockets.delete(key)
      socket.close('link down')
    }
  }

  /** A notice of a local root thread (notifier.onNotice): to every connected link as relay.notice when this host delivers nothing itself. */
  onNotice(notice: Notice): void {
    // A thread its person is looking at on this Mac is not news on the phone.
    if (this.closed || notice.onScreen || this.deps.deliversNotices()) return
    // Everything but url: the carrier's /ui cannot open this host's thread.
    const body = {
      event: notice.event,
      kind: notice.kind,
      threadId: notice.threadId,
      title: notice.title,
      ...(notice.subtitle ? { subtitle: notice.subtitle } : {}),
      body: notice.body,
      ts: notice.ts,
      seq: notice.seq,
      ...(notice.requestId ? { requestId: notice.requestId } : {}),
      ...(notice.hostName ? { hostName: notice.hostName } : {})
    }
    for (const envId of this.heartbeats.keys()) {
      const request = this.deps.link(envId)
      if (!request) continue
      request('relay.notice', { from: this.deps.environmentId, notice: body }, { timeoutMs: RELAY_CALL_MS }).catch((err: unknown) =>
        this.log(`${envId}: notice not taken (${err instanceof Error ? err.message : String(err)})`)
      )
    }
  }

  /** Open lanes, for tests and the status line. */
  laneCount(): number {
    return this.sockets.size
  }

  close(): void {
    this.closed = true
    this.offPresence()
    for (const envId of [...this.heartbeats.keys()]) this.clearHeartbeat(envId)
    for (const socket of [...this.sockets.values()]) socket.close('host closing')
    this.sockets.clear()
  }

  private key(from: string, socketId: string): string {
    return `${from}\u0000${socketId}`
  }

  private clearHeartbeat(envId: string): void {
    const timer = this.heartbeats.get(envId)
    if (timer) clearInterval(timer)
    this.heartbeats.delete(envId)
  }

  private publish(p: MacPresence): void {
    for (const envId of this.heartbeats.keys()) void this.send(envId, p)
  }

  private readonly warned = new Set<string>()
  private async send(envId: string, presence: MacPresence): Promise<void> {
    const request = this.deps.link(envId)
    if (!request) return
    try {
      await request('peer.presence', { from: this.deps.environmentId, presence }, { timeoutMs: RELAY_CALL_MS })
      this.warned.delete(envId)
    } catch (err) {
      if (this.warned.has(envId)) return
      this.warned.add(envId)
      this.log(`${envId}: presence not taken (${err instanceof Error ? err.message : String(err)})`)
    }
  }

  private async tellClosed(envId: string, socketId: string, reason: string): Promise<void> {
    const request = this.deps.link(envId)
    if (!request) return
    try {
      await request('relay.closed', { from: this.deps.environmentId, socketId, reason }, { timeoutMs: RELAY_CALL_MS })
    } catch (err) {
      this.log(`${envId}: relay.closed not taken (${err instanceof Error ? err.message : String(err)})`)
    }
  }
}

/** The offer macBridge.linkUp adds to peer.register: this host serves relayed lanes and facade calls. */
export const relayOffers = (): string[] => [RELAY_OFFER]
