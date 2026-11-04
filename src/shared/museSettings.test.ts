import { describe, expect, it } from 'vitest'
import { isSharedMuseEntry, museAccountDirName } from './museSettings'

describe('muse account dirs', () => {
  it('names a dir safely from an account', () => {
    expect(museAccountDirName('Landon@Example.com')).toBe('landon@example.com')
    expect(museAccountDirName('key-0a1b2c3d4e5f')).toBe('key-0a1b2c3d4e5f')
    expect(museAccountDirName('../../etc')).toBe('__.._etc')
    expect(museAccountDirName('a b/c')).toBe('a_b_c')
    expect(museAccountDirName('')).toBe('_')
  })

  it('shares every entry of the real config dir but the login and its lock', () => {
    expect(isSharedMuseEntry('settings.json')).toBe(true)
    expect(isSharedMuseEntry('skills')).toBe(true)
    expect(isSharedMuseEntry('trust.json')).toBe(true)
    expect(isSharedMuseEntry('auth.json')).toBe(false)
    expect(isSharedMuseEntry('.auth.json.lock')).toBe(false)
    expect(isSharedMuseEntry('auth.json.123.tmp')).toBe(false)
  })
})
