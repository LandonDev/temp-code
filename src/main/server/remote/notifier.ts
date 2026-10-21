import type { EventRow, SessionMeta } from '@shared/events'
import { toolFace } from './facade'

/**
 * Thread state → one notice per transition, for the hub, per-key webhooks
 * and anything in-process that wants to know (the renderer later):
 *
 *   needs_you  a permission or question prompt appeared (the thread waits)
 *   finished   a turn ended idle with nothing pending
 *   failed     an error row ended the turn, or an account needs sign-in
 *   stuck      a working thread wrote no row for `stuckMinutes`, or a
 *              stall was reported for it
 *
 * Every signal (a meta push, a persisted row) marks the thread and arms a
 * short timer; at the flush the LIVE meta decides what the thread is in,
 * and a notice goes out only when (event, state key) differs from the
 * last one sent for that thread. A prompt that is answered inside the
 * window, or a turn that settles and restarts, produces nothing twice.
 * Roots only: a subagent's rows count as activity of its root, and its
 * prompts are reported on the root with the subagent named.
 */

export type NoticeEvent = 'needs_you' | 'finished' | 'failed' | 'stuck'
/** What a notice is about: the phone's category (Approve and Deny on an approval) and the body's shape. */
export type NoticeKind = 'approval' | 'question' | 'plan' | 'waiting' | 'finished' | 'failed' | 'stuck'

export interface Notice {
  event: NoticeEvent
  kind: NoticeKind
  threadId: string
  title: string
  /** The project or workspace the thread is in, when known. */
  subtitle?: string
  body: string
  url?: string
  ts: number
  /** The root's row to land on: the prompt, the error, else the last row seen. */
  seq: number
  /** The approval a phone may decide from the notification (kind `approval`). */
  requestId?: string
}

export type NoticeSink = (notice: Notice) => void | Promise<void>

/** What the notifier reads of the registry (SessionRegistry satisfies it). */
export interface NotifierRegistry {
  onMeta(listener: (meta: SessionMeta) => void): () => void
  onEvent(listener: (row: EventRow) => void): () => void
  list(opts?: { archived?: boolean }): SessionMeta[]
  get(id: string): SessionMeta | null
  rootSessionOf(id: string): string
  lastActivityAt(id: string): number
}

export interface NotifierOptions {
  registry: NotifierRegistry
  /** Minutes a working thread may stay silent; read at every sweep so a setting change applies at once. */
  stuckMinutes: () => number
  /** The public origin for links; null leaves `url` out. */
  origin?: () => string | null
  /** The project's or workspace's name for a thread: the notification's subtitle. */
  place?: (meta: SessionMeta) => string | null
  now?: () => number
  /** Signals inside this window settle into one decision. */
  debounceMs?: number
  sweepMs?: number
  log?: (line: string) => void
}

export const STUCK_MINUTES_DEFAULT = 10
export const NOTIFY_DEBOUNCE_MS = 1_500
export const NOTIFY_SWEEP_MS = 30_000
const BODY_CHARS = 200

const WORKING = new Set<SessionMeta['status']>(['starting', 'running', 'watching'])

interface Pending {
  /** The session that asked: the root, or one of its subagents. */
  sessionId: string
  requestId: string
  kind: 'permission' | 'question' | 'plan'
  face: string
  /** The subagent that asked, when it was not the root itself. */
  by: string | null
  /** The root's row the prompt sits at (a subagent's prompt lands on the root's latest row). */
  seq: number
}

interface ThreadState {
  status: SessionMeta['status']
  /** The last notice sent and the state it described. */
  sent: { event: NoticeEvent; key: string } | null
  pending: Pending | null
  lastError: { message: string; stopped: boolean; seq: number } | null
  lastRowAt: number
  lastRowSeq: number
  /** When the current stretch of work began, for "Done in 12m". */
  startedAt: number | null
  stuckSent: boolean
  timer: ReturnType<typeof setTimeout> | null
  /** A stall report asked for an immediate stuck check. */
  stalled: boolean
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
const firstLine = (text: string): string => oneLine(text.split(/\r?\n/).find((l) => l.trim()) ?? '')
const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

/** "45s", "12m", "1h 05m": the desktop's duration at the coarseness a notification wants. */
export function briefDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

export class Notifier {
  private readonly threads = new Map<string, ThreadState>()
  private readonly sinks = new Set<NoticeSink>()
  private readonly now: () => number
  private readonly debounceMs: number
  private readonly sweepMs: number
  private readonly log: (line: string) => void
  private unsubscribe: (() => void)[] = []
  private sweeper: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: NotifierOptions) {
    this.now = options.now ?? Date.now
    this.debounceMs = options.debounceMs ?? NOTIFY_DEBOUNCE_MS
    this.sweepMs = options.sweepMs ?? NOTIFY_SWEEP_MS
    this.log = options.log ?? ((line) => console.log(`[notify] ${line}`))
  }

