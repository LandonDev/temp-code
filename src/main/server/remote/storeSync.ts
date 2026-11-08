import { z } from 'zod'
import type { ServerPush } from '@shared/contract'
import { AddonRowSchema, type AddonRow, type StoreHome } from '@shared/contract-addons'
import { SkillMetaSchema, SkillSchema, type SkillMeta } from '@shared/contract-skills'
import type { AddonStore } from '../addonStore'
import type { SkillStore } from '../skillStore'
import type { Peers } from './peers'
import type { Scope } from './rulesSync'

/**
 * The add-on registry and the skills store live on the box, the settings
 * home RulesSync names (`settingsHomeOf`: the copy whose platform is not
 * darwin), one copy of each shared scope: the global rows and each
 * workspace both hosts hold (paired by the workspace's `linkId`). This runs
 * on the host holding the admin peer link (the Mac), for both tables:
 *
 *  - follows: on link-up, on the home's `addons`, `skills` or `workspaces`
 *    push and every 5 minutes, it reads the home's rows and writes them
 *    here (`put`, the home's ids, times and writers), fetching a skill's
 *    files only when its digest moved, and drops a row of a shared scope
 *    the home no longer lists.
 *  - seeds once per home, table and scope: before a shared scope's first
 *    follow, each row of it the home lacks by id goes to the home with its
 *    id and writers (a workspace linked after the first sync keeps its rows
 *    this way). A name the home already uses in that scope is the home's:
 *    the row here is dropped with one log line naming both ids.
 *  - routes writes (`forward`): a write to a shared scope goes to the home,
 *    and the home's answer lands here; a home out of reach refuses with
 *    nothing written. A scope the home has no copy of stays this host's
 *    own. A follow whose read started before a forward never writes its
 *    older answer over the forward's (`writes`).
 *  - says where a scope lives (`homeFor`): addons.list and skills.list
 *    answer it, and the settings pages print it.
 */

export const STORE_SYNC_PERIOD_MS = 5 * 60_000
export const STORE_SYNC_DEBOUNCE_MS = 500
/** + `<home id>:<table>` → JSON array of the scope keys seeded ('global', a workspace's linkId). */
export const STORE_SEEDED_KEY = 'store-sync:seeded:'

type Link = NonNullable<ReturnType<Peers['get']>>

export interface StoreSyncDeps {
  environmentId: string
  /** RulesSync: the home, the shared scopes, and its pull (which records the peer's workspaces). */
  home: { homeOf(): string; sharedScopes(peerId: string): Scope[]; syncWith(peerId: string): Promise<void> }
  addons: AddonStore
  skills: SkillStore
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void }
  peers: Pick<Peers, 'get' | 'all'>
  log?: (line: string) => void
}

export type StoreWrite = 'addons.set' | 'addons.remove' | 'skills.set' | 'skills.remove'

/** One synced table: its RPCs and how a row moves between the hosts. */
interface Table<R extends { id: string; name: string; workspaceId: string | null }> {
  name: 'addons' | 'skills'
  list: 'addons.list' | 'skills.list'
  set: 'addons.set' | 'skills.set'
  remove: 'addons.remove' | 'skills.remove'
  rows(): R[]
  parseList(answer: unknown): R[]
  /** addons.set / skills.set params carrying a local row to the home, its scope mapped. */
  seedParams(row: R, peerWorkspaceId: string | null): unknown
  /** Write the home's row here; false when it already stood. */
  land(link: Link, row: R, stale: () => boolean): Promise<boolean>
  drop(id: string): boolean
  /** The row a forwarded write's answer carries, with the files a skills.set sent. */
  landAnswer(answer: unknown, params: unknown, localWorkspaceId: string | null): void
  /** The params of a write with its scope mapped to the home's. */
  mapParams(params: unknown, peerWorkspaceId: string | null): unknown
}

export const offlineRefusal = (host: string): string => `refused: add-ons and skills live on ${host}; it is offline`

export class StoreSync {
  private readonly tables: [Table<AddonRow>, Table<SkillMeta>]
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  private period: NodeJS.Timeout | null = null
  private closed = false
  /** Forwards started: a follow whose read began before one never writes. */
  private writes = 0

