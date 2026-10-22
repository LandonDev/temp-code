import { randomBytes } from 'node:crypto'
import { allows, requiredCapability, type Principal } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest, type ServerFrame, type ServerPush } from '@shared/contract'
import {
  RELAY_BOX_LOCAL,
  RELAY_CALL_MS,
  RELAY_CLOSE_CONTRACT,
  RELAY_CLOSE_HOST_CLOSED,
  RELAY_CLOSE_UNREACHABLE,
  RELAY_FACADE_MS,
  RELAY_HOSTS_MAX,
  RELAY_METHODS,
  RELAY_OFFER,
  linkDownText,
  relayForbidden,
  relayRefusal,
  type HostPresence,
  type MacPresence,
  type RelayFacadeResult,
  type RelayNotice,
  type RelayOpenResult,
  type RelayPrincipal
} from '@shared/contract-relay'
import { PeerCalls, PeerOfflineError } from './peerCalls'

/**
 * The box side of the relay (docs/box.md "The relay: the phone and the API
 * reach the Mac through the box"). A phone paired with this host opens
 * `/ws?ticket=…&host=<envId>`; `HostRelay.attachRelayed` composes the hello
 * under the Mac's environment id, opens a lane on the Mac over the peer link
 * (`relay.open`), runs this host's own gate on every request frame (a local
 * method or a cap the key lacks never crosses), answers the key's own
 * `remote.push.*` rows itself, refuses what the Mac's state forbids with one
 * typed line, and forwards the rest as `relay.frame`; the Mac's frames come
 * back verbatim in `relay.frames`. The table of hosts and their presence is
 * kept here (persisted as `relay.hosts`), pushed as `presence` to every
 * remote socket on a change, and read by the hello, `/api/hello` and `/mcp`.
 */

const HOSTS_KEY = 'relay.hosts'
const PERSIST_DEBOUNCE_MS = 1_000

/** What the lane needs of the phone's socket (ws's WebSocket fits; tests pass a fake). */
export interface LaneSocket {
  readyState: number
  readonly OPEN: number
  send(text: string): void
  close(code: number, reason: string): void
  on(event: 'message', listener: (data: unknown) => void): unknown
  on(event: 'close', listener: () => void): unknown
}

export interface RelayTransport {
  online(envId: string): boolean
  open(envId: string, socketId: string, principal: RelayPrincipal): Promise<RelayOpenResult>
  frame(envId: string, socketId: string, frame: unknown): Promise<void>
  close(envId: string, socketId: string, reason: string): Promise<void>
  facade(envId: string, principal: RelayPrincipal, name: string, args: unknown): Promise<RelayFacadeResult>
}

/** PeerCalls over the link: each call a peer.call of the relay offer. */
export class PeerRelayTransport implements RelayTransport {
  constructor(
    private readonly calls: PeerCalls,
    private readonly environmentId: string
  ) {}
  online(envId: string): boolean {
    return this.calls.online(envId, RELAY_OFFER)
  }
  open(envId: string, socketId: string, principal: RelayPrincipal): Promise<RelayOpenResult> {
    return this.calls.call<RelayOpenResult>(envId, 'relay.open', { from: this.environmentId, args: { socketId, principal } }, RELAY_CALL_MS)
  }
  async frame(envId: string, socketId: string, frame: unknown): Promise<void> {
    await this.calls.call(envId, 'relay.frame', { from: this.environmentId, args: { socketId, frame } }, RELAY_CALL_MS)
  }
  async close(envId: string, socketId: string, reason: string): Promise<void> {
    await this.calls.call(envId, 'relay.close', { from: this.environmentId, args: { socketId, reason } }, RELAY_CALL_MS)
  }
  facade(envId: string, principal: RelayPrincipal, name: string, args: unknown): Promise<RelayFacadeResult> {
    return this.calls.call<RelayFacadeResult>(envId, 'relay.facade', { from: this.environmentId, args: { principal, name, arguments: args } }, RELAY_FACADE_MS)
  }
}

