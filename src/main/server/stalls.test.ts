import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BACKPRESSURE_BYTES,
  countPush,
  currentLag,
  DEFAULT_IDLE_MAX_WAIT_MS,
  DEFAULT_IDLE_THRESHOLD_MS,
  inFlightRequests,
  loopLine,
  recordBackpressure,
  recordCheckpoint,
  recordSlowRequest,
  reportRendererStall,
  setBufferedBytes,
  setLaneStats,
  setRunningCount,
  setStallLog,
  setLagForTests,
  startStallMonitor,
  STALL_MS,
  timed,
  TIMED_MS,
  trackRequest,
  untrackRequest,
  untilLoopIdle,
  whenLoopIdle,
  yieldUntilIdle
} from './stalls'

let dir: string
const log = (): string => readFileSync(join(dir, 'stalls.log'), 'utf8')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stalls-'))
  setStallLog(dir)
  setRunningCount(() => 3)
})

afterEach(() => {
  vi.useRealTimers()
  setLagForTests(null)
  setStallLog(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('loop lag', () => {
  it('returns zeros without a monitor', () => {
    expect(currentLag()).toEqual({ meanMs: 0, maxMs: 0, ewmaMs: 0 })
  })

  it('reports a busy section in the last second', async () => {
    const stop = startStallMonitor()
    try {
      await new Promise((resolve) => setTimeout(resolve, 60))
      spin(120)
      await new Promise((resolve) => setTimeout(resolve, 1100))
      expect(currentLag().maxMs).toBeGreaterThanOrEqual(100)
      expect(currentLag().meanMs).toBeGreaterThan(0)
      expect(currentLag().ewmaMs).toBeGreaterThan(0)
    } finally {
      stop()
    }
    expect(currentLag()).toEqual({ meanMs: 0, maxMs: 0, ewmaMs: 0 })
  })

  it('returns every in-flight request with its age without exposing the map', () => {
    vi.useFakeTimers()
    for (let i = 0; i < 14; i++) trackRequest(`lag:${i}`, 'git.status')
    try {
      vi.advanceTimersByTime(1200)
      const requests = inFlightRequests()
      expect(requests).toHaveLength(14)
      expect(requests[0]).toEqual({ method: 'git.status', ageMs: 1200 })
      requests[0].method = 'changed'
      expect(inFlightRequests()[0].method).toBe('git.status')
    } finally {
      for (let i = 0; i < 14; i++) untrackRequest(`lag:${i}`)
    }
  })

  it('resolves at once below the default threshold', async () => {
    vi.useFakeTimers()
    setLagForTests({ meanMs: DEFAULT_IDLE_THRESHOLD_MS - 1, maxMs: 120, ewmaMs: 80 })
    await untilLoopIdle()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('polls until lag drops below the chosen threshold', async () => {
    vi.useFakeTimers()
    setLagForTests({ meanMs: 30, maxMs: 100, ewmaMs: 50 })
    let done = false
    const wait = untilLoopIdle({ thresholdMs: 30 }).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(100)
    expect(done).toBe(false)
    setLagForTests({ meanMs: 29, maxMs: 100, ewmaMs: 50 })
    await vi.advanceTimersByTimeAsync(50)
    await wait
    expect(done).toBe(true)
  })

  it('a host job runs at once on a quiet loop and waits for quiet on a busy one', async () => {
    vi.useFakeTimers()
    const ran: string[] = []
    whenLoopIdle(() => ran.push('quiet'))
    expect(ran).toEqual(['quiet'])
    setLagForTests({ meanMs: 80, maxMs: 200, ewmaMs: 60 })
    whenLoopIdle(() => ran.push('busy'))
    await vi.advanceTimersByTimeAsync(500)
    expect(ran).toEqual(['quiet'])
    setLagForTests({ meanMs: 5, maxMs: 20, ewmaMs: 30 })
    await vi.advanceTimersByTimeAsync(50)
    expect(ran).toEqual(['quiet', 'busy'])
  })

  it('a background slice gives the loop a turn even when it is quiet', async () => {
    let turned = false
    setImmediate(() => (turned = true))
    await yieldUntilIdle()
    expect(turned).toBe(true)
  })

  it('resolves at the wait bound even while lag stays high', async () => {
    vi.useFakeTimers()
    setLagForTests({ meanMs: 90, maxMs: 200, ewmaMs: 80 })
    for (const maxWaitMs of [125, DEFAULT_IDLE_MAX_WAIT_MS]) {
      let done = false
      const wait = untilLoopIdle(maxWaitMs === 125 ? { maxWaitMs } : undefined).then(() => { done = true })
      await vi.advanceTimersByTimeAsync(maxWaitMs - 1)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await wait
      expect(done).toBe(true)
    }
  })
})

const spin = (ms: number): void => {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // hold the thread
  }
}

describe('stall recorder', () => {
  it('writes a loop line only when the sampled max reaches the threshold', () => {
    expect(loopLine({ max: (STALL_MS - 1) * 1e6, mean: 1e6 })).toBeNull()
    expect(loopLine({ max: 312e6, mean: 40e6 })).toBe('loop max=312ms mean=40ms')
  })

  it('a slow request line carries the in-flight requests, pushes, running count, load and rss', () => {
    trackRequest('1:7', 'session.events')
    countPush('meta')
    countPush('meta')
    countPush('event')
    recordSlowRequest('queue.list', 812)
    untrackRequest('1:7')
    const line = log().trim()
    expect(line).toMatch(/^\d{4}-\d\d-\d\dT[^ ]+ slow-request queue\.list 812ms inflight=session\.events:\d+ms pushes=meta:2,event:1 running=3 load=\d+\.\d rss=\d+MB wsbuf=0KB lane=bulk:0\/0$/)
  })

  it('the context carries the most unsent bytes on any client socket, and a backpressure line names the connection', () => {
    setBufferedBytes(() => 9 * 1024 * 1024)
    recordBackpressure(2, 9 * 1024 * 1024)
    setBufferedBytes(() => 0)
    const line = log().trim()
    expect(line).toMatch(/ backpressure connection=2 unsent=9216KB inflight=- pushes=meta:\d+,event:\d+ running=3 load=\d+\.\d rss=\d+MB wsbuf=9216KB lane=bulk:0\/0$/)
    expect(BACKPRESSURE_BYTES).toBe(8 * 1024 * 1024)
  })

  it('the context names the bulk lane\'s requests running and waiting', () => {
    setLaneStats(() => ({ running: 2, held: 7 }))
    recordSlowRequest('git.diffStats', 900)
    setLaneStats(() => ({ running: 0, held: 0 }))
    expect(log().trim()).toMatch(/ slow-request git\.diffStats 900ms .* wsbuf=\d+KB lane=bulk:2\/7$/)
  })

  it('a worker checkpoint at or over the threshold writes a checkpoint line with the context', () => {
    recordCheckpoint('main', 40, TIMED_MS - 1)
    expect(existsSync(join(dir, 'stalls.log'))).toBe(false)
    recordCheckpoint('cold', 1547, 81.6)
    expect(log().trim()).toMatch(/ checkpoint schema=cold frames=1547 ms=82 inflight=- pushes=meta:\d+,event:\d+ running=3 load=/)
  })

  it('timed logs a section at or over the threshold and returns its value', () => {
    expect(timed('fast', () => 1)).toBe(1)
    expect(existsSync(join(dir, 'stalls.log'))).toBe(false)
    expect(timed('mirrorSession', () => { spin(TIMED_MS + 10); return 'done' })).toBe('done')
    expect(log()).toMatch(/ timed mirrorSession \d+ms inflight=/)
  })

  it('renderer lines are prefixed and kept to one line without server context', () => {
    reportRendererStall('longtask 320ms switch=tab-switch:abc\nextra')
    const line = log().trim()
    expect(line).toMatch(/ \[renderer\] longtask 320ms switch=tab-switch:abc extra$/)
    expect(line).not.toContain('inflight=')
  })

  it('rotates the file to stalls.log.1 once it reaches 2 MB', () => {
    writeFileSync(join(dir, 'stalls.log'), 'x'.repeat(2 * 1024 * 1024))
    recordSlowRequest('session.list', 900)
    expect(readFileSync(join(dir, 'stalls.log.1'), 'utf8').length).toBe(2 * 1024 * 1024)
    expect(log()).toContain('slow-request session.list 900ms')
  })

  it('does nothing without a log dir', () => {
    setStallLog(null)
    recordSlowRequest('session.list', 900)
    expect(existsSync(join(dir, 'stalls.log'))).toBe(false)
  })
})
