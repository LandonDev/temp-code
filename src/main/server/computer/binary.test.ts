import { describe, expect, it } from 'vitest'
import { computerBinaryPath, computerUnavailable } from './binary'

describe('computer use availability', () => {
  const mac = { platform: 'darwin' as const, headless: false, env: {}, exists: () => true }
  it('runs on a Mac with a screen and a built binary', () => {
    expect(computerUnavailable(mac)).toBeNull()
  })
  it('says why it is off, one line each', () => {
    expect(computerUnavailable({ ...mac, platform: 'linux' })).toBe('computer use runs on a Mac')
    expect(computerUnavailable({ ...mac, headless: true })).toBe('this host runs without a screen')
    expect(computerUnavailable({ ...mac, env: { TEMP_CODE_COMPUTER: '0' } })).toBe('turned off')
    expect(computerUnavailable({ ...mac, exists: () => false })).toBe('tc-computer is not built')
  })
  it('a headless proof instance on a Mac serves computer use only with TEMP_CODE_COMPUTER=1 and TEMP_CODE_USER_DATA', () => {
    const headless = { ...mac, headless: true }
    expect(computerUnavailable({ ...headless, env: { TEMP_CODE_COMPUTER: '1', TEMP_CODE_USER_DATA: '/tmp/i' } })).toBeNull()
    expect(computerUnavailable({ ...headless, env: { TEMP_CODE_COMPUTER: '1' } })).toBe('this host runs without a screen')
    expect(computerUnavailable({ ...headless, env: { TEMP_CODE_USER_DATA: '/tmp/i' } })).toBe('this host runs without a screen')
    expect(computerUnavailable({ ...headless, platform: 'linux', env: { TEMP_CODE_COMPUTER: '1', TEMP_CODE_USER_DATA: '/tmp/i' } })).toBe('computer use runs on a Mac')
  })
  it('TEMP_CODE_COMPUTER_BIN names the binary, else resources/native', () => {
    expect(computerBinaryPath({ TEMP_CODE_COMPUTER_BIN: '/tmp/tc' })).toBe('/tmp/tc')
    expect(computerBinaryPath({})).toMatch(/resources\/native\/tc-computer$/)
    const asked: string[] = []
    computerUnavailable({ ...mac, env: { TEMP_CODE_COMPUTER_BIN: '/x/tc' }, exists: (p) => (asked.push(p), true) })
    expect(asked).toEqual(['/x/tc'])
  })
})
