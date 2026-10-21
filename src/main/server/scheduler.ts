import type { SessionMeta } from '@shared/events'
import { ordinal, parseMaxRunning, THREAD_CAP_KEY } from '@shared/threadCap'

/**
 * The thread scheduler (CLAUDE.md "Master threads"): a thread the host
 * cannot run yet is created `queued` and started later, instead of being
 * refused or booted into a storm. Two reasons to queue:
 *
 * - The host's running cap (`threads.maxRunning`, default 4, 0 = unlimited):
 *   root threads (no parentId) in `starting`, `running` or `waiting` count;
 *   subagents follow their parent and never count; paused, idle, watching,
 *   stopped, queued, error and done do not count.
 * - An unmet `after`: the sibling has not yet settled in `done`, or `idle`
 *   after at least one turn, and was not archived or deleted. A sibling
 *   that errored or stopped keeps the waiter queued, and the waiter's
 *   activity line says so.
 *
 * Only a request that opted in queues (`session.create { queue: true }`,
 * or any thread of a master); a person's own new thread starts at once.
 * `admit` is the registry's question on a thread's first message; `tick`
 * starts queued roots oldest-first while a slot is free and their `after`
 * is met, on every meta change (settle, archive, delete, status), after
 * boot once the BootResumer has done its resume (`holdUntil`), and when
 * the cap changes. Starting is the registry's `startQueued`: the same path
 * a first message takes (boot the harness, send the stored first message),
 * so the status moves off `queued` through `starting`.
 *
 * Every queued root's `activity` line (what the rail and the working strip
 * read) is "Queued · waiting for <sibling title>" or "Queued · 3rd in line",
 * recomputed on every tick and pushed only when it changed.
 */

export interface SchedulerRegistry {
  /** Every stored row, raw (not decorated), archived ones included. */
  listSessions(): SessionMeta[]
  getSetting(key: string): string | null
  /** Has the thread sent at least one user message (a turn happened or is held)? */
  hasUserText(sessionId: string): boolean
  /** Boot a queued thread and send its stored first message. */
  startQueued(sessionId: string): Promise<boolean>
  /** A queued row's activity line changed: push its meta again. */
  setQueuedLine(sessionId: string, line: string | null): void
  onMeta(listener: (session: SessionMeta) => void): () => void
  onRemoved(listener: (sessionIds: string[]) => void): () => void
  log?(line: string): void
}

export type Admission = 'start' | 'queue'

export type AfterState =
  | { met: true }
  | { met: false; title: string; why: 'running' | 'errored' | 'stopped' | 'paused' | 'queued' }

const COUNTED = new Set<SessionMeta['status']>(['starting', 'running', 'waiting'])

export class ThreadScheduler {
  private readonly lines = new Map<string, string>()
  /** Queued ids whose start is in flight: counted as running until the row moves. */
  private readonly inFlight = new Set<string>()
  private held = false
  private dirty = false
  private running: Promise<void> | null = null
  private detach: (() => void) | null = null

  constructor(private readonly reg: SchedulerRegistry) {}

  /** Follow the registry: every meta change and removal schedules a tick. */
  attach(): () => void {
    if (this.detach) return this.detach
    const offMeta = this.reg.onMeta(() => this.schedule())
    const offRemoved = this.reg.onRemoved(() => this.schedule())
    this.detach = () => {
      offMeta()
      offRemoved()
      this.detach = null
    }
    return this.detach
  }

  /** Hold every start until the promise settles (the boot resume), then tick. */
  holdUntil(until: Promise<unknown>): void {
    this.held = true
    void until.finally(() => {
      this.held = false
      this.schedule()
    })
  }

  maxRunning(): number {
    return parseMaxRunning(this.reg.getSetting(THREAD_CAP_KEY))
  }

  /** Roots in a turn on this host, plus the starts this scheduler has in flight. */
  runningCount(sessions = this.reg.listSessions()): number {
    let n = 0
    for (const s of sessions) {
      if (s.parentId || s.archived) continue
      if (COUNTED.has(s.status) || (s.status === 'queued' && this.inFlight.has(s.id))) n++
    }
    return n
  }

  /** Is there room for one more root right now? */
  hasSlot(sessions = this.reg.listSessions()): boolean {
    const cap = this.maxRunning()
    return cap === 0 || this.runningCount(sessions) < cap
  }

