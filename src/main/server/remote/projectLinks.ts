import type { ServerPush } from '@shared/contract'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import {
  decideLink,
  matchProjects,
  matchWorkspaces,
  newProjectLinkId,
  newWorkspaceLinkId,
  settingsHomeOf,
  type CatalogLinkArgs,
  type LinkDecision
} from '@shared/projectLinks'

/**
 * The linker (docs/box.md "One project across hosts: the linker"): on the
 * host that holds the admin link to another host (the Mac, to the box), it
 * pairs this host's workspaces and projects with the peer's by the pure
 * rules of shared/projectLinks.ts and stamps the ids both copies share,
 * here through the registry and there through `catalog.link`.
 *
 * A run is two reads (`workspace.list`, `project.list` on the peer) and at
 * most two writes (one per side, only when something changed). It runs on
 * link-up, on a `workspaces`/`projects` push from the peer, on a catalog
 * change here and every 5 minutes, each host at most once per burst
 * (`LINK_DEBOUNCE_MS`). A link that is down skips the run. The linker never
 * removes a link: a row with no partner keeps what it carries.
 */

export const LINK_DEBOUNCE_MS = 2_000
export const LINK_PERIOD_MS = 5 * 60_000

/** The part of a PeerLink the linker uses. */
export interface LinkerLink {
  id: string
  connected: boolean
  build: { platform: string } | null
  request<T = unknown>(method: string, params?: unknown): Promise<T>
}

export interface ProjectLinkerDeps {
  environmentId: string
  /** This host's `process.platform`. */
  platform?: string
  registry: {
    listWorkspaces(): WorkspaceMeta[]
    listProjects(): ProjectMeta[]
    linkCatalog(args: CatalogLinkArgs): void
    onCatalog(listener: (kind: 'workspaces' | 'projects') => void): () => void
  }
  peers: { get(id: string): LinkerLink | undefined; all(): LinkerLink[] }
  mint?: { workspace: () => string; project: () => string }
  now?: () => number
  log?: (line: string) => void
}

export interface ProjectLinkStatus {
  lastRunAt: number | null
  pairs: { workspaces: number; projects: number }
  error?: string
}

type Row = { id: string; linkId?: string | null }
type Stamps = { id: string; linkId: string }[]

/**
 * Turn decisions into stamps for each side. A stamp that would give an id
 * to a second row on the same host is dropped: one id names one copy per
 * host (`project.ensureLinked` finds a copy by it).
 */
function stampsOf<T extends Row>(
  pairs: { local: T; peer: T }[],
  decide: (pair: { local: T; peer: T }) => LinkDecision | null,
  localRows: readonly Row[],
  peerRows: readonly Row[]
): { local: Stamps; peer: Stamps } {
  const holder = (rows: readonly Row[]) => new Map(rows.filter((r) => r.linkId).map((r) => [r.linkId as string, r.id]))
  const localHolder = holder(localRows)
  const peerHolder = holder(peerRows)
  const out = { local: [] as Stamps, peer: [] as Stamps }
  const free = (held: Map<string, string>, id: string, linkId: string): boolean => (held.get(linkId) ?? id) === id
  for (const pair of pairs) {
    const d = decide(pair)
    if (!d) continue
    if (d.local && !free(localHolder, pair.local.id, d.linkId)) continue
    if (d.peer && !free(peerHolder, pair.peer.id, d.linkId)) continue
    if (d.local) {
      localHolder.set(d.linkId, pair.local.id)
      out.local.push({ id: pair.local.id, linkId: d.linkId })
    }
    if (d.peer) {
      peerHolder.set(d.linkId, pair.peer.id)
      out.peer.push({ id: pair.peer.id, linkId: d.linkId })
    }
  }
  return out
}

export class ProjectLinker {
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  private readonly statuses = new Map<string, ProjectLinkStatus>()
  private period: NodeJS.Timeout | null = null
  private offCatalog: (() => void) | null = null
  /** True while this linker stamps local rows: the catalog change that causes is its own. */
  private stamping = false
  private closed = false

