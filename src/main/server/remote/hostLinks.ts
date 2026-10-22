import type { MacBridgePush } from '@shared/contract-macbridge'
import type { MacPeerMethod } from '@shared/contract-macjobs'
import { PeerOfflineError, type LinkRequest, type PeerCalls } from './peerCalls'

/**
 * One way to call another host's main process, whichever way the socket
 * between them runs (docs/box.md "Threads across hosts"). A host is reached
 *
 *  - `registered`: it dialed this host and registered with `peer.register`
 *    (the Mac on the box); the call is a `peer.call` push down that socket
 *    (remote/peerCalls.ts), answered with `peer.reply`;
 *  - `link`: this host dialed it and holds a PeerLink (the box, from the
 *    Mac); the call is an ordinary request on its listener, under the admin
 *    key the link authenticated with.
 *
 * The same pair is never both at once (the box cannot dial the Mac), so a
 * host is one or the other. Callers name the method and the host and never
 * know which way it went; a host out of reach is `PeerOfflineError` either
 * way, so the callers' "linkDown" rule holds on both.
 */

export type HostVia = 'registered' | 'link'

export interface HostTransport {
  /** Every host reachable now, with how. */
  reachable(): { id: string; via: HostVia }[]
  /** How a host is reached, or null when it is not. */
  via(id: string): HostVia | null
  /** Why a host is not reachable for threads: null when it is. */
  refusal(id: string): string | null
  call<T>(id: string, method: string, params: unknown, deadlineMs: number): Promise<T>
}

export interface HostLinksDeps {
  /** The sockets other hosts registered on this one. */
  calls: Pick<PeerCalls, 'online' | 'registeredIds' | 'call'>
  /** The offer a registration must carry to count (`threads`). */
  offer: string
  /** The link this host holds to a saved host, while it is up. */
  link: (id: string) => LinkRequest | null
  /** Every saved host this process keeps a link to, up or not. */
  linkIds: () => string[]
}

export class HostLinks implements HostTransport {
  constructor(private readonly deps: HostLinksDeps) {}

  reachable(): { id: string; via: HostVia }[] {
    const out: { id: string; via: HostVia }[] = this.deps.calls.registeredIds(this.deps.offer).map((id) => ({ id, via: 'registered' as const }))
    for (const id of this.deps.linkIds()) if (!out.some((r) => r.id === id) && this.deps.link(id)) out.push({ id, via: 'link' })
    return out
  }

  via(id: string): HostVia | null {
    if (this.deps.calls.online(id, this.deps.offer)) return 'registered'
    if (this.deps.link(id)) return 'link'
    return null
  }

  refusal(id: string): string | null {
    if (this.via(id)) return null
    if (this.deps.calls.online(id)) return `host offline for threads: ${id} is linked but offers no threads (an older app there)`
    return `host offline: ${id} has no live link to this host`
  }

  async call<T>(id: string, method: string, params: unknown, deadlineMs: number): Promise<T> {
    if (this.deps.calls.online(id, this.deps.offer))
      return this.deps.calls.call<T>(id, method as MacPeerMethod, params as Extract<MacBridgePush, { push: 'peer.call' }>['params'], deadlineMs)
    const request = this.deps.link(id)
    if (!request) throw new PeerOfflineError(id)
    try {
      return (await request(method, params, { timeoutMs: deadlineMs })) as T
    } catch (err) {
      // The link dropped under the call: the callers read that as the host out of reach.
      if (!this.deps.link(id)) throw new PeerOfflineError(id)
      throw err
    }
  }
}