/** The box's view of relayed hosts for /mcp (mcp.ts): the rows, and a facade call with the refusal applied first. */
export interface RelayFacadeHosts {
  list(): HostPresence[]
  call(envId: string, principal: RelayPrincipal, name: string, args: unknown): Promise<RelayFacadeResult>
}

export interface HostRelayDeps {
  environmentId: string
  transport: RelayTransport
  calls: Pick<PeerCalls, 'onRegister' | 'onDrop' | 'info' | 'registeredIds'>
  /** `relay.hosts`: the last picture of every host, so a down one is listed across a restart. */
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void }
  /** Every direct remote client socket of this host: the presence push (relayed lanes get it from HostRelay itself). */
  broadcast: (push: Extract<ServerPush, { push: 'presence' }>) => void
  /** A relayed lane's remote.push.* (handlers.ts handleRemote with the key as createdBy). */
  pushLocal: (req: ClientRequest, principal: Principal & { kind: 'remote' }) => Promise<unknown>
  /** A notice from a host: this host's sinks with environmentId = the host's. */
  deliverNotice: (from: string, notice: RelayNotice) => Promise<void>
  contract: number
  now?: () => number
  /** The zone the refusal's `since` is written in (tests); the process zone by default. */
  timeZone?: string
  log?: (line: string) => void
}

interface Lane {
  socketId: string
  envId: string
  ws: LaneSocket
  principal: Principal & { kind: 'remote' }
  opened: boolean
  /** Requests that arrived before relay.open answered, in order. */
  queued: ClientRequest[]
  /** Request ids forwarded and not yet answered. */
  pending: Set<string>
  closed: boolean
}

export class HostRelay {
  private transport: RelayTransport
  private readonly rows = new Map<string, HostPresence>()
  private readonly lanes = new Map<string, Lane>()
  private readonly now: () => number
  private readonly log: (line: string) => void
  private persistTimer: NodeJS.Timeout | null = null
  private readonly offRegister: () => void
  private readonly offDrop: () => void
  private closed = false

  constructor(private readonly deps: HostRelayDeps) {
    this.transport = deps.transport
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((line) => console.log(`[relay] ${line}`))
    this.load()
    for (const id of deps.calls.registeredIds(RELAY_OFFER)) this.registered(id)
    this.offRegister = deps.calls.onRegister((id, offers) => {
      if (offers.has(RELAY_OFFER)) this.registered(id)
    })
    this.offDrop = deps.calls.onDrop((id, offers) => {
      if (offers.has(RELAY_OFFER) || this.rows.has(id)) this.dropped(id)
    })
  }

  /** Whether a lane to the host can open now: the listener's 503 when not. */
  online(envId: string): boolean {
    return this.transport.online(envId)
  }

  /** The iOS test server's seam (relayLoopback.ts): carry lanes in-process instead of over the link. */
  setTransport(transport: RelayTransport): void {
    this.transport = transport
  }

  // ── presence ─────────────────────────────────────────────────────────

  /** Every host that ever registered with the relay offer, newest registration first, at most RELAY_HOSTS_MAX. */
  hosts(): HostPresence[] {
    return [...this.rows.values()].map((row) => {
      const info = this.deps.calls.info(row.environmentId)
      return info ? { ...row, lastSeenAt: Math.max(row.lastSeenAt ?? 0, info.lastSeenAt) } : row
    })
  }

  presenceOf(envId: string): HostPresence | null {
    const row = this.rows.get(envId)
    if (!row) return null
    const info = this.deps.calls.info(envId)
    return info ? { ...row, lastSeenAt: Math.max(row.lastSeenAt ?? 0, info.lastSeenAt) } : row
  }

