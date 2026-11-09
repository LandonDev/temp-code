import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ComputerSessionRow } from '@shared/contract-computer'
import type { AppRef } from '@shared/computer/protocol'
import type { SessionMeta, SessionStatus } from '@shared/events'
import { attachmentDir } from '../attachmentDir'
import { hostErrorLine } from '@shared/computer/hostErrors'
import { refusal, type ComputerToolOutcome } from './result'
import { runComputerTool, type ComputerRegistry, type ComputerToolContext, type RunHost, type ThreadComputer } from './run'
import type { Clock, ComputerService } from './service'
import { pruneServiceShots } from './shots'
import { currentSessionTierGate, type SessionTierGate } from './tierGate'
import { TierVerdicts, type SettingsStore } from './verdicts'

/**
 * One computer session per thread (docs/computer-protocol.md "Sessions"):
 * its calls run one at a time in arrival order, so the diff chain the model
 * reads stays in order and cards come up one at a time. A thread's session is
 * live from its first computer call in a turn until the turn settles, a Stop,
 * or the thread's end; live sessions are the Activity rows and keep the
 * service from its idle shutdown. Ten minutes after a thread's last call its
 * service session closes and its shots in the service's directory go.
 */

export interface ComputerSessionsOptions {
  service: ComputerService
  registry: ComputerRegistry
  store: SettingsStore
  /** the service's dataDir, for pruning its shots */
  dataDir: string
  /** where a thread's pictures land; default attachmentDir(thread)/computer */
  landing?: (threadId: string) => string
  gate?: () => SessionTierGate
  /** proof seam: pin an app query to an AppRef (e2e-computer pins TextEdit to its scratch pid); the server never sets it */
  resolveApp?: (query: string) => AppRef | null
  /** the thread's root, for the gate */
  rootOf?: (threadId: string) => string
  clock?: Clock
  log?: (line: string) => void
}

export const IDLE_CLOSE_MS = 600_000
/** rows push at most four a second */
export const ROW_PUSH_MS = 250
const SETTLED: readonly SessionStatus[] = ['idle', 'done', 'error', 'stopped', 'watching']
const REAL_CLOCK: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) }

/** The thread id when the capture plan's session pattern takes it, else `t_` and 40 hex of its sha256. */
export function serviceSessionId(threadId: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(threadId) ? threadId : `t_${createHash('sha256').update(threadId).digest('hex').slice(0, 40)}`
}

function rowFor(t: ThreadComputer): ComputerSessionRow | null {
  if (!t.live) return null
  return {
    threadId: t.threadId,
    since: t.live.since,
    lastCallAt: t.live.lastCallAt,
    apps: t.used.flatMap((key) => {
      const a = t.apps.get(key)
      return a ? [{ name: a.name, bundleId: a.bundleId, window: a.window?.title ?? null }] : []
    }),
    running: t.live.running,
    tier: t.live.tier
  }
}

export class ComputerSessions {
  readonly verdicts: TierVerdicts
  private readonly threads = new Map<string, ThreadComputer>()
  private readonly statuses = new Map<string, SessionStatus>()
  private readonly rowListeners = new Set<(rows: ComputerSessionRow[]) => void>()
  private readonly clock: Clock
  private readonly host: RunHost
  private rowTimer: unknown = null
  private lastPush = 0

  constructor(private readonly opts: ComputerSessionsOptions) {
    this.clock = opts.clock ?? REAL_CLOCK
    this.verdicts = new TierVerdicts(opts.store, this.clock)
    opts.service.onEpoch(() => {
      for (const t of this.threads.values()) t.openedIn = null
    })
    this.host = {
      service: opts.service,
      verdicts: this.verdicts,
      gate: () => opts.gate?.() ?? currentSessionTierGate(),
      registry: opts.registry,
      store: opts.store,
      resolveApp: opts.resolveApp,
      landing: opts.landing ?? ((id) => join(attachmentDir(id), 'computer')),
      rootOf: opts.rootOf ?? ((id) => id),
      now: () => this.clock.now(),
      log: (line) => (opts.log ?? console.log)(`[computer] ${line}`),
      touched: () => this.touched()
    }
  }