  onNotice(sink: NoticeSink): () => void {
    this.sinks.add(sink)
    return () => this.sinks.delete(sink)
  }

  /** Seed from the live threads without a notice, then follow the registry. */
  start(): void {
    const reg = this.options.registry
    for (const meta of reg.list({ archived: false })) {
      if (meta.parentId) continue
      this.stateOf(meta.id, meta.status)
    }
    this.unsubscribe = [
      reg.onMeta((meta) => this.onMeta(meta)),
      reg.onEvent((row) => this.onRow(row))
    ]
    this.sweeper = setInterval(() => this.sweep(), this.sweepMs)
    this.sweeper.unref?.()
  }

  stop(): void {
    for (const off of this.unsubscribe) off()
    this.unsubscribe = []
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
    for (const state of this.threads.values()) if (state.timer) clearTimeout(state.timer)
    this.threads.clear()
  }

  /** A stall was measured for this thread (or its root): check it now. */
  reportStall(sessionId: string): void {
    const rootId = this.options.registry.rootSessionOf(sessionId)
    const state = this.threads.get(rootId)
    if (!state) return
    state.stalled = true
    this.arm(rootId)
  }

  private stateOf(id: string, status: SessionMeta['status']): ThreadState {
    let state = this.threads.get(id)
    if (!state) {
      state = {
        status,
        sent: null,
        pending: null,
        lastError: null,
        lastRowAt: this.options.registry.lastActivityAt(id) || this.now(),
        lastRowSeq: 0,
        startedAt: WORKING.has(status) ? (this.options.registry.get(id)?.busySince ?? null) : null,
        stuckSent: false,
        timer: null,
        stalled: false
      }
      this.threads.set(id, state)
    }
    return state
  }

  private onMeta(meta: SessionMeta): void {
    if (meta.parentId) {
      // A subagent that waits (or stops waiting) on a prompt changes what its root is in.
      const rootId = this.options.registry.rootSessionOf(meta.id)
      if (this.threads.get(rootId)?.pending?.sessionId === meta.id) this.arm(rootId)
      return
    }
    if (meta.archived) {
      const state = this.threads.get(meta.id)
      if (state?.timer) clearTimeout(state.timer)
      this.threads.delete(meta.id)
      return
    }
    const state = this.stateOf(meta.id, meta.status)
    if (state.status === meta.status) return
    const was = state.status
    state.status = meta.status
    if (WORKING.has(meta.status) && !WORKING.has(was)) {
      // A new stretch of work: silence counts from here, and the prompt is gone.
      state.lastRowAt = this.now()
      state.stuckSent = false
      state.pending = null
      // busySince survives steers and prompts; without it a resume keeps its start, a fresh run starts now.
      state.startedAt = meta.busySince ?? (was === 'waiting' || was === 'paused' ? state.startedAt : null) ?? this.now()
    }
    if (meta.status !== 'waiting' && !WORKING.has(meta.status)) state.pending = null
    this.arm(meta.id)
  }

