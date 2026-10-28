import type { SessionMeta } from '@shared/events'
import { joinFacts } from '@shared/statusWords'
import { currentLag, DEFAULT_IDLE_THRESHOLD_MS, untilLoopIdle } from './stalls'

/**
 * The thread scheduler (CLAUDE.md "Master threads"): a thread is created
 * `queued` and started later, instead of being refused, for one of two
 * reasons. Its `after` sibling has not finished: met when the sibling has
 * settled in `done`, or `idle` after at least one turn, or was archived or
 * deleted; one that errored, stopped or paused keeps the waiter queued and
 * the waiter's line says so. Or the host is at its running cap
 * (admission.ts): every live harness process counts, roots and subagents,
 * in starting, running, waiting or watching, plus idle rows still holding
 * a handle (`liveIds`); warm processes and queued rows never do.
 *
 * `admit` is the registry's question whenever a send needs a harness that
 * is not there (a first message, a thread whose handle the idle sweep
 * dropped). `after` and the boot hold apply to a root's first message when
 * its create opted in (`optIn`); the cap applies to every start. A send on
 * a focused thread (`focused`) is admitted over the cap, up to
 * FOCUSED_OVER_CAP such, so the person is never held. `tick` starts queued
 * rows oldest-first as their `after` is met and slots free, on every meta
 * change (settle, archive, delete, status) and after boot once the
 * BootResumer has done its resume (`holdUntil`). A pass reserves the slots
 * of the starts it picks before launching them (`inFlight`), so a burst of
 * passes never starts more than the cap. Starting is the registry's
 * `startQueued`: the same path a first message takes, so the status moves
 * off `queued` through `starting`; `session.start` (Start now) calls it
 * directly, past `after` and past the cap.
 *
 * Every queued row's `activity` line (what the rail, the board and the
 * working strip read) is "Queued  waiting for <sibling title>" (with
 * "(errored)", "(stopped)" or "(paused)" appended) for an `after` wait, and
 * "Queued  120 of 120 running" for the cap, recomputed on every tick and
 * pushed only when it changed.
 *
 * An idle thread still holding its harness holds a slot, so while rows
 * wait on the cap the pass asks the registry to put down the longest-idle
 * harnesses (`reclaimIdle`, what the 10-minute idle sweep does, only
 * sooner); the next send on such a thread resumes it. That is how a
 * settle frees a slot.
 *
 * Passes follow the loop: while it keeps up, a burst of changes is one pass
 * on the next microtask; while it lags (a fleet's meta storm), each pass
 * waits for a quiet loop (untilLoopIdle) and comes at most once per
 * PASS_GAP_MS.
 */

export interface SchedulerRegistry {
  /** One stored row, raw (not decorated), archived ones included; null when gone. */
  session(sessionId: string): SessionMeta | null
  /** The unarchived queued threads, roots and subagents, raw: a pass reads only these, never the whole table. */
  queued(): SessionMeta[]
  /** Has the thread sent at least one user message (a turn happened or is held)? */
  hasUserText(sessionId: string): boolean
  /** Boot a queued thread and send its stored first message. */
  startQueued(sessionId: string): Promise<boolean>
  /** A queued row's activity line changed: push its meta again. */
  setQueuedLine(sessionId: string, line: string | null): void
  onMeta(listener: (session: SessionMeta) => void): () => void
  onRemoved(listener: (sessionIds: string[]) => void): () => void
  /** The ids holding a running slot now (from the index and the live handles, never a table read); the scheduler adds the starts it reserved. */
  liveIds?(): Set<string>
  /** The running cap (admission.ts); absent: no cap. */
  cap?(): number
  /** Available memory is under the floor: nothing new is admitted. */
  memoryLow?(): boolean
  /** Put down up to `n` idle harnesses to free slots for the queue; when
   *  fewer were old enough, `nextAt` is when the next one will be. */
  reclaimIdle?(n: number): { freed: number; nextAt: number | null }
  log?(line: string): void
}

export type Admission = 'start' | 'queue'

/** Passes at most this often while the loop lags. */
export const PASS_GAP_MS = 250