  /** The host's own word (the admin request peer.presence): screen, power, and that it is alive. */
  onPeerPresence(from: string, p: MacPresence): { ok: true } {
    const row = this.rows.get(from)
    if (!row) return { ok: true }
    const changed = row.screen !== p.screen || row.power !== p.power
    row.screen = p.screen
    row.power = p.power
    row.lastSeenAt = this.now()
    this.persistLater()
    if (changed) {
      this.log(`${row.name} (${from}): ${p.screen}, ${p.power}`)
      this.broadcast()
    }
    return { ok: true }
  }

  /** A test server's seed: a row as if the host had registered (relayLoopback.ts). */
  seedForTests(envId: string, row: Omit<HostPresence, 'environmentId'>): void {
    this.place(envId, { environmentId: envId, ...row })
    this.persistLater()
    this.broadcast()
  }

  private registered(envId: string): void {
    const info = this.deps.calls.info(envId)
    const prior = this.rows.get(envId)
    const now = this.now()
    const row: HostPresence = {
      environmentId: envId,
      name: info?.name ?? prior?.name ?? 'Mac',
      platform: info?.build?.platform ?? prior?.platform ?? 'unknown',
      link: 'up',
      since: now,
      screen: info?.presence?.screen ?? 'unknown',
      power: info?.presence?.power ?? 'awake',
      lastSeenAt: now,
      build: info?.build ?? prior?.build ?? null
    }
    const changed = !prior || prior.link !== 'up' || prior.screen !== row.screen || prior.power !== row.power || prior.name !== row.name
    this.place(envId, row)
    this.log(`${row.name} (${envId}): link up (${row.screen}, ${row.power})`)
    this.persistLater()
    if (changed) this.broadcast()
  }

  private dropped(envId: string): void {
    const row = this.rows.get(envId)
    if (!row || row.link === 'down') return
    row.link = 'down'
    row.since = this.now()
    this.log(`${row.name} (${envId}): link down`)
    this.persistLater()
    this.broadcast()
    for (const lane of [...this.lanes.values()]) if (lane.envId === envId) this.unreachable(lane, row)
  }

  /** Newest registration first; the oldest row leaves past the cap. */
  private place(envId: string, row: HostPresence): void {
    this.rows.delete(envId)
    const rest = [...this.rows.entries()]
    this.rows.clear()
    this.rows.set(envId, row)
    for (const [id, r] of rest) this.rows.set(id, r)
    while (this.rows.size > RELAY_HOSTS_MAX) {
      const last = [...this.rows.keys()].pop()
      if (last) this.rows.delete(last)
    }
  }

  /** To every direct remote socket (deps.broadcast) and every relayed lane here (the box's own frame on it). */
  private broadcast(): void {
    const push = { push: 'presence' as const, hosts: this.hosts() }
    this.deps.broadcast(push)
    for (const lane of this.lanes.values()) this.send(lane, push)
  }

  private load(): void {
    const raw = this.deps.store.getSetting(HOSTS_KEY)
    if (!raw) return
    try {
      const rows = JSON.parse(raw) as HostPresence[]
      if (!Array.isArray(rows)) return
      for (const row of rows.slice(0, RELAY_HOSTS_MAX)) {
        if (!row || typeof row.environmentId !== 'string') continue
        // Nothing is up before it registers again; `since` stays what it was so a down host still says since when.
        this.rows.set(row.environmentId, { ...row, link: 'down' })
      }
    } catch {
      /* a corrupt row set starts empty */
    }
  }

