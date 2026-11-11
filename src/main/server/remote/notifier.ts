import type { EventRow, Failure, SessionMeta } from '@shared/events'
import { approvalLine } from '@shared/approvalLine'

/**
 * Thread state → one notice per transition, for the hub, per-key webhooks
 * and anything in-process that wants to know (the renderer later):
 *
 *   needs_you  a permission or question prompt appeared (the thread waits)
 *   finished   a turn ended idle with nothing pending; a plan completed; a
 *              master's batch ended
 *   failed     an error row ended the turn, an account needs sign-in, the
 *              harness is gone (`stopped`), or a batch step failed
 *   stuck      a working thread wrote no row for `stuckMinutes`
 *
 * Every signal (a meta push, a persisted row) marks the thread and arms a
 * short timer; at the flush the LIVE meta decides what the thread is in,
 * and a notice goes out only when (event, state key) differs from the
 * last one sent for that thread. A prompt that is answered inside the
 * window, or a turn that settles and restarts, produces nothing twice.
 * Roots only: a subagent's rows count as activity of its root, and its
 * prompts are reported on the root.
 *
 * One voice: the title names the thread, the body says what happened in
 * the fewest words, a status word or a verb first, a colon before its
 * detail, commas between further facts. "Run bun test?", "Tabs or
 * spaces?", "Needs you", "Done in 12m, 2 tasks left", "Ready to build",
 * "Batch done: 3 landed, gate passed", "Failed: <the host's verdict>",
 * "Stopped unexpectedly", "No output for 12m".
 */

export type NoticeEvent = 'needs_you' | 'finished' | 'failed' | 'stuck'
/** What a notice is about: the phone's category (Approve and Deny on an approval) and the body's shape. */
export type NoticeKind = 'approval' | 'question' | 'plan' | 'waiting' | 'finished' | 'failed' | 'stuck' | 'batch' | 'stopped'

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
  /** A computer step held for the session tier: the phone's category is `tc.run-skip`, Run now and Skip. */
  choices?: 'run-skip'
  /** This host's name: the phone adds it to the subtitle when several hosts are paired. */
  hostName?: string
  /** A desktop window shows this thread to its person right now: the person-facing sinks (hub, APNs, relay) skip it. */
  onScreen?: true
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
  /** This host's name, carried on every notice. */
  hostName?: () => string
  /** A desktop window shows this root to its person now (FocusSet.isNamed): the notice is stamped `onScreen`. */
  onScreen?: (rootId: string) => boolean
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
  /** The body: the approval's question, or the first question asked. */
  face: string
  /** The root's row the prompt sits at (a subagent's prompt lands on the root's latest row). */
  seq: number
  /** The approval's buttons are Run now and Skip (a held computer step). */
  choices?: 'run-skip'
}

/** What a thread is in now, as one notice to send (`decide`). */
interface Decision {
  event: NoticeEvent
  kind: NoticeKind
  key: string
  body: string
  seq: number
  requestId?: string
  choices?: 'run-skip'
}

interface ThreadState {
  status: SessionMeta['status']
  /** The last notice sent and the state it described. */
  sent: { event: NoticeEvent; key: string } | null
  pending: Pending | null
  lastError: { message: string; stopped: boolean; seq: number; failure: Failure | null } | null
  /** A master's batch ended (kind `batch`) or a batch step failed (kind `gate`): told once the master is idle or watching. */
  lastBatch: { body: string; failed: boolean; seq: number } | null
  lastRowAt: number
  lastRowSeq: number
  /** When the current stretch of work began, for "Done in 12m". */
  startedAt: number | null
  stuckSent: boolean
  timer: ReturnType<typeof setTimeout> | null
  /** A master told its batch's end and the person has not written since: its idle is not a second Done. */
  batchTold: boolean
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
const firstLine = (text: string): string => oneLine(text.split(/\r?\n/).find((l) => l.trim()) ?? '')
const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

// The approval's question (shared/approvalLine.ts): the notices and the away rows say it alike.
export { approvalLine }

/**
 * The body of a batch engine row on a master (batch.ts): "Batch done: 3
 * landed, gate passed in 4m 12s" from its `Batch done: <line>` notice, or
 * "Batch stopped: gate failed at vitest" from a failing gate or release
 * step (the row's message is `gateLine`; what follows its lead, a comma
 * now, the old " · " on a stored row, is kept, an `at …` place joined with
 * a space, anything else with a comma).
 * Null for any other notice row.
 */
export function batchBody(event: { kind: string; message: string; gate?: { step: string; ok: boolean } }): { body: string; failed: boolean } | null {
  if (event.kind === 'batch') {
    const m = /^Batch done(?::\s*(.*))?$/s.exec(firstLine(event.message))
    if (!m) return null
    const line = m[1] ? m[1].split(/\s·\s|,\s/).map((part) => part.trim()).filter(Boolean).join(', ') : ''
    return { body: cut(line ? `Batch done: ${line}` : 'Batch done', BODY_CHARS), failed: false }
  }
  if (event.kind === 'gate' && event.gate && !event.gate.ok) {
    const tail = firstLine(event.message).split(/\s·\s|,\s/).slice(1).map((part) => part.trim()).filter(Boolean).join(', ')
    const join = !tail ? '' : tail.startsWith('at ') ? ` ${tail}` : `, ${tail}`
    return { body: cut(`Batch stopped: ${event.gate.step} failed${join}`, BODY_CHARS), failed: true }
  }
  return null
}

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