/** Focused threads a send may start past the cap at once. */
export const FOCUSED_OVER_CAP = 2

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
  private reclaimTimer: ReturnType<typeof setTimeout> | null = null
  /** The order threads were queued in, for threads created in the same millisecond. */
  private readonly order = new Map<string, number>()
  private orderSeq = 0
  /** Threads a focused send started past the cap, while they stay live. */
  private readonly overCap = new Set<string>()
  private lastPassAt = Number.NEGATIVE_INFINITY
  private disposed = false

  /** Is the person looking at this thread? The server wires it to the windows' focus (focus.ts). */
  focused: (sessionId: string) => boolean = () => false

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
  afterState(session: Pick<SessionMeta, 'after'>): AfterState {
    if (!session.after) return { met: true }
    const sibling = this.reg.session(session.after)
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

  /** The cap in force; Infinity with no admission control. */
  cap(): number {
    return this.reg.cap?.() ?? Number.POSITIVE_INFINITY
  }

  /** Every id holding a running slot, the reserved starts included. */
  live(): Set<string> {
    const ids = new Set(this.reg.liveIds?.() ?? [])
    for (const id of this.inFlight) ids.add(id)
    return ids
  }

  /** Running slots taken and threads queued, for admission.get. */
  counts(): { running: number; queued: number } {
    return { running: this.live().size, queued: this.reg.queued().length }
  }

  /**
   * The registry's question on a send, and at create before the eager
   * boot. `first` and `optIn` (the create asked to queue, or a master made
   * it) bring `after` and the boot hold in; the cap applies to every start
   * that needs a harness (`harness`: one is already up or booting, so its
   * slot is held).
   */
  admit(
    session: Pick<SessionMeta, 'id' | 'after' | 'parentId'>,
    opts: { first?: boolean; optIn?: boolean; harness?: boolean } = {}
  ): Admission {
    if (!session.parentId && opts.optIn && opts.first !== false) {
      // The boot resume is still bringing threads back: wait for the picture to settle.
      if (this.held) return 'queue'
      if (!this.afterState(session).met) {
        this.noteQueued(session.id)
        return 'queue'
      }
    }
    if (opts.harness) return 'start'
    if (this.takeSlot(session.id)) return 'start'
    this.noteQueued(session.id)
    return 'queue'
  }

  /** Remember when a thread joined the queue: oldest first breaks a createdAt tie by it. */
  noteQueued(sessionId: string): void {
    if (!this.order.has(sessionId)) this.order.set(sessionId, ++this.orderSeq)
  }

  /** A slot for this start: one free under the cap, or a focused thread's exemption. */
  private takeSlot(sessionId: string): boolean {
    const live = this.live()
    if (live.has(sessionId)) return true
    if (!this.reg.memoryLow?.() && live.size < this.cap()) return true
    if (!this.focused(sessionId)) return false
    for (const id of this.overCap) if (!live.has(id)) this.overCap.delete(id)
    if (this.overCap.size >= FOCUSED_OVER_CAP) return false
    this.overCap.add(sessionId)
    return true
  }

  /** Something changed: run a pass soon, coalescing bursts into one. */
  schedule(): void {
    if (this.disposed) return
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
      if (currentLag().meanMs >= DEFAULT_IDLE_THRESHOLD_MS) {
        const gap = this.lastPassAt + PASS_GAP_MS - Date.now()
        await Promise.all([gap > 0 ? new Promise((r) => setTimeout(r, gap)) : null, untilLoopIdle()])
        // Disposed while it waited: nothing may start now.
        if (this.disposed) return
      }
      this.dirty = false
      this.lastPassAt = Date.now()
      try {
        await this.pass()
      } catch (error) {
        this.reg.log?.(`[scheduler] pass failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private async pass(): Promise<void> {
    const queued = this.reg
      .queued()
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt ||
          (this.order.get(a.id) ?? Infinity) - (this.order.get(b.id) ?? Infinity) ||
          a.id.localeCompare(b.id)
      )
    const queuedIds = new Set(queued.map((s) => s.id))
    for (const id of this.inFlight) if (!queuedIds.has(id)) this.inFlight.delete(id)
    for (const id of this.order.keys()) if (!queuedIds.has(id)) this.order.delete(id)
    const live = this.live()
    const cap = this.cap()
    const low = this.reg.memoryLow?.() ?? false
    let free = low ? 0 : cap - live.size
    const starts: SessionMeta[] = []
    const capped: string[] = []
    const lines = new Map<string, string>()
    for (const s of queued) {
      if (this.inFlight.has(s.id)) continue
      const after = this.afterState(s)
      if (!after.met) {
        lines.set(s.id, waitingLine(after))
        continue
      }
      if (this.held) {
        lines.set(s.id, 'Queued')
        continue
      }
      if (free <= 0) {
        capped.push(s.id)
        continue
      }
      free--
      starts.push(s)
    }
    // Rows still wait on the cap: idle harnesses give their slots up, and
    // the next pass starts the rows behind them.
    if (capped.length > 0 && !low && this.reg.reclaimIdle) {
      const { freed, nextAt } = this.reg.reclaimIdle(capped.length)
      if (freed > 0) this.schedule()
      else if (nextAt !== null && !this.reclaimTimer) {
        this.reclaimTimer = setTimeout(() => {
          this.reclaimTimer = null
          this.schedule()
        }, Math.max(0, nextAt - Date.now()))
        this.reclaimTimer.unref?.()
      }
    }
    // Reserve every picked start's slot before any launches.
    for (const s of starts) this.inFlight.add(s.id)
    const running = live.size + starts.length
    for (const id of capped) lines.set(id, capLine(running, cap, low))
    for (const s of starts) {
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

  /** Why a queued row waits, as it stands now (the line before a pass has pushed one). */
  describe(session: Pick<SessionMeta, 'after'>): string {
    const after = this.afterState(session)
    if (!after.met) return waitingLine(after)
    if (this.held) return 'Queued'
    return capLine(this.live().size, this.cap(), this.reg.memoryLow?.() ?? false)
  }

  /** The line a queued row carries, null for a row not queued. */
  lineOf(sessionId: string): string | null {
    return this.lines.get(sessionId) ?? null
  }

  dispose(): void {
    this.disposed = true
    this.dirty = false
    this.detach?.()
    this.lines.clear()
    this.inFlight.clear()
    this.overCap.clear()
    this.order.clear()
    if (this.reclaimTimer) clearTimeout(this.reclaimTimer)
    this.reclaimTimer = null
  }
}

function capLine(running: number, cap: number, low: boolean): string {
  return joinFacts('Queued', low ? 'waiting for memory' : `${running} of ${cap} running`)
}

function waitingLine(after: Extract<AfterState, { met: false }>): string {
  const base = joinFacts('Queued', `waiting for ${after.title}`)
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
