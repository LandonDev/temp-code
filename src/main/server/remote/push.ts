import type { DatabaseSync } from 'node:sqlite'
import type { SessionMeta } from '@shared/events'
import { PUSH_EVENTS, type PushEnvironment, type PushEvent, type PushStatus } from '@shared/contract-remote'
import type { HubActivityState, HubClient } from '../hub'

/**
 * Push registrations (thread L6). A paired phone registers its APNs token
 * under its key; the host keeps one row per key and forwards it to the hub
 * as an `apns` subscription for this host, scoped to the events the phone
 * asked for. A rotated token replaces the row and the subscription; revoking
 * the key or unregistering drops both. The hub does the APNs delivery
 * (infra/hub/src/apns.ts); this host never holds the APNs key.
 *
 * A phone also registers the push token of the Live Activity it started for
 * a thread; `ActivityFeed` turns that thread's status transitions into
 * `liveactivity` pushes through the hub and ends the activity when the
 * thread settles.
 */

export type PushHub = Pick<HubClient, 'registerDevice' | 'removeDevice' | 'setActivity' | 'removeActivity' | 'pushActivity'>

interface PushRow {
  key_id: string
  token: string
  bundle_id: string
  environment: PushEnvironment
  events: string
  relay: PushStatus['relay']
  error: string | null
  updated_at: number
}

interface ActivityRow {
  key_id: string
  session_id: string
  token: string
  bundle_id: string
  environment: PushEnvironment
  updated_at: number
}

export interface PushRegistration {
  token: string
  bundleId: string
  environment: PushEnvironment
  events?: PushEvent[]
}

export interface PushActivityInput {
  sessionId: string
  /** `null` ends the activity on this host and the hub. */
  token: string | null
  bundleId?: string
  environment?: PushEnvironment
}

export interface PushOptions {
  /** The hub client, when this host has one; null leaves every row at relay `none`. */
  hub: () => PushHub | null
  now?: () => number
  log?: (line: string) => void
}

const NOT_REGISTERED: PushStatus = { registered: false, relay: 'none', error: null, events: [], updatedAt: null }

const eventsOf = (text: string): PushEvent[] =>
  text.split(',').filter((e): e is PushEvent => (PUSH_EVENTS as readonly string[]).includes(e))

