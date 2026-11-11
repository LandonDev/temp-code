import { describe, expect, it } from 'vitest'
import { isThrashing, recentCompactions, THRASH } from './contextThrash'

const min = 60_000

describe('isThrashing', () => {
  it('lets three compactions inside ten minutes be', () => {
    expect(isThrashing([0, 2 * min, 4 * min], 4 * min)).toBe(false)
  })

  it('calls four inside ten minutes thrash', () => {
    expect(isThrashing([0, 1 * min, 2 * min, 3 * min], 3 * min)).toBe(true)
  })

  it('lets four spread over eleven minutes be', () => {
    expect(isThrashing([0, 4 * min, 8 * min, 11 * min], 11 * min)).toBe(false)
    expect(recentCompactions([0, 4 * min, 8 * min, 11 * min], 11 * min)).toEqual([4 * min, 8 * min, 11 * min])
  })

  it('counts a compaction exactly ten minutes old, and not one a moment older', () => {
    expect(isThrashing([0, 3 * min, 6 * min, THRASH.withinMs], THRASH.withinMs)).toBe(true)
    expect(isThrashing([0, 3 * min, 6 * min, THRASH.withinMs + 1], THRASH.withinMs + 1)).toBe(false)
  })
})

describe('contextThrashRow', () => {
  it('writes the row the classifier reads back', async () => {
    const { contextThrashRow, parseContextThrashRow } = await import('./contextThrash')
    const row = contextThrashRow(4, 6 * min, { tokens: 167_400, window: 200_000 })
    expect(row).toBe('context thrash: 4 compactions in 6 min; first request 167k of 200k')
    expect(parseContextThrashRow(row)).toEqual({ count: 4, minutes: 6, first: '167k', window: '200k' })
    expect(contextThrashRow(4, 20_000, null)).toBe('context thrash: 4 compactions in 1 min')
    expect(parseContextThrashRow('turn ended: error_max_turns')).toBeNull()
  })
})