  constructor(private readonly deps: StoreSyncDeps) {
    const { addons, skills } = deps
    this.tables = [
      {
        name: 'addons',
        list: 'addons.list',
        set: 'addons.set',
        remove: 'addons.remove',
        rows: () => addons.list(),
        parseList: (a) => z.array(AddonRowSchema).parse((a as { addons?: unknown }).addons ?? []),
        seedParams: (r, ws) => ({
          addon: { id: r.id, name: r.name, workspaceId: ws, description: r.description, spec: r.spec, enabled: r.enabled, addedBy: r.addedBy, writtenBy: r.writtenBy }
        }),
        land: async (_link, row) => addons.put(row),
        drop: (id) => addons.remove(id),
        landAnswer: (a, _p, ws) => {
          const row = AddonRowSchema.parse((a as { addon?: unknown }).addon)
          addons.put({ ...row, workspaceId: ws })
        },
        mapParams: (p, ws) => {
          const params = p as { addon?: Record<string, unknown> }
          return params.addon ? { ...params, addon: { ...params.addon, workspaceId: ws } } : params
        }
      },
      {
        name: 'skills',
        list: 'skills.list',
        set: 'skills.set',
        remove: 'skills.remove',
        rows: () => skills.list(),
        parseList: (a) => z.array(SkillMetaSchema).parse((a as { skills?: unknown }).skills ?? []),
        seedParams: (r, ws) => ({
          skill: {
            id: r.id,
            name: r.name,
            workspaceId: ws,
            harnesses: r.harnesses,
            enabled: r.enabled,
            files: skills.get(r.id)?.files ?? [],
            addedBy: r.addedBy,
            writtenBy: r.writtenBy
          }
        }),
        land: async (link, row, stale) => {
          // Files cross only when the digest moved.
          if (skills.meta(row.id)?.digest === row.digest) return skills.put(row)
          const res = await link.request<{ skill: unknown }>('skills.get', { id: row.id })
          if (stale()) return false
          const whole = SkillSchema.parse(res.skill)
          return skills.put({ ...whole, workspaceId: row.workspaceId })
        },
        drop: (id) => skills.remove(id),
        landAnswer: (a, p, ws) => {
          const meta = SkillMetaSchema.parse((a as { skill?: unknown }).skill)
          const files = (p as { skill?: { files?: unknown } }).skill?.files
          skills.put({ ...meta, workspaceId: ws, files: SkillSchema.shape.files.parse(files) })
        },
        mapParams: (p, ws) => {
          const params = p as { skill?: Record<string, unknown> }
          return params.skill ? { ...params, skill: { ...params.skill, workspaceId: ws } } : params
        }
      }
    ]
  }

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(`[store-sync] ${l}`)))(line)
  }

  start(): void {
    if (this.period || this.closed) return
    this.period = setInterval(() => {
      for (const link of this.deps.peers.all()) this.schedule(link.id)
    }, STORE_SYNC_PERIOD_MS)
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

  /** The home's `addons`, `skills` or `workspaces` push: follow it. Never consumes the push. */
  onPeerPush(from: string, push: ServerPush): boolean {
    if (push.push === 'addons' || push.push === 'skills' || push.push === 'workspaces') this.schedule(from)
    return false
  }

  schedule(id: string): void {
    if (this.closed) return
    const t = this.timers.get(id)
    if (t) clearTimeout(t)
    const timer = setTimeout(() => {
      this.timers.delete(id)
      void this.syncWith(id)
    }, STORE_SYNC_DEBOUNCE_MS)
    timer.unref?.()
    this.timers.set(id, timer)
  }

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
    // RulesSync's pull records the peer's workspaces and platform: the home and the shared scopes follow from them.
    await this.deps.home.syncWith(id)
    const link = this.deps.peers.get(id)
    if (!link?.connected || this.deps.home.homeOf() !== id) return
    await this.follow(link, this.tables[0])
    await this.follow(link, this.tables[1])
  }

  /** One table against the home: seed what is new to it, then write its rows here and drop what it no longer lists. */
  private async follow<R extends { id: string; name: string; workspaceId: string | null }>(link: Link, table: Table<R>): Promise<void> {
    const scopes = this.deps.home.sharedScopes(link.id)
    const byPeer = new Map(scopes.map((s) => [s.peer, s]))
    const before = this.writes
    let theirs = table.parseList(await link.request(table.list, {}))
    if (this.writes !== before) return
    if (await this.seed(link, table, scopes, theirs)) {
      theirs = table.parseList(await link.request(table.list, {}))
      if (this.writes !== before) return
    }
    const stale = (): boolean => this.writes !== before
    const listed = new Set<string>()
    for (const row of theirs) {
      const scope = byPeer.get(row.workspaceId)
      if (!scope) continue // a workspace this host has no copy of
      listed.add(row.id)
      if (stale()) return
      if (await table.land(link, { ...row, workspaceId: scope.local }, stale)) this.log(`${link.env.name}: followed ${table.name} ${row.name} (${scope.key})`)
    }
    if (stale()) return
    const shared = new Set(scopes.map((s) => s.local))
    for (const row of table.rows()) {
      if (!shared.has(row.workspaceId) || listed.has(row.id)) continue
      if (table.drop(row.id)) this.log(`${link.env.name}: dropped ${table.name} ${row.name}, gone from the home`)
    }
  }

  /** Seed each shared scope not yet seeded for this home and table; true when the home got anything. */
  private async seed<R extends { id: string; name: string; workspaceId: string | null }>(link: Link, table: Table<R>, scopes: Scope[], theirs: R[]): Promise<boolean> {
    const key = `${STORE_SEEDED_KEY}${link.id}:${table.name}`
    const seeded = new Set(this.readSeeded(key))
    const homeIds = new Set(theirs.map((r) => r.id))
    let sent = false
    for (const scope of scopes) {
      if (seeded.has(scope.key)) continue
      for (const row of table.rows()) {
        if (row.workspaceId !== scope.local || homeIds.has(row.id)) continue
        const named = theirs.find((r) => r.workspaceId === scope.peer && r.name === row.name)
        if (named) {
          table.drop(row.id)
          this.log(`${link.env.name}: ${table.name} ${row.name} (${scope.key}) is the home's ${named.id}; dropped ${row.id} here`)
          continue
        }
        await link.request(table.set, table.seedParams(row, scope.peer))
        sent = true
      }
      seeded.add(scope.key)
      this.deps.store.setSetting(key, JSON.stringify([...seeded]))
      this.log(`${link.env.name}: seeded ${table.name} for ${scope.key}`)
    }
    return sent
  }

  private readSeeded(key: string): string[] {
    try {
      return JSON.parse(this.deps.store.getSetting(key) ?? '[]') as string[]
    } catch {
      return []
    }
  }

  /** The home and the scope a write to `workspaceId` goes to, or null when it is this host's own. */
  private route(workspaceId: string | null): { link: Link; scope: Scope } | null {
    const home = this.deps.home.homeOf()
    if (home === this.deps.environmentId) return null
    const link = this.deps.peers.get(home)
    if (!link) return null
    const scope = this.deps.home.sharedScopes(home).find((s) => s.local === workspaceId)
    return scope ? { link, scope } : null
  }

  /**
   * A write to the store: `true` when it went to the home and the home's
   * answer now stands here too, `false` when the caller writes it here as
   * before (this host is the home, or the scope is its own). Throws the
   * refusal when the home is offline; nothing is written then.
   */
  async forward(method: StoreWrite, params: unknown, workspaceId: string | null): Promise<boolean> {
    const route = this.route(workspaceId)
    if (!route) return false
    const { link, scope } = route
    const table = method.startsWith('addons.') ? this.tables[0] : this.tables[1]
    if (!link.connected) throw new Error(offlineRefusal(link.env.name))
    this.writes++
    let answer: unknown
    try {
      answer = await link.request(method, table.mapParams(params, scope.peer))
    } catch (err) {
      if (!link.connected) throw new Error(offlineRefusal(link.env.name))
      throw err
    }
    if (method === table.set) table.landAnswer(answer, params, scope.local)
    else table.drop((params as { id: string }).id)
    // Anything else that moved on the home comes with the next follow.
    this.schedule(link.id)
    return true
  }

  /** Where a scope's one copy lives when another host holds it: that host's name and whether it answers now. Null when this host's copy is the one. */
  homeFor(workspaceId: string | null): StoreHome {
    const route = this.route(workspaceId)
    return route ? { name: route.link.env.name, online: route.link.connected } : null
  }
}