  private persistLater(): void {
    if (this.closed) return
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persist()
    }, PERSIST_DEBOUNCE_MS)
    this.persistTimer.unref?.()
  }

  private persist(): void {
    this.deps.store.setSetting(HOSTS_KEY, JSON.stringify([...this.rows.values()]))
  }

  // ── lanes ────────────────────────────────────────────────────────────

  /** A phone's socket for a host: the hello at once, then the lane on the host. */
  attachRelayed(ws: LaneSocket, principal: Principal & { kind: 'remote' }, envId: string): void {
    const socketId = `l${randomBytes(9).toString('base64url')}`
    const lane: Lane = { socketId, envId, ws, principal, opened: false, queued: [], pending: new Set(), closed: false }
    this.lanes.set(socketId, lane)
    const row = this.presenceOf(envId)
    this.send(lane, {
      push: 'hello',
      environmentId: envId,
      contract: this.deps.contract,
      caps: principal.caps,
      key: { id: principal.keyId, name: principal.name },
      ...(row?.build ? { build: row.build } : {}),
      via: this.deps.environmentId,
      ...(row ? { presence: row } : {})
    })
    ws.on('message', (data) => void this.onMessage(lane, data))
    ws.on('close', () => {
      if (lane.closed) return
      lane.closed = true
      this.lanes.delete(socketId)
      this.transport.close(envId, socketId, 'client closed').catch(() => {})
    })
    if (!row || row.link !== 'up') {
      this.unreachable(lane, row)
      return
    }
    this.transport
      .open(envId, socketId, { keyId: principal.keyId, name: principal.name, audience: principal.audience, caps: principal.caps })
      .then((answer) => {
        if (lane.closed) return
        if (answer.contract !== this.deps.contract) {
          this.log(`${envId}: lane ${socketId} speaks contract ${answer.contract}, this host ${this.deps.contract}`)
          this.end(lane, RELAY_CLOSE_CONTRACT, 'contract')
          return
        }
        lane.opened = true
        const queued = lane.queued.splice(0)
        for (const req of queued) this.forward(lane, req)
      })
      .catch((err: unknown) => {
        if (lane.closed) return
        this.log(`${envId}: lane ${socketId} did not open (${err instanceof Error ? err.message : String(err)})`)
        this.unreachable(lane, this.presenceOf(envId), err)
      })
  }

  /** Frames the host's attach() sent on a lane, verbatim to the phone. */
  onFrames(from: string, socketId: string, frames: unknown[]): { ok: true } {
    const lane = this.lanes.get(socketId)
    if (!lane || lane.envId !== from) throw new Error(`unknown socket ${socketId}`)
    for (const frame of frames) {
      const id = (frame as { id?: unknown })?.id
      if (typeof id === 'string') lane.pending.delete(id)
      if (lane.ws.readyState === lane.ws.OPEN) lane.ws.send(JSON.stringify(frame))
    }
    return { ok: true }
  }

  /** The host closed its end of a lane (backpressure, shutdown). */
  onClosed(from: string, socketId: string, reason: string): { ok: true } {
    const lane = this.lanes.get(socketId)
    if (lane && lane.envId === from) this.end(lane, RELAY_CLOSE_HOST_CLOSED, reason.slice(0, 120))
    return { ok: true }
  }

  /** A notice from a host: this host's own sinks, with the host's id. */
  onNotice(from: string, notice: RelayNotice): { ok: true } {
    if (!this.rows.has(from)) return { ok: true }
    void this.deps.deliverNotice(from, notice).catch((err: unknown) =>
      this.log(`${from}: notice not delivered (${err instanceof Error ? err.message : String(err)})`)
    )
    return { ok: true }
  }

  laneCount(): number {
    return this.lanes.size
  }

  private async onMessage(lane: Lane, data: unknown): Promise<void> {
    let raw: unknown
    try {
      raw = JSON.parse(String(data))
    } catch {
      return
    }
    const parsed = ClientRequestSchema.safeParse(raw)
    if (!parsed.success) {
      const id = (raw as { id?: string })?.id
      if (id) this.send(lane, { id, ok: false, error: `bad request: ${parsed.error.message}` })
      return
    }
    const req = parsed.data
    const need = requiredCapability(req)
    if (need === 'local') return this.send(lane, { id: req.id, ok: false, error: `forbidden: ${req.method} is local-only` })
    if (!allows(lane.principal.caps, need)) return this.send(lane, { id: req.id, ok: false, error: `forbidden: ${req.method} needs ${need}` })
    if ((RELAY_BOX_LOCAL as readonly string[]).includes(req.method)) {
      if (req.method === 'remote.push.activity') return this.send(lane, { id: req.id, ok: true, result: null })
      try {
        return this.send(lane, { id: req.id, ok: true, result: await this.deps.pushLocal(req, lane.principal) })
      } catch (err) {
        return this.send(lane, { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    }
    const relayNeed = RELAY_METHODS[req.method]
    if (!relayNeed) return this.send(lane, { id: req.id, ok: false, error: relayForbidden(req.method) })
    const row = this.presenceOf(lane.envId)
    const refusal = row ? relayRefusal(row, relayNeed, this.now(), this.deps.timeZone) : `unavailable: the Mac is unreachable`
    if (refusal) return this.send(lane, { id: req.id, ok: false, error: refusal })
    if (!lane.opened) {
      lane.queued.push(req)
      return
    }
    this.forward(lane, req)
  }

  private forward(lane: Lane, req: ClientRequest): void {
    lane.pending.add(req.id)
    this.transport.frame(lane.envId, lane.socketId, req).catch((err: unknown) => {
      if (!lane.pending.delete(req.id)) return
      const row = this.presenceOf(lane.envId)
      const error = err instanceof PeerOfflineError && row ? linkDownText(row, this.now(), this.deps.timeZone) : err instanceof Error ? err.message : String(err)
      this.send(lane, { id: req.id, ok: false, error })
    })
  }

  /** The link is gone (or never was): fail what waits with linkDown, then close 4010. */
  private unreachable(lane: Lane, row: HostPresence | null, cause?: unknown): void {
    const since = row?.since ?? this.now()
    const text =
      cause && !(cause instanceof PeerOfflineError) && cause instanceof Error
        ? `linkDown: ${cause.message}`
        : linkDownText({ since }, this.now(), this.deps.timeZone)
    for (const id of [...lane.pending, ...lane.queued.map((r) => r.id)]) this.send(lane, { id, ok: false, error: text })
    lane.pending.clear()
    lane.queued.length = 0
    this.end(lane, RELAY_CLOSE_UNREACHABLE, 'host unreachable')
  }

  private end(lane: Lane, code: number, reason: string): void {
    if (lane.closed) return
    lane.closed = true
    this.lanes.delete(lane.socketId)
    try {
      lane.ws.close(code, reason)
    } catch {
      /* already closing */
    }
    if (lane.opened && code !== RELAY_CLOSE_UNREACHABLE && code !== RELAY_CLOSE_HOST_CLOSED)
      this.transport.close(lane.envId, lane.socketId, reason).catch(() => {})
  }

  private send(lane: Lane, frame: ServerFrame): void {
    if (lane.ws.readyState !== lane.ws.OPEN) return
    lane.ws.send(JSON.stringify(frame))
  }

  // ── mcp ──────────────────────────────────────────────────────────────

  facadeHosts(): RelayFacadeHosts {
    return {
      list: () => this.hosts(),
      call: async (envId, principal, name, args) => {
        const row = this.presenceOf(envId)
        if (!row) return { ok: false, code: 'not_found', message: `no host "${envId}" is known here; list_projects names the hosts` }
        const refusal = relayRefusal(row, 'link', this.now(), this.deps.timeZone)
        if (refusal) return { ok: false, code: 'unavailable', message: refusal }
        try {
          return await this.transport.facade(envId, principal, name, args)
        } catch (err) {
          const current = this.presenceOf(envId) ?? row
          if (err instanceof PeerOfflineError) return { ok: false, code: 'unavailable', message: linkDownText(current, this.now(), this.deps.timeZone) }
          return { ok: false, code: 'unavailable', message: `unavailable: ${err instanceof Error ? err.message : String(err)}` }
        }
      }
    }
  }

  close(): void {
    this.closed = true
    this.offRegister()
    this.offDrop()
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
      this.persist()
    }
    for (const lane of [...this.lanes.values()]) this.end(lane, RELAY_CLOSE_HOST_CLOSED, 'server closing')
  }
}
