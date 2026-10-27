/**
 * Always-on stall recorder for the main process. One short line per
 * stall in `<userData>/logs/stalls.log` (rotated once to `stalls.log.1`
 * at 2 MB), so an intermittent freeze is diagnosable after the fact:
 *
 *   - `loop`: the event loop was blocked ≥ STALL_MS in the last second
 *     (monitorEventLoopDelay, sampled once a second)
 *   - `timed`: a known synchronous section ran ≥ TIMED_MS
 *   - `checkpoint`: the checkpoint worker (dbWorkers.ts) copied a WAL into
 *     its file for ≥ TIMED_MS; off the loop, but the disk time shows here
 *   - `slow-request`: a WS request took longer than the boot log's cap
 *   - `[renderer] …`: a line the renderer sent through `stall.report`
 *
 * Every server line carries the requests in flight (method + age), the
 * pushes sent in the last second, the running thread count, loadavg, RSS,
 * the most unsent bytes on a socket and the bulk lane (lane.ts) as
 * `lane=bulk:<running>/<held>`. Cost: two integer counters, one Map entry per in-flight request,
 * one histogram read a second. Nothing allocates per event.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadavg } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { InFlightRequest, LoopLag } from '@shared/contract'

export const STALL_MS = 150
export const TIMED_MS = 50
const ROTATE_BYTES = 2 * 1024 * 1024
const SAMPLE_MS = 1000
export const DEFAULT_IDLE_THRESHOLD_MS = 50
export const DEFAULT_IDLE_MAX_WAIT_MS = 2000
const EWMA_ALPHA = 1 / 10
let lag: LoopLag = { meanMs: 0, maxMs: 0, ewmaMs: 0 }
let testLag: LoopLag | null = null

export function currentLag(): LoopLag {
  return { ...(testLag ?? lag) }
}

export function setLagForTests(sample: LoopLag | null): void {
  testLag = sample
}

export async function untilLoopIdle(opts: { thresholdMs?: number; maxWaitMs?: number } = {}): Promise<void> {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS
  const deadline = performance.now() + (opts.maxWaitMs ?? DEFAULT_IDLE_MAX_WAIT_MS)
  while (currentLag().meanMs >= thresholdMs) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) return
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remaining)))
  }
}

/** A background job's pause between slices: one turn of the loop (sockets
 *  and timers run), then untilLoopIdle, so a walk or a move never takes the
 *  loop from a person's request while it lags. */
export async function yieldUntilIdle(opts: { thresholdMs?: number; maxWaitMs?: number } = {}): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await untilLoopIdle(opts)
}

/** Run a host job now when the loop keeps up, else once it is quiet (or
 *  the wait bound passed): a timer's sweep or save never lands on a busy loop. */
export function whenLoopIdle(fn: () => void, opts: { thresholdMs?: number; maxWaitMs?: number } = {}): void {
  if (currentLag().meanMs < (opts.thresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS)) {
    fn()
    return
  }
  void untilLoopIdle(opts).then(fn)
}

let file: string | null = null
let runningCount: () => number = () => 0
let bufferedBytes: () => number = () => 0
let laneStats: () => { running: number; held: number } = () => ({ running: 0, held: 0 })
const inFlight = new Map<string, { method: string; startedAt: number }>()
const pushes = { meta: 0, event: 0 }
/** The last second's meta pushes by producer (notifyMeta's tag) and the distinct sessions they named. */
const metaProducers = new Map<string, number>()
const metaIds = new Set<string>()

/** Where stall lines go; `null` (tests, no data dir) disables the recorder. */
export function setStallLog(logDir: string | null): void {
  file = logDir ? join(logDir, 'stalls.log') : null
}

/** How many threads are live right now; asked only when a line is written. */
export function setRunningCount(fn: () => number): void {
  runningCount = fn
}

/** The most bytes any client socket holds unsent (`ws.bufferedAmount`);
 *  the `wsbuf=` field. A renderer that cannot drain its socket shows here
 *  while every request still reads as served (2026-10-17: a full kernel
 *  send queue behind an idle server). */
export function setBufferedBytes(fn: () => number): void {
  bufferedBytes = fn
}

/** The bulk lane's requests running and waiting (lane.ts); the `lane=` field. */
export function setLaneStats(fn: () => { running: number; held: number }): void {
  laneStats = fn
}

/** Unsent bytes past which a socket's connection logs one `backpressure` line. */
export const BACKPRESSURE_BYTES = 8 * 1024 * 1024

export function recordBackpressure(connection: number, bytes: number): void {
  write(`backpressure connection=${connection} unsent=${Math.round(bytes / 1024)}KB`)
}

/** A request the socket handler is working on: `key` is unique per connection + id. */
export function trackRequest(key: string, method: string): void {
  inFlight.set(key, { method, startedAt: Date.now() })
}

export function untrackRequest(key: string): void {
  inFlight.delete(key)
}

export function inFlightRequests(): InFlightRequest[] {
  const now = Date.now()
  return [...inFlight.values()].map((r) => ({ method: r.method, ageMs: now - r.startedAt }))
}

