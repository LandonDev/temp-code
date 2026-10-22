import type { ServerPush } from '@shared/contract'
import type { ProjectMeta } from '@shared/domain'
import { ProjectSettingsBundleSchema, settingsHomeOf, type ProjectSettingsBundle } from '@shared/projectLinks'
import type { Peers } from './peers'

/**
 * Project settings live on the box (docs/box.md "One project across hosts:
 * settings live on the box"). A linked project's settings home is the copy
 * `settingsHomeOf` names: the box's, when one copy is on a Mac. This module
 * runs on the host that holds the admin peer link (the Mac) and does two
 * things, both for a linked project whose home is a peer:
 *
 *  - follows: on link-up, on the peer's `projects` push and every 5 minutes
 *    (debounced per peer), it reads the peer's catalog and, for each local
 *    copy whose home's stamp is newer than its own, pulls the home's bundle
 *    and writes it here under the local id with the home's stamp. One
 *    direction only: it never writes toward the home.
 *  - routes writes (`forward`, the one rule the RPC handlers ask): a write
 *    to such a project goes to the home's copy over the link, then the
 *    home's bundle is written here, so the next pull has nothing to do. A
 *    home out of reach refuses the write and nothing is written here.
 *
 * Which peer holds a copy is remembered per peer in the settings table
 * (`PEER_KEY`), so a Mac that boots with the box down still knows the box is
 * the home and refuses instead of writing what the next pull would undo.
 */

export const PROJECT_SETTINGS_PERIOD_MS = 5 * 60_000
export const PROJECT_SETTINGS_DEBOUNCE_MS = 500
export const PEER_KEY = 'project-settings-sync:peer:'

/** What this host remembers of a peer: its platform and its linked projects. */
interface PeerRecord {
  platform: string | null
  projects: { id: string; workspaceId: string; linkId: string; name: string }[]
}

type Link = NonNullable<ReturnType<Peers['get']>>

export interface ProjectSettingsSyncDeps {
  environmentId: string
  /** This host's `process.platform`. */
  platform: string
  registry: {
    listProjects(): ProjectMeta[]
    getProject(projectId: string): ProjectMeta | null
    setProjectSettings(projectId: string, bundle: ProjectSettingsBundle, at?: number): void
  }
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void }
  peers: Pick<Peers, 'get' | 'all'>
  log?: (line: string) => void
  now?: () => number
}

/** Where a settings write goes: here, or the home's copy on a peer. */
export type SettingsRoute =
  | { kind: 'local' }
  | { kind: 'home'; link: Link; localId: string; peerProjectId: string; peerWorkspaceId: string }

export class ProjectSettingsSync {
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  private period: NodeJS.Timeout | null = null
  private closed = false

