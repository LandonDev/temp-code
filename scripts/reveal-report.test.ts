import { describe, expect, it } from 'vitest'
import { revealLine, summarizeReveal, type RevealRecord } from './lib/revealReport'

describe('the reveal report', () => {
  it('counts the spans of one callback in one row as one step, and measures gaps within a row', () => {
    const records: RevealRecord[] = [
      { t: 0, row: 'a', chars: 30 },
      { t: 100, row: 'a', chars: 20 },
      { t: 100, row: 'a', chars: 12 }, // the same step, split by an emphasis
      { t: 210, row: 'a', chars: 35 },
      { t: 640, row: 'a', chars: 40 }, // a hold
      { t: 50, row: 'b', chars: 10 }, // another row: no gap to row a
      { t: 150, row: 'b', chars: 10 }
    ]
    const s = summarizeReveal(records, 100)
    expect(s.steps).toBe(6)
    expect(s.chars).toEqual({ p50: 32, p90: 40, max: 40 })
    expect(s.gapMs).toEqual({ p50: 110, p90: 430, max: 430 })
    expect(s.longGaps).toBe(1)
    expect(revealLine(s)).toBe('6 steps; gap p50 110 ms, p90 430 ms, max 430 ms; chars p50 32, p90 40, max 40; 1 gaps over two steps')
  })

  it('reads nothing as zeros', () => {
    expect(summarizeReveal([], 100)).toEqual({ steps: 0, gapMs: { p50: 0, p90: 0, max: 0 }, chars: { p50: 0, p90: 0, max: 0 }, longGaps: 0 })
  })
})
