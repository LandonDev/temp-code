/**
 * Always-on stall recorder for the main process. One short line per
 * stall in `<userData>/logs/stalls.log` (rotated once to `stalls.log.1`
 * at 2 MB), so an intermittent freeze is diagnosable after the fact:
 *
 *   - `loop`: the event loop was blocked ≥ STALL_MS in the last second
 *     (monitorEventLoopDelay, sampled once a second)
 *   - `timed`: a known synchronous section ran ≥ TIMED_MS
 *   - `slow-request`: a WS request took longer than the boot log's cap
 *   - `[renderer] …`: a line the renderer sent through `stall.report`
 *
 * Every server line carries the requests in flight (method + age), the
 * pushes sent in the last second, the running thread count, loadavg and
 * RSS. Cost: two integer counters, one Map entry per in-flight request,
 * one histogram read a second. Nothing allocates per event.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadavg } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'

export const STALL_MS = 150
export const TIMED_MS = 50
const ROTATE_BYTES = 2 * 1024 * 1024
const SAMPLE_MS = 1000

let file: string | null = null
let runningCount: () => number = () => 0
const inFlight = new Map<string, { method: string; startedAt: number }>()
const pushes = { meta: 0, event: 0 }

/** Where stall lines go; `null` (tests, no data dir) disables the recorder. */
export function setStallLog(logDir: string | null): void {
  file = logDir ? join(logDir, 'stalls.log') : null
}

/** How many threads are live right now; asked only when a line is written. */
export function setRunningCount(fn: () => number): void {
  runningCount = fn
}

/** A request the socket handler is working on: `key` is unique per connection + id. */
export function trackRequest(key: string, method: string): void {
  inFlight.set(key, { method, startedAt: Date.now() })
}

export function untrackRequest(key: string): void {
  inFlight.delete(key)
}

/** One push frame went out; the loop line reports the last second's totals. */
export function countPush(kind: 'meta' | 'event'): void {
  pushes[kind] += 1
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
  histogram.enable()
  const timer = setInterval(() => {
    const line = loopLine({ max: histogram.max, mean: histogram.mean })
    histogram.reset()
    if (line) write(line)
    pushes.meta = 0
    pushes.event = 0
  }, SAMPLE_MS)
  timer.unref()
  return () => {
    clearInterval(timer)
    histogram.disable()
  }
}

/** The state suffix every server line ends with. */
export function context(): string {
  const now = Date.now()
  const requests = [...inFlight.values()]
    .map((r) => `${r.method}:${now - r.startedAt}ms`)
    .slice(0, 12)
    .join(',')
  let running = 0
  try {
    running = runningCount()
  } catch {
    // context is best effort
  }
  const rss = Math.round(process.memoryUsage.rss() / 1048576)
  return `inflight=${requests || '-'} pushes=meta:${pushes.meta},event:${pushes.event} running=${running} load=${loadavg()[0].toFixed(1)} rss=${rss}MB`
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
