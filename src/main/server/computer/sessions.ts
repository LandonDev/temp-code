import type { PreviewTarget } from './preview'
import { join } from 'node:path'
import type { ComputerSessionRow } from '@shared/contract-computer'
import type { AppRef, FrontReport } from '@shared/computer/protocol'
import type { SessionMeta, SessionStatus } from '@shared/events'
import { attachmentDir } from '../attachmentDir'
import { hostErrorLine } from '@shared/computer/hostErrors'
import { capturePicture, type ComputerHistory, type HistoryEntry, type HistoryPicture, type PictureTarget } from './history'
import { frontLine, refusal, type ComputerToolOutcome } from './result'
import { runComputerTool, type ComputerRegistry, type ComputerToolContext, type RunHost, type ThreadComputer } from './run'
import { CallTiming, timingLine } from '@shared/computer/bridgeTiming'
import type { Clock, ComputerService } from './service'
import { TargetResolver } from './policy'
import { serviceSessionId } from './sessionId'
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
  /** TEMP_CODE_COMPUTER_TRACE=1: one `[computer] timing` line per call this host's own thread makes */
  trace?: boolean
  /** the threads' journal (history.ts): every call's entry and one picture of the window after it. Without it nothing is journaled. */
  history?: ComputerHistory
}

/** The settings row a thread's first computer call writes: its next harness loads the tools without a search (§27.11). */
export const computerUsedSetting = (threadId: string): string => `computer.used.${threadId}`

export const IDLE_CLOSE_MS = 600_000
/** rows push at most four a second */
export const ROW_PUSH_MS = 250
const SETTLED: readonly SessionStatus[] = ['idle', 'done', 'error', 'stopped', 'watching']
const REAL_CLOCK: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) }

export { serviceSessionId }

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
    running: t.live.running && t.live.held ? { ...t.live.running, words: t.live.held, held: true } : t.live.running,
    tier: t.live.tier,
    ...(t.live.running && t.live.asking ? { asking: { line: t.live.asking } } : {})
  }
}

export class ComputerSessions {
  readonly verdicts: TierVerdicts
  private readonly threads = new Map<string, ThreadComputer>()
  private readonly statuses = new Map<string, SessionStatus>()
  private readonly targetListeners = new Set<(threadId: string) => void>()
  private readonly targetKeys = new Map<string, string>()
  /** threads whose used marker is written, so a call reads the settings table at most once */
  private readonly marked = new Set<string>()
  private readonly rowListeners = new Set<(rows: ComputerSessionRow[]) => void>()
  private readonly clock: Clock
  private readonly host: RunHost
  private rowTimer: unknown = null
  private lastPush = 0

  constructor(private readonly opts: ComputerSessionsOptions) {
    this.clock = opts.clock ?? REAL_CLOCK
    this.verdicts = new TierVerdicts(opts.store, this.clock)
    const targets = new TargetResolver()
    opts.service.onEpoch(() => {
      for (const t of this.threads.values()) t.openedIn = null
      targets.invalidate()
    })
    opts.service.onNotification((n) => {
      if (n.method === 'apps/changed') targets.invalidate()
      if (n.method === 'apps/frontRestored') this.frontRestored(n.params, targets.activeName())
    })
    this.host = {
      service: opts.service,
      verdicts: this.verdicts,
      gate: () => opts.gate?.() ?? currentSessionTierGate(),
      registry: opts.registry,
      store: opts.store,
      resolveApp: opts.resolveApp,
      targets,
      landing: opts.landing ?? ((id) => join(attachmentDir(id), 'computer')),
      rootOf: opts.rootOf ?? ((id) => id),
      now: () => this.clock.now(),
      log: (line) => (opts.log ?? console.log)(`[computer] ${line}`),
      touched: () => this.touched(),
      ...(opts.history ? { history: opts.history } : {})
    }
  }

