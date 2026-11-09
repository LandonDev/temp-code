import { cpus, loadavg } from 'node:os'
import {
  MAC_BRIDGE_DEFAULT_MAX_COMPUTER,
  MAC_LOAD_LIMIT_PER_CORE,
  MAC_LOAD_RESUME_FRACTION,
  MAC_LOAD_SAMPLE_MS,
  type MacBridgeHeld,
  type MacBridgeLoad
} from '@shared/contract-macbridge'

/**
 * The Mac load guard (docs/box.md "The Mac bridge": "The load guard"). Fifteen
 * box threads once drove the Mac to a load average of 810 and nothing stopped
 * them. This sits between the decision and the spawn of every command and
 * job the bridge admits, and never touches reads, listings, fetches or
 * writes:
 *
 *  - Per host, a cap on concurrent commands plus jobs
 *    (`macBridge.maxRunning.<envId>`, default 4). At the cap, the next one
 *    waits its turn, in order, with its position.
 *  - A load watch: every 15 s the one-minute load average and the core count
 *    are sampled. Over the limit (`macBridge.loadLimit`, default 2 × cores)
 *    every new command and job is held, whatever its host; they resume once
 *    the load is back under three quarters of the limit (1.5 × cores by
 *    default), so a load bouncing around the limit does not flap the queue.
 *  - Per host, a cap on live computer sessions
 *    (`macBridge.maxComputer.<envId>`, default 2; contract-maccomputer.ts).
 *    A computer session is a running job too, so it counts toward the host's
 *    cap on commands and jobs as well; a command waiting behind a session the
 *    computer cap holds still starts when it fits.
 *  - A held call is not refused: the caller's tool result is delayed. It
 *    waits only as long as the call's own deadline allows (`until`), can be
 *    cancelled from the Mac (Stop on its row), and every change of standing
 *    (position, reason, the load figure) reaches the renderer through
 *    `onChange`.
 *
 * Pure: the sampler and the clock are injectable, and with `intervalMs: 0`
 * nothing ticks on its own (the tests call `sample()`).
 */

export interface LoadSample {
  /** os.loadavg()[0]: the one-minute load average. */
  load: number
  cores: number
}

export const osLoadSample = (): LoadSample => ({
  load: loadavg()[0] ?? 0,
  cores: Math.max(1, cpus().length)
})

export interface MacLoadGuardDeps {
  /** The host's cap on concurrent commands and jobs. */
  maxRunning: (envId: string) => number
  /** The host's cap on live computer sessions; MAC_BRIDGE_DEFAULT_MAX_COMPUTER when absent. */
  maxComputer?: (envId: string) => number
  /** `macBridge.loadLimit` when set by hand, else null for MAC_LOAD_LIMIT_PER_CORE × cores. */
  loadLimit: () => number | null
  sample?: () => LoadSample
  /** Between samples; 0 never samples on its own. */
  intervalMs?: number
  now?: () => number
  /** A held call's standing changed: its position, its reason or the load figure; or it was admitted (held is then null). */
  onChange?: (id: string, held: MacBridgeHeld | null) => void
  log?: (line: string) => void
}

/** How a hold ended: its turn came, the call's deadline passed first, or the Mac stopped it. */
export type HoldEnd = 'admitted' | 'expired' | 'cancelled'

/** What waits on the guard: a command or job, or a computer session (which is also a running job). */
export type HoldKind = 'job' | 'computer'

export type Admission =
  { admitted: true } | { admitted: false; held: MacBridgeHeld; done: Promise<HoldEnd> }

interface Waiter {
  id: string
  envId: string
  kind: HoldKind
  until: number
  held: MacBridgeHeld
  resolve: (end: HoldEnd) => void
  /** Ends the hold at `until`; none for a deadline too far to time (Infinity in tests). */
  timer: NodeJS.Timeout | null
}

const MAX_TIMER_MS = 0x7fffffff

/** The limit for a sample: the pinned one, else per core. */
export function loadLimitFor(sample: LoadSample, pinned: number | null): number {
  return pinned ?? MAC_LOAD_LIMIT_PER_CORE * sample.cores
}

/**
 * Busy after a sample, with hysteresis: over the limit becomes busy; busy
 * stays until the load is under MAC_LOAD_RESUME_FRACTION of the limit.
 */
export function nextBusy(wasBusy: boolean, load: number, limit: number): boolean {
  return wasBusy ? load >= limit * MAC_LOAD_RESUME_FRACTION : load > limit
}