export class PushRegistry {
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(
    private readonly db: DatabaseSync,
    private readonly options: PushOptions
  ) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((line) => console.log(`[push] ${line}`))
  }

  private row(keyId: string): PushRow | null {
    return (this.db.prepare(`SELECT * FROM remote_push WHERE key_id = ?`).get(keyId) as PushRow | undefined) ?? null
  }

  private statusOf(row: PushRow | null): PushStatus {
    if (!row) return { ...NOT_REGISTERED }
    return { registered: true, relay: row.relay, error: row.error, events: eventsOf(row.events), updatedAt: row.updated_at }
  }

  status(keyId: string): PushStatus {
    return this.statusOf(this.row(keyId))
  }

  /** The key's registration, replaced whole; the hub call decides the relay state. */
  async register(keyId: string, input: PushRegistration): Promise<PushStatus> {
    const events = [...new Set(input.events?.length ? input.events : PUSH_EVENTS)]
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO remote_push (key_id, token, bundle_id, environment, events, relay, error, updated_at) VALUES (?, ?, ?, ?, ?, 'none', NULL, ?)
         ON CONFLICT(key_id) DO UPDATE SET token = excluded.token, bundle_id = excluded.bundle_id, environment = excluded.environment, events = excluded.events, relay = 'none', error = NULL, updated_at = excluded.updated_at`
      )
      .run(keyId, input.token.toLowerCase(), input.bundleId, input.environment, events.join(','), now)
    await this.relay(keyId)
    return this.status(keyId)
  }

  /** Forwards the row to the hub and records what it said. */
  private async relay(keyId: string): Promise<void> {
    const row = this.row(keyId)
    const hub = this.options.hub()
    if (!row || !hub) return
    const ack = await hub.registerDevice({
      deviceId: keyId,
      token: row.token,
      bundleId: row.bundle_id,
      environment: row.environment,
      events: eventsOf(row.events)
    })
    this.db
      .prepare(`UPDATE remote_push SET relay = ?, error = ? WHERE key_id = ? AND token = ?`)
      .run(ack.ok ? 'ok' : 'failed', ack.ok ? null : ack.error, keyId, row.token)
    if (!ack.ok) this.log(`hub refused the registration of key ${keyId}: ${ack.error}`)
  }

  /** Drops the key's registration and its activities, here and on the hub. */
  async unregister(keyId: string): Promise<PushStatus> {
    const row = this.row(keyId)
    const activities = this.db.prepare(`SELECT * FROM remote_push_activities WHERE key_id = ?`).all(keyId) as unknown as ActivityRow[]
    this.db.prepare(`DELETE FROM remote_push WHERE key_id = ?`).run(keyId)
    this.db.prepare(`DELETE FROM remote_push_activities WHERE key_id = ?`).run(keyId)
    const hub = this.options.hub()
    if (hub) {
      if (row) {
        const ack = await hub.removeDevice(keyId)
        if (!ack.ok) this.log(`hub kept the subscription of key ${keyId}: ${ack.error}`)
      }
      for (const activity of activities) void hub.removeActivity(keyId, activity.session_id)
    }
    return { ...NOT_REGISTERED }
  }

  /** A revoked key's registration goes with it. */
  async dropKey(keyId: string): Promise<void> {
    if (!this.row(keyId) && !this.activities(undefined, keyId).length) return
    await this.unregister(keyId)
  }

  /** The Live Activity token a phone holds for a thread; `token: null` ends it. */
  async setActivity(keyId: string, input: PushActivityInput): Promise<void> {
    const hub = this.options.hub()
    if (input.token === null) {
      const gone = this.db.prepare(`DELETE FROM remote_push_activities WHERE key_id = ? AND session_id = ?`).run(keyId, input.sessionId).changes > 0
      if (gone && hub) void hub.removeActivity(keyId, input.sessionId)
      return
    }
    const device = this.row(keyId)
    const bundleId = input.bundleId ?? device?.bundle_id
    const environment = input.environment ?? device?.environment
    if (!bundleId || !environment) throw new Error('a Live Activity token needs the bundleId and environment, or a push registration on this key')
    this.db
      .prepare(
        `INSERT INTO remote_push_activities (key_id, session_id, token, bundle_id, environment, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key_id, session_id) DO UPDATE SET token = excluded.token, bundle_id = excluded.bundle_id, environment = excluded.environment, updated_at = excluded.updated_at`
      )
      .run(keyId, input.sessionId, input.token.toLowerCase(), bundleId, environment, this.now())
    if (hub) {
      const ack = await hub.setActivity({ deviceId: keyId, threadId: input.sessionId, token: input.token.toLowerCase(), bundleId, environment })
      if (!ack.ok) this.log(`hub refused the activity token of key ${keyId} for ${input.sessionId}: ${ack.error}`)
    }
  }

  /** The activities registered for a thread (or, with `keyId`, for one key). */
  activities(sessionId?: string, keyId?: string): { keyId: string; sessionId: string }[] {
    const rows = (
      sessionId !== undefined
        ? this.db.prepare(`SELECT * FROM remote_push_activities WHERE session_id = ?`).all(sessionId)
        : this.db.prepare(`SELECT * FROM remote_push_activities WHERE key_id = ?`).all(keyId ?? '')
    ) as unknown as ActivityRow[]
    return rows.map((r) => ({ keyId: r.key_id, sessionId: r.session_id }))
  }

  hasActivities(sessionId: string): boolean {
    return (this.db.prepare(`SELECT 1 FROM remote_push_activities WHERE session_id = ? LIMIT 1`).get(sessionId) ?? null) !== null
  }

  /** The thread settled: every activity on it is over (the hub drops its own at the `end` push). */
  endActivities(sessionId: string): void {
    this.db.prepare(`DELETE FROM remote_push_activities WHERE session_id = ?`).run(sessionId)
  }

  /** At boot: a row the hub never acknowledged is offered again. */
  async resync(): Promise<void> {
    if (!this.options.hub()) return
    const rows = this.db.prepare(`SELECT key_id FROM remote_push WHERE relay != 'ok'`).all() as unknown as { key_id: string }[]
    for (const row of rows) await this.relay(row.key_id)
  }
}

// ── the Live Activity feed ─────────────────────────────────────────────

/** What the feed reads of the registry (SessionRegistry satisfies it). */
export interface ActivityRegistry {
  onMeta(listener: (meta: SessionMeta) => void): () => void
}

export interface ActivityFeedOptions {
  registry: ActivityRegistry
  push: Pick<PushRegistry, 'hasActivities' | 'endActivities'>
  hub: () => Pick<PushHub, 'pushActivity'> | null
  now?: () => number
  log?: (line: string) => void
}

/** The activity's phase for a status: the strip's word, or how it ended. */
export function activityPhase(status: SessionMeta['status'], archived = false): HubActivityState['phase'] {
  if (archived) return 'finished'
  switch (status) {
    case 'starting':
    case 'running':
    case 'watching':
      return 'working'
    case 'paused':
      return 'paused'
    case 'waiting':
      return 'waiting'
    case 'error':
      return 'failed'
    default:
      return 'finished'
  }
}

/**
 * Root threads with a registered activity: every change of phase or title
 * becomes one `liveactivity` push; a settled phase is the `end` that shows
 * the final state briefly, after which the activity rows are gone.
 */
export class ActivityFeed {
  private readonly last = new Map<string, string>()
  private readonly queues = new Map<string, Promise<void>>()
  private off: (() => void) | null = null
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly options: ActivityFeedOptions) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((line) => console.log(`[push] ${line}`))
  }

  start(): void {
    this.off = this.options.registry.onMeta((meta) => this.onMeta(meta))
  }

  stop(): void {
    this.off?.()
    this.off = null
    this.last.clear()
  }

  /** Pushes settle in order per thread: an `end` never lands before the update it follows. */
  private onMeta(meta: SessionMeta): void {
    if (meta.parentId) return
    const run = (this.queues.get(meta.id) ?? Promise.resolve()).then(() => this.push(meta)).catch((err: unknown) => this.log(`activity push failed for ${meta.id}: ${err instanceof Error ? err.message : String(err)}`))
    this.queues.set(meta.id, run)
    void run.then(() => {
      if (this.queues.get(meta.id) === run) this.queues.delete(meta.id)
    })
  }

  private async push(meta: SessionMeta): Promise<void> {
    if (!this.options.push.hasActivities(meta.id)) {
      this.last.delete(meta.id)
      return
    }
    const phase = activityPhase(meta.status, meta.archived)
    const key = `${phase}|${meta.title}`
    if (this.last.get(meta.id) === key) return
    this.last.set(meta.id, key)
    const live = phase === 'working' || phase === 'paused'
    const hub = this.options.hub()
    if (hub) {
      await hub.pushActivity({
        threadId: meta.id,
        event: live ? 'update' : 'end',
        state: { phase, since: meta.busySince ?? meta.updatedAt, ts: this.now() },
        title: meta.title,
        ...(meta.threadType ? { threadType: meta.threadType } : {})
      })
    }
    if (!live) {
      this.options.push.endActivities(meta.id)
      this.last.delete(meta.id)
    }
  }
}
