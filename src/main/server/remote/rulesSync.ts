import type { ServerPush } from '@shared/contract'
import type { WorkspaceMeta } from '@shared/domain'
import { ThreadDefaultsSchema, type ThreadDefaults } from '@shared/defaults'
import { settingsHomeOf } from '@shared/projectLinks'
import { OrchestrationRulesSchema, type OrchestrationRules } from '@shared/rules'
import type { Peers } from './peers'

/**
 * Orchestration rules and thread defaults live on the box, the same home
 * project settings have (projectSettingsSync.ts, `settingsHomeOf`): one copy
 * of the global set and of each linked workspace's override (paired by the
 * workspace's `linkId`). This runs on the host holding the admin peer link
 * (the Mac):
 *
 *  - follows: on link-up, on the home's `workspaces` push (the box re-sends
 *    it whenever a rule or default changes) and every 5 minutes, it reads the
 *    home's value of every scope and writes it here when it differs.
 *  - seeds once: a scope this host has never synced with the home takes THIS
 *    host's value onto the home first (the person edited the rules on the
 *    Mac before there was one copy); the home owns it from then on.
 *  - routes writes (`forward`): `rules.set` / `defaults.set` for a shared
 *    scope goes to the home and the home's value is written back here; a home
 *    out of reach refuses with nothing written. A workspace with no copy on
 *    the home stays this host's own.
 */

export const RULES_SYNC_PERIOD_MS = 5 * 60_000
export const RULES_SYNC_DEBOUNCE_MS = 500
export const PEER_KEY = 'rules-sync:peer:'
export const SEEDED_KEY = 'rules-sync:seeded:'

interface PeerRecord {
  platform: string | null
  workspaces: { id: string; linkId: string }[]
}

type Link = NonNullable<ReturnType<Peers['get']>>

export interface RulesSyncDeps {
  environmentId: string
  platform: string
  registry: {
    listWorkspaces(): WorkspaceMeta[]
    getOrchestrationRules(workspaceId: string | null): OrchestrationRules | null
    setOrchestrationRules(workspaceId: string | null, rules: OrchestrationRules | null): void
    getThreadDefaults(workspaceId: string | null): ThreadDefaults | null
    setThreadDefaults(workspaceId: string | null, defaults: ThreadDefaults | null): void
  }
  store: { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void }
  peers: Pick<Peers, 'get' | 'all'>
  log?: (line: string) => void
}

/** One synced setting: its RPCs, the field it rides in and this host's store. */
interface Kind {
  get: 'rules.get' | 'defaults.get'
  set: 'rules.set' | 'defaults.set'
  field: 'rules' | 'defaults'
  parse(value: unknown): unknown
  read(workspaceId: string | null): unknown
  write(workspaceId: string | null, value: unknown): void
}

/** A shared scope: the global set, or a workspace both hosts hold. */
interface Scope {
  key: string
  local: string | null
  peer: string | null
}

export class RulesSync {
  private readonly kinds: Kind[]
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  private period: NodeJS.Timeout | null = null
  private closed = false

