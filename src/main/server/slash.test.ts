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

describe('expandSlashRefs by harness and source', () => {
  it('points codex and muse at a store skill with its path, never its body', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'slash-'))
    const skill = join(dir, 'SKILL.md')
    const prompt = join(dir, 'prompt.md')
    writeFileSync(skill, 'SKILL BODY')
    writeFileSync(prompt, 'PROMPT BODY')
    const commands = await import('./commands')
    const list = vi.spyOn(commands, 'listCommands').mockResolvedValue([
      { name: 'impeccable', source: 'skill', path: skill, description: '', scope: 'user' },
      { name: 'ship', source: 'prompt', path: prompt, description: '', scope: 'user' }
    ] as never)
    for (const provider of ['codex', 'muse'] as const) {
      const out = await expandSlashRefs(provider, '/tmp', 'polish it /impeccable then /ship')
      expect(out).toContain(`Where the message says /impeccable: open your "impeccable" skill (${skill}) and follow it`)
      expect(out).not.toContain('SKILL BODY')
      // A prompt has no skill behind it: its body still goes in.
      expect(out).toContain('PROMPT BODY')
    }
    const claude = await expandSlashRefs('claude', '/tmp', 'polish it /impeccable')
    expect(claude).toContain('invoke your "impeccable" skill')
    expect(claude).not.toContain('SKILL BODY')
    // Cursor loads no skill itself: the body is inlined.
    expect(await expandSlashRefs('cursor', '/tmp', 'polish it /impeccable')).toContain('SKILL BODY')
    list.mockRestore()
  })
})
