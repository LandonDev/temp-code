import { describe, expect, it } from 'vitest'
import { guardOutcome, settledInResult } from './guardWord'

describe("the front guard's word", () => {
  it('takes a result that says how the steal ended', () => {
    const front = { raised: true, restored: 'restored' as const, ms: 61 }
    expect(settledInResult(front)).toBe(true)
    expect(guardOutcome(front, null)).toEqual(front)
  })
  it('waits for the notice while the restore was still running as the result went out', () => {
    expect(settledInResult({ raised: true })).toBe(false)
    expect(guardOutcome({ raised: true }, { raised: true, restored: 'restored', ms: 90 })).toEqual({ raised: true, restored: 'restored', ms: 90 })
    expect(guardOutcome({ raised: true }, null)).toEqual({ raised: true })
  })
  it('reads a steal after the result from the notice alone', () => {
    expect(guardOutcome({ raised: false }, { raised: true, restored: 'restored', ms: 40 })).toEqual({ raised: true, restored: 'restored', ms: 40 })
    expect(guardOutcome(undefined, null)).toBeNull()
  })
})
