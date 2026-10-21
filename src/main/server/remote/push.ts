import type { DatabaseSync } from 'node:sqlite'
import type { SessionMeta } from '@shared/events'
import { PUSH_EVENTS, type PushEnvironment, type PushEvent, type PushStatus } from '@shared/contract-remote'
import type { HubActivityState, HubClient } from '../hub'
import type { ApnsSender } from './apns'
import { ACTIVITY_DISMISS_S, ALERT_TTL_S, activityPayload, notificationPayload, type ApnsNotice } from './apnsPayload'

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
 *
 * A host that holds the APNs key itself (remote/apns.ts, the box) posts to
 * Apple directly instead: every registration is relayed locally (`ok`
 * without a hub subscription, and a hub subscription it once made is
 * removed at boot), notices and activity states go out over http2, and a
 * token Apple calls gone drops the row. The hub path stays for hosts
 * without the key.
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
  /** The host's own APNs sender, when it holds the key: it wins over the hub. */
  apns?: () => Pick<ApnsSender, 'send'> | null
  /** What this host is called in a notice's `hostId` (the hub's id, else the environment id). */
  hostId?: () => string
  environmentId?: () => string
  now?: () => number
  log?: (line: string) => void
}

export type PushDelivery = { delivered: number; failed: number }

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

  private get apns(): Pick<ApnsSender, 'send'> | null {
    return this.options.apns?.() ?? null
  }

  /** Forwards the row to the hub and records what it said; a host with its own sender relays locally. */
  private async relay(keyId: string): Promise<void> {
    const row = this.row(keyId)
    if (!row) return
    if (this.apns) {
      this.db.prepare(`UPDATE remote_push SET relay = 'ok', error = NULL WHERE key_id = ?`).run(keyId)
      return
    }
    const hub = this.options.hub()
    if (!hub) return
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

  /** At boot: a row the hub never acknowledged is offered again; a host that now sends itself takes its devices back from the hub. */
  async resync(): Promise<void> {
    const hub = this.options.hub()
    if (this.apns) {
      const rows = this.db.prepare(`SELECT key_id FROM remote_push`).all() as unknown as { key_id: string }[]
      for (const row of rows) {
        await this.relay(row.key_id)
        if (hub) void hub.removeDevice(row.key_id)
      }
      return
    }
    if (!hub) return
    const rows = this.db.prepare(`SELECT key_id FROM remote_push WHERE relay != 'ok'`).all() as unknown as { key_id: string }[]
    for (const row of rows) await this.relay(row.key_id)
  }

  /** The Live Activity tokens held for a thread, for the host's own sender. */
  activityTokens(sessionId: string): { keyId: string; token: string; bundleId: string; environment: PushEnvironment }[] {
    const rows = this.db.prepare(`SELECT * FROM remote_push_activities WHERE session_id = ?`).all(sessionId) as unknown as ActivityRow[]
    return rows.map((r) => ({ keyId: r.key_id, token: r.token, bundleId: r.bundle_id, environment: r.environment }))
  }

  /** A notifier notice to every registered phone that asked for its event, from this host's own sender (nothing when there is none). */
  async deliver(notice: Omit<ApnsNotice, 'hostId' | 'environmentId'>): Promise<PushDelivery> {
    const apns = this.apns
    if (!apns) return { delivered: 0, failed: 0 }
    const rows = (this.db.prepare(`SELECT * FROM remote_push`).all() as unknown as PushRow[]).filter((r) => eventsOf(r.events).includes(notice.event))
    const hostId = this.options.hostId?.() ?? 'host'
    const environmentId = this.options.environmentId?.()
    const payload = notificationPayload({ ...notice, hostId, ...(environmentId ? { environmentId } : {}) })
    let delivered = 0
    let failed = 0
    for (const row of rows) {
      const result = await apns.send({
        token: row.token,
        topic: row.bundle_id,
        pushType: 'alert',
        environment: row.environment,
        payload,
        expiration: Math.floor(notice.ts / 1000) + ALERT_TTL_S,
        collapseId: `${notice.threadId ?? hostId}:${notice.event}`
      })
      if (result.ok) {
        delivered += 1
        continue
      }
      failed += 1
      if (result.gone) {
        // A phone that uninstalled or re-registered: the row goes, with its activities.
        this.db.prepare(`DELETE FROM remote_push WHERE key_id = ?`).run(row.key_id)
        this.db.prepare(`DELETE FROM remote_push_activities WHERE key_id = ?`).run(row.key_id)
        this.log(`dropped the registration of key ${row.key_id}: ${result.error}`)
      } else {
        this.db.prepare(`UPDATE remote_push SET relay = 'failed', error = ? WHERE key_id = ?`).run(result.error, row.key_id)
        this.log(`push to key ${row.key_id} failed: ${result.error}`)
      }
    }
    return { delivered, failed }
  }

  /** A Live Activity state to every phone holding a token for the thread, from this host's own sender. */
  async deliverActivity(update: { threadId: string; event: 'update' | 'end'; state: HubActivityState; ts: number; priority?: 5 | 10 }): Promise<PushDelivery> {
    const apns = this.apns
    if (!apns) return { delivered: 0, failed: 0 }
    const payload = activityPayload(update, update.ts)
    let delivered = 0
    let failed = 0
    for (const row of this.activityTokens(update.threadId)) {
      const result = await apns.send({
        token: row.token,
        topic: `${row.bundleId}.push-type.liveactivity`,
        pushType: 'liveactivity',
        environment: row.environment,
        payload,
        expiration: Math.floor(update.ts / 1000) + (update.event === 'end' ? ALERT_TTL_S : 60),
        collapseId: update.threadId,
        ...(update.priority === undefined ? {} : { priority: update.priority })
      })
      if (result.ok) delivered += 1
      else {
        failed += 1
        if (result.gone) this.db.prepare(`DELETE FROM remote_push_activities WHERE key_id = ? AND session_id = ?`).run(row.keyId, update.threadId)
        this.log(`activity push to key ${row.keyId} failed: ${result.error}`)
      }
    }
    return { delivered, failed }
  }
}
export { ACTIVITY_DISMISS_S }

