import { describe, expect, it } from 'vitest'
import { computerPinFromEnv } from './pin'

describe('computerPinFromEnv', () => {
  it('pins app queries to pids on an isolated instance only', () => {
    expect(computerPinFromEnv({ TEMP_CODE_COMPUTER_PIN: 'TextEdit=4242' })).toBeNull()
    const pin = computerPinFromEnv({ TEMP_CODE_USER_DATA: '/tmp/x', TEMP_CODE_COMPUTER_PIN: 'TextEdit=4242, Notes = 77' })!
    expect(pin('TextEdit')).toEqual({ pid: 4242 })
    expect(pin('textedit')).toEqual({ pid: 4242 })
    expect(pin('Notes')).toEqual({ pid: 77 })
    expect(pin('Safari')).toBeNull()
  })

  it('leaves a malformed entry out, and nothing at all when none is good', () => {
    const pin = computerPinFromEnv({ TEMP_CODE_USER_DATA: '/tmp/x', TEMP_CODE_COMPUTER_PIN: 'TextEdit=abc,=12,Notes=0,Mail=9' })!
    expect(pin('TextEdit')).toBeNull()
    expect(pin('Notes')).toBeNull()
    expect(pin('Mail')).toEqual({ pid: 9 })
    expect(computerPinFromEnv({ TEMP_CODE_USER_DATA: '/tmp/x', TEMP_CODE_COMPUTER_PIN: 'junk' })).toBeNull()
  })
})
