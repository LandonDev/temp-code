import type { Principal } from '@shared/capabilities'
import type { HostPresence, RelayCallParams, RelayFacadeResult, RelayOpenResult, RelayPrincipal } from '@shared/contract-relay'
import { MacPresenceWatcher } from '../../presence'
import type { FacadeContext } from './facade'
import type { LinkRequest } from './peerCalls'
import type { HostRelay, RelayTransport } from './relay'
import { RelayServer, type RelaySocket } from './relayServe'

/**
 * The relay in one process, for the iOS client's test server
 * (scripts/ios-client-test-server.ts): fake hosts whose lanes are served by
 * this same server's attach(), so a phone's relayed lane lists the seeded
 * threads under the fake host's id, and whose presence a control route
 * flips. Each host is an ordinary RelayServer; the transport calls its
 * `handle` directly where production sends a peer.call, and its link answers
 * relay.frames, relay.closed, peer.presence and relay.notice on the
 * HostRelay where production sends them over the socket. Test-only.
 */

export class LoopbackRelayTransport implements RelayTransport {
  private readonly servers = new Map<string, RelayServer>()

  constructor(private readonly carrierId: string) {}

  add(envId: string, server: RelayServer): void {
    this.servers.set(envId, server)
  }

  online(envId: string): boolean {
    return this.servers.has(envId)
  }

  private call<T>(envId: string, method: 'relay.open' | 'relay.frame' | 'relay.close' | 'relay.facade', args: RelayCallParams['args']): Promise<T> {
    const server = this.servers.get(envId)
    if (!server) return Promise.reject(new Error(`loopback: no host ${envId}`))
    return server.handle(method, { from: this.carrierId, args }, { from: this.carrierId }) as Promise<T>
  }

  open(envId: string, socketId: string, principal: RelayPrincipal): Promise<RelayOpenResult> {
    return this.call(envId, 'relay.open', { socketId, principal })
  }
  async frame(envId: string, socketId: string, frame: unknown): Promise<void> {
    await this.call(envId, 'relay.frame', { socketId, frame })
  }
  async close(envId: string, socketId: string, reason: string): Promise<void> {
    await this.call(envId, 'relay.close', { socketId, reason })
  }
  facade(envId: string, principal: RelayPrincipal, name: string, args: unknown): Promise<RelayFacadeResult> {
    return this.call(envId, 'relay.facade', { principal, name, arguments: args })
  }
}

/** A host's requests to the carrier, answered on the HostRelay in-process. */
export function loopbackLink(relay: HostRelay): LinkRequest {
  return async (method, params) => {
    const p = params as Record<string, never>
    switch (method) {
      case 'relay.frames':
        return relay.onFrames(p.from, p.socketId, p.frames)
      case 'relay.closed':
        return relay.onClosed(p.from, p.socketId, p.reason)
      case 'peer.presence':
        return relay.onPeerPresence(p.from, p.presence)
      case 'relay.notice':
        return relay.onNotice(p.from, p.notice)
      default:
        throw new Error(`loopback: ${method} is not carried`)
    }
  }
}

export interface LoopbackHostSpec {
  environmentId: string
  name: string
  /** The row the carrier lists at start; `link: 'down'` leaves the host out of the transport (a 503). */
  row: Omit<HostPresence, 'environmentId' | 'name'>
}

export interface LoopbackHosts {
  transport: LoopbackRelayTransport
  /** Flip a host's presence as its own watcher would; the carrier hears it as peer.presence. */
  setPresence(envId: string, patch: { screen?: HostPresence['screen']; power?: HostPresence['power'] }): HostPresence | null
  close(): void
}

/** Seed `relay` with these hosts and carry their lanes onto `attach` (the carrier's own). */
export function startLoopbackHosts(opts: {
  carrierId: string
  carrierName: string
  relay: HostRelay
  attach: (ws: RelaySocket, principal: Principal & { kind: 'remote' }) => void
  facade: () => Omit<FacadeContext, 'principal' | 'environmentId' | 'hostName'>
  hosts: LoopbackHostSpec[]
}): LoopbackHosts {
  const transport = new LoopbackRelayTransport(opts.carrierId)
  const link = loopbackLink(opts.relay)
  const watchers = new Map<string, MacPresenceWatcher>()
  const servers: RelayServer[] = []
  for (const host of opts.hosts) {
    opts.relay.seedForTests(host.environmentId, { name: host.name, ...host.row })
    if (host.row.link === 'down') continue
    const watcher = new MacPresenceWatcher({ initial: { screen: host.row.screen, power: host.row.power } })
    const server = new RelayServer({
      environmentId: host.environmentId,
      attach: opts.attach,
      link: (envId) => (envId === opts.carrierId ? link : null),
      environments: () => [{ id: opts.carrierId, name: opts.carrierName }],
      presence: watcher,
      facade: () => ({ ...opts.facade(), environmentId: host.environmentId, hostName: host.name }),
      deliversNotices: () => true,
      hostname: host.name,
      log: () => {}
    })
    server.linkUp(opts.carrierId)
    transport.add(host.environmentId, server)
    watchers.set(host.environmentId, watcher)
    servers.push(server)
  }
  opts.relay.setTransport(transport)
  return {
    transport,
    setPresence: (envId, patch) => {
      watchers.get(envId)?.set(patch)
      return opts.relay.presenceOf(envId)
    },
    close: () => {
      for (const s of servers) s.close()
    }
  }
}
