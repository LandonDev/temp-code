import { randomBytes } from 'node:crypto'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { PORT_SEARCH_SPAN, type ForwardHost, type ForwardedPort, type MacForward, type PortBinding } from '@shared/contract-ports'
import type { LinkRequest } from './peerCalls'
import { LinkStream } from './portStreams'

/**
 * The Mac side of the dev server forward (docs/box.md "Dev servers on the
 * box"). A host it holds a peer link to sends its list of ports; for each one
 * the Mac binds 127.0.0.1:<port> itself, the same number when nothing on the
 * Mac answers there, else the next free one above it (so the person's own dev
 * instance on 5173 keeps 5173 and the forward takes 5174, and the row says
 * so), and tells the host what it bound. Every accepted connection is a
 * stream on the link (portStreams.ts). The per-host switch
 * (`ports.forward.<envId>`, on by default) off, the host dropping a port, the
 * link going down or the app quitting closes the listener and its streams;
 * the link coming back brings the list again and every port is bound anew,
 * on its old number when that is still free.
 */

export interface MacPortLink {
  request: LinkRequest
  /** The link socket's unsent bytes. */
  buffered: () => number
}

export interface MacPortsDeps {
  /** This Mac's environment id (the `from` of its requests). */
  environmentId: string
  link: (hostId: string) => MacPortLink | null
  /** The saved hosts that may forward here, with their names and whether their link is up. */
  hosts: () => { id: string; name: string; connected: boolean }[]
  enabled: (hostId: string) => boolean
  setEnabled: (hostId: string, on: boolean) => void
  /** Whether a port is free on this machine (tests pass their own). */
  isFree?: (port: number) => Promise<boolean>
  log?: (line: string) => void
}

interface Bound {
  port: ForwardedPort
  server: Server | null
  macPort: number | null
  error: string | null
  streams: Map<string, LinkStream>
}

/** Something answers on the port, over v4 or v6 loopback: the browser's `localhost` would reach it, so it is taken. */
export function answers(port: number, host: string, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port })
    const done = (v: boolean) => {
      clearTimeout(t)
      s.destroy()
      resolve(v)
    }
    const t = setTimeout(() => done(false), timeoutMs)
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

export const portIsFree = async (port: number): Promise<boolean> =>
  !(await answers(port, '127.0.0.1')) && !(await answers(port, '::1'))

/** Listen on 127.0.0.1:port; null when it is taken. */
function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = () => {
      server.removeListener('listening', onListening)
      resolve(false)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve(true)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen({ host: '127.0.0.1', port, exclusive: true })
  })
}

/**
 * The Mac's number for a port: `prefer` (its number before a reconnect), then
 * `wanted`, then each one above it up to PORT_SEARCH_SPAN, skipping `taken`
 * (this Mac's other forwards) and any number something already answers on.
 */
export async function allocate(
  server: Server,
  wanted: number,
  opts: { prefer?: number | null; taken: ReadonlySet<number>; isFree: (port: number) => Promise<boolean> }
): Promise<number | null> {
  const order: number[] = []
  if (opts.prefer) order.push(opts.prefer)
  for (let p = wanted; p <= Math.min(65535, wanted + PORT_SEARCH_SPAN); p++) if (p !== opts.prefer) order.push(p)
  for (const p of order) {
    if (opts.taken.has(p)) continue
    if (!(await opts.isFree(p))) continue
    if (await listen(server, p)) return p
  }
  return null
}

export class MacPortForwards {
  private readonly bound = new Map<string, Map<string, Bound>>()
  private readonly offered = new Map<string, ForwardedPort[]>()
  /** The Mac number each forward had, kept across a reconnect. */
  private readonly lastMac = new Map<string, number>()
  private readonly chains = new Map<string, Promise<void>>()
  private readonly listeners = new Set<(hosts: ForwardHost[]) => void>()
  private readonly log: (line: string) => void
  private closed = false

  constructor(private readonly deps: MacPortsDeps) {
    this.log = deps.log ?? ((line) => console.log(`[ports] ${line}`))
  }

