import { connect, type Socket } from 'node:net'
import type { ServerFrame } from '@shared/contract'
import type { ForwardedPort, PortBinding, PortForwardInfo } from '@shared/contract-ports'
import { LinkStream } from './portStreams'

/**
 * The host side of the dev server forward (docs/box.md "Dev servers on the
 * box"): the ports this host offers (its threads' `port` rows and its dev
 * runs' listeners) go to every Mac registered with the `ports` offer as one
 * list, sent again on every change and whenever a Mac registers (a link that
 * came back re-forwards everything). The Mac answers what it bound
 * (`ports.bound`), which the rows show and the tool result's tail names.
 * Each `ports.open` dials this host's loopback, never another interface:
 * 127.0.0.1, then ::1 for a server bound to v6 alone.
 */

export interface PortForwardHostDeps {
  /** This host's environment id (the list says whose it is). */
  environmentId: string
  /** Every port this host offers now. */
  offers: () => ForwardedPort[]
  /** Registered Macs that take forwards. */
  macs: () => string[]
  push: (envId: string, frame: ServerFrame) => boolean
  /** The Mac socket's unsent bytes (ws.bufferedAmount). */
  buffered: (envId: string) => number
  hostName: (envId: string) => string | null
  /** Dial a port on this host's loopback (tests and the proof pass their own). */
  dial?: (port: number) => Promise<Socket>
  log?: (line: string) => void
}

/** 127.0.0.1, else ::1: loopback only. */
export function dialLoopback(port: number): Promise<Socket> {
  const attempt = (host: string) =>
    new Promise<Socket>((resolve, reject) => {
      const s = connect({ host, port, allowHalfOpen: true })
      s.once('connect', () => {
        s.removeListener('error', reject)
        resolve(s)
      })
      s.once('error', reject)
    })
  return attempt('127.0.0.1').catch(() => attempt('::1'))
}

export class PortForwardHost {
  /** What each Mac bound: envId → forward id → binding. */
  private readonly bindings = new Map<string, Map<string, PortBinding>>()
  /** The JSON of the list each Mac was last sent. */
  private readonly sent = new Map<string, string>()
  private readonly streams = new Map<string, { envId: string; stream: LinkStream }>()
  private readonly boundListeners = new Set<(ids: string[]) => void>()
  private readonly log: (line: string) => void

  constructor(private readonly deps: PortForwardHostDeps) {
    this.log = deps.log ?? ((line) => console.log(`[ports] ${line}`))
  }

  /** The offered list changed (or might have): every Mac whose copy differs hears it. */
  refresh(): void {
    const ports = this.deps.offers()
    const json = JSON.stringify(ports)
    for (const envId of this.deps.macs()) {
      if (this.sent.get(envId) === json) continue
      if (this.deps.push(envId, { push: 'ports', from: this.deps.environmentId, ports } as ServerFrame)) {
        this.sent.set(envId, json)
        this.log(`${this.deps.hostName(envId) ?? envId}: ${ports.length} port${ports.length === 1 ? '' : 's'} offered`)
      }
    }
    // Bindings of ports that left are dropped (the Mac closes their listeners and streams).
    const ids = new Set(ports.map((p) => p.id))
    for (const map of this.bindings.values()) for (const id of [...map.keys()]) if (!ids.has(id)) map.delete(id)
  }

  /** A Mac registered (or registered again): it gets the whole list now. */
  macRegistered(envId: string): void {
    this.sent.delete(envId)
    this.refresh()
  }

  /** A Mac's socket closed: its streams end and what it bound is forgotten. */
  macDropped(envId: string): void {
    this.sent.delete(envId)
    const had = [...(this.bindings.get(envId)?.keys() ?? [])]
    this.bindings.delete(envId)
    for (const s of [...this.streams.values()]) if (s.envId === envId) s.stream.finish('link closed')
    if (had.length) this.emitBound(had)
  }

  bound(envId: string, bound: PortBinding[]): { ok: true } {
    const map = new Map(bound.map((b) => [b.id, b]))
    const prior = this.bindings.get(envId)
    this.bindings.set(envId, map)
    const changed = new Set<string>()
    for (const b of bound) if (JSON.stringify(prior?.get(b.id)) !== JSON.stringify(b)) changed.add(b.id)
    for (const id of prior?.keys() ?? []) if (!map.has(id)) changed.add(id)
    if (changed.size) this.emitBound([...changed])
    return { ok: true }
  }

  private emitBound(ids: string[]): void {
    for (const l of this.boundListeners) l(ids)
  }

  /** What the Macs bound for some forward ids changed. */
  onBound(listener: (ids: string[]) => void): () => void {
    this.boundListeners.add(listener)
    return () => this.boundListeners.delete(listener)
  }

  /** Where one forward landed, per Mac. */
  forwardsOf(id: string): PortForwardInfo[] {
    const out: PortForwardInfo[] = []
    for (const [envId, map] of this.bindings) {
      const b = map.get(id)
      if (b) out.push({ environmentId: envId, hostName: this.deps.hostName(envId), macPort: b.macPort, error: b.error })
    }
    return out
  }

  /** Resolves once every registered Mac answered for each id (or after `ms`). */
  whenBound(ids: readonly string[], ms: number): Promise<void> {
    const done = () => this.deps.macs().every((m) => ids.every((id) => this.bindings.get(m)?.has(id)))
    if (!ids.length || done()) return Promise.resolve()
    return new Promise((resolve) => {
      const off = this.onBound(() => {
        if (!done()) return
        clear()
      })
      const timer = setTimeout(() => clear(), ms)
      const clear = () => {
        off()
        clearTimeout(timer)
        resolve()
      }
    })
  }

  // ── streams ──────────────────────────────────────────────────────────

  async open(envId: string, streamId: string, forwardId: string): Promise<{ ok: true }> {
    const port = this.deps.offers().find((p) => p.id === forwardId)
    if (!port) throw new Error(`no such forward: ${forwardId}`)
    const key = `${envId}/${streamId}`
    if (this.streams.has(key)) throw new Error(`stream ${streamId} is open`)
    const socket = await (this.deps.dial ?? dialLoopback)(port.port)
    const stream = new LinkStream(
      key,
      socket,
      {
        data: (seq, data) => {
          this.deps.push(envId, { push: 'ports.data', streamId, seq, data } as ServerFrame)
        },
        close: (seq, error) => {
          this.deps.push(envId, { push: 'ports.close', streamId, seq, ...(error ? { error } : {}) } as ServerFrame)
        },
        buffered: () => this.deps.buffered(envId)
      },
      (k) => this.streams.delete(k)
    )
    this.streams.set(key, { envId, stream })
    stream.pump()
    return { ok: true }
  }

  data(envId: string, streamId: string, seq: number, data: string): { ok: true } {
    this.streams.get(`${envId}/${streamId}`)?.stream.deliver(seq, data)
    return { ok: true }
  }

  close(envId: string, streamId: string, seq: number, error?: string): { ok: true } {
    this.streams.get(`${envId}/${streamId}`)?.stream.remoteClose(seq, error)
    return { ok: true }
  }

  /** Open streams, for the proof and the log. */
  streamCount(envId?: string): number {
    return [...this.streams.values()].filter((s) => !envId || s.envId === envId).length
  }

  shutdown(): void {
    for (const s of [...this.streams.values()]) s.stream.finish('host closing')
  }
}