  constructor(private readonly deps: RulesSyncDeps) {
    const r = deps.registry
    this.kinds = [
      {
        get: 'rules.get',
        set: 'rules.set',
        field: 'rules',
        parse: (v) => OrchestrationRulesSchema.nullable().parse(v),
        read: (ws) => r.getOrchestrationRules(ws),
        write: (ws, v) => r.setOrchestrationRules(ws, v as OrchestrationRules | null)
      },
      {
        get: 'defaults.get',
        set: 'defaults.set',
        field: 'defaults',
        parse: (v) => ThreadDefaultsSchema.nullable().parse(v),
        read: (ws) => r.getThreadDefaults(ws),
        write: (ws, v) => r.setThreadDefaults(ws, v as ThreadDefaults | null)
      }
    ]
  }

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(`[rules-sync] ${l}`)))(line)
  }

  start(): void {
    if (this.period || this.closed) return
    this.period = setInterval(() => {
      for (const link of this.deps.peers.all()) this.schedule(link.id)
    }, RULES_SYNC_PERIOD_MS)
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

  /** The peer's `workspaces` push: follow it. Never consumes the push. */
  onPeerPush(from: string, push: ServerPush): boolean {
    if (push.push === 'workspaces') this.schedule(from)
    return false
  }

  schedule(id: string): void {
    if (this.closed) return
    const t = this.timers.get(id)
    if (t) clearTimeout(t)
    const timer = setTimeout(() => {
      this.timers.delete(id)
      void this.syncWith(id)
    }, RULES_SYNC_DEBOUNCE_MS)
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
    const link = this.deps.peers.get(id)
    if (!link?.connected) return
    this.remember(id, await link.request<WorkspaceMeta[]>('workspace.list'))
    if (this.homeOf() !== id) return
    const seeded = new Set(this.seeded(id))
    for (const scope of this.scopes(id)) {
      if (!seeded.has(scope.key)) {
        for (const kind of this.kinds) {
          await link.request(kind.set, { workspaceId: scope.peer, [kind.field]: kind.read(scope.local) })
        }
        seeded.add(scope.key)
        this.deps.store.setSetting(`${SEEDED_KEY}${id}`, JSON.stringify([...seeded]))
        this.log(`${link.env.name}: seeded ${scope.key}`)
        continue
      }
      for (const kind of this.kinds) await this.follow(link, kind, scope)
    }
  }

  /** The home's value of one scope, written here when it differs. */
  private async follow(link: Link, kind: Kind, scope: Scope): Promise<void> {
    const res = await link.request<Record<string, unknown> & { overridden: boolean }>(kind.get, { workspaceId: scope.peer })
    const theirs = kind.parse(res.overridden ? res[kind.field] : null)
    if (JSON.stringify(theirs) === JSON.stringify(kind.read(scope.local))) return
    kind.write(scope.local, theirs)
    this.log(`${link.env.name}: followed ${kind.field} for ${scope.key}`)
  }

  // ── the home ────────────────────────────────────────────────────────

  private record(id: string): PeerRecord | null {
    const raw = this.deps.store.getSetting(`${PEER_KEY}${id}`)
    if (!raw) return null
    try {
      return JSON.parse(raw) as PeerRecord
    } catch {
      return null
    }
  }

  private seeded(id: string): string[] {
    try {
      return JSON.parse(this.deps.store.getSetting(`${SEEDED_KEY}${id}`) ?? '[]') as string[]
    } catch {
      return []
    }
  }

  private remember(id: string, workspaces: WorkspaceMeta[]): void {
    const record: PeerRecord = {
      platform: this.deps.peers.get(id)?.build?.platform ?? this.record(id)?.platform ?? null,
      workspaces: workspaces.filter((w) => w.linkId).map((w) => ({ id: w.id, linkId: w.linkId! }))
    }
    const raw = JSON.stringify(record)
    if (raw !== this.deps.store.getSetting(`${PEER_KEY}${id}`)) this.deps.store.setSetting(`${PEER_KEY}${id}`, raw)
  }

  /** The settings home among this host and every peer it has synced with once. */
  homeOf(): string {
    const copies = [{ environmentId: this.deps.environmentId }]
    for (const link of this.deps.peers.all()) if (this.record(link.id)) copies.push({ environmentId: link.id })
    return (
      settingsHomeOf(copies, (id) =>
        id === this.deps.environmentId ? this.deps.platform : (this.deps.peers.get(id)?.build?.platform ?? this.record(id)?.platform ?? undefined)
      ) ?? this.deps.environmentId
    )
  }

  /** The global scope and every local workspace whose link the peer holds too. */
  private scopes(id: string): Scope[] {
    const theirs = new Map((this.record(id)?.workspaces ?? []).map((w) => [w.linkId, w.id]))
    const out: Scope[] = [{ key: 'global', local: null, peer: null }]
    for (const ws of this.deps.registry.listWorkspaces()) {
      const peer = ws.linkId ? theirs.get(ws.linkId) : undefined
      if (peer) out.push({ key: ws.linkId!, local: ws.id, peer })
    }
    return out
  }

  /**
   * A `rules.set` / `defaults.set`: `true` when it went to the home and the
   * home's value now stands here too, `false` when the caller writes it here
   * as before. Throws the refusal when the home is offline.
   */
  async forward(method: 'rules.set' | 'defaults.set', workspaceId: string | null, value: unknown): Promise<boolean> {
    const home = this.homeOf()
    if (home === this.deps.environmentId) return false
    const link = this.deps.peers.get(home)
    if (!link) return false
    const scope = this.scopes(home).find((s) => s.local === workspaceId)
    if (!scope) return false
    const kind = this.kinds.find((k) => k.set === method)!
    if (!link.connected) throw new Error(refusal(link.env.name))
    try {
      await link.request(method, { workspaceId: scope.peer, [kind.field]: value })
    } catch (err) {
      if (!link.connected) throw new Error(refusal(link.env.name))
      throw err
    }
    try {
      await this.follow(link, kind, scope)
    } catch (err) {
      // The home has it; the next pull brings it here.
      kind.write(workspaceId, kind.parse(value))
      this.log(`${link.env.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return true
  }
}

export const refusal = (host: string): string => `refused: orchestration rules and thread defaults live on ${host}; it is offline`
