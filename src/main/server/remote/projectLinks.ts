import type { ServerPush } from '@shared/contract'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import type { EnsureLinkedResult } from '@shared/wireSchemas'
import {
  decideLink,
  matchProjects,
  projectMatchKey,
  matchWorkspaces,
  newProjectLinkId,
  newWorkspaceLinkId,
  settingsHomeOf,
  type CatalogLinkArgs,
  type EnsureLinkedArgs,
  type LinkableProject,
  type LinkableWorkspace,
  type LinkDecision,
  type Pair
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
 *
 * Then it makes the copies that are missing (docs/box.md "One project across
 * hosts: a new project gets its copies"): a project with no link id, not
 * archived, in a paired workspace whose other copy has no project of its
 * name, gets its copy on the other side through `project.ensureLinked`
 * (over the link for the peer, in process for this host) with a fresh id,
 * and the source row takes that id only once the copy exists. A project
 * that carries a link id has had its copy: a partner missing then is one a
 * person deleted (or a wrong link they undid), never made again. A failed
 * copy writes one log line and the reason on the source row (`linkNote`),
 * which the next run tries again.
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
  /** This host's `project.ensureLinked` (server/projectLinks.ts). */
  ensureLinked(args: EnsureLinkedArgs): Promise<EnsureLinkedResult>
  /** Where this host's checkouts live, for the peer's path mapping. */
  workRoot?: () => string
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
type Notes = { id: string; note: string | null }[]

/** The id both copies of a workspace pair carry once this run's stamps land, or null while they differ. */
function agreedLink(pair: Pair<Row>, stamps: { local: Stamps; peer: Stamps }): string | null {
  const l = stamps.local.find((s) => s.id === pair.local.id)?.linkId ?? pair.local.linkId
  const p = stamps.peer.find((s) => s.id === pair.peer.id)?.linkId ?? pair.peer.linkId
  return l && l === p ? l : null
}

/** The projects of `from` that need a copy in `to`: unlinked, unarchived, unpaired, and no project of their name there. */
function missingCopies(from: readonly ProjectMeta[], to: readonly ProjectMeta[], paired: ReadonlySet<string>): ProjectMeta[] {
  const names = new Set(to.map((p) => projectMatchKey(p.name)))
  return from.filter((p) => !p.linkId && !p.archived && !paired.has(p.id) && !names.has(projectMatchKey(p.name)))
}

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
      await this.makeCopies(link, wsPairs, ws, prPairs, localPr, peerPr, mint.project)
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

  /**
   * Make each missing copy, one at a time: a fresh id, `project.ensureLinked`
   * on the side that lacks the project (never making a workspace there), and
   * the id stamped on the source once the copy exists. A failure leaves the
   * source unlinked with its reason, logged once per new reason.
   */
  private async makeCopies(
    link: LinkerLink,
    wsPairs: readonly Pair<LinkableWorkspace>[],
    wsStamps: { local: Stamps; peer: Stamps },
    prPairs: readonly Pair<LinkableProject>[],
    localPr: readonly ProjectMeta[],
    peerPr: readonly ProjectMeta[],
    mint: () => string
  ): Promise<void> {
    const pairedLocal = new Set(prPairs.map((p) => p.local.id))
    const pairedPeer = new Set(prPairs.map((p) => p.peer.id))
    const out = { local: { stamps: [] as Stamps, notes: [] as Notes }, peer: { stamps: [] as Stamps, notes: [] as Notes } }
    const myRoot = this.deps.workRoot?.()
    for (const pair of wsPairs) {
      const workspaceLinkId = agreedLink(pair, wsStamps)
      if (!workspaceLinkId) continue
      const mine = localPr.filter((p) => p.workspaceId === pair.local.id)
      const theirs = peerPr.filter((p) => p.workspaceId === pair.peer.id)
      const jobs = [
        ...missingCopies(mine, theirs, pairedLocal).map((p) => ({ p, ws: pair.local, to: 'peer' as const })),
        ...missingCopies(theirs, mine, pairedPeer).map((p) => ({ p, ws: pair.peer, to: 'local' as const }))
      ]
      for (const { p, ws, to } of jobs) {
        const projectLinkId = mint()
        const args: EnsureLinkedArgs = {
          projectLinkId,
          workspaceLinkId,
          name: p.name,
          branch: p.branch ?? null,
          mode: p.mode,
          callerWorkspacePath: ws.path,
          callerProjectCwd: p.cwd,
          ...(to === 'peer' && myRoot ? { callerWorkRoot: myRoot } : {}),
          ...(ws.githubRepo ? { workspaceGithubRepo: ws.githubRepo } : {}),
          workspaceMustExist: true
        }
        let why: string
        try {
          const made = to === 'peer' ? await link.request<EnsureLinkedResult>('project.ensureLinked', args) : await this.deps.ensureLinked(args)
          if (made.project) {
            const source = to === 'peer' ? out.local : out.peer
            source.stamps.push({ id: p.id, linkId: projectLinkId })
            this.log(`${link.id}: made ${p.name}'s copy ${to === 'peer' ? 'there' : 'here'}${made.note ? ` (${made.note})` : ''}`)
            continue
          }
          why = made.note ?? 'no copy was made'
        } catch (err) {
          if (!link.connected) return
          why = err instanceof Error ? err.message.replace(/^\w+: /, '') : String(err)
        }
        const note = `Couldn't make a copy: ${why}`.slice(0, 500)
        if ((p.linkNote ?? null) === note) continue
        this.log(`${link.id}: no copy of ${p.name} ${to === 'peer' ? 'there' : 'here'}: ${why}`)
        ;(to === 'peer' ? out.local : out.peer).notes.push({ id: p.id, note })
      }
    }
    if (out.peer.stamps.length || out.peer.notes.length) {
      await link.request('catalog.link', { workspaces: [], projects: out.peer.stamps, notes: out.peer.notes } satisfies CatalogLinkArgs)
    }
    if (out.local.stamps.length || out.local.notes.length) {
      this.stamping = true
      try {
        this.deps.registry.linkCatalog({ workspaces: [], projects: out.local.stamps, notes: out.local.notes })
      } finally {
        this.stamping = false
      }
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
