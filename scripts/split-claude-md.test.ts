import { describe, expect, it } from 'vitest'
import { fileOf, INLINE, sectionsOf, slugOf } from './split-claude-md'

describe('split-claude-md', () => {
  it('splits on ## headings outside fences and keeps each body verbatim', () => {
    const text = '# Title\n\nintro\n\n## A: one\nalpha\n```\n## not a heading\n```\n\n## B\nbeta\n'
    const { head, sections } = sectionsOf(text)
    expect(head).toBe('# Title\n\nintro\n')
    expect(sections.map((s) => s.heading)).toEqual(['A: one', 'B'])
    expect(sections[0].body).toBe('alpha\n```\n## not a heading\n```\n')
    expect(fileOf(sections[1])).toBe('# B\n\nbeta\n')
  })

  it('names a file by the words before the colon, or by the map', () => {
    expect(slugOf('Provider traffic: the gateway, and Codex needs 0.162.1+')).toBe('provider-traffic')
    expect(slugOf('The interactive lane: the thread on screen goes first')).toBe('interactive-lane')
    expect(slugOf('Plans: `plan_complete` and the auto-start')).toBe('plans-auto-start')
    expect(INLINE.has('Testing: spawn an isolated dev instance')).toBe(true)
  })
})