export class MacLoadGuard {
  /** Request ids running per host (commands, jobs and computer sessions the bridge admitted). */
  private readonly running = new Map<string, Set<string>>()
  /** The computer sessions among them, per host. */
  private readonly computers = new Map<string, Set<string>>()
  /** Held calls per host, oldest first. */
  private readonly queues = new Map<string, Waiter[]>()
  private last: LoadSample & { at: number }
  private busy = false
  private timer: NodeJS.Timeout | null = null
  private readonly sampler: () => LoadSample
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly deps: MacLoadGuardDeps) {
    this.sampler = deps.sample ?? osLoadSample
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => {})
    const first = this.sampler()
    this.last = { ...first, at: this.now() }
    this.busy = nextBusy(false, first.load, loadLimitFor(first, deps.loadLimit()))
    const every = deps.intervalMs ?? MAC_LOAD_SAMPLE_MS
    if (every > 0) {
      this.timer = setInterval(() => this.sample(), every)
      this.timer.unref()
    }
  }

  /** Take a sample now, move the busy state through the hysteresis and let waiting calls go. */
  sample(): MacBridgeLoad {
    const s = this.sampler()
    this.last = { ...s, at: this.now() }
    const limit = loadLimitFor(s, this.deps.loadLimit())
    const was = this.busy
    this.busy = nextBusy(was, s.load, limit)
    if (this.busy !== was)
      this.log(
        this.busy
          ? `load ${s.load.toFixed(1)} over ${limit} on ${s.cores} cores: holding new commands and jobs`
          : `load ${s.load.toFixed(1)} under ${(limit * MAC_LOAD_RESUME_FRACTION).toFixed(1)}: releasing held calls`
      )
    this.drain()
    return this.status()
  }

  status(): MacBridgeLoad {
    const pinned = this.deps.loadLimit()
    const limit = loadLimitFor(this.last, pinned)
    return {
      load: this.last.load,
      cores: this.last.cores,
      limit,
      pinned: pinned !== null,
      resumeBelow: limit * MAC_LOAD_RESUME_FRACTION,
      busy: this.busy,
      sampledAt: this.last.at
    }
  }

  runningCount(envId: string): number {
    return this.running.get(envId)?.size ?? 0
  }

  /** Live computer sessions the host holds (they count in runningCount too). */
  computerCount(envId: string): number {
    return this.computers.get(envId)?.size ?? 0
  }

  heldCount(envId: string): number {
    return this.queues.get(envId)?.length ?? 0
  }

  heldOf(id: string): MacBridgeHeld | null {
    for (const q of this.queues.values()) {
      const w = q.find((x) => x.id === id)
      if (w) return w.held
    }
    return null
  }

  /** A setting changed (a cap, the limit): let go whatever now fits. */
  reconsider(): void {
    const limit = loadLimitFor(this.last, this.deps.loadLimit())
    // A lower limit can make the current load busy; a higher one releases at once.
    this.busy = this.last.load > limit ? true : nextBusy(this.busy, this.last.load, limit)
    this.drain()
  }

  /**
   * Admit an allowed command or job: at once when the Mac is under its limit
   * and the host under its cap, else after its turn. `until` is the call's
   * own deadline; past it the hold ends `expired`.
   */
  acquire(envId: string, id: string, until: number, kind: HoldKind = 'job'): Admission {
    if (this.fits(envId, kind)) {
      this.mark(envId, id, kind)
      return { admitted: true }
    }
    const queue = this.queues.get(envId) ?? []
    this.queues.set(envId, queue)
    let settle!: (end: HoldEnd) => void
    const done = new Promise<HoldEnd>((resolve) => (settle = resolve))
    const reason = this.reasonOf(envId, kind)
    const waiter: Waiter = {
      id,
      envId,
      kind,
      until,
      held: this.standing(envId, reason, 1 + queue.filter((w) => this.reasonOf(envId, w.kind) === reason).length),
      resolve: settle,
      timer: null
    }
    const delay = until - this.now()
    if (delay <= MAX_TIMER_MS) {
      waiter.timer = setTimeout(() => this.end(waiter, 'expired'), Math.max(0, delay))
      waiter.timer.unref()
    }
    queue.push(waiter)
    this.log(
      `${envId}: holding ${id} (${waiter.held.reason}; ${waiter.held.position} in line, load ${waiter.held.load.toFixed(1)} of ${waiter.held.limit}, ${waiter.held.running} of ${waiter.held.maxRunning} running)`
    )
    return { admitted: false, held: waiter.held, done }
  }

  /** Stop on a held row: it leaves the queue and its call fails as stopped. */
  cancel(id: string): boolean {
    for (const q of this.queues.values()) {
      const w = q.find((x) => x.id === id)
      if (w) {
        this.end(w, 'cancelled')
        return true
      }
    }
    return false
  }

  /** A command or job the guard admitted ended (whatever way): its slot is free. */
  release(id: string): void {
    for (const [envId, set] of this.computers) {
      if (set.delete(id) && set.size === 0) this.computers.delete(envId)
    }
    for (const [envId, set] of this.running) {
      if (set.delete(id)) {
        if (set.size === 0) this.running.delete(envId)
        this.drain()
        return
      }
    }
    // Never admitted (held and then expired or cancelled, or denied before the guard): nothing to free.
  }

  /** Every hold ends cancelled; the watch stops. */
  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const q of [...this.queues.values()]) for (const w of [...q]) this.end(w, 'cancelled')
    this.running.clear()
    this.computers.clear()
  }

  // ── inside ─────────────────────────────────────────────────────────

  private maxComputerOf(envId: string): number {
    return this.deps.maxComputer?.(envId) ?? MAC_BRIDGE_DEFAULT_MAX_COMPUTER
  }

  private computerFull(envId: string): boolean {
    return this.computerCount(envId) >= this.maxComputerOf(envId)
  }

  private fits(envId: string, kind: HoldKind): boolean {
    return (
      !this.busy &&
      this.runningCount(envId) < this.deps.maxRunning(envId) &&
      (kind !== 'computer' || !this.computerFull(envId))
    )
  }

  /** What holds a waiter of this kind now: the load, else the computer cap, else the host's cap. */
  private reasonOf(envId: string, kind: HoldKind): MacBridgeHeld['reason'] {
    if (this.busy) return 'load'
    return kind === 'computer' && this.computerFull(envId) ? 'computer' : 'cap'
  }

  private mark(envId: string, id: string, kind: HoldKind): void {
    const set = this.running.get(envId) ?? new Set<string>()
    set.add(id)
    this.running.set(envId, set)
    if (kind !== 'computer') return
    const own = this.computers.get(envId) ?? new Set<string>()
    own.add(id)
    this.computers.set(envId, own)
  }

  private standing(envId: string, reason: MacBridgeHeld['reason'], position: number): MacBridgeHeld {
    const limit = loadLimitFor(this.last, this.deps.loadLimit())
    return {
      reason,
      position,
      load: this.last.load,
      limit,
      cores: this.last.cores,
      maxRunning: this.deps.maxRunning(envId),
      running: this.runningCount(envId),
      ...(reason === 'computer' ? { computer: this.computerCount(envId), maxComputer: this.maxComputerOf(envId) } : {})
    }
  }

  private end(w: Waiter, how: HoldEnd): void {
    const queue = this.queues.get(w.envId)
    if (!queue) return
    const at = queue.indexOf(w)
    if (at < 0) return
    queue.splice(at, 1)
    if (queue.length === 0) this.queues.delete(w.envId)
    if (w.timer) clearTimeout(w.timer)
    if (how === 'admitted') this.mark(w.envId, w.id, w.kind)
    else this.log(`${w.envId}: ${w.id} ${how} after waiting`)
    w.resolve(how)
    this.deps.onChange?.(w.id, null)
    if (how !== 'admitted') this.restand(w.envId)
  }

  /**
   * Let go, in arrival order, every waiter whose own caps let it in (a
   * command behind a session the computer cap holds still starts); then tell
   * the rest where they stand.
   */
  private drain(): void {
    for (const [envId, queue] of [...this.queues]) {
      for (const w of [...queue]) if (this.fits(envId, w.kind)) this.end(w, 'admitted')
      this.restand(envId)
    }
  }

  /** Each waiter's standing: its reason, and its place among those ahead of it held by the same cap. */
  private restand(envId: string): void {
    const queue = this.queues.get(envId)
    if (!queue) return
    const ahead = new Map<MacBridgeHeld['reason'], number>()
    for (const w of queue) {
      const reason = this.reasonOf(envId, w.kind)
      const position = (ahead.get(reason) ?? 0) + 1
      ahead.set(reason, position)
      const next = this.standing(envId, reason, position)
      if (
        next.position !== w.held.position ||
        next.reason !== w.held.reason ||
        next.load !== w.held.load ||
        next.limit !== w.held.limit ||
        next.running !== w.held.running ||
        next.maxRunning !== w.held.maxRunning ||
        next.computer !== w.held.computer ||
        next.maxComputer !== w.held.maxComputer
      ) {
        w.held = next
        this.deps.onChange?.(w.id, next)
      }
    }
  }
}
