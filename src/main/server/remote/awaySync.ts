import type { ServerPush } from '@shared/contract'
import { isNewerAway, type AwayState } from '@shared/away'
import type { AwaySnapshot } from '@shared/contract-away'
import type { AwayService } from '../away'
import type { Peers } from './peers'

/**
 * Away from computer, one state on every host (docs/box.md "Away from
 * computer: one state on every host"). Runs on the host holding the peer
 * links (the Mac). No host is the home: a flip must work while the box is
 * out of reach. Newest wins, both ways:
 *
 *  - a flip here goes to every open link as `away.apply`;
 *  - a peer's `away` push (the box sends one to every socket on each change,
 *    so a flip at its /ui reaches every Mac) is applied when newer and never
 *    sent back to where it came from;
 *  - on link-up each side reads the other's state and the older one takes
 *    the newer.
 */
export interface AwaySyncDeps {
  away: Pick<AwayService, 'get' | 'apply' | 'onChange'>
  peers: Pick<Peers, 'get' | 'all'>
  log?: (line: string) => void
}

export class AwaySync {
  /** The link whose push is being applied: its own state is not sent back to it. */
  private source: string | null = null
  private off: (() => void) | null = null

  constructor(private readonly deps: AwaySyncDeps) {}

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(`[away-sync] ${l}`)))(line)
  }

  start(): void {
    if (this.off) return
    this.off = this.deps.away.onChange((snapshot, stateChanged) => {
      if (stateChanged) this.send(snapshot.state)
    })
  }

  close(): void {
    this.off?.()
    this.off = null
  }

  /** A link came up: whichever side is older takes the newer state. */
  async linkUp(id: string): Promise<void> {
    const link = this.deps.peers.get(id)
    if (!link?.connected) return
    try {
      const theirs = (await link.request<AwaySnapshot>('away.get')).state
      const mine = this.deps.away.get().state
      if (isNewerAway(theirs, mine)) this.applyFrom(id, theirs)
      else if (isNewerAway(mine, theirs)) await link.request('away.apply', { state: mine })
    } catch (err) {
      this.log(`${link.env.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** A peer's `away` push: applied when newer. Consumes it. */
  onPeerPush(from: string, push: ServerPush): boolean {
    if (push.push !== 'away') return false
    this.applyFrom(from, push.state)
    return true
  }

  private applyFrom(id: string, state: AwayState): void {
    this.source = id
    try {
      this.deps.away.apply(state)
    } finally {
      this.source = null
    }
  }

  private send(state: AwayState): void {
    for (const link of this.deps.peers.all()) {
      if (!link.connected || link.id === this.source) continue
      link.request('away.apply', { state }).catch((err: unknown) => {
        // The link-up reconcile carries it once the peer is back.
        this.log(`${link.env.name}: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }
}
