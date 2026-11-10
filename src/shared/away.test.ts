import { describe, expect, it } from 'vitest'
import { AWAY_DENIED_KINDS, awayAllowsKind } from './away'
import { HOST_CONFIRM_KINDS } from './computer/policy'

describe('awayAllowsKind', () => {
  it('denies only the kinds that spend money', () => {
    const denied = HOST_CONFIRM_KINDS.filter((kind) => !awayAllowsKind(kind))
    expect(denied).toEqual(['pay', 'subscribe'])
    expect([...AWAY_DENIED_KINDS]).toEqual(['pay', 'subscribe'])
  })

  it('allows a password field and an unflagged act', () => {
    expect(awayAllowsKind('password')).toBe(true)
    expect(awayAllowsKind(undefined)).toBe(true)
    expect(awayAllowsKind(null)).toBe(true)
  })
})