  private onRow(row: EventRow): void {
    const reg = this.options.registry
    const rootId = reg.rootSessionOf(row.sessionId)
    const state = this.threads.get(rootId)
    if (!state) return
    const own = rootId === row.sessionId
    state.lastRowAt = this.now()
    state.lastRowSeq = Math.max(state.lastRowSeq, own ? row.seq : state.lastRowSeq + 1)
    state.stuckSent = false
    state.stalled = false
    const { event } = row
    switch (event.type) {
      case 'approval-request': {
        const plan = event.toolName === 'ExitPlanMode' || event.toolName === 'exit_plan_mode'
        state.pending = {
          sessionId: row.sessionId,
          requestId: event.requestId,
          kind: plan ? 'plan' : 'permission',
          face: plan
            ? ''
            : `${event.toolName} — ${event.title ? oneLine(event.title) : toolFace(event.input)}`,
          by: own ? null : (reg.get(row.sessionId)?.title ?? row.sessionId),
          seq: own ? row.seq : state.lastRowSeq
        }
        this.arm(rootId)
        return
      }
      case 'question-request':
        state.pending = {
          sessionId: row.sessionId,
          requestId: event.requestId,
          kind: 'question',
          face: event.questions.map((q) => oneLine(q.question)).join(' · '),
          by: own ? null : (reg.get(row.sessionId)?.title ?? row.sessionId),
          seq: own ? row.seq : state.lastRowSeq
        }
        this.arm(rootId)
        return
      case 'approval-resolved':
      case 'question-resolved':
        if (state.pending?.requestId === event.requestId) state.pending = null
        this.arm(rootId)
        return
      case 'error':
        if (!own) return
        state.lastError = { message: event.message, stopped: event.stopped === true, seq: row.seq }
        // A sign-in that lapsed stops the thread without a status change: failed now.
        if (/needs sign-in/.test(event.message)) this.arm(rootId)
        return
      default:
        return
    }
  }