  /** The tool flow for one call (run.ts), behind the thread's serial queue. */
  run(ctx: ComputerToolContext, tool: string, args: unknown): Promise<ComputerToolOutcome> {
    this.markUsed(ctx.threadId)
    const t = this.thread(ctx.threadId)
    const startedAt = this.clock.now()
    let journaled: { entry: HistoryEntry; target: PictureTarget | null } | null = null
    const job = t.queue.then(async () => {
      const own = new AbortController()
      t.inflight = own
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, own.signal]) : own.signal
      // a bridged call brings its own tally (remote/macComputer.ts); this host's own thread gets one here, for the trace
      const timing = ctx.timing ?? (this.opts.trace ? new CallTiming() : undefined)
      const runFrom = this.clock.now()
      try {
        if (t.ended) return refusal(hostErrorLine('cancelled', 'the thread ended'))
        return await runComputerTool(this.host, t, timing ? { ...ctx, timing } : ctx, tool, args, signal, (entry, target) => (journaled = { entry, target }))
      } finally {
        if (timing && !ctx.timing) {
          const now = this.clock.now()
          this.host.log(
            `thread=${t.threadId} ${timingLine({ total: now - startedAt, queue: runFrom - startedAt, run: now - runFrom }, { tool, service: timing.serviceMs, waited: timing.waitedMs })}`
          )
        }
        if (t.inflight === own) t.inflight = null
        this.targetChanged(t.threadId)
        this.armIdleClose(t)
        this.updateBusy()
      }
    })
    // The picture of the window as the call left it is the queue's tail: the caller has its answer by then, so the
    // model never waits for it, and the thread's next call, a Stop, its end and the idle close all do.
    t.queue = job.catch(() => undefined).then(() => (journaled ? this.picture(t, journaled.entry, journaled.target) : undefined))
    return job
  }

  /**
   * One picture for the journal, or why there is none: never for a call with no closing read, with the switch off,
   * or once the thread was stopped or ended. Nothing it does can fail the queue.
   */
  private async picture(t: ThreadComputer, entry: HistoryEntry, target: PictureTarget | null): Promise<void> {
    const history = this.opts.history
    if (!history) return
    try {
      const picture: HistoryPicture = !target
        ? { none: 'no-read' }
        : !history.pictures()
          ? { none: 'off' }
          : t.stopped || t.ended
            ? { none: 'failed' }
            : await capturePicture(this.opts.service, target, { clock: this.clock })
      await entry.picture(picture)
    } catch (e) {
      this.host.log(`computer history: a picture was not kept: ${(e as Error).message}`)
    }
  }

  /** Everything the thread queued so far has run, the picture after its last call included. */
  async drained(threadId: string): Promise<void> {
    await this.threads.get(threadId)?.queue
  }

  /**
   * A steal the guard undid after its call answered (§23.5): the thread whose
   * session armed the watch reads it once, in its next result. A notice that
   * names no session, or one this host no longer knows, is dropped.
   */
  private frontRestored(p: { session?: string; name: string; front: FrontReport; afterMs: number }, person: string | null): void {
    const threadId = p.session ? this.threadOfServiceSession(p.session) : null
    const t = threadId ? this.threads.get(threadId) : undefined
    const line = frontLine(p.name, p.front, person, p.afterMs)
    if (t && line) t.pendingFront.push(line)
  }

  /** Whether the thread made a computer call before, on this host or in an earlier run of it (§27.11). */
  used(threadId: string): boolean {
    return this.marked.has(threadId) || this.opts.store.getSetting(computerUsedSetting(threadId)) !== null
  }

  private markUsed(threadId: string): void {
    if (this.marked.has(threadId)) return
    this.marked.add(threadId)
    const key = computerUsedSetting(threadId)
    if (this.opts.store.getSetting(key) === null) this.opts.store.setSetting(key, String(this.clock.now()))
  }

  /** The thread's row, for the words its bridge lists. */
  meta(threadId: string): SessionMeta | null {
    return this.opts.registry.get(threadId)
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
    this.opts.history?.beginTurn(threadId)
  }

  /** A turn settled: the thread's session is no longer live (its row goes; the service may idle). */
  settleTurn(threadId: string): void {
    void this.host.gate().settle?.(threadId, 'turn-end')
    const t = this.threads.get(threadId)
    if (!t?.live) return
    t.live = null
    this.touched()
    this.updateBusy()
  }

  /** The running call of a thread is held (the scheduler's line), or no longer (null): its row says the line. */
  setHeld(threadId: string, line: string | null): void {
    const live = this.threads.get(threadId)?.live
    if (!live?.running || (live.held ?? null) === line) return
    live.held = line
    this.touched()
  }

  /** The thread behind a service session id (`session/interrupted` names the session). */
  threadOfServiceSession(serviceSession: string): string | null {
    for (const t of this.threads.values()) if (t.serviceSession === serviceSession) return t.threadId
    return null
  }

  onRows(fn: (rows: ComputerSessionRow[]) => void): () => void {
    this.rowListeners.add(fn)
    return () => this.rowListeners.delete(fn)
  }

  previewTarget(threadId: string): PreviewTarget | null {
    const t = this.threads.get(threadId)
    const app = t?.apps.get(t.used[0])
    return t?.live && app?.window ? {
      serviceSession: t.serviceSession,
      app: { pid: app.pid, name: app.name },
      window: { ...app.window }
    } : null
  }

  onTarget(fn: (threadId: string) => void): () => void {
    this.targetListeners.add(fn)
    return () => this.targetListeners.delete(fn)
  }

  async ensureOpen(threadId: string): Promise<string> {
    const t = this.threads.get(threadId)
    if (!t?.live || t.stopped) throw new Error('Computer session closed')
    const conn = await this.opts.service.connection()
    if (t.openedIn !== conn.epoch) {
      await this.opts.service.request('session.open', { session: t.serviceSession })
      if (this.threads.get(threadId) !== t || !t.live || t.stopped) throw new Error('Computer session closed')
      t.openedIn = conn.epoch
    }
    return t.serviceSession
  }

  private targetChanged(threadId: string): void {
    const key = JSON.stringify(this.previewTarget(threadId))
    if ((this.targetKeys.get(threadId) ?? 'null') === key) return
    this.targetKeys.set(threadId, key)
    for (const fn of this.targetListeners) fn(threadId)
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
    await this.host.gate().settle?.(threadId, 'stopped')
    t.live = null
    this.touched()
    this.updateBusy()
    return wasLive
  }

  /** The composer's Stop, a pause: cancel what is in flight. A pause also lets go of what the gate holds for the thread. */
  cancel(threadId: string, why: 'interrupt' | 'paused'): void {
    this.threads.get(threadId)?.inflight?.abort(why)
    if (why === 'paused') void this.host.gate().settle?.(threadId, 'paused')
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
    if (meta.status === 'paused') this.cancel(meta.id, 'paused')
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
      this.targetKeys.delete(id)
      await this.host.gate().settle?.(id, 'ended')
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
        pendingFront: [],
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
    t.listedApps = undefined
    t.used = []
    this.targetChanged(t.threadId)
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
