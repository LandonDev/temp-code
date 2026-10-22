import { createHash } from 'node:crypto'
import type { ClientRequest } from '@shared/contract'
import { METHOD_CAPABILITY } from '@shared/capabilities'
import { currentLag } from './stalls'

/**
 * Request classes and the gate that orders them (attach() in index.ts, after
 * the capability gate):
 *   - `interactive`: a request naming a thread someone is looking at
 *     (focus.ts: its log, sends, queue, notes, checkpoint state, a focused
 *     master's batch), or one the renderer marked `lane: 'ui'` (a person's
 *     click: send, approve, answer, stop, pause, resume, start now, archive);
 *   - `bulk`: the polls and walks nobody waits on second by second: the git
 *     status reads, an unfocused thread's checkpoint state, the searches,
 *     the command list, GitHub, thread resources, the doctor, file watches,
 *     and the deploy, publish and sync methods;
 *   - `normal`: everything else.
 * Interactive and normal run at once. Bulk runs at most BULK_RUNNING at a
 * time per host and only while the loop keeps up (`currentLag().meanMs`
 * under BULK_LAG_MS); otherwise it waits in a FIFO, and a duplicate of a
 * request waiting or running (same method and params) joins it and gets
 * its answer: five windows polling one cwd's git status cost one run. Only
 * a read joins (from any socket); a write or a per-socket subscription
 * always runs, in its turn, so a subscribe, unsubscribe, subscribe never
 * loses the last one. Nothing waits past BULK_MAX_WAIT_MS.
 */

export type Lane = 'interactive' | 'normal' | 'bulk'

/** What the classifier asks the interactive set (focus.ts). */
export interface InteractiveSet {
  isInteractive(sessionId: string): boolean
}

export const BULK_RUNNING = 2
export const BULK_LAG_MS = 50
export const BULK_MAX_WAIT_MS = 20_000
const BULK_POLL_MS = 50

const BULK_METHODS: ReadonlySet<string> = new Set([
  // The git status reads the changes panel and the rail poll.
  'project.changes',
  'git.diffStats',
  'git.diffIndex',
  'checkpoint.status',
  'search.project',
  'session.search',
  'commands.list',
  'doctor.get',
  'fs.watch',
  'host.deploy',
  'host.deployStatus',
  'host.publish',
  'host.publishStatus',
  'harness.manifest',
  'harness.file',
  'harness.commit',
  'harness.status',
  'harness.sync',
  'memory.exchange',
  'memory.files',
  'memory.status',
  'memory.sync',
  'accounts.sync'
])
const BULK_PREFIXES = ['github.', 'resources.']

/** Subscriptions kept per socket: a duplicate from another socket must run for that socket. */
const PER_SOCKET: ReadonlySet<string> = new Set(['fs.watch'])

/** The thread a request names, when it names one. */
function namedSession(req: ClientRequest): string | null {
  const params = 'params' in req ? (req.params as Record<string, unknown> | undefined) : undefined
  if (!params || typeof params !== 'object') return null
  if (typeof params.sessionId === 'string') return params.sessionId
  // A master's batch (batch.get, batch.children, …) names the master.
  if (req.method.startsWith('batch.') && typeof params.masterId === 'string') return params.masterId
  return null
}

function isBulkMethod(method: string): boolean {
  return BULK_METHODS.has(method) || BULK_PREFIXES.some((prefix) => method.startsWith(prefix))
}

export function laneOf(req: ClientRequest, interactive: InteractiveSet): Lane {
  const sessionId = namedSession(req)
  if (sessionId !== null && interactive.isInteractive(sessionId)) return 'interactive'
  if (req.lane === 'ui') return 'interactive'
  return isBulkMethod(req.method) ? 'bulk' : 'normal'
}

/** The join key of a bulk request: its method and a digest of its params,
 *  for a read every socket may share; null for anything else (never joins). */
export function bulkKey(req: ClientRequest): string | null {
  if (METHOD_CAPABILITY[req.method] !== 'read' || PER_SOCKET.has(req.method)) return null
  const params = 'params' in req ? JSON.stringify(req.params ?? null) : 'null'
  const digest = params.length > 64 ? createHash('sha1').update(params).digest('base64') : params
  return `${req.method}\0${digest}`
}

interface Entry {
  key: string | null
  enqueuedAt: number
  run: () => Promise<unknown>
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

export interface LaneGateOptions {
  maxRunning?: number
  lagMs?: number
  maxWaitMs?: number
  /** The loop's lag now (stalls.ts by default). */
  lag?: () => number
  now?: () => number
}

/** The host's bulk lane: see the file's comment. One per server. */
export class LaneGate {
  private readonly waiting: Entry[] = []
  private readonly byKey = new Map<string, Entry>()
  private running = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly maxRunning: number
  private readonly lagMs: number
  private readonly maxWaitMs: number
  private readonly lag: () => number
  private readonly now: () => number
  /** Requests that joined one already waiting or running, since the gate was made. */
  joins = 0

  constructor(options: LaneGateOptions = {}) {
    this.maxRunning = options.maxRunning ?? BULK_RUNNING
    this.lagMs = options.lagMs ?? BULK_LAG_MS
    this.maxWaitMs = options.maxWaitMs ?? BULK_MAX_WAIT_MS
    this.lag = options.lag ?? (() => currentLag().meanMs)
    this.now = options.now ?? (() => Date.now())
  }

  /** Run `task` in its lane: at once unless bulk; a bulk duplicate of `key`
   *  shares the first one's outcome, and a null key never joins. */
  run<T>(lane: Lane, key: string | null, task: () => Promise<T>): Promise<T> {
    if (lane !== 'bulk') return task()
    const known = key === null ? undefined : this.byKey.get(key)
    if (known) {
      this.joins++
      return known.promise as Promise<T>
    }
    let resolve!: (value: unknown) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res
      reject = rej
    })
    const entry: Entry = { key, enqueuedAt: this.now(), run: task, promise, resolve, reject }
    if (key !== null) this.byKey.set(key, entry)
    this.waiting.push(entry)
    this.pump()
    return promise as Promise<T>
  }

  /** Bulk requests running and waiting, for the stall line. */
  stats(): { running: number; held: number } {
    return { running: this.running, held: this.waiting.length }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Start what may start, in order; the head that may not holds the rest. */
  private pump(): void {
    const now = this.now()
    while (this.waiting.length > 0) {
      const head = this.waiting[0]
      const overdue = now - head.enqueuedAt >= this.maxWaitMs
      if (!overdue && (this.running >= this.maxRunning || this.lag() >= this.lagMs)) break
      this.waiting.shift()
      this.start(head)
    }
    if (this.waiting.length === 0 || this.timer) return
    // Blocked by the lag or the cap: look again soon, and by the head's deadline at the latest.
    const untilDue = this.waiting[0].enqueuedAt + this.maxWaitMs - now
    this.timer = setTimeout(
      () => {
        this.timer = null
        this.pump()
      },
      Math.max(0, Math.min(BULK_POLL_MS, untilDue))
    )
    this.timer.unref?.()
  }

  private start(entry: Entry): void {
    this.running++
    let settled: Promise<unknown>
    try {
      settled = entry.run()
    } catch (error) {
      settled = Promise.reject(error)
    }
    settled.then(entry.resolve, entry.reject).finally(() => {
      this.running--
      if (entry.key !== null) this.byKey.delete(entry.key)
      this.pump()
    })
  }
}
