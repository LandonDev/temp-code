import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseMapping } from '../pathMap'
import {
  conflictName,
  encodeProjectDir,
  inMemorySet,
  invertMapping,
  listMemory,
  mappingReadsForward,
  memoryRoot,
  memoryRules,
  parseConflictName,
  stripConflict,
  translateEncodedDir,
  translateMemoryPath
} from './memorySet'

let home: string
const put = (rel: string, body = 'x'): void => {
  mkdirSync(dirname(join(home, rel)), { recursive: true })
  writeFileSync(join(home, rel), body)
}
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tc-memset-')))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const MAP = parseMapping(
  JSON.stringify({
    roots: { '/Users/landon/IdeaProjects/temp-code': '/srv/agents/work/temp-code' },
    prefixes: { '/Users/landon/.temp-code/worktrees': '/srv/agents/home/.temp-code/worktrees', '/Users/landon': '/srv/agents/home' }
  })
)

describe('the encoded project dir', () => {
  it('encodes a cwd the way Claude Code names its projects dir', () => {
    expect(encodeProjectDir('/Users/landon/IdeaProjects/temp-code')).toBe('-Users-landon-IdeaProjects-temp-code')
    expect(encodeProjectDir('/srv/agents/work/temp-code/.claude/worktrees/x')).toBe('-srv-agents-work-temp-code--claude-worktrees-x')
  })
  it('translates a mapped root, a prefix, a worktree under the root, and leaves an unmapped project alone', () => {
    expect(translateEncodedDir('-Users-landon-IdeaProjects-temp-code', MAP)).toBe('-srv-agents-work-temp-code')
    expect(translateEncodedDir('-Users-landon-IdeaProjects-temp-code--claude-worktrees-memory-sync', MAP)).toBe('-srv-agents-work-temp-code--claude-worktrees-memory-sync')
    expect(translateEncodedDir('-Users-landon-Desktop-notes', MAP)).toBe('-srv-agents-home-Desktop-notes')
    expect(translateEncodedDir('-Users-landon--temp-code-worktrees-update-33', MAP)).toBe('-srv-agents-home--temp-code-worktrees-update-33')
    // `-Users-landonx` is not under /Users/landon.
    expect(translateEncodedDir('-Users-landonx-IdeaProjects-foo', MAP)).toBe('-Users-landonx-IdeaProjects-foo')
    expect(translateEncodedDir('-opt-elsewhere', MAP)).toBe('-opt-elsewhere')
  })
  it('round-trips through the inverted map', () => {
    const inv = invertMapping(MAP)
    expect(translateEncodedDir('-srv-agents-work-temp-code', inv)).toBe('-Users-landon-IdeaProjects-temp-code')
    expect(translateEncodedDir(translateEncodedDir('-Users-landon-IdeaProjects-temp-code--claude-worktrees-a', MAP), inv)).toBe('-Users-landon-IdeaProjects-temp-code--claude-worktrees-a')
  })
  it('translates only the encoded dir of a project memory path', () => {
    expect(translateMemoryPath('.claude/projects/-Users-landon-IdeaProjects-temp-code/memory/MEMORY.md', MAP)).toBe('.claude/projects/-srv-agents-work-temp-code/memory/MEMORY.md')
    expect(translateMemoryPath('.claude/plans/x.md', MAP)).toBe('.claude/plans/x.md')
  })
  it('reads the shipped map forward from the Mac and backward from the box', () => {
    expect(mappingReadsForward(MAP, '/Users/landon', '/srv/agents/home')).toBe(true)
    expect(mappingReadsForward(MAP, '/srv/agents/home', '/Users/landon')).toBe(false)
    expect(mappingReadsForward({ roots: {}, prefixes: {} }, '/a', '/b')).toBe(true)
  })
})