  /** The tool flow for one call (run.ts), behind the thread's serial queue. */
  run(ctx: ComputerToolContext, tool: string, args: unknown): Promise<ComputerToolOutcome> {
    const t = this.thread(ctx.threadId)
    const job = t.queue.then(async () => {
      const own = new AbortController()
      t.inflight = own
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, own.signal]) : own.signal
      try {
        if (t.ended) return refusal(hostErrorLine('cancelled', 'the thread ended'))
        return await runComputerTool(this.host, t, ctx, tool, args, signal)
      } finally {
        if (t.inflight === own) t.inflight = null
        this.armIdleClose(t)
        this.updateBusy()
      }
    })
    t.queue = job.catch(() => undefined)
    return job
  }

  rows(): ComputerSessionRow[] {
    const rows: ComputerSessionRow[] = []
    for (const t of this.threads.values()) {
      const row = rowFor(t)
      if (row) rows.push(row)
    }
    return rows
  }

  /** One thread's live row, or null when its session is not live. */
  rowOf(threadId: string): ComputerSessionRow | null {
    const t = this.threads.get(threadId)
    return t ? rowFor(t) : null
  }

  /**
   * A turn starts: Stop of the last turn no longer holds. onMeta calls it for
   * this host's threads; the Mac bridge (remote/macComputer.ts) for a box
   * thread's session, whose turns this host's registry never sees.
   */
  beginTurn(threadId: string): void {
    const t = this.threads.get(threadId)
    if (t) t.stopped = false
  }

  /** A turn settled: the thread's session is no longer live (its row goes; the service may idle). */
  settleTurn(threadId: string): void {
    const t = this.threads.get(threadId)
    if (!t?.live) return
    t.live = null
    this.touched()
    this.updateBusy()
  }

  onRows(fn: (rows: ComputerSessionRow[]) => void): () => void {
    this.rowListeners.add(fn)
    return () => this.rowListeners.delete(fn)
  }

  /**
   * Stop on the Activity row: computer use ends for the thread's turn. The
   * call in flight is cancelled (a card still waiting is denied through its
   * signal), and once it settles the service session closes, which lets go
   * of any held key or button. Later calls this turn answer `stopped`.
   */
  async stop(threadId: string): Promise<boolean> {
    const t = this.threads.get(threadId)
    if (!t) return false
    const wasLive = t.live !== null
    t.stopped = true
    t.inflight?.abort('stopped')
    await t.queue
    await this.closeSession(t)
    t.live = null
    this.touched()
    this.updateBusy()
    return wasLive
  }

  /** The composer's Stop, a pause: cancel what is in flight. */
  cancel(threadId: string, why: 'interrupt' | 'paused'): void {
    this.threads.get(threadId)?.inflight?.abort(why)
  }

  /** registry.onMeta: turn boundaries, pause, archive. */
  onMeta(meta: SessionMeta): void {
    const prev = this.statuses.get(meta.id)
    this.statuses.set(meta.id, meta.status)
    if (meta.archived) {
      void this.end([meta.id])
      return
    }
    const t = this.threads.get(meta.id)
    if (!t || prev === meta.status) return
    if ((meta.status === 'starting' || meta.status === 'running') && (prev === undefined || SETTLED.includes(prev))) this.beginTurn(meta.id)
    if (meta.status === 'paused') t.inflight?.abort('paused')
    if (SETTLED.includes(meta.status)) this.settleTurn(meta.id)
  }

  /** registry.onRemoved, an archive, a move: close and forget. */
  async end(threadIds: string[]): Promise<void> {
    for (const id of threadIds) {
      this.statuses.delete(id)
      const t = this.threads.get(id)
      if (!t) continue
      this.threads.delete(id)
      t.ended = true
      t.inflight?.abort('ended')
      await t.queue
      if (t.idleTimer !== null) this.clock.clearTimeout(t.idleTimer)
      await this.closeSession(t)
    }
    this.touched()
    this.updateBusy()
  }

  private thread(threadId: string): ThreadComputer {
    let t = this.threads.get(threadId)
    if (!t) {
      t = {
        threadId,
        serviceSession: serviceSessionId(threadId),
        openedIn: null,
        apps: new Map(),
        aliases: new Map(),
        used: [],
        queue: Promise.resolve(),
        live: null,
        stopped: false,
        inflight: null,
        idleTimer: null,
        nextShot: null,
        ended: false
      }
      this.threads.set(threadId, t)
    }
    return t
  }

  /** The service frees the session's maps and bases, and its shot directory goes; the next read is full. */
  private async closeSession(t: ThreadComputer): Promise<void> {
    const s = this.opts.service.state()
    if (t.openedIn && s.state === 'up' && s.epoch === t.openedIn)
      await this.opts.service.request('session.close', { session: t.serviceSession }).catch(() => undefined)
    t.openedIn = null
    t.apps.clear()
    t.used = []
    await pruneServiceShots(this.opts.dataDir, t.serviceSession).catch(() => undefined)
  }

  private armIdleClose(t: ThreadComputer): void {
    if (t.idleTimer !== null) this.clock.clearTimeout(t.idleTimer)
    t.idleTimer = this.clock.setTimeout(() => {
      t.idleTimer = null
      if (t.inflight || this.threads.get(t.threadId) !== t) return
      void this.closeSession(t)
    }, IDLE_CLOSE_MS)
  }

  private updateBusy(): void {
    this.opts.service.setBusy([...this.threads.values()].some((t) => t.live !== null))
  }

  private touched(): void {
    if (this.rowTimer !== null) return
    const wait = Math.max(0, this.lastPush + ROW_PUSH_MS - this.clock.now())
    this.rowTimer = this.clock.setTimeout(() => {
      this.rowTimer = null
      this.lastPush = this.clock.now()
      const rows = this.rows()
      for (const fn of this.rowListeners) fn(rows)
    }, wait)
  }
}
