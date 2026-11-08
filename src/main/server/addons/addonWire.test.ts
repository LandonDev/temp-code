import { describe, expect, it } from 'vitest'
import { grantGapsLine, megabytes } from './addonWire'

describe('the add-on host words', () => {
  it('says what a grant lacks in the card\'s words', () => {
    expect(grantGapsLine(['FAKE_TOKEN'])).toBe('Needs values for FAKE_TOKEN')
    expect(grantGapsLine(['FAKE_TOKEN', 'X-Api-Key'])).toBe('Needs values for FAKE_TOKEN and X-Api-Key')
    expect(grantGapsLine(['sign-in'])).toBe('Needs a sign-in on the Mac')
    expect(grantGapsLine(['A', 'sign-in'])).toBe('Needs a sign-in on the Mac and values for A')
  })

  it('writes a size to one decimal', () => {
    expect(megabytes(16.5 * 1024 * 1024)).toBe('16.5 MB')
    expect(megabytes(16 * 1024 * 1024)).toBe('16 MB')
  })
})