  onChange(listener: (hosts: ForwardHost[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    if (!this.listeners.size) return
    const hosts = this.hosts()
    for (const l of this.listeners) l(hosts)
  }

  /** Every saved host, its switch, and what it forwards here now. */
  hosts(): ForwardHost[] {
    return this.deps.hosts().map((h) => ({
      environmentId: h.id,
      name: h.name,
      enabled: this.deps.enabled(h.id),
      connected: h.connected,
      forwards: [...(this.bound.get(h.id)?.values() ?? [])].map(
        (b): MacForward => ({
          id: b.port.id,
          port: b.port.port,
          macPort: b.macPort,
          label: b.port.label,
          title: b.port.title,
          error: b.error,
          connections: b.streams.size
        })
      )
    }))
  }

  /** The host's list: bind what is new, close what left, then say what is bound. One pass per host at a time. */
  onPorts(hostId: string, ports: ForwardedPort[]): Promise<void> {
    this.offered.set(hostId, ports)
    return this.serial(hostId, () => this.reconcile(hostId))
  }

  private serial(hostId: string, fn: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(hostId) ?? Promise.resolve()).then(fn, fn)
    this.chains.set(hostId, next)
    return next
  }

  private async reconcile(hostId: string): Promise<void> {
    if (this.closed) return
    const want = this.deps.enabled(hostId) ? (this.offered.get(hostId) ?? []) : []
    let map = this.bound.get(hostId)
    if (!map) this.bound.set(hostId, (map = new Map()))
    for (const [id, b] of [...map]) {
      // A port that left, or whose number on the host changed, is closed (and bound again below).
      const now = want.find((p) => p.id === id)
      if (!now || now.port !== b.port.port) {
        this.unbind(b)
        map.delete(id)
      } else b.port = now
    }
    for (const p of want) {
      if (map.has(p.id)) continue
      map.set(p.id, await this.bind(hostId, p))
    }
    this.changed()
    await this.report(hostId)
  }

  private taken(): Set<number> {
    const out = new Set<number>()
    for (const map of this.bound.values()) for (const b of map.values()) if (b.macPort) out.add(b.macPort)
    return out
  }

  private async bind(hostId: string, port: ForwardedPort): Promise<Bound> {
    const b: Bound = { port, server: null, macPort: null, error: null, streams: new Map() }
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (socket) => this.accept(hostId, b, socket))
    const macPort = await allocate(server, port.port, { prefer: this.lastMac.get(port.id) ?? null, taken: this.taken(), isFree: this.deps.isFree ?? portIsFree })
    if (macPort === null) {
      b.error = `no free port from ${port.port} to ${port.port + 100}`
      server.close()
      this.log(`${hostId}: ${port.port} not forwarded: ${b.error}`)
      return b
    }
    server.on('error', (err) => this.log(`${hostId}: forward ${macPort}: ${err.message}`))
    b.server = server
    b.macPort = macPort
    this.lastMac.set(port.id, macPort)
    this.log(`${hostId}: ${port.port} → 127.0.0.1:${macPort}${macPort !== port.port ? ` (${port.port} is taken here)` : ''}`)
    return b
  }

  private accept(hostId: string, b: Bound, socket: Socket): void {
    const link = this.deps.link(hostId)
    if (!link || !b.server) {
      socket.destroy()
      return
    }
    const from = this.deps.environmentId
    const streamId = `s${randomBytes(9).toString('base64url')}`
    const stream = new LinkStream(
      streamId,
      socket,
      {
        data: (seq, data) => link.request('ports.data', { from, streamId, seq, data }),
        close: (seq, error) => void link.request('ports.close', { from, streamId, seq, ...(error ? { error } : {}) }).catch(() => {}),
        buffered: link.buffered
      },
      (id) => {
        b.streams.delete(id)
        this.changed()
      }
    )
    // Registered before the open goes out, so the host's first bytes have somewhere to land.
    b.streams.set(streamId, stream)
    this.changed()
    link.request('ports.open', { from, streamId, forwardId: b.port.id }, { timeoutMs: 10_000 }).then(
      () => stream.pump(),
      (err: unknown) => {
        this.log(`${hostId}: ${b.port.port}: open failed: ${err instanceof Error ? err.message : String(err)}`)
        stream.finish()
      }
    )
  }

  private unbind(b: Bound): void {
    for (const s of [...b.streams.values()]) s.finish('forward closed', true)
    b.server?.close()
    b.server = null
  }

  private async report(hostId: string): Promise<void> {
    const link = this.deps.link(hostId)
    if (!link) return
    const bound: PortBinding[] = [...(this.bound.get(hostId)?.values() ?? [])].map((b) => ({ id: b.port.id, macPort: b.macPort, error: b.error }))
    await link.request('ports.bound', { from: this.deps.environmentId, bound }).catch((err: unknown) => {
      this.log(`${hostId}: ports.bound: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  private stream(hostId: string, streamId: string): LinkStream | undefined {
    for (const b of this.bound.get(hostId)?.values() ?? []) {
      const s = b.streams.get(streamId)
      if (s) return s
    }
    return undefined
  }

  onData(hostId: string, streamId: string, seq: number, data: string): void {
    this.stream(hostId, streamId)?.deliver(seq, data)
  }

  onClose(hostId: string, streamId: string, seq: number, error?: string): void {
    this.stream(hostId, streamId)?.remoteClose(seq, error)
  }

  /** The link to a host went down: every forward of it closes until the list comes again. */
  linkDown(hostId: string): void {
    void this.serial(hostId, async () => {
      for (const b of this.bound.get(hostId)?.values() ?? []) this.unbind(b)
      this.bound.delete(hostId)
      this.offered.delete(hostId)
      this.changed()
    })
  }

  /** The host's switch: off closes every forward of it (and says so to the host), on binds the list again. */
  async setEnabled(hostId: string, on: boolean): Promise<ForwardHost[]> {
    this.deps.setEnabled(hostId, on)
    await this.serial(hostId, () => this.reconcile(hostId))
    return this.hosts()
  }

  shutdown(): void {
    this.closed = true
    for (const map of this.bound.values()) for (const b of map.values()) this.unbind(b)
    this.bound.clear()
  }
}

/** The setting that holds a host's switch; absent means on. */
export const forwardSettingKey = (hostId: string): string => `ports.forward.${hostId}`
