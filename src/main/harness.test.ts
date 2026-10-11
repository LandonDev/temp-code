import { describe, expect, it } from 'vitest'
import { applyHarness, pickHarness } from './harness'

describe('harness overrides', () => {
  it('keeps only the known keys with string values', () => {
    expect(
      pickHarness({
        TEMP_CODE_USER_DATA: '/tmp/x/userData',
        TEMP_CODE_DEBUG_PORT: 9230,
        TEMP_CODE_UPDATE_FEED: ' http://127.0.0.1:9231/ ',
        OTHER: 'no'
      })
    ).toEqual({ TEMP_CODE_USER_DATA: '/tmp/x/userData', TEMP_CODE_UPDATE_FEED: 'http://127.0.0.1:9231/' })
    expect(pickHarness(undefined)).toEqual({})
    expect(pickHarness('nope')).toEqual({})
  })

  it('fills the environment without overriding what is already set', () => {
    const env: NodeJS.ProcessEnv = { TEMP_CODE_USER_DATA: '/env/userData' }
    applyHarness(env, { TEMP_CODE_USER_DATA: '/baked/userData', TEMP_CODE_DEBUG_PORT: '9230' })
    expect(env).toEqual({ TEMP_CODE_USER_DATA: '/env/userData', TEMP_CODE_DEBUG_PORT: '9230' })
  })
})
