import type { DatabaseSync } from 'node:sqlite'
import type { SessionMeta } from '@shared/events'
import { PUSH_EVENTS, type PushEnvironment, type PushEvent, type PushStatus } from '@shared/contract-remote'
import type { HubActivityRow, HubActivityState, HubClient } from '../hub'
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

/** One phone's activity token: what a push is addressed to. */
export interface ActivityTarget {
  keyId: string
  token: string
}

/** A token and every thread it covers; two or more make a group activity. */
export interface ActivityGroup extends ActivityTarget {
  sessionIds: string[]
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

  /**
   * Every activity token covering a thread, with all the threads that token
   * covers. A phone keeps one activity per host and registers its token for
   * each thread it follows, so a token on two or more threads is a group.
   */
  activityGroups(sessionId: string): ActivityGroup[] {
    const pairs = this.db.prepare(`SELECT DISTINCT key_id, token FROM remote_push_activities WHERE session_id = ?`).all(sessionId) as unknown as { key_id: string; token: string }[]
    const members = this.db.prepare(`SELECT session_id FROM remote_push_activities WHERE key_id = ? AND token = ? ORDER BY session_id`)
    return pairs.map((p) => ({ keyId: p.key_id, token: p.token, sessionIds: (members.all(p.key_id, p.token) as unknown as { session_id: string }[]).map((m) => m.session_id) }))
  }

  /** The thread settled: every single-thread activity on it is over (the hub drops its own at the `end` push). A group's rows stay until the group ends. */
  endActivities(sessionId: string): void {
    this.db
      .prepare(
        `DELETE FROM remote_push_activities WHERE session_id = ? AND NOT EXISTS (
           SELECT 1 FROM remote_push_activities other WHERE other.key_id = remote_push_activities.key_id AND other.token = remote_push_activities.token AND other.session_id != remote_push_activities.session_id)`
      )
      .run(sessionId)
  }

