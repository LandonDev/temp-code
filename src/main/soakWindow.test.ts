import { describe, expect, it } from 'vitest'
import { SOAK_SWITCHES, soakWindow } from './soakWindow'

describe('the soak window flag', () => {
  it('is honoured only on an isolated instance', () => {
    expect(soakWindow({})).toBe(false)
    expect(soakWindow({ TEMP_CODE_SOAK_WINDOW: '1' })).toBe(false)
    expect(soakWindow({ TEMP_CODE_USER_DATA: '/tmp/tc-soak/ud' })).toBe(false)
    expect(soakWindow({ TEMP_CODE_USER_DATA: '/tmp/tc-soak/ud', TEMP_CODE_SOAK_WINDOW: '0' })).toBe(false)
    expect(soakWindow({ TEMP_CODE_USER_DATA: '/tmp/tc-soak/ud', TEMP_CODE_SOAK_WINDOW: '1' })).toBe(true)
  })
  it('turns off occluded-window and renderer backgrounding', () => {
    expect(SOAK_SWITCHES).toEqual(['disable-backgrounding-occluded-windows', 'disable-renderer-backgrounding'])
  })
})