  /** The sibling a thread waits for, as it stands. */
  afterState(session: Pick<SessionMeta, 'after'>, sessions = this.reg.listSessions()): AfterState {
    if (!session.after) return { met: true }
    const sibling = sessions.find((s) => s.id === session.after)
    // Gone or archived: nothing left to wait for.
    if (!sibling || sibling.archived) return { met: true }
    if (sibling.status === 'done') return { met: true }
    if (sibling.status === 'idle' && this.reg.hasUserText(sibling.id)) return { met: true }
    const why =
      sibling.status === 'error'
        ? 'errored'
        : sibling.status === 'stopped'
          ? 'stopped'
          : sibling.status === 'paused'
            ? 'paused'
            : sibling.status === 'queued'
              ? 'queued'
              : 'running'
    return { met: false, title: sibling.title, why }
  }

  /** The registry's question on a thread's first message. */
  admit(session: Pick<SessionMeta, 'id' | 'after' | 'parentId'>): Admission {
    if (session.parentId) return 'start'
    // The boot resume is still taking slots: wait for the picture to settle.
    if (this.held) return 'queue'
    const sessions = this.reg.listSessions()
    if (!this.afterState(session, sessions).met) return 'queue'
    return this.hasSlot(sessions) ? 'start' : 'queue'
  }

  /** Something changed: run a pass soon, coalescing bursts into one. */
  schedule(): void {
    this.dirty = true
    if (this.running) return
    this.running = this.loop().finally(() => {
      this.running = null
      // A change that landed between the loop's end and here is not lost.
      if (this.dirty) this.schedule()
    })
  }

  /** Run a pass now and wait for it (tests, the cap change). */
  tick(): Promise<void> {
    this.schedule()
    return this.running ?? Promise.resolve()
  }

  private async loop(): Promise<void> {
    // Off the caller's stack: a burst of changes becomes one pass.
    await Promise.resolve()
    while (this.dirty) {
      this.dirty = false
      try {
        await this.pass()
      } catch (error) {
        this.reg.log?.(`[scheduler] pass failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private async pass(): Promise<void> {
    const sessions = this.reg.listSessions()
    const queued = sessions
      .filter((s) => s.status === 'queued' && !s.parentId && !s.archived)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    for (const id of this.inFlight) {
      if (!queued.some((s) => s.id === id)) this.inFlight.delete(id)
    }
    const cap = this.maxRunning()
    let slots = cap === 0 ? Number.POSITIVE_INFINITY : cap - this.runningCount(sessions)
    const starts: SessionMeta[] = []
    const lines = new Map<string, string>()
    let position = 0
    for (const s of queued) {
      if (this.inFlight.has(s.id)) continue
      const after = this.afterState(s, sessions)
      if (!after.met) {
        lines.set(s.id, waitingLine(after))
        continue
      }
      if (!this.held && slots > 0) {
        slots--
        starts.push(s)
        continue
      }
      position++
      lines.set(s.id, `Queued · ${ordinal(position)} in line`)
    }
    for (const s of starts) {
      this.inFlight.add(s.id)
      this.lines.delete(s.id)
      void this.reg
        .startQueued(s.id)
        .catch((error) => {
          this.reg.log?.(`[scheduler] ${s.id}: start failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => {
          this.inFlight.delete(s.id)
          this.schedule()
        })
    }
    // Lines: push only what changed, drop what left the queue.
    for (const [id, line] of lines) {
      if (this.lines.get(id) === line) continue
      this.lines.set(id, line)
      this.reg.setQueuedLine(id, line)
    }
    for (const id of [...this.lines.keys()]) {
      if (lines.has(id)) continue
      this.lines.delete(id)
      this.reg.setQueuedLine(id, null)
    }
  }

  /** The line a queued row carries, null for a row not queued. */
  lineOf(sessionId: string): string | null {
    return this.lines.get(sessionId) ?? null
  }

  dispose(): void {
    this.detach?.()
    this.lines.clear()
    this.inFlight.clear()
  }
}

function waitingLine(after: Extract<AfterState, { met: false }>): string {
  const base = `Queued · waiting for ${after.title}`
  switch (after.why) {
    case 'errored':
      return `${base} (errored)`
    case 'stopped':
      return `${base} (stopped)`
    case 'paused':
      return `${base} (paused)`
    default:
      return base
  }
}
