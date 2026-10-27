import { describe, expect, it } from 'vitest'
import { hasSlashToken } from './slash'

describe('hasSlashToken', () => {
  it('finds a /word at a line start or after whitespace, with or without a namespace', () => {
    expect(hasSlashToken('/review the diff')).toBe(true)
    expect(hasSlashToken('please /impeccable this')).toBe(true)
    expect(hasSlashToken('rules:\n/emil-design-eng')).toBe(true)
    expect(hasSlashToken('use /anthropic-skills:pdf here')).toBe(true)
  })

  it('ignores paths, URLs, dates and fractions: no command discovery for them', () => {
    expect(hasSlashToken('open src/main/server/slash.ts')).toBe(false)
    expect(hasSlashToken('see https://example.com/docs')).toBe(false)
    expect(hasSlashToken('on 2026/10/27')).toBe(false)
    expect(hasSlashToken('a 3/4 cup')).toBe(false)
    expect(hasSlashToken('no slash at all')).toBe(false)
    expect(hasSlashToken('')).toBe(false)
  })
})