  constructor(private readonly deps: ProjectLinkerDeps) {}

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(`[project-links] ${l}`)))(line)
  }

  /** Listen to the catalog here and run every 5 minutes. */
  start(): void {
    if (this.closed || this.period) return
    this.offCatalog = this.deps.registry.onCatalog(() => {
      if (!this.stamping) this.soonAll()
    })
    this.period = setInterval(() => this.soonAll(), LINK_PERIOD_MS)
    this.period.unref?.()
  }

  linkUp(id: string): void {
    this.soon(id)
  }

  /** A push on a link this host holds: the peer's catalog changed. Never consumes the push. */
  onPeerPush(from: string, push: ServerPush): void {
    if (push.push === 'workspaces' || push.push === 'projects') this.soon(from)
  }

  private soonAll(): void {
    for (const link of this.deps.peers.all()) this.soon(link.id)
  }

  /** Run for `id` once the burst is over; asks meanwhile ride the one waiting. */
  soon(id: string): void {
    if (this.closed || this.timers.has(id)) return
    const timer = setTimeout(() => {
      this.timers.delete(id)
      void this.run(id)
    }, LINK_DEBOUNCE_MS)
    timer.unref?.()
    this.timers.set(id, timer)
  }

  /** One run against `id` now; a run asked while one is going follows it once. */
  run(id: string): Promise<void> {
    if (this.closed) return Promise.resolve()
    const going = this.running.get(id)
    if (going) {
      this.again.add(id)
      return going
    }
    const run = this.link(id).finally(() => {
      this.running.delete(id)
      if (this.again.delete(id)) void this.run(id)
    })
    this.running.set(id, run)
    return run
  }

  status(id: string): ProjectLinkStatus | null {
    return this.statuses.get(id) ?? null
  }

  statusAll(): Record<string, ProjectLinkStatus> {
    return Object.fromEntries(this.statuses)
  }

  private async link(id: string): Promise<void> {
    const link = this.deps.peers.get(id)
    if (!link?.connected) return
    try {
      const [peerWs, peerPr] = await Promise.all([link.request<WorkspaceMeta[]>('workspace.list'), link.request<ProjectMeta[]>('project.list')])
      const localWs = this.deps.registry.listWorkspaces()
      const localPr = this.deps.registry.listProjects()
      const me = this.deps.environmentId
      const platform = this.deps.platform ?? process.platform
      // The peer's platform is its hello's; unheard counts as a box (settingsHomeOf).
      const home = settingsHomeOf([{ environmentId: me }, { environmentId: id }], (env) => (env === me ? platform : link.build?.platform))
      const peerIsHome = home === id
      const mint = this.deps.mint ?? { workspace: newWorkspaceLinkId, project: newProjectLinkId }

      const wsPairs = matchWorkspaces(localWs, peerWs)
      const prPairs = matchProjects(wsPairs, localPr, peerPr)
      const ws = stampsOf(wsPairs, (p) => decideLink(p.local.linkId, p.peer.linkId, peerIsHome, mint.workspace), localWs, peerWs)
      const pr = stampsOf(prPairs, (p) => decideLink(p.local.linkId, p.peer.linkId, peerIsHome, mint.project), localPr, peerPr)

      if (ws.peer.length || pr.peer.length) await link.request('catalog.link', { workspaces: ws.peer, projects: pr.peer } satisfies CatalogLinkArgs)
      if (ws.local.length || pr.local.length) {
        this.stamping = true
        try {
          this.deps.registry.linkCatalog({ workspaces: ws.local, projects: pr.local })
        } finally {
          this.stamping = false
        }
      }
      const stamped = ws.local.length + ws.peer.length + pr.local.length + pr.peer.length
      if (stamped) this.log(`${id}: stamped ${ws.local.length + pr.local.length} here, ${ws.peer.length + pr.peer.length} there`)
      this.statuses.set(id, { lastRunAt: this.now(), pairs: { workspaces: wsPairs.length, projects: prPairs.length } })
    } catch (err) {
      // The link dropped under the run: quiet, the next link-up runs again.
      if (!this.deps.peers.get(id)?.connected) return
      const error = err instanceof Error ? err.message : String(err)
      const was = this.statuses.get(id)
      this.statuses.set(id, { lastRunAt: this.now(), pairs: was?.pairs ?? { workspaces: 0, projects: 0 }, error })
      this.log(`${id}: ${error}`)
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  close(): void {
    this.closed = true
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    if (this.period) clearInterval(this.period)
    this.period = null
    this.offCatalog?.()
    this.offCatalog = null
  }
}
