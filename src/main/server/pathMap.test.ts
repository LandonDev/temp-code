import { describe, expect, it } from 'vitest'
import { parseMapping, remapper } from './pathMap'

const map = parseMapping(
  JSON.stringify({
    roots: { '/Users/landon/IdeaProjects/temp-code': '/srv/agents/work/temp-code' },
    prefixes: { '/Users/landon/IdeaProjects': '/srv/agents/work', '/Users/landon': '/srv/agents/home' }
  })
)

describe('remapper.text', () => {
  const r = remapper(map)
  it('rewrites every mapped path in a text, the longest source first', () => {
    const text = 'cd /Users/landon/IdeaProjects/temp-code/src && cat /Users/landon/IdeaProjects/other/a.md ~ /Users/landon/.claude/x'
    expect(r.text(text)).toBe('cd /srv/agents/work/temp-code/src && cat /srv/agents/work/other/a.md ~ /srv/agents/home/.claude/x')
  })
  it('only on a path boundary on both sides', () => {
    expect(r.text('/Users/landonx/a and /opt/Users/landon/b')).toBe('/Users/landonx/a and /opt/Users/landon/b')
    // temp-code-prod is not the temp-code root: it falls to the IdeaProjects prefix.
    expect(r.text('/Users/landon/IdeaProjects/temp-code-prod/x')).toBe('/srv/agents/work/temp-code-prod/x')
    expect(r.text('"/Users/landon"')).toBe('"/srv/agents/home"')
  })
  it('agrees with path() on a single path', () => {
    for (const p of ['/Users/landon/IdeaProjects/temp-code', '/Users/landon/IdeaProjects/x/y', '/Users/landon/Library/z']) expect(r.text(p)).toBe(r.path(p))
  })
  it('leaves a text with nothing mapped alone, and an empty map changes nothing', () => {
    expect(r.text('/etc/hosts')).toBe('/etc/hosts')
    expect(remapper({ roots: {}, prefixes: {} }).text('/Users/landon/a')).toBe('/Users/landon/a')
  })
})