// ── the Live Activity feed ─────────────────────────────────────────────

/** What the feed reads of the registry (SessionRegistry satisfies it). */
export interface ActivityRegistry {
  onMeta(listener: (meta: SessionMeta) => void): () => void
  /** The live meta, for a push the feed makes on its own clock (a coalesced task line, a reason that arrived). */
  get?(id: string): SessionMeta | null
}

export interface ActivityFeedOptions {
  registry: ActivityRegistry
  push: Pick<PushRegistry, 'hasActivities' | 'endActivities' | 'deliverActivity'>
  hub: () => Pick<PushHub, 'pushActivity'> | null
  /** The host sends the activity states itself when this answers true. */
  local?: () => boolean
  /** Task-line-only changes go out at most once per window per thread. */
  coalesceMs?: number
  /** A waiting thread's end waits this long for the notifier's reason before going without one. */
  reasonWaitMs?: number
  now?: () => number
  log?: (line: string) => void
}

/** A chatty thread's task line changes every few seconds; one push per window keeps inside the Live Activity budget. */
export const ACTIVITY_COALESCE_MS = 20_000
/** The notifier decides a needs-you line within its debounce (1.5 s); the end push waits a little longer than that. */
export const ACTIVITY_REASON_WAIT_MS = 2_500
const TASK_CHARS = 120
const REASON_CHARS = 160
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

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
 * The content state for a meta: what the desktop's running row shows. The
 * task is the list's in-progress item, else the activity line ("Editing
 * PromptBar.tsx"); the tally only when the thread has a list; the reason
 * only while it waits.
 */
export function activityState(meta: SessionMeta, now: number, reason: string | null = null): HubActivityState {
  const phase = activityPhase(meta.status, meta.archived)
  const tasks = meta.tasks ?? null
  const task = tasks?.current || (phase === 'working' ? meta.activity : null) || null
  const state: HubActivityState = { phase, since: meta.busySince ?? meta.updatedAt, ts: now, title: cut(oneLine(meta.title), TASK_CHARS) }
  if (task) state.task = cut(oneLine(task), TASK_CHARS)
  if (tasks && tasks.total > 0) {
    state.done = tasks.done
    state.total = tasks.total
  }
  if (phase === 'waiting' && reason) state.reason = cut(oneLine(reason), REASON_CHARS)
  return state
}

interface Tracked {
  /** The last state pushed, without its clock. */
  sent: Omit<HubActivityState, 'ts'> | null
  sentAt: number
  /** A task-line change waiting for the window to pass. */
  soft: ReturnType<typeof setTimeout> | null
  /** A waiting end holding out for the notifier's reason. */
  hold: ReturnType<typeof setTimeout> | null
  reason: string | null
}

/**
 * Root threads with a registered activity: every change of what the card
 * shows becomes one `liveactivity` push. A change of phase, tally, title or
 * reason goes at once at priority 10; a change of the task line alone is
 * coalesced to one push per window at priority 5, the latest line winning.
 * A settled phase is the `end` that shows the final state briefly, after
 * which the activity rows are gone; a waiting end holds briefly for the
 * notifier's needs-you line so the card can say what the thread wants.
 */
export class ActivityFeed {
  private readonly threads = new Map<string, Tracked>()
  private readonly queues = new Map<string, Promise<void>>()
  private off: (() => void) | null = null
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly coalesceMs: number
  private readonly reasonWaitMs: number

