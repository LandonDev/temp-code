import { describe, expect, it } from 'vitest'
import { FailureSchema } from './events'
import { fallbackFailure } from './failureFallback'

describe('fallbackFailure', () => {
  it('is an unknown failure with two plain lines and no account', () => {
    const f = fallbackFailure()
    expect(FailureSchema.parse(f)).toEqual(f)
    expect(f).toEqual({
      kind: 'unknown',
      account: null,
      summary: 'The turn ended before it finished',
      cause: 'The harness gave no reason.'
    })
  })
  it('hands out a fresh object each time', () => {
    expect(fallbackFailure()).not.toBe(fallbackFailure())
  })
})
