import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  countPush,
  loopLine,
  recordSlowRequest,
  reportRendererStall,
  setRunningCount,
  setStallLog,
  STALL_MS,
  timed,
  TIMED_MS,
  trackRequest,
  untrackRequest
} from './stalls'

let dir: string
const log = (): string => readFileSync(join(dir, 'stalls.log'), 'utf8')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stalls-'))
  setStallLog(dir)
  setRunningCount(() => 3)
})

afterEach(() => {
  setStallLog(null)
  rmSync(dir, { recursive: true, force: true })
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
    expect(line).toMatch(/^\d{4}-\d\d-\d\dT[^ ]+ slow-request queue\.list 812ms inflight=session\.events:\d+ms pushes=meta:2,event:1 running=3 load=\d+\.\d rss=\d+MB$/)
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
