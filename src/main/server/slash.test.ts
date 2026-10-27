import { describe, expect, it, vi } from 'vitest'
import { expandSlashRefs, hasSlashToken } from './slash'

vi.mock('./commands', () => ({
  listCommands: async () => [{ name: 'x', source: 'plugin', path: null, description: '' }]
}))

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

describe('expandSlashRefs', () => {
  it('expands the first token of a message after hasSlashToken looked at it (the shared regex starts over)', async () => {
    expect(hasSlashToken('make it a /x please')).toBe(true)
    const out = await expandSlashRefs('claude', '/tmp', 'make it a /x please')
    expect(out).toContain('use your "x" plugin')
    // And again: the second message's token is found too.
    expect(await expandSlashRefs('claude', '/tmp', 'then /x again')).toContain('use your "x" plugin')
  })
})