describe('the set', () => {
  it('admits project memory, plans, CLAUDE.md, codex memories and AGENTS.md; refuses transcripts, secrets, .git and bad paths', () => {
    expect(memoryRoot('.claude/projects/-srv-agents-work-temp-code/memory/MEMORY.md')).toBe('.claude/projects/-srv-agents-work-temp-code/memory')
    expect(memoryRoot('.claude/projects/-srv-agents-work-temp-code/memory/deep/note.md')).toBe('.claude/projects/-srv-agents-work-temp-code/memory')
    expect(memoryRoot('.claude/plans/sunny-otter.md')).toBe('.claude/plans')
    expect(memoryRoot('.claude/CLAUDE.md')).toBe('.claude')
    expect(memoryRoot('.codex/memories/rollout_summaries/a.md')).toBe('.codex/memories')
    expect(memoryRoot('.codex/AGENTS.md')).toBe('.codex')
    for (const bad of [
      '.claude/projects/-srv-agents-work-temp-code/abc.jsonl',
      '.claude/projects/-srv-agents-work-temp-code/abc/tool-results/x.txt',
      '.claude/projects/-srv-agents-work-temp-code/memory/secret.pem',
      '.claude/projects/bad name/memory/x.md',
      '.codex/memories/.git/HEAD',
      '.codex/auth.json',
      '.claude/.credentials.json',
      '.claude/settings.json',
      '../x.md',
      '/etc/passwd',
      '.claude/projects/-x/memory/../../../y.md'
    ])
      expect(memoryRoot(bad), bad).toBeNull()
    expect(inMemorySet('.claude/plans/a.md')).toBe(true)
  })
  it('lists the memory of every project dir that has one, the plans and the fixed files; never a transcript', () => {
    put('.claude/projects/-a/memory/MEMORY.md', '# index')
    put('.claude/projects/-a/memory/one.md')
    put('.claude/projects/-a/session.jsonl', '{}')
    put('.claude/projects/-a/session/tool-results/r.txt')
    put('.claude/projects/-b/other.jsonl', '{}')
    put('.claude/plans/p.md')
    put('.claude/CLAUDE.md', 'user rules')
    put('.claude/settings.json', '{}')
    put('.codex/memories/MEMORY.md')
    put('.codex/memories/.git/HEAD', 'ref')
    put('.codex/AGENTS.md')
    put('.codex/config.toml')
    expect(memoryRules(home).map((r) => (r.kind === 'tree' ? r.root : r.path))).toEqual(['.claude/projects/-a/memory', '.claude/plans', '.claude/CLAUDE.md', '.codex/memories', '.codex/AGENTS.md'])
    expect(listMemory(home).entries.map((e) => e.relPath)).toEqual([
      '.claude/CLAUDE.md',
      '.claude/plans/p.md',
      '.claude/projects/-a/memory/MEMORY.md',
      '.claude/projects/-a/memory/one.md',
      '.codex/AGENTS.md',
      '.codex/memories/MEMORY.md'
    ])
  })
})

describe('conflict copies', () => {
  it('names the copy beside the file with the host and a UTC stamp, and reads it back', () => {
    const at = Date.UTC(2026, 9, 21, 13, 5, 9)
    expect(conflictName('.claude/projects/-a/memory/note.md', 'Landon’s Mac', at)).toBe('.claude/projects/-a/memory/note.conflict-Landon_s_Mac-20261021T130509.md')
    expect(conflictName('.codex/AGENTS.md', 'box', at)).toBe('.codex/AGENTS.conflict-box-20261021T130509.md')
    expect(conflictName('.claude/plans/noext', 'box', at)).toBe('.claude/plans/noext.conflict-box-20261021T130509')
    expect(parseConflictName('.claude/plans/note.conflict-box-20261021T130509.md')).toEqual({ host: 'box', at })
    expect(parseConflictName('.claude/plans/note.md')).toBeNull()
  })
})

describe('a conflict copy beside a single file', () => {
  it('is in the set, listed and admitted', () => {
    put('.claude/CLAUDE.md', 'rules')
    put('.claude/CLAUDE.conflict-box-20261021T120000.md', 'the box copy')
    put('.claude/CLAUDE.other.md', 'not a copy')
    expect(listMemory(home).entries.map((e) => e.relPath)).toEqual(['.claude/CLAUDE.conflict-box-20261021T120000.md', '.claude/CLAUDE.md'])
    expect(memoryRoot('.claude/CLAUDE.conflict-box-20261021T120000.md')).toBe('.claude')
    expect(memoryRoot('.claude/CLAUDE.other.md')).toBeNull()
    expect(stripConflict('note.conflict-mac-20261021T120000.md')).toBe('note.md')
    expect(stripConflict('noext.conflict-mac-20261021T120000')).toBe('noext')
  })
})
