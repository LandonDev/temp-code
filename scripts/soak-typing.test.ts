import { describe, expect, it } from 'vitest'
import { firstDifference, spread, summarizePhase, typingGaps, typingMarkdown, typingPhases, typingProse, type TypingRecords } from './lib/soakTyping'

const records = (over: Partial<TypingRecords> = {}): TypingRecords => ({
  keys: [],
  events: [],
  longTasks: [],
  frames: [],
  store: { flushes: 80, metaFlushes: 70, masterMetas: 10, liveEdits: 500 },
  windowMs: 10_000,
  ...over
})

describe('the typing scene', () => {
  it('types fewer keys on the gate, and skips the idle phase where nothing can pause the load', () => {
    expect(typingPhases(false, true).map((p) => [p.name, p.count, p.cadence])).toEqual([
      ['idle', 300, 'paced'],
      ['busy', 300, 'paced'],
      ['fast', 300, 'fast'],
      ['burst', 2_000, 'none'],
      ['paste', 2_000, 'none']
    ])
    expect(typingPhases(true, true).map((p) => p.count)).toEqual([100, 200, 100, 1_000, 2_000])
    expect(typingPhases(true, false).map((p) => p.name)).toEqual(['busy', 'fast', 'burst', 'paste'])
  })

  it('seeds its prose and its gaps: the same run types the same text at the same pace', () => {
    expect(typingProse(300)).toBe(typingProse(300))
    expect(typingProse(300)).toHaveLength(300)
    expect(typingProse(300, 8)).not.toBe(typingProse(300))
    // Plain prose: no newline (an Enter would send), no character the composer turns into a token.
    expect(typingProse(2_000)).toMatch(/^[A-Za-z ,.]+$/)
    const paced = typingGaps('paced', 500)
    expect(paced).toEqual(typingGaps('paced', 500))
    expect(Math.min(...paced)).toBeGreaterThanOrEqual(60)
    expect(Math.max(...paced)).toBeLessThanOrEqual(120)
    const fast = typingGaps('fast', 500)
    expect(Math.min(...fast)).toBeGreaterThanOrEqual(30)
    expect(Math.max(...fast)).toBeLessThanOrEqual(40)
    expect(typingGaps('none', 10)).toEqual(Array(10).fill(0))
  })

  it('reads percentiles by nearest rank', () => {
    const s = spread(Array.from({ length: 100 }, (_, i) => i + 1))
    expect(s).toEqual({ n: 100, p50: 50, p95: 95, p99: 99, max: 100 })
    expect(spread([])).toEqual({ n: 0, p50: null, p95: null, p99: null, max: null })
    expect(spread([3.14159, Number.NaN]).p50).toBe(3.1)
  })

  it('names the first character that differs', () => {
    expect(firstDifference('abc', 'abc')).toBeNull()
    expect(firstDifference('abcdef', 'abXdef')).toBe(2)
    expect(firstDifference('abcdef', 'abc')).toBe(3)
    expect(firstDifference('abc', 'abcd')).toBe(3)
  })

  it('sums a paced phase: latency to the next frame, input delay, events, long tasks, long frames and the store', () => {
    const keys = Array.from({ length: 100 }, (_, i) => ({ stamp: i * 100, handler: i * 100 + 2, frame: i === 99 ? null : i * 100 + 10 + (i % 10) }))
    const summary = summarizePhase(
      { name: 'busy', count: 100, cadence: 'paced' },
      records({
        keys,
        events: [
          { interactionId: 1, duration: 24 },
          { interactionId: 2, duration: 40 }
        ],
        longTasks: [
          { start: 1_000, duration: 60 },
          { start: 5_000, duration: 80 }
        ],
        frames: [{ start: 1_000, duration: 90, blocking: 40, scripts: [{ invoker: 'TimerHandler', fn: 'onPush', url: 'app://renderer/assets/index.js', duration: 70 }] }]
      }),
      'hello',
      'hello'
    )
    // A keystroke whose frame never came is left out of the latency, not counted as 0.
    expect(summary.frame).toEqual({ n: 99, p50: 14, p95: 19, p99: 19, max: 19 })
    expect(summary.inputDelay.p95).toBe(2)
    // Two of 100 keystrokes took 16 ms or more: the p95 is under 16.
    expect(summary.events).toEqual({ over16: 2, p95: null, max: 40 })
    expect(summary.longTasks).toEqual({ count: 2, totalMs: 140, maxMs: 80 })
    expect(summary.frames.worst).toEqual([{ duration: 90, scripts: ['onPush 70 ms (index.js)'] }])
    expect(summary.store).toEqual({ flushesPerS: 8, metaFlushesPerS: 7, masterMetasPerS: 1, liveEditsPerS: 50 })
    expect(summary.text).toEqual({ ok: true, firstDifference: null, expected: 5, actual: 5 })
  })

  it('a paste has no keystroke readings, and a wrong text says where', () => {
    const summary = summarizePhase({ name: 'paste', count: 2_000, cadence: 'none' }, records(), 'abcdef', 'abXdef')
    expect(summary.frame.n).toBe(0)
    expect(summary.text).toEqual({ ok: false, firstDifference: 2, expected: 6, actual: 6 })
    const md = typingMarkdown([summary])
    expect(md[2]).toContain('| paste | 2000 |')
    expect(md[2]).toContain('differs at 2 (6 of 6)')
  })
})