  /** A group activity ended: its rows go, every thread it covered with them. Answers those threads. */
  endGroup(keyId: string, token: string): string[] {
    const ids = (this.db.prepare(`SELECT session_id FROM remote_push_activities WHERE key_id = ? AND token = ?`).all(keyId, token) as unknown as { session_id: string }[]).map((r) => r.session_id)
    this.db.prepare(`DELETE FROM remote_push_activities WHERE key_id = ? AND token = ?`).run(keyId, token)
    return ids
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
  /** `environmentId` names another host's thread: a relayed host's notice (remote/relay.ts), so the tap opens it there. */
  async deliver(notice: Omit<ApnsNotice, 'hostId' | 'environmentId'> & { environmentId?: string }): Promise<PushDelivery> {
    const apns = this.apns
    if (!apns) return { delivered: 0, failed: 0 }
    const rows = (this.db.prepare(`SELECT * FROM remote_push`).all() as unknown as PushRow[]).filter((r) => eventsOf(r.events).includes(notice.event))
    const hostId = this.options.hostId?.() ?? 'host'
    const environmentId = notice.environmentId ?? this.options.environmentId?.()
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

  /**
   * A Live Activity state from this host's own sender: to the `targets`
   * tokens when named (a group's, or a thread's single-thread ones), else to
   * every phone holding a token for the thread.
   */
  async deliverActivity(update: { threadId: string; event: 'update' | 'end'; state: HubActivityState; ts: number; priority?: 5 | 10; targets?: ActivityTarget[] }): Promise<PushDelivery> {
    const apns = this.apns
    if (!apns) return { delivered: 0, failed: 0 }
    const payload = activityPayload(update, update.ts)
    const wanted = update.targets ? new Set(update.targets.map((t) => `${t.keyId}\u0000${t.token}`)) : null
    const rows = wanted
      ? (this.db.prepare(`SELECT * FROM remote_push_activities`).all() as unknown as ActivityRow[])
          .filter((r) => wanted.delete(`${r.key_id}\u0000${r.token}`))
          .map((r) => ({ keyId: r.key_id, token: r.token, bundleId: r.bundle_id, environment: r.environment }))
      : this.activityTokens(update.threadId)
    let delivered = 0
    let failed = 0
    for (const row of rows) {
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
        if (result.gone) this.db.prepare(`DELETE FROM remote_push_activities WHERE key_id = ? AND token = ?`).run(row.keyId, row.token)
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
  push: Pick<PushRegistry, 'hasActivities' | 'endActivities' | 'deliverActivity' | 'activityGroups' | 'endGroup'>
  hub: () => Pick<PushHub, 'pushActivity' | 'removeActivity'> | null
  /** The host sends the activity states itself when this answers true. */
  local?: () => boolean
  /** A master's batch: children done of total and the running step's name (null when the thread has no batch). */
  batch?: (masterId: string) => BatchTally | null
  isMaster?: (meta: SessionMeta) => boolean
  /** Task-line-only changes go out at most once per window per thread. */
  coalesceMs?: number
  /** A waiting thread's end waits this long for the notifier's reason before going without one. */
  reasonWaitMs?: number
  now?: () => number
  log?: (line: string) => void
}

/** What a watching master's card counts: its batch's children, and the step the engine is on. */
export interface BatchTally {
  done: number
  total: number
  step: string | null
}

/** A chatty thread's task line changes every few seconds; one push per window keeps inside the Live Activity budget. */
export const ACTIVITY_COALESCE_MS = 20_000
/** The notifier decides a needs-you line within its debounce (1.5 s); the end push waits a little longer than that. */
export const ACTIVITY_REASON_WAIT_MS = 2_500
const TASK_CHARS = 120
const REASON_CHARS = 160
/** A group's rows ride one content state, so each says less than a single thread's card. */
const ROW_TITLE_CHARS = 60
const ROW_TASK_CHARS = 80
const ROW_REASON_CHARS = 100
/** At most this many threads ride a group's state; the rest are `more`. */
export const ACTIVITY_GROUP_ROWS = 6
/** A thread that settled stays on a group's card this long, then leaves it. */
export const ACTIVITY_SETTLE_MS = 60_000
/** ActivityKit refuses a content state over 4 KB: rows give way before that. */
const GROUP_BYTES = 3_500
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/**
 * The activity's phase for a status: the strip's word, or how it ended.
 * Null for a queued thread: created and not yet booted, it is not live and
 * never starts or keeps an activity.
 */
export function activityPhase(status: SessionMeta['status'], archived = false): HubActivityState['phase'] | null {
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
    case 'stopped':
      return 'stopped'
    case 'queued':
      return null
    default:
      return 'finished'
  }
}

/**
 * The content state for a meta: what the desktop's running row shows. The
 * task is the list's in-progress item, else the activity line ("Editing
 * PromptBar.tsx"); the tally only when the thread has a list; the reason
 * only while it waits. A master with a batch counts its children done of
 * total (`unit: 'threads'`) and names the engine's running step, else how
 * many threads it waits on. Null for a queued thread.
 */
export function activityState(meta: SessionMeta, now: number, reason: string | null = null, batch: BatchTally | null = null): HubActivityState | null {
  const phase = activityPhase(meta.status, meta.archived)
  if (phase === null) return null
  const state: HubActivityState = { phase, since: meta.busySince ?? meta.updatedAt, ts: now, title: cut(oneLine(meta.title), TASK_CHARS) }
  if (batch) {
    const open = batch.total - batch.done
    state.task = cut(oneLine(batch.step ?? `Waiting on ${open} ${open === 1 ? 'thread' : 'threads'}`), TASK_CHARS)
    state.done = batch.done
    state.total = batch.total
    state.unit = 'threads'
  } else {
    const tasks = meta.tasks ?? null
    const task = tasks?.current || (phase === 'working' ? meta.activity : null) || null
    if (task) state.task = cut(oneLine(task), TASK_CHARS)
    if (tasks && tasks.total > 0) {
      state.done = tasks.done
      state.total = tasks.total
    }
  }
  if (phase === 'waiting' && reason) state.reason = cut(oneLine(reason), REASON_CHARS)
  return state
}

/** The order of a group's rows: what needs the person, then what works, then what is held or over. */
const PHASE_RANK: Record<HubActivityState['phase'], number> = { waiting: 0, working: 1, paused: 2, failed: 3, stopped: 4, finished: 5 }
const isSettled = (phase: HubActivityState['phase']): boolean => phase === 'finished' || phase === 'failed' || phase === 'stopped'
const isLive = (phase: HubActivityState['phase']): boolean => phase === 'working' || phase === 'paused'

/** One thread of a group: its meta, the notifier's reason while it waits, a master's batch. */
export interface ActivityGroupEntry {
  meta: SessionMeta
  reason?: string | null
  batch?: BatchTally | null
}

/** A thread's row on a group card: the single state, cut shorter, with its id, type and the time its clock froze. Null when queued. */
export function activityRow(entry: ActivityGroupEntry, now: number): HubActivityRow | null {
  const state = activityState(entry.meta, now, entry.reason ?? null, entry.batch ?? null)
  if (!state) return null
  const row: HubActivityRow = { id: entry.meta.id, phase: state.phase, since: state.since }
  if (entry.meta.threadType) row.type = entry.meta.threadType
  if (state.phase !== 'working') row.ts = entry.meta.updatedAt
  if (state.title) row.title = cut(state.title, ROW_TITLE_CHARS)
  if (state.task) row.task = cut(state.task, ROW_TASK_CHARS)
  if (state.total !== undefined) {
    row.done = state.done
    row.total = state.total
  }
  if (state.unit) row.unit = state.unit
  if (state.reason) row.reason = cut(state.reason, ROW_REASON_CHARS)
  return row
}

/**
 * The content state of a group activity: one row per thread it covers
 * (queued ones left out), needs-you first, then working, paused, failed,
 * stopped and finished, each kind oldest first; a settled row leaves after
 * `ACTIVITY_SETTLE_MS`; at most `ACTIVITY_GROUP_ROWS` rows and never more
 * than ActivityKit's 4 KB, the rest counted in `more`. The group is live
 * while any thread works or is paused (its clock the longest-running
 * one's); once none is, the phase is the lead row's and the push is the
 * end. The top-level fields name the lead thread, so a phone that predates
 * groups still draws one card. Null when no thread has a row.
 */
export function activityGroupState(entries: ActivityGroupEntry[], now: number): HubActivityState | null {
  const rows = entries.map((e) => activityRow(e, now)).filter((r): r is HubActivityRow => r !== null)
  if (!rows.length) return null
  rows.sort((a, b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase] || a.since - b.since || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const fresh = rows.filter((r) => !isSettled(r.phase) || now - (r.ts ?? now) < ACTIVITY_SETTLE_MS)
  const shown = fresh.length ? fresh : rows
  const working = rows.filter((r) => r.phase === 'working')
  const live = rows.some((r) => isLive(r.phase))
  const lead = (live ? shown.find((r) => isLive(r.phase)) : undefined) ?? shown[0]
  const state: HubActivityState = { phase: live ? (working.length ? 'working' : 'paused') : lead.phase, since: working.length ? Math.min(...working.map((r) => r.since)) : lead.since, ts: now }
  if (lead.title) state.title = lead.title
  if (lead.task) state.task = lead.task
  if (state.phase === 'waiting' && lead.reason) state.reason = lead.reason
  const threads = shown.slice(0, ACTIVITY_GROUP_ROWS)
  state.threads = threads
  let more = shown.length - threads.length
  while (threads.length > 2 && Buffer.byteLength(JSON.stringify(state)) > GROUP_BYTES) {
    threads.pop()
    more += 1
  }
  if (more > 0) state.more = more
  return state
}

/** What one push goes to: a thread's single-thread tokens, or one group's token. */
interface Bucket {
  id: string
  group: boolean
  sessionIds: string[]
  targets: ActivityTarget[]
}

interface Sent {
  /** The last state pushed, without its clock. */
  sent: Omit<HubActivityState, 'ts'> | null
  sentAt: number
  /** A task-line change waiting for the window to pass. */
  soft: ReturnType<typeof setTimeout> | null
  /** A group: the moment its oldest settled row leaves. */
  settle: ReturnType<typeof setTimeout> | null
  /** A group: the thread whose change it last pushed, for a push the feed makes on its own clock. */
  trigger: string
}

interface ThreadTrack {
  /** The phase last seen, so a waiting thread holds for its reason once. */
  phase: HubActivityState['phase'] | null
  /** A waiting end holding out for the notifier's reason. */
  hold: ReturnType<typeof setTimeout> | null
  reason: string | null
}

/** A state with its task lines blanked: two states equal here differ only in what the threads are doing right now. */
const withoutTasks = (state: Omit<HubActivityState, 'ts'>): string =>
  JSON.stringify({ ...state, task: undefined, threads: state.threads?.map((r) => ({ ...r, task: undefined })) })

/**
 * Root threads with a registered activity: every change of what the card
 * shows becomes one `liveactivity` push. A thread's single-thread tokens
 * share one push; a phone's group token (one activity covering several
 * threads of this host, `activityGroupState`) gets its own, recomputed
 * whenever any thread it covers moves. A change of phase, tally, title,
 * reason or the rows goes at once at priority 10; a change of task lines
 * alone is coalesced to one push per window at priority 5, the latest
 * lines winning; a settled row leaving a group goes at priority 5. A
 * settled single thread, or a group with nothing working or paused, is the
 * `end` that shows the final state briefly, after which the rows are gone;
 * a waiting thread holds briefly for the notifier's needs-you line so the
 * card can say what it wants. A queued thread is skipped whole: no push,
 * no row.
 */
export class ActivityFeed {
  private readonly threads = new Map<string, ThreadTrack>()
  private readonly buckets = new Map<string, Sent>()
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
    for (const t of this.threads.values()) if (t.hold) clearTimeout(t.hold)
    for (const b of this.buckets.values()) this.clearTimers(b)
    this.threads.clear()
    this.buckets.clear()
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

  /** A master's batch moved (a step started, a child landed): its card re-reads the tally without waiting for a meta. */
  poke(masterId: string): void {
    const meta = this.options.registry.get?.(masterId) ?? null
    if (!meta || meta.parentId) return
    if (!this.options.push.hasActivities(meta.id)) return
    this.enqueue(meta, {})
  }

  private batchOf(meta: SessionMeta): BatchTally | null {
    if (!this.options.batch || !(this.options.isMaster?.(meta) ?? meta.isMaster === true)) return null
    return this.options.batch(meta.id)
  }

  private track(id: string): ThreadTrack {
    let t = this.threads.get(id)
    if (!t) {
      t = { phase: null, hold: null, reason: null }
      this.threads.set(id, t)
    }
    return t
  }

  private sentOf(id: string, trigger: string): Sent {
    let b = this.buckets.get(id)
    if (!b) {
      b = { sent: null, sentAt: 0, soft: null, settle: null, trigger }
      this.buckets.set(id, b)
    }
    b.trigger = trigger
    return b
  }

  private clearTimers(b: Sent): void {
    if (b.soft) clearTimeout(b.soft)
    if (b.settle) clearTimeout(b.settle)
    b.soft = null
    b.settle = null
  }

  private onMeta(meta: SessionMeta): void {
    if (meta.parentId) return
    if (!this.options.push.hasActivities(meta.id)) {
      this.forget(meta.id)
      return
    }
    const phase = activityPhase(meta.status, meta.archived)
    if (phase === null) return
    const t = this.track(meta.id)
    const before = t.phase
    t.phase = phase
    if (phase !== 'waiting') {
      t.reason = null
      if (t.hold) {
        // The prompt was answered before the end went out: nothing to end.
        clearTimeout(t.hold)
        t.hold = null
      }
    }
    if (phase === 'waiting' && !t.reason && !t.hold && before !== 'waiting') {
      // The notifier's line lands within its debounce; the state shows it when it does.
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
    if (t?.hold) clearTimeout(t.hold)
    this.threads.delete(id)
    const solo = this.buckets.get(`t:${id}`)
    if (solo) this.clearTimers(solo)
    this.buckets.delete(`t:${id}`)
  }

  /** Where a thread's change goes: one push for its single-thread tokens, one per group token covering it. */
  private bucketsOf(threadId: string): Bucket[] {
    const groups = this.options.push.activityGroups(threadId)
    const solo = groups.filter((g) => g.sessionIds.length < 2)
    const out: Bucket[] = []
    if (solo.length) out.push({ id: `t:${threadId}`, group: false, sessionIds: [threadId], targets: solo.map(({ keyId, token }) => ({ keyId, token })) })
    for (const g of groups) {
      if (g.sessionIds.length >= 2) out.push({ id: `g:${g.keyId}:${g.token}`, group: true, sessionIds: g.sessionIds, targets: [{ keyId: g.keyId, token: g.token }] })
    }
    return out
  }

  private enqueue(meta: SessionMeta, opts: { urgent?: boolean; quiet?: boolean }): void {
    for (const bucket of this.bucketsOf(meta.id)) this.enqueueBucket(bucket, meta, opts)
  }

  private stateOf(bucket: Bucket, meta: SessionMeta): HubActivityState | null {
    if (!bucket.group) return activityState(meta, this.now(), this.threads.get(meta.id)?.reason ?? null, this.batchOf(meta))
    const entries: ActivityGroupEntry[] = []
    for (const id of bucket.sessionIds) {
      const m = id === meta.id ? meta : (this.options.registry.get?.(id) ?? null)
      if (m && !m.parentId) entries.push({ meta: m, reason: this.threads.get(id)?.reason ?? null, batch: this.batchOf(m) })
    }
    return activityGroupState(entries, this.now())
  }

  /** Decides now or later; pushes settle in order per bucket, so an `end` never lands before the update it follows. */
  private enqueueBucket(bucket: Bucket, meta: SessionMeta, opts: { urgent?: boolean; quiet?: boolean }): void {
    const next = this.stateOf(bucket, meta)
    if (!next) return
    const b = this.sentOf(bucket.id, meta.id)
    const { ts: _ts, ...bare } = next
    const live = isLive(next.phase)
    const sent = b.sent
    const same = sent !== null && JSON.stringify(sent) === JSON.stringify(bare)
    const softOnly = sent !== null && live && !same && sent.phase === next.phase && withoutTasks(sent) === withoutTasks(bare)
    if (same && live) return
    if (same && !live && !opts.urgent) return
    if (softOnly && !opts.urgent) {
      const due = b.sentAt + this.coalesceMs - this.now()
      if (due > 0) {
        if (!b.soft) {
          b.soft = setTimeout(() => {
            b.soft = null
            const current = this.options.registry.get?.(b.trigger) ?? meta
            const again = this.bucketsOf(current.id).find((x) => x.id === bucket.id)
            if (again) this.enqueueBucket(again, current, { urgent: true })
          }, due)
          b.soft.unref?.()
        }
        return
      }
    }
    if (b.soft) {
      clearTimeout(b.soft)
      b.soft = null
    }
    const priority: 5 | 10 = softOnly || opts.quiet ? 5 : 10
    // Decided now, so a meta that follows at once compares against this state, not the one before it.
    b.sent = bare
    b.sentAt = this.now()
    if (bucket.group && live) this.armSettle(bucket, b, next)
    const run = (this.queues.get(bucket.id) ?? Promise.resolve())
      .then(() => this.push(bucket, meta, next, live, priority))
      .catch((err: unknown) => this.log(`activity push failed for ${bucket.id}: ${err instanceof Error ? err.message : String(err)}`))
    this.queues.set(bucket.id, run)
    void run.then(() => {
      if (this.queues.get(bucket.id) === run) this.queues.delete(bucket.id)
    })
  }

  /** A live group showing a settled row: recompute when the oldest one is due to leave. */
  private armSettle(bucket: Bucket, b: Sent, state: HubActivityState): void {
    if (b.settle) clearTimeout(b.settle)
    b.settle = null
    const due = (state.threads ?? []).filter((r) => isSettled(r.phase)).map((r) => (r.ts ?? 0) + ACTIVITY_SETTLE_MS - this.now())
    if (!due.length) return
    b.settle = setTimeout(
      () => {
        b.settle = null
        const current = this.options.registry.get?.(b.trigger) ?? null
        const again = current ? this.bucketsOf(current.id).find((x) => x.id === bucket.id) : undefined
        if (current && again) this.enqueueBucket(again, current, { quiet: true })
      },
      Math.max(0, Math.min(...due)) + 50
    )
    b.settle.unref?.()
  }

  private async push(bucket: Bucket, meta: SessionMeta, state: HubActivityState, live: boolean, priority: 5 | 10): Promise<void> {
    if (!this.options.push.hasActivities(meta.id)) {
      this.forget(meta.id)
      return
    }
    const event = live ? 'update' : 'end'
    const hub = this.options.local?.() ? null : this.options.hub()
    if (this.options.local?.()) {
      await this.options.push.deliverActivity({ threadId: meta.id, event, state, ts: this.now(), priority, targets: bucket.targets })
    } else if (hub) {
      // The hub fans a thread's state out to every token on it, a group token among them.
      await hub.pushActivity({ threadId: meta.id, event, state, title: state.title, ...(meta.threadType ? { threadType: meta.threadType } : {}), priority })
    }
    if (live) return
    const b = this.buckets.get(bucket.id)
    if (b) this.clearTimers(b)
    this.buckets.delete(bucket.id)
    if (!bucket.group) {
      this.options.push.endActivities(meta.id)
      if (!this.options.push.hasActivities(meta.id)) this.forget(meta.id)
      return
    }
    for (const target of bucket.targets) {
      for (const id of this.options.push.endGroup(target.keyId, target.token)) {
        if (hub) void hub.removeActivity(target.keyId, id)
        if (!this.options.push.hasActivities(id)) this.forget(id)
      }
    }
  }
}