  private stateOf(id: string, status: SessionMeta['status']): ThreadState {
    let state = this.threads.get(id)
    if (!state) {
      state = {
        status,
        sent: null,
        pending: null,
        lastError: null,
        lastBatch: null,
        lastRowAt: this.options.registry.lastActivityAt(id) || this.now(),
        lastRowSeq: 0,
        startedAt: WORKING.has(status) ? (this.options.registry.get(id)?.busySince ?? null) : null,
        stuckSent: false,
        timer: null,
        batchTold: false
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
    const { event } = row
    switch (event.type) {
      case 'user-text':
        if (own) state.batchTold = false
        return
      case 'approval-request': {
        const plan = event.toolName === 'ExitPlanMode' || event.toolName === 'exit_plan_mode'
        state.pending = {
          sessionId: row.sessionId,
          requestId: event.requestId,
          kind: plan ? 'plan' : 'permission',
          face: plan ? '' : approvalLine(event.toolName, event.input, event.title),
          seq: own ? row.seq : state.lastRowSeq,
          ...(event.choices === 'run-skip' ? { choices: 'run-skip' as const } : {})
        }
        this.arm(rootId)
        return
      }
      case 'question-request':
        state.pending = {
          sessionId: row.sessionId,
          requestId: event.requestId,
          kind: 'question',
          face: oneLine(event.questions[0]?.question ?? ''),
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
        state.lastError = { message: event.message, stopped: event.stopped === true, seq: row.seq, failure: event.failure ?? null }
        // A sign-in that lapsed stops the thread without a status change: failed now.
        if (/needs sign-in/.test(event.message)) this.arm(rootId)
        return
      case 'notice': {
        // The batch engine's rows on a master (batch.ts): its end, or a gate or release step that failed.
        if (!own) return
        const batch = batchBody(event)
        if (!batch) return
        state.lastBatch = { ...batch, seq: row.seq }
        this.arm(rootId)
        return
      }
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
  ): Decision | null {
    const meta = this.options.registry.get(id)
    if (!meta || meta.archived) return null
    state.status = meta.status
    // Created, not yet booted: nothing has happened to tell.
    if (meta.status === 'queued') return null
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
      if (!p)
        return {
          event: 'needs_you',
          kind: 'waiting',
          key: `waiting:${state.lastRowSeq}`,
          body: 'Needs you',
          seq: state.lastRowSeq
        }
      const body = p.kind === 'plan' ? 'Plan ready to approve' : p.face || 'Needs you'
      return {
        event: 'needs_you',
        kind: p.kind === 'permission' ? 'approval' : p.kind,
        key: `prompt:${p.requestId}`,
        body: cut(body, BODY_CHARS),
        seq: p.seq,
        ...(p.kind === 'permission' ? { requestId: p.requestId, ...(p.choices ? { choices: p.choices } : {}) } : {})
      }
    }
    if (meta.status === 'error') {
      // The host's verdict when it gave one (failureKind.ts), else the error's first line.
      const e = state.lastError
      const line = e && !e.stopped ? e.failure?.summary || firstLine(e.message) : ''
      return {
        event: 'failed',
        kind: 'failed',
        key: `error:${e?.seq ?? state.lastRowSeq}`,
        body: cut(line ? `Failed: ${line}` : 'Failed', BODY_CHARS),
        seq: e?.seq ?? state.lastRowSeq
      }
    }
    if (meta.status === 'stopped') {
      // The liveness sweep found no harness behind a running row (sessions.ts).
      return { event: 'failed', kind: 'stopped', key: `stopped:${state.lastRowSeq}`, body: 'Stopped unexpectedly', seq: state.lastRowSeq }
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
    // A master's batch ended, or a step of it failed: said once the master is between turns.
    if (state.lastBatch && meta.isMaster === true && (meta.status === 'idle' || meta.status === 'watching')) {
      const b = state.lastBatch
      return { event: b.failed ? 'failed' : 'finished', kind: 'batch', key: `batch:${b.seq}`, body: b.body, seq: b.seq }
    }
    if (WORKING.has(meta.status)) return null
    if (meta.status === 'idle' || meta.status === 'done') {
      // A stop by the user is not a finish, and a thread that never worked since we looked has nothing to report.
      if (state.lastError?.stopped && state.lastError.seq >= state.lastRowSeq - 2) return null
      if (state.sent === null && state.lastRowSeq === 0) return null
      // A batch thread's finish is the master's to tell, in its one batch notice.
      if (this.inLiveBatch(meta)) return null
      // A master's idle right after its batch notice would say Done twice.
      if (meta.isMaster === true && state.batchTold) return null
      // A plan the planner marked complete (planFlow.ts): only a plan that
      // waits for the person says so; a started build will say Done itself.
      if (meta.threadType === 'planning' && meta.planCompletedAt) {
        if (meta.implementationId) return null
        return { event: 'finished', kind: 'plan', key: `plan:${meta.planCompletedAt}`, body: 'Ready to build', seq: state.lastRowSeq }
      }
      return { event: 'finished', kind: 'finished', key: `finished:${state.lastRowSeq}`, body: this.finishedBody(meta, state), seq: state.lastRowSeq }
    }
    return null
  }

  /** The thread is a child of a master that is live: pinned, here and unarchived. */
  private inLiveBatch(meta: SessionMeta): boolean {
    if (!meta.masterId) return false
    const master = this.options.registry.get(meta.masterId)
    return master !== null && !master.archived && master.isMaster === true
  }

  /** "Done in 12m", and "Done in 12m, 2 tasks left" when the thread's list is not finished. */
  private finishedBody(meta: SessionMeta, state: ThreadState): string {
    const ms = state.startedAt === null ? 0 : this.now() - state.startedAt
    const done = ms >= 1000 ? `Done in ${briefDuration(ms)}` : 'Done'
    const left = meta.tasks && meta.tasks.total > 0 ? meta.tasks.total - meta.tasks.done : 0
    return left > 0 ? `${done}, ${left} ${left === 1 ? 'task' : 'tasks'} left` : done
  }

  private flush(id: string): void {
    const state = this.threads.get(id)
    if (!state) return
    const decision = this.decide(id, state)
    if (!decision) return
    if (state.sent && state.sent.event === decision.event && state.sent.key === decision.key) return
    if (decision.event === 'stuck') state.stuckSent = true
    if (decision.kind === 'batch') {
      state.lastBatch = null
      state.batchTold = true
    }
    state.sent = { event: decision.event, key: decision.key }
    this.emit(id, decision.event, decision.kind, decision.body, decision.seq, decision)
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
        `No output for ${briefDuration(now - state.lastRowAt)}`,
        state.lastRowSeq
      )
    }
  }

  private emit(
    id: string,
    event: NoticeEvent,
    kind: NoticeKind,
    body: string,
    seq: number,
    prompt: Pick<Notice, 'requestId' | 'choices'> = {}
  ): void {
    const meta = this.options.registry.get(id)
    if (!meta) return
    const origin = this.options.origin?.() ?? null
    const place = oneLine(this.options.place?.(meta) ?? '')
    const hostName = this.options.hostName?.() ?? null
    // An untitled thread is named by its place, which then is not said again as the subtitle.
    const named = oneLine(meta.title)
    const notice: Notice = {
      event,
      kind,
      threadId: id,
      title: cut(named || place || 'Untitled', 120),
      ...(named && place ? { subtitle: cut(place, 80) } : {}),
      body,
      ...(origin ? { url: `${origin}/ui#thread=${id}` } : {}),
      ts: this.now(),
      seq,
      ...(prompt.requestId === undefined ? {} : { requestId: prompt.requestId }),
      ...(prompt.choices ? { choices: prompt.choices } : {}),
      ...(hostName ? { hostName: cut(oneLine(hostName), 80) } : {}),
      ...(this.options.onScreen?.(id) ? { onScreen: true as const } : {})
    }
    this.log(`${event} ${id} "${notice.title}": ${body}${notice.onScreen ? ' (on screen)' : ''}`)
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