  constructor(private readonly options: ActivityFeedOptions) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((line) => console.log(`[push] ${line}`))
    this.coalesceMs = options.coalesceMs ?? ACTIVITY_COALESCE_MS
    this.reasonWaitMs = options.reasonWaitMs ?? ACTIVITY_REASON_WAIT_MS
  }

  start(): void {
    this.off = this.options.registry.onMeta((meta) => this.onMeta(meta))
  }

  stop(): void {
    this.off?.()
    this.off = null
    for (const t of this.threads.values()) {
      if (t.soft) clearTimeout(t.soft)
      if (t.hold) clearTimeout(t.hold)
    }
    this.threads.clear()
  }

  /** The notifier decided what a thread needs: the waiting state carries it. */
  needsYou(threadId: string, reason: string): void {
    const t = this.track(threadId)
    t.reason = reason
    if (t.hold) {
      clearTimeout(t.hold)
      t.hold = null
    }
    const meta = this.options.registry.get?.(threadId) ?? null
    if (meta) this.enqueue(meta, { urgent: true })
  }

  private track(id: string): Tracked {
    let t = this.threads.get(id)
    if (!t) {
      t = { sent: null, sentAt: 0, soft: null, hold: null, reason: null }
      this.threads.set(id, t)
    }
    return t
  }

  private onMeta(meta: SessionMeta): void {
    if (meta.parentId) return
    if (!this.options.push.hasActivities(meta.id)) {
      this.forget(meta.id)
      return
    }
    const t = this.track(meta.id)
    const phase = activityPhase(meta.status, meta.archived)
    if (phase !== 'waiting') {
      t.reason = null
      if (t.hold) {
        // The prompt was answered before the end went out: nothing to end.
        clearTimeout(t.hold)
        t.hold = null
      }
    }
    if (phase === 'waiting' && !t.reason && !t.hold && t.sent?.phase !== 'waiting') {
      // The notifier's line lands within its debounce; the end shows it when it does.
      t.hold = setTimeout(() => {
        t.hold = null
        const live = this.options.registry.get?.(meta.id) ?? meta
        this.enqueue(live, { urgent: true })
      }, this.reasonWaitMs)
      t.hold.unref?.()
      return
    }
    this.enqueue(meta, {})
  }

  private forget(id: string): void {
    const t = this.threads.get(id)
    if (!t) return
    if (t.soft) clearTimeout(t.soft)
    if (t.hold) clearTimeout(t.hold)
    this.threads.delete(id)
  }

  /** Decides now or later; pushes settle in order per thread, so an `end` never lands before the update it follows. */
  private enqueue(meta: SessionMeta, opts: { urgent?: boolean }): void {
    const t = this.track(meta.id)
    const next = activityState(meta, this.now(), t.reason)
    const { ts: _ts, ...bare } = next
    const live = next.phase === 'working' || next.phase === 'paused'
    const sent = t.sent
    const softOnly = sent !== null && live && sent.phase === next.phase && sent.title === next.title && sent.done === next.done && sent.total === next.total && sent.reason === next.reason && sent.task !== next.task
    const same = sent !== null && JSON.stringify(sent) === JSON.stringify(bare)
    if (same && live) return
    if (same && !live && !opts.urgent) return
    if (softOnly && !opts.urgent) {
      const due = t.sentAt + this.coalesceMs - this.now()
      if (due > 0) {
        if (!t.soft) {
          t.soft = setTimeout(() => {
            t.soft = null
            const current = this.options.registry.get?.(meta.id) ?? meta
            this.enqueue(current, { urgent: true })
          }, due)
          t.soft.unref?.()
        }
        return
      }
    }
    if (t.soft) {
      clearTimeout(t.soft)
      t.soft = null
    }
    const priority: 5 | 10 = softOnly ? 5 : 10
    // Decided now, so a meta that follows at once compares against this state, not the one before it.
    t.sent = bare
    t.sentAt = this.now()
    const run = (this.queues.get(meta.id) ?? Promise.resolve())
      .then(() => this.push(meta.id, next, live, priority, meta.threadType))
      .catch((err: unknown) => this.log(`activity push failed for ${meta.id}: ${err instanceof Error ? err.message : String(err)}`))
    this.queues.set(meta.id, run)
    void run.then(() => {
      if (this.queues.get(meta.id) === run) this.queues.delete(meta.id)
    })
  }

  private async push(id: string, state: HubActivityState, live: boolean, priority: 5 | 10, threadType: SessionMeta['threadType']): Promise<void> {
    if (!this.options.push.hasActivities(id)) {
      this.forget(id)
      return
    }
    const event = live ? 'update' : 'end'
    if (this.options.local?.()) {
      await this.options.push.deliverActivity({ threadId: id, event, state, ts: this.now(), priority })
    } else {
      const hub = this.options.hub()
      if (hub) await hub.pushActivity({ threadId: id, event, state, title: state.title, ...(threadType ? { threadType } : {}), priority })
    }
    if (!live) {
      this.options.push.endActivities(id)
      this.forget(id)
    }
  }
}