  private arm(id: string): void {
    const state = this.threads.get(id)
    if (!state) return
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = null
      this.flush(id)
    }, this.debounceMs)
    state.timer.unref?.()
  }

  /** What the thread is in now, as one (event, key) — or nothing notable. */
  private decide(
    id: string,
    state: ThreadState
  ): { event: NoticeEvent; kind: NoticeKind; key: string; body: string; seq: number; requestId?: string } | null {
    const meta = this.options.registry.get(id)
    if (!meta || meta.archived) return null
    state.status = meta.status
    const signIn =
      state.lastError && !state.lastError.stopped && /needs sign-in/.test(state.lastError.message)
        ? state.lastError
        : null
    const p = state.pending
    const childWaiting =
      p !== null &&
      p.sessionId !== id &&
      this.options.registry.get(p.sessionId)?.status === 'waiting'
    if (meta.status === 'waiting' || childWaiting) {
      const who = p?.by ? ` (subagent ${cut(p.by, 60)})` : ''
      if (!p)
        return {
          event: 'needs_you',
          kind: 'waiting',
          key: `waiting:${state.lastRowSeq}`,
          body: `Waiting for you${who}`,
          seq: state.lastRowSeq
        }
      const body =
        p.kind === 'plan'
          ? `Plan ready to approve${who}`
          : p.kind === 'question'
            ? `Asked${who}: ${p.face}`
            : `Needs approval${who}: ${p.face}`
      return {
        event: 'needs_you',
        kind: p.kind === 'permission' ? 'approval' : p.kind,
        key: `prompt:${p.requestId}`,
        body: cut(body, BODY_CHARS),
        seq: p.seq,
        ...(p.kind === 'permission' ? { requestId: p.requestId } : {})
      }
    }
    if (meta.status === 'error') {
      const e = state.lastError
      const line = e && !e.stopped ? firstLine(e.message) : ''
      return {
        event: 'failed',
        kind: 'failed',
        key: `error:${e?.seq ?? state.lastRowSeq}`,
        body: cut(line ? `Failed: ${line}` : 'Failed', BODY_CHARS),
        seq: e?.seq ?? state.lastRowSeq
      }
    }
    if (signIn && WORKING.has(meta.status)) {
      return {
        event: 'failed',
        kind: 'failed',
        key: `error:${signIn.seq}`,
        body: cut(`Failed: ${firstLine(signIn.message)}`, BODY_CHARS),
        seq: signIn.seq
      }
    }
    if (WORKING.has(meta.status)) {
      if (state.stalled)
        return {
          event: 'stuck',
          kind: 'stuck',
          key: `stuck:${state.lastRowSeq}`,
          body: 'Stalled while working',
          seq: state.lastRowSeq
        }
      return null
    }
    if (meta.status === 'idle' || meta.status === 'done') {
      // A stop by the user is not a finish, and a thread that never worked since we looked has nothing to report.
      if (state.lastError?.stopped && state.lastError.seq >= state.lastRowSeq - 2) return null
      if (state.sent === null && state.lastRowSeq === 0) return null
      // A plan the planner marked complete says so, and whether its build
      // runs (planFlow.ts): the person's own notice of a finished plan.
      if (meta.threadType === 'planning' && meta.planCompletedAt) {
        const build = meta.implementationId ? this.options.registry.get(meta.implementationId) : null
        const body = build && !build.archived ? `Plan complete — implementation started: ${cut(build.title, 80)}` : 'Plan complete — waiting for you to start the build'
        return { event: 'finished', kind: 'plan', key: `plan:${meta.planCompletedAt}:${build?.id ?? ''}`, body, seq: state.lastRowSeq }
      }
      return { event: 'finished', kind: 'finished', key: `finished:${state.lastRowSeq}`, body: this.finishedBody(meta, state), seq: state.lastRowSeq }
    }
    return null
  }

  /** "Done in 12m · 7 tasks": the stretch's length, and the list's tally when the thread has one. */
  private finishedBody(meta: SessionMeta, state: ThreadState): string {
    const parts: string[] = []
    const ms = state.startedAt === null ? 0 : this.now() - state.startedAt
    parts.push(ms >= 1000 ? `Done in ${briefDuration(ms)}` : 'Done')
    const tasks = meta.tasks
    if (tasks && tasks.total > 0) parts.push(tasks.done === tasks.total ? `${tasks.total} ${tasks.total === 1 ? 'task' : 'tasks'}` : `${tasks.done}/${tasks.total} tasks`)
    return parts.join(' · ')
  }

  private flush(id: string): void {
    const state = this.threads.get(id)
    if (!state) return
    const decision = this.decide(id, state)
    if (!decision) return
    if (state.sent && state.sent.event === decision.event && state.sent.key === decision.key) return
    if (decision.event === 'stuck') state.stuckSent = true
    state.sent = { event: decision.event, key: decision.key }
    this.emit(id, decision.event, decision.kind, decision.body, decision.seq, decision.requestId)
  }

  /** Working threads silent past the limit (and nothing told us since) get one `stuck`. */
  sweep(): void {
    const limit = Math.max(1, this.options.stuckMinutes()) * 60_000
    const now = this.now()
    for (const [id, state] of this.threads) {
      if (!WORKING.has(state.status) || state.stuckSent || state.timer) continue
      if (now - state.lastRowAt < limit) continue
      const meta = this.options.registry.get(id)
      if (!meta || meta.archived || !WORKING.has(meta.status)) continue
      const key = `stuck:${state.lastRowSeq}`
      if (state.sent?.event === 'stuck' && state.sent.key === key) continue
      state.stuckSent = true
      state.sent = { event: 'stuck', key }
      this.emit(
        id,
        'stuck',
        'stuck',
        `Quiet for ${Math.round((now - state.lastRowAt) / 60_000)} min while working`,
        state.lastRowSeq
      )
    }
  }

  private emit(id: string, event: NoticeEvent, kind: NoticeKind, body: string, seq: number, requestId?: string): void {
    const meta = this.options.registry.get(id)
    if (!meta) return
    const origin = this.options.origin?.() ?? null
    const place = this.options.place?.(meta) ?? null
    const notice: Notice = {
      event,
      kind,
      threadId: id,
      title: cut(oneLine(meta.title) || 'Untitled', 120),
      ...(place ? { subtitle: cut(oneLine(place), 80) } : {}),
      body,
      ...(origin ? { url: `${origin}/ui#thread=${id}` } : {}),
      ts: this.now(),
      seq,
      ...(requestId === undefined ? {} : { requestId })
    }
    this.log(`${event} ${id} "${notice.title}": ${body}`)
    for (const sink of this.sinks) {
      try {
        const out = sink(notice)
        if (out && typeof (out as Promise<void>).catch === 'function') {
          ;(out as Promise<void>).catch((err: unknown) =>
            this.log(`sink failed: ${err instanceof Error ? err.message : String(err)}`)
          )
        }
      } catch (err) {
        this.log(`sink failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}