  constructor(private readonly deps: ProjectSettingsSyncDeps) {}

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(`[project-settings] ${l}`)))(line)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  start(): void {
    if (this.period || this.closed) return
    this.period = setInterval(() => {
      for (const link of this.deps.peers.all()) this.schedule(link.id)
    }, PROJECT_SETTINGS_PERIOD_MS)
    this.period.unref?.()
  }

  close(): void {
    this.closed = true
    if (this.period) clearInterval(this.period)
    this.period = null
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  linkUp(id: string): void {
    this.schedule(id)
  }

  /** A peer's `projects` push: remember its catalog and follow it. Never consumes the push. */
  onPeerPush(from: string, push: ServerPush): boolean {
    if (push.push !== 'projects') return false
    this.remember(from, push.projects)
    this.schedule(from)
    return false
  }

  /** Debounced: a burst of pushes is one pull. */
  schedule(id: string): void {
    if (this.closed) return
    const t = this.timers.get(id)
    if (t) clearTimeout(t)
    const timer = setTimeout(() => {
      this.timers.delete(id)
      void this.syncWith(id)
    }, PROJECT_SETTINGS_DEBOUNCE_MS)
    timer.unref?.()
    this.timers.set(id, timer)
  }

  /** One pull from one peer; a call while one runs runs once more after it. */
  syncWith(id: string): Promise<void> {
    const live = this.running.get(id)
    if (live) {
      this.again.add(id)
      return live
    }
    const run = (async () => {
      try {
        do {
          this.again.delete(id)
          await this.pull(id)
        } while (this.again.has(id) && !this.closed)
      } catch (err) {
        this.log(`${this.deps.peers.get(id)?.env.name ?? id}: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        this.running.delete(id)
      }
    })()
    this.running.set(id, run)
    return run
  }

  private async pull(id: string): Promise<void> {
    const link = this.deps.peers.get(id)
    if (!link?.connected) return
    const theirs = await link.request<ProjectMeta[]>('project.list')
    this.remember(id, theirs)
    const byLink = new Map(theirs.filter((p) => p.linkId).map((p) => [p.linkId!, p]))
    for (const local of this.deps.registry.listProjects()) {
      const peer = local.linkId ? byLink.get(local.linkId) : undefined
      if (!peer || this.homeOf(local.linkId!) !== id) continue
      const theirStamp = peer.settingsUpdatedAt ?? null
      // A home that never changed a setting has nothing to follow; this
      // copy keeps what it had before the link.
      if (theirStamp === null) continue
      if (local.settingsUpdatedAt != null && theirStamp <= local.settingsUpdatedAt) continue
      await this.apply(link, local.id, peer.id)
    }
  }

  /** The home's bundle, written here under the local id with the home's stamp. */
  private async apply(link: Link, localId: string, peerProjectId: string): Promise<void> {
    const bundle = ProjectSettingsBundleSchema.parse(await link.request('project.settings.get', { projectId: peerProjectId }))
    this.deps.registry.setProjectSettings(localId, bundle, bundle.updatedAt ?? this.now())
    this.log(`${link.env.name}: followed ${bundle.name}`)
  }

  // ── the settings home ───────────────────────────────────────────────

  private record(id: string): PeerRecord | null {
    const raw = this.deps.store.getSetting(`${PEER_KEY}${id}`)
    if (!raw) return null
    try {
      return JSON.parse(raw) as PeerRecord
    } catch {
      return null
    }
  }

  private remember(id: string, projects: ProjectMeta[]): void {
    const link = this.deps.peers.get(id)
    const record: PeerRecord = {
      platform: link?.build?.platform ?? this.record(id)?.platform ?? null,
      projects: projects
        .filter((p) => p.linkId)
        .map((p) => ({ id: p.id, workspaceId: p.workspaceId, linkId: p.linkId!, name: p.name }))
    }
    const raw = JSON.stringify(record)
    if (raw !== this.deps.store.getSetting(`${PEER_KEY}${id}`)) this.deps.store.setSetting(`${PEER_KEY}${id}`, raw)
  }

  private platformOf = (id: string): string | undefined => {
    if (id === this.deps.environmentId) return this.deps.platform
    return this.deps.peers.get(id)?.build?.platform ?? this.record(id)?.platform ?? undefined
  }

  /** The environment id of a link's settings home among this host and the peers holding a copy. */
  homeOf(linkId: string): string {
    const copies = [{ environmentId: this.deps.environmentId }]
    for (const link of this.deps.peers.all()) {
      if (this.record(link.id)?.projects.some((p) => p.linkId === linkId)) copies.push({ environmentId: link.id })
    }
    return settingsHomeOf(copies, this.platformOf) ?? this.deps.environmentId
  }

  /**
   * Where a write to the project's settings goes. An unlinked project, or
   * one whose home is this host, is written here as it always was. A home
   * out of reach is a refusal, with nothing written.
   */
  route(projectId: string): SettingsRoute {
    const local = this.deps.registry.getProject(projectId)
    if (!local?.linkId) return { kind: 'local' }
    const home = this.homeOf(local.linkId)
    if (home === this.deps.environmentId) return { kind: 'local' }
    const link = this.deps.peers.get(home)
    const copy = this.record(home)?.projects.find((p) => p.linkId === local.linkId)
    if (!link || !copy) return { kind: 'local' }
    if (!link.connected) throw new Error(refusal(local.name, link.env.name))
    return { kind: 'home', link, localId: local.id, peerProjectId: copy.id, peerWorkspaceId: copy.workspaceId }
  }

  /**
   * A settings write: `true` when it went to the home (the same method on
   * the home's copy) and the home's bundle now stands here too; `false`
   * when the caller writes it here as before. Throws the refusal.
   */
  async forward(projectId: string | null | undefined, method: string, params: Record<string, unknown>): Promise<boolean> {
    if (!projectId) return false
    const r = this.route(projectId)
    if (r.kind === 'local') return false
    const name = this.deps.registry.getProject(projectId)?.name ?? projectId
    try {
      await r.link.request(method, {
        ...params,
        projectId: r.peerProjectId,
        ...('workspaceId' in params ? { workspaceId: r.peerWorkspaceId } : {})
      })
    } catch (err) {
      if (!r.link.connected) throw new Error(refusal(name, r.link.env.name))
      throw err
    }
    try {
      await this.apply(r.link, r.localId, r.peerProjectId)
    } catch (err) {
      // The home has it; the next pull brings it here.
      this.log(`${r.link.env.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return true
  }
}

export const refusal = (project: string, host: string): string => `refused: settings of ${project} live on ${host}; it is offline`
