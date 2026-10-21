import { describe, expect, it } from 'vitest'
import { decideOpen, decisionNote, localPathOf, remotePathOf, type PathMap } from './openOnMac'

const map: PathMap = {
  roots: {
    '/Users/landon/IdeaProjects/temp-code': '/srv/agents/work/temp-code',
    '/Users/landon/Desktop/Websites/cosmicweb': '/srv/agents/work/cosmicweb'
  },
  prefixes: { '/Users/landon/.temp-code/worktrees': '/srv/agents/home/.temp-code/worktrees', '/Users/landon': '/srv/agents/home' }
}

describe('localPathOf', () => {
  it('inverts a root: box /srv/agents/work/<X>/… is the Mac checkout of <X>', () => {
    expect(localPathOf(map, '/srv/agents/work/temp-code/src/main/index.ts')).toBe('/Users/landon/IdeaProjects/temp-code/src/main/index.ts')
    expect(localPathOf(map, '/srv/agents/work/temp-code')).toBe('/Users/landon/IdeaProjects/temp-code')
    expect(localPathOf(map, '/srv/agents/work/cosmicweb/app/page.tsx')).toBe('/Users/landon/Desktop/Websites/cosmicweb/app/page.tsx')
  })
  it('falls to the longest prefix and leaves the rest alone', () => {
    expect(localPathOf(map, '/srv/agents/home/.temp-code/worktrees/x/a.md')).toBe('/Users/landon/.temp-code/worktrees/x/a.md')
    expect(localPathOf(map, '/srv/agents/home/.claude/settings.json')).toBe('/Users/landon/.claude/settings.json')
    expect(localPathOf(map, '/srv/agents/work/other/a.ts')).toBeNull()
    expect(localPathOf(map, '/etc/hosts')).toBeNull()
    expect(localPathOf(map, 'src/a.ts')).toBeNull()
  })
  it('matches on a path boundary only', () => {
    expect(localPathOf(map, '/srv/agents/work/temp-code-prod/a.ts')).toBeNull()
    expect(localPathOf(map, '/srv/agents/homer/x')).toBeNull()
  })
  it('round-trips through remotePathOf', () => {
    for (const p of ['/srv/agents/work/temp-code/a.ts', '/srv/agents/home/.zshrc']) expect(remotePathOf(map, localPathOf(map, p)!)).toBe(p)
    expect(remotePathOf(map, '/opt/x')).toBeNull()
  })
})

describe('decideOpen', () => {
  const base = { localPath: '/Users/landon/IdeaProjects/temp-code/a.ts', localProject: '/Users/landon/IdeaProjects/temp-code', localProjectExists: true }
  it('opens the editor when both copies hash the same', () => {
    expect(decideOpen({ ...base, remoteDigest: 'aa', localDigest: 'aa' })).toEqual({ kind: 'local', localPath: base.localPath })
  })
  it('previews with a note when the Mac copy differs', () => {
    expect(decideOpen({ ...base, remoteDigest: 'aa', localDigest: 'bb' })).toEqual({ kind: 'differs', localPath: base.localPath })
  })
  it('previews when the project is here but the file is not', () => {
    expect(decideOpen({ ...base, remoteDigest: 'aa', localDigest: null })).toEqual({ kind: 'missing', localPath: base.localPath, localProject: base.localProject })
  })
  it('is absent when nothing maps it or the project is not checked out here', () => {
    expect(decideOpen({ ...base, localPath: null, remoteDigest: 'aa', localDigest: null })).toEqual({ kind: 'absent', localPath: null })
    expect(decideOpen({ ...base, localProjectExists: false, remoteDigest: 'aa', localDigest: null })).toEqual({ kind: 'absent', localPath: base.localPath })
    expect(decideOpen({ ...base, localProject: null, localProjectExists: false, remoteDigest: 'aa', localDigest: null })).toEqual({ kind: 'absent', localPath: base.localPath })
  })
  it('opens the Mac copy of a file the host deleted', () => {
    expect(decideOpen({ ...base, remoteDigest: null, localDigest: 'bb' })).toEqual({ kind: 'local', localPath: base.localPath })
  })
})

describe('decisionNote', () => {
  it('names the branch here when known', () => {
    expect(decisionNote({ kind: 'differs', localPath: '/x' }, 'master', 'box')).toBe('Mac copy differs: on branch master here')
    expect(decisionNote({ kind: 'missing', localPath: '/x', localProject: '/p' }, null, 'box')).toBe('No Mac copy')
    expect(decisionNote({ kind: 'absent', localPath: null }, null, 'box')).toBe('Only on box')
    expect(decisionNote({ kind: 'absent', localPath: '/x' }, 'main', 'box')).toBe('Not checked out on the Mac')
    expect(decisionNote({ kind: 'local', localPath: '/x' }, 'main', 'box')).toBeNull()
  })
})
