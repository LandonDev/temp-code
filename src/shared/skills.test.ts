import { describe, expect, it } from 'vitest'
import {
  SKILL_MAX_BYTES,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_FILES,
  SKILL_NAME_RE,
  generationDirName,
  harnessesFrom,
  harnessWords,
  isNativeBinary,
  skillChangeCard,
  skillDigest,
  skillFrontmatter,
  skillProblem,
  skillRemoveCard,
  skillWriteAsks,
  viewDigest,
  viewDirName,
  visibleSkills
} from './skills'

const enc = new TextEncoder()
const md = (name: string, description = 'Use it when testing.'): string => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
const file = (path: string, text: string) => ({ path, bytes: enc.encode(text) })
const skill = (name = 'tidy', extra: { path: string; bytes: Uint8Array }[] = []) => [file('SKILL.md', md(name)), ...extra]

describe('skillProblem', () => {
  it('passes a skill with its SKILL.md and files beside it', () => {
    expect(skillProblem('tidy', skill('tidy', [file('scripts/run.sh', 'echo hi'), file('reference/notes.md', 'x')]))).toBeNull()
    expect(SKILL_NAME_RE.test('a'.repeat(64))).toBe(true)
    expect(SKILL_NAME_RE.test('a'.repeat(65))).toBe(false)
  })

  it('refuses each thing a skill may not hold', () => {
    const big = new Uint8Array(SKILL_MAX_FILE_BYTES + 1)
    const elf = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])
    const cases: [string, ReturnType<typeof skill>, RegExp][] = [
      ['Tidy', skill('Tidy'), /^name takes/],
      ['tidy', [], /needs its SKILL.md/],
      ['tidy', [file('README.md', 'x')], /SKILL.md is missing/],
      ['tidy', [file('SKILL.md', '# no frontmatter')], /frontmatter giving the skill's name and a description/],
      ['tidy', [file('SKILL.md', '---\nname: tidy\n---\n')], /frontmatter giving/],
      ['tidy', [file('SKILL.md', md('other'))], /names the skill other, not tidy/],
      ['tidy', skill('tidy', [file('../escape', 'x')]), /not a path inside/],
      ['tidy', skill('tidy', [file('a//b', 'x')]), /not a path inside/],
      ['tidy', skill('tidy', [file('SKILL.md', 'x')]), /there twice/],
      ['tidy', skill('tidy', [file('keys/deploy.pem', 'x')]), /credential/],
      ['tidy', skill('tidy', [file('auth.json', '{}')]), /credential/],
      ['tidy', skill('tidy', [file('scripts/bin/linux-x64/tool', 'x')]), /binary cache/],
      ['tidy', skill('tidy', [{ path: 'tool', bytes: elf }]), /native binary/],
      ['tidy', skill('tidy', [{ path: 'big.bin', bytes: big }]), /over the 4 MB a file may be/]
    ]
    for (const [name, files, re] of cases) expect(skillProblem(name, files), String(re)).toMatch(re)
    const many = skill('tidy', Array.from({ length: SKILL_MAX_FILES }, (_, i) => file(`f${i}.md`, 'x')))
    expect(skillProblem('tidy', many)).toMatch(/at most 512 files/)
    const chunk = new Uint8Array(SKILL_MAX_FILE_BYTES)
    const heavy = skill('tidy', Array.from({ length: SKILL_MAX_BYTES / SKILL_MAX_FILE_BYTES }, (_, i) => ({ path: `c${i}.dat`, bytes: chunk })))
    expect(skillProblem('tidy', heavy)).toMatch(/over the 16 MB a skill may be/)
  })

  it('tells native binaries from text and a Java class', () => {
    const at = (bytes: number[]) => Uint8Array.from(bytes)
    expect(isNativeBinary(at([0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0]))).toBe(true)
    expect(isNativeBinary(at([0xcf, 0xfa, 0xed, 0xfe]))).toBe(true)
    expect(isNativeBinary(at([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]))).toBe(true)
    expect(isNativeBinary(at([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52]))).toBe(false)
    const pe = new Uint8Array(128)
    pe.set([0x4d, 0x5a])
    pe[0x3c] = 0x40
    pe.set([0x50, 0x45, 0, 0], 0x40)
    expect(isNativeBinary(pe)).toBe(true)
    expect(isNativeBinary(enc.encode('MZ is how this markdown file happens to start, and it is long enough to read a header offset'))).toBe(false)
    expect(isNativeBinary(enc.encode('#!/bin/sh\necho hi'))).toBe(false)
  })
})

