import type { ServerFrame, ServerPush } from '@shared/contract'
import type { SelfUpdateOutcome } from '../updateTrigger'

/**
 * A release landed: say so, so the installed app fetches it that second
 * instead of on its five-minute poll (update.ts `selfUpdate`).
 *
 * The box has no link of its own to the Mac; it sends `release-available`
 * down every registered Mac's socket (PeerCalls.notify) when a batch's
 * publish step reports green or its deploy of a v1.0.N finishes. The Mac
 * hears it on its link (`Peers.onPush`) and hands the version to its
 * updater, which ignores a version it already runs or holds. On the Mac
 * the same announcer is the local updater itself: a publish the Mac's own
 * batch ran goes straight to `selfUpdate`, no link involved.
 */

export const RELEASE_AVAILABLE_PUSH = 'release-available'

export interface ReleaseAnnouncerDeps {
  environmentId: string
  /** One frame down every registered peer's socket (PeerCalls.notify); absent on a host no peer registers with. */
  notify?: (frame: ServerFrame) => void
  /** This host's own updater (update.ts selfUpdate); absent on a headless host or a dev instance. */
  selfUpdate?: (version: string) => Promise<SelfUpdateOutcome>
  log?: (line: string) => void
}

const VERSION = /^\d+\.\d+\.\d+$/

export class ReleaseAnnouncer {
  constructor(private readonly deps: ReleaseAnnouncerDeps) {}

  /** A release this host saw land: tell the peers, and this host's own updater. `version` is "1.0.N" or "v1.0.N". */
  announce(version: string): void {
    const v = version.replace(/^v/, '')
    if (!VERSION.test(v)) return
    this.deps.notify?.({ push: RELEASE_AVAILABLE_PUSH, from: this.deps.environmentId, version: v })
    void this.fetch(v, 'this host')
  }

  /** A push on a link this host holds: a peer's word that a release landed. */
  onPeerPush(from: string, push: ServerPush): boolean {
    if (push.push !== RELEASE_AVAILABLE_PUSH) return false
    if (typeof push.version === 'string' && VERSION.test(push.version)) void this.fetch(push.version, from)
    return true
  }

  private async fetch(version: string, from: string): Promise<void> {
    if (!this.deps.selfUpdate) return
    try {
      const outcome = await this.deps.selfUpdate(version)
      this.deps.log?.(`[release] ${version} from ${from}: ${outcome}`)
    } catch (err) {
      this.deps.log?.(`[release] ${version} from ${from}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
