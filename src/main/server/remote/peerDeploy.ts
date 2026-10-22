import type { ServerPush } from '@shared/contract'
import type { DeployStatus, HostLogPush } from '@shared/contract-host'
import type { LinkRequest } from './peerCalls'

/**
 * The box's deploy trigger as the Mac's batch engine sees it (batch.ts
 * `deploy` dep when the master thread lives on the Mac): `host.deploy` and
 * `host.log { job: 'deploy' }` over the Mac's link to the box, the box's
 * `host-log` pushes fed to the one subscriber, the same shape as
 * hostJobs.ts's DeployTrigger. The deploy restarts the box's process, so
 * the link drops mid-run: `linkUp` re-asks the log and feeds only what the
 * subscriber has not seen (the new process re-reads the whole file), and
 * the step closes on the status the fresh snapshot carries.
 */

export interface PeerDeployDeps {
  /** The connected links: id and name; the box is the only one, else the call refuses. */
  links: () => { id: string; name: string }[]
  link: (id: string) => LinkRequest | null
  log?: (line: string) => void
}

type Snapshot = { text: string; status: DeployStatus }

export class PeerDeploy {
  private envId: string | null = null
  private send: ((push: HostLogPush) => void) | null = null
  private delivered = ''
  private last: DeployStatus | null = null

  constructor(private readonly deps: PeerDeployDeps) {}

  /** The one box this Mac links to; a refusal names the choices. */
  resolveBox(): string {
    const links = this.deps.links()
    if (links.length === 1) return links[0].id
    if (!links.length) throw new Error('no host is linked')
    throw new Error(`several hosts are linked (${links.map((l) => l.name).join(', ')}); a box deploy from the Mac needs exactly one`)
  }

  async deploy(ref: string): Promise<DeployStatus> {
    const envId = this.resolveBox()
    const request = this.deps.link(envId)
    if (!request) throw new Error('the box is not connected')
    this.envId = envId
    this.delivered = ''
    const status = (await request('host.deploy', { ref })) as DeployStatus
    this.last = status
    return status
  }

  async status(): Promise<DeployStatus> {
    const request = this.envId ? this.deps.link(this.envId) : null
    if (!request) {
      if (this.last) return this.last
      throw new Error('the box is not connected')
    }
    const status = (await request('host.deployStatus', {})) as DeployStatus
    this.last = status
    return status
  }

  /** The one subscriber hears the box's deploy log from here on; the snapshot's unseen text comes first. */
  subscribe(_connection: number, send: (push: HostLogPush) => void): () => void {
    this.send = send
    void this.follow()
    return () => {
      if (this.send === send) this.send = null
    }
  }

  /** A link came (back) up: if it is the box's and someone listens, ask for the log again. */
  linkUp(envId: string): void {
    if (envId === this.envId && this.send) void this.follow()
  }

  /** A push on a link this Mac holds: the box's deploy log, for the subscriber. */
  onPeerPush(from: string, push: ServerPush): boolean {
    if (push.push !== 'host-log' || push.job !== 'deploy') return false
    if (from !== this.envId || !this.send) return true
    if (push.reset) this.delivered = ''
    if (push.append) this.delivered += push.append
    this.last = push.status as DeployStatus
    this.send(push)
    return true
  }

  private async follow(): Promise<void> {
    const request = this.envId ? this.deps.link(this.envId) : null
    const send = this.send
    if (!request || !send) return
    try {
      const snapshot = (await request('host.log', { job: 'deploy' })) as Snapshot
      if (this.send !== send) return
      const text = snapshot.text
      // The new process on the box re-read the whole log: feed only what is new.
      const fresh = text.startsWith(this.delivered) ? text.slice(this.delivered.length) : text
      if (!text.startsWith(this.delivered)) this.delivered = ''
      this.delivered += fresh
      this.last = snapshot.status
      send({ push: 'host-log', job: 'deploy', ...(fresh ? { append: fresh } : {}), status: snapshot.status })
    } catch (err) {
      this.deps.log?.(`[deploy] the box's log: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