/** One push frame went out; the loop line reports the last second's totals.
 *  A meta push names its producer (the registry's tag: `status`, `accounts`,
 *  …) and the session, so a storm reads `meta:4038/781ids(accounts:3900,status:138)`:
 *  how many frames, for how many threads, from which code. */
export function countPush(kind: 'meta' | 'event', producer?: string, sessionId?: string): void {
  pushes[kind] += 1
  if (kind !== 'meta') return
  if (producer) metaProducers.set(producer, (metaProducers.get(producer) ?? 0) + 1)
  if (sessionId) metaIds.add(sessionId)
}

/** The `pushes=` field: totals, and the meta breakdown when one was tagged. */
export function pushesField(): string {
  let meta = `meta:${pushes.meta}`
  if (metaIds.size > 0 || metaProducers.size > 0) {
    const by = [...metaProducers.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([producer, n]) => `${producer}:${n}`)
      .join(',')
    meta += `/${metaIds.size}ids${by ? `(${by})` : ''}`
  }
  return `pushes=${meta},event:${pushes.event}`
}

/** Test seam: the counters a tick would clear. */
export function resetPushesForTests(): void {
  resetPushes()
}

function resetPushes(): void {
  pushes.meta = 0
  pushes.event = 0
  metaProducers.clear()
  metaIds.clear()
}

/** A send's phase line (sendSpans.ts): the send-time picture rides with it. */
export function recordSendSpan(body: string): void {
  write(body)
}

/** Runs `fn` and logs it when it held the loop for TIMED_MS or more. */
export function timed<T>(label: string, fn: () => T): T {
  const startedAt = performance.now()
  try {
    return fn()
  } finally {
    const ms = performance.now() - startedAt
    if (ms >= TIMED_MS) write(`timed ${label} ${Math.round(ms)}ms`)
  }
}

/** A WAL checkpoint the worker ran: logged when it took TIMED_MS or more. */
export function recordCheckpoint(schema: string, frames: number, ms: number): void {
  if (ms >= TIMED_MS) write(`checkpoint schema=${schema} frames=${frames} ms=${Math.round(ms)}`)
}

export function recordSlowRequest(method: string, ms: number): void {
  write(`slow-request ${method} ${ms}ms`)
}

/** A stall the renderer measured; its line already carries its own context. */
export function reportRendererStall(line: string): void {
  write(`[renderer] ${line.replace(/[\r\n]+/g, ' ').slice(0, 2000)}`, false)
}

/** The `loop` line for one histogram sample, or null when the loop kept up. */
export function loopLine(sample: { max: number; mean: number }): string | null {
  const max = Math.round(sample.max / 1e6)
  if (max < STALL_MS) return null
  return `loop max=${max}ms mean=${Math.round(sample.mean / 1e6)}ms`
}

/**
 * Samples the loop delay once a second for the life of the process.
 * Returns the stop function; the timer is unref'd so it never holds exit.
 */
export function startStallMonitor(): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 })
  lag = { meanMs: 0, maxMs: 0, ewmaMs: 0 }
  histogram.enable()
  const timer = setInterval(() => {
    // The last second's mean and max, read before the reset; the EWMA folds
    // each second in with weight 1/10, so it follows the last ~10 s.
    const meanMs = Number.isFinite(histogram.mean) ? histogram.mean / 1e6 : 0
    lag = {
      meanMs,
      maxMs: histogram.max / 1e6,
      ewmaMs: lag.ewmaMs + EWMA_ALPHA * (meanMs - lag.ewmaMs)
    }
    const line = loopLine({ max: histogram.max, mean: histogram.mean })
    histogram.reset()
    if (line) write(line)
    resetPushes()
  }, SAMPLE_MS)
  timer.unref()
  return () => {
    clearInterval(timer)
    histogram.disable()
    lag = { meanMs: 0, maxMs: 0, ewmaMs: 0 }
  }
}

/** The state suffix every server line ends with. */
export function context(): string {
  const requests = inFlightRequests()
    .map((r) => `${r.method}:${r.ageMs}ms`)
    .slice(0, 12)
    .join(',')
  let running = 0
  try {
    running = runningCount()
  } catch {
    // context is best effort
  }
  const rss = Math.round(process.memoryUsage.rss() / 1048576)
  let wsbuf = 0
  try {
    wsbuf = Math.round(bufferedBytes() / 1024)
  } catch {
    // context is best effort
  }
  let lane = '0/0'
  try {
    const { running: bulkRunning, held } = laneStats()
    lane = `${bulkRunning}/${held}`
  } catch {
    // context is best effort
  }
  return `inflight=${requests || '-'} ${pushesField()} running=${running} load=${loadavg()[0].toFixed(1)} rss=${rss}MB wsbuf=${wsbuf}KB lane=bulk:${lane}`
}

function write(body: string, withContext = true): void {
  const target = file
  if (!target) return
  const line = `${new Date().toISOString()} ${body}${withContext ? ` ${context()}` : ''}\n`
  try {
    mkdirSync(join(target, '..'), { recursive: true })
    let size = 0
    try {
      size = statSync(target).size
    } catch {
      // first line
    }
    if (size >= ROTATE_BYTES) renameSync(target, `${target}.1`)
    appendFileSync(target, line)
  } catch {
    // diagnostics never fail the app
  }
}
