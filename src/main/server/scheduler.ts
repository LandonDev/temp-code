import type { SessionMeta } from '@shared/events'

/**
 * The thread scheduler (CLAUDE.md "Master threads"): a thread whose
 * `after` sibling has not finished is created `queued` and started later,
 * instead of being refused. That is the one reason to queue; there is no
 * running cap. `after` is met when the sibling has settled in `done`, or
 * `idle` after at least one turn, or was archived or deleted. A sibling
 * that errored, stopped or paused keeps the waiter queued, and the
 * waiter's activity line says so.
 *
 * `admit` is the registry's question on a thread's first message; `tick`
 * starts queued roots oldest-first once their `after` is met, on every
 * meta change (settle, archive, delete, status) and after boot once the
 * BootResumer has done its resume (`holdUntil`). Starting is the
 * registry's `startQueued`: the same path a first message takes (boot the
 * harness, send the stored first message), so the status moves off
 * `queued` through `starting`.
 *
 * Every queued root's `activity` line (what the rail and the working strip
 * read) is "Queued · waiting for <sibling title>", with "(errored)",
 * "(stopped)" or "(paused)" appended, recomputed on every tick and pushed
 * only when it changed.
 */

export interface SchedulerRegistry {
  /** Every stored row, raw (not decorated), archived ones included. */
  listSessions(): SessionMeta[]
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

export class ThreadScheduler {
  private readonly lines = new Map<string, string>()
  /** Queued ids whose start is in flight, so a pass never starts one twice. */
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
    // The boot resume is still bringing threads back: wait for the picture to settle.
    if (this.held) return 'queue'
    return this.afterState(session).met ? 'start' : 'queue'
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

  /** Run a pass now and wait for it (tests). */
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
    const starts: SessionMeta[] = []
    const lines = new Map<string, string>()
    for (const s of queued) {
      if (this.inFlight.has(s.id)) continue
      const after = this.afterState(s, sessions)
      if (!after.met) {
        lines.set(s.id, waitingLine(after))
        continue
      }
      if (this.held) {
        lines.set(s.id, 'Queued')
        continue
      }
      starts.push(s)
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