describe('skillDigest and the views', () => {
  it('is the same whatever the order, and moves with content, path or the executable bit', () => {
    const a = { path: 'SKILL.md', bytes: enc.encode('x'), executable: false }
    const b = { path: 'run.sh', bytes: enc.encode('echo'), executable: true }
    expect(skillDigest([a, b])).toBe(skillDigest([b, a]))
    expect(skillDigest([a, b])).not.toBe(skillDigest([a, { ...b, executable: false }]))
    expect(skillDigest([a, b])).not.toBe(skillDigest([a, { ...b, bytes: enc.encode('echo!') }]))
    expect(skillDigest([a, b])).not.toBe(skillDigest([a, { ...b, path: 'go.sh' }]))
    expect(viewDigest([{ name: 'a', digest: '1' }, { name: 'b', digest: '2' }])).toBe(viewDigest([{ name: 'b', digest: '2' }, { name: 'a', digest: '1' }]))
    expect(viewDigest([{ name: 'a', digest: '1' }])).not.toBe(viewDigest([{ name: 'a', digest: '2' }]))
  })

  it('a CLI gets the enabled skills for it, a workspace skill shadowing a global one', () => {
    const row = (id: string, name: string, workspaceId: string | null, harnesses: 'all' | ('claude' | 'codex' | 'muse')[] = 'all', enabled = true) => ({
      id,
      name,
      workspaceId,
      harnesses,
      enabled
    })
    const rows = [
      row('g1', 'tidy', null),
      row('g2', 'review', null, ['codex']),
      row('g3', 'off', null, 'all', false),
      row('w1', 'tidy', 'ws1', ['muse']),
      row('w2', 'ship', 'ws1')
    ]
    expect(visibleSkills(rows, null, 'claude').map((r) => r.id)).toEqual(['g1'])
    expect(visibleSkills(rows, null, 'codex').map((r) => r.id)).toEqual(['g2', 'g1'])
    // The workspace's tidy is Muse-only and shadows the global one for every CLI.
    expect(visibleSkills(rows, 'ws1', 'claude').map((r) => r.id)).toEqual(['w2'])
    expect(visibleSkills(rows, 'ws1', 'muse').map((r) => r.id)).toEqual(['w2', 'w1'])
  })

  it('names a view and its generation', () => {
    expect(viewDirName(null)).toBe('global')
    expect(viewDirName('w-abc_1')).toBe('ws-w-abc_1')
    expect(viewDirName('a/b')).toBe('ws-a_b')
    expect(generationDirName('global', 'abcdef0123456789')).toBe('global@abcdef012345')
  })
})

describe('skillFrontmatter', () => {
  it('reads plain, quoted and CRLF frontmatter', () => {
    expect(skillFrontmatter(md('tidy'))).toEqual({ name: 'tidy', description: 'Use it when testing.' })
    expect(skillFrontmatter(`---\r\nname: "tidy"\r\ndescription: 'It''s for "this" # not a comment'\r\n---\r\n`)).toEqual({
      name: 'tidy',
      description: 'It\'s for "this" # not a comment'
    })
    expect(skillFrontmatter(`---\nname: tidy # the name\ndescription: "Line\\nnext"\n---\n`)).toEqual({ name: 'tidy', description: 'Line\nnext' })
    expect(skillFrontmatter('# no frontmatter\nname: x')).toEqual({})
    expect(skillFrontmatter('---\nname: x\n')).toEqual({})
  })

  it('reads folded, literal and continued descriptions, ignoring other keys', () => {
    const folded = `---\nname: impeccable\ndescription: >-\n  Use when the user wants to design,\n  redesign or polish.\n\n  Not for backend work.\nlicense: MIT\nmetadata:\n  name: nested\n---\n`
    expect(skillFrontmatter(folded)).toEqual({ name: 'impeccable', description: 'Use when the user wants to design, redesign or polish.\nNot for backend work.' })
    const literal = `---\nname: tidy\ndescription: |\n  Line one\n    indented two\n\n---\n`
    expect(skillFrontmatter(literal).description).toBe('Line one\n  indented two')
    const clip = `---\nname: tidy\ndescription: >\n  One\n  two\n---\n`
    expect(skillFrontmatter(clip).description).toBe('One two')
    const continued = `---\nname: tidy\ndescription: Use it when the code\n  needs tidying.\n---\n`
    expect(skillFrontmatter(continued).description).toBe('Use it when the code needs tidying.')
  })
})

describe('the cards', () => {
  it('words a change and a removal of a person\'s skill, never asking for a new one or a thread\'s own', () => {
    const person = { writtenBy: { kind: 'person' as const } }
    const card = skillChangeCard({ name: 'tidy', harnesses: 'all', fileCount: 4, bytes: 12 * 1024, changes: 'SKILL.md changed' }, person, { workspaceName: null })
    expect(card).toEqual({
      title: 'Change the skill tidy',
      input: { where: 'Every workspace', harnesses: 'Claude, Codex and Muse', files: '4 files, 12 KB', changes: 'SKILL.md changed', writtenBy: 'You' }
    })
    // The card lists its rows in this order: what changed sits right after the files.
    expect(Object.keys(card.input)).toEqual(['where', 'harnesses', 'files', 'changes', 'writtenBy'])
    expect(
      skillChangeCard({ name: 'tidy', harnesses: ['muse', 'claude'], fileCount: 1, bytes: 300, changes: 'only which CLIs get it' }, { writtenBy: { kind: 'import', from: 'x' } }, { workspaceName: 'temp-code' }).input
    ).toEqual({
      where: 'temp-code',
      harnesses: 'Claude and Muse',
      files: '1 file, 300 B',
      changes: 'only which CLIs get it',
      writtenBy: 'Imported'
    })
    expect(skillRemoveCard({ name: 'tidy', writtenBy: { kind: 'person', key: 'Phone' } }, { workspaceName: null })).toEqual({
      title: 'Remove the skill tidy',
      input: { where: 'Every workspace', writtenBy: 'Phone' }
    })
    expect(skillWriteAsks(null)).toBe(false)
    expect(skillWriteAsks({ writtenBy: { kind: 'thread', sessionId: 's', environmentId: 'e', title: 't' } })).toBe(false)
    expect(skillWriteAsks(person)).toBe(true)
    expect(harnessWords(['codex'])).toBe('Codex')
  })

  it('reads skill_write\'s harnesses argument', () => {
    expect(harnessesFrom(undefined)).toBe('all')
    expect(harnessesFrom(['all'])).toBe('all')
    expect(harnessesFrom(['muse', 'claude'])).toEqual(['claude', 'muse'])
    expect(harnessesFrom(['codex', 'claude', 'muse'])).toBe('all')
  })
})
