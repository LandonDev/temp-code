import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_ROOTS,
  claudeGenerationOfRoot,
  claudeSkillRootFor,
  claudeSkillsGeneration,
  configureClaudeSkillRoots,
  ensureClaudeRoot,
  personClaudeDir,
  personClaudeJson,
  relinkClaudeSkills
} from './claudeRoots'
import type { ScopeKey } from './pointers'

let tmp: string
let root: string
let person: string
let personJson: string
let logs: string[]
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tc-claude-roots-')))
  root = join(tmp, 'harness')
  person = join(tmp, 'home', '.claude')
  personJson = join(tmp, 'home', '.claude.json')
  logs = []
  mkdirSync(join(person, 'skills', 'mine'), { recursive: true })
  writeFileSync(join(person, 'settings.json'), '{}')
  writeFileSync(join(person, 'CLAUDE.md'), '# me')
  mkdirSync(join(person, 'commands'))
  writeFileSync(personJson, '{"projects":{}}')
})
afterEach(() => {
  configureClaudeSkillRoots(null)
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  rmSync(tmp, { recursive: true, force: true })
})

/** A generation with these skill folders, and the scope's pointer at it. */
function pointAt(scope: ScopeKey, gen: string, skills: string[]): string {
  const genDir = join(root, 'claude', gen)
  for (const s of skills) {
    mkdirSync(join(genDir, 'skills', s), { recursive: true })
    writeFileSync(join(genDir, 'skills', s, 'SKILL.md'), `---\nname: ${s}\n---\n${gen}`)
  }
  mkdirSync(join(genDir, 'skills'), { recursive: true })
  const pointer = join(root, 'claude', 'scope', scope)
  mkdirSync(join(root, 'claude', 'scope'), { recursive: true })
  rmSync(pointer, { force: true })
  symlinkSync(join('..', gen), pointer)
  return pointer
}

const ensure = (scope: ScopeKey = 'global', pointer = join(root, 'claude', 'scope', scope)): string =>
  ensureClaudeRoot({ root, scope, pointer, personDir: person, personJson, log: (l) => logs.push(l) })

describe('the owned Claude root', () => {
  it('holds a link per store skill through the pointer, the synced bucket, .claude.json and every other entry of the person\'s dir', () => {
    mkdirSync(join(person, 'skills', 'synced', 'brand'), { recursive: true })
    const pointer = pointAt('global', 'global@aaaaaaaaaaaa', ['alpha', 'beta'])
    const dir = ensure()
    expect(dir).toBe(join(root, CLAUDE_ROOTS, 'global'))
    expect(readdirSync(join(dir, 'skills')).sort()).toEqual(['alpha', 'beta', 'synced'])
    expect(readlinkSync(join(dir, 'skills', 'alpha'))).toBe(join(pointer, 'skills', 'alpha'))
    expect(readlinkSync(join(dir, 'skills', 'synced'))).toBe(join(person, 'skills', 'synced'))
    expect(readFileSync(join(dir, 'skills', 'beta', 'SKILL.md'), 'utf8')).toContain('global@aaaaaaaaaaaa')
    expect(readlinkSync(join(dir, '.claude.json'))).toBe(personJson)
    for (const name of ['settings.json', 'CLAUDE.md', 'commands', 'projects']) expect(readlinkSync(join(dir, name))).toBe(join(person, name))
    // The person's own skills are never linked.
    expect(existsSync(join(dir, 'skills', 'mine'))).toBe(false)
    expect(lstatSync(join(dir, 'skills')).isDirectory()).toBe(true)
  })

  it('creates projects/ in the person\'s dir first, and writes nothing else there', () => {
    pointAt('global', 'global@aaaaaaaaaaaa', ['alpha'])
    const before = readdirSync(person).sort()
    ensure()
    expect(readdirSync(person).sort()).toEqual([...before, 'projects'].sort())
    expect(lstatSync(join(person, 'projects')).isDirectory()).toBe(true)
    ensure()
    expect(readdirSync(person).sort()).toEqual([...before, 'projects'].sort())
    expect(readdirSync(join(person, 'skills'))).toEqual(['mine'])
  })

  it('relinks names after a move, while an edited skill is reached through the pointer with no relink', () => {
    const pointer = pointAt('ws-w1', 'ws-w1@aaaaaaaaaaaa', ['alpha', 'beta'])
    const dir = ensure('ws-w1')
    pointAt('ws-w1', 'ws-w1@bbbbbbbbbbbb', ['alpha', 'gamma'])
    // Before the relink, an edit to alpha is already seen.
    expect(readFileSync(join(dir, 'skills', 'alpha', 'SKILL.md'), 'utf8')).toContain('ws-w1@bbbbbbbbbbbb')
    relinkClaudeSkills(dir, pointer, person)
    expect(readdirSync(join(dir, 'skills')).sort()).toEqual(['alpha', 'gamma'])
    // A scope with no root yet is left alone.
    relinkClaudeSkills(join(root, CLAUDE_ROOTS, 'ws-none'), pointer, person)
    expect(existsSync(join(root, CLAUDE_ROOTS, 'ws-none'))).toBe(false)
  })

  it('gives a store row named synced no link: synced stays the person\'s bucket', () => {
    mkdirSync(join(person, 'skills', 'synced'), { recursive: true })
    pointAt('global', 'global@aaaaaaaaaaaa', ['alpha', 'synced'])
    const dir = ensure()
    expect(readlinkSync(join(dir, 'skills', 'synced'))).toBe(join(person, 'skills', 'synced'))
    ensure()
    expect(logs.filter((l) => l.includes('named synced')).length).toBe(1)
    // With no bucket of the person's, nothing is linked under that name.
    rmSync(join(person, 'skills', 'synced'), { recursive: true })
    ensure()
    expect(existsSync(join(dir, 'skills', 'synced'))).toBe(false)
  })

  it('removes a link whose target left, and keeps what the CLI made there', () => {
    pointAt('global', 'global@aaaaaaaaaaaa', ['alpha'])
    const dir = ensure()
    mkdirSync(join(dir, 'sessions'))
    writeFileSync(join(dir, 'sessions', 'x.json'), '{}')
    symlinkSync(join(person, 'gone'), join(dir, 'oldlink.lnk-12345'))
    rmSync(join(person, 'commands'), { recursive: true })
    ensure()
    expect(existsSync(join(dir, 'commands'))).toBe(false)
    expect(lstatOrNull(join(dir, 'commands'))).toBe(false)
    expect(readFileSync(join(dir, 'sessions', 'x.json'), 'utf8')).toBe('{}')
    expect(existsSync(join(dir, 'oldlink.lnk-12345'))).toBe(false)
    expect(lstatOrNull(join(dir, 'oldlink.lnk-12345'))).toBe(false)
  })

  it('sets a diverged .claude.json aside and links the person\'s again', () => {
    pointAt('global', 'global@aaaaaaaaaaaa', [])
    const dir = ensure()
    rmSync(join(dir, '.claude.json'))
    writeFileSync(join(dir, '.claude.json'), '{"mine":true}')
    ensure()
    expect(readlinkSync(join(dir, '.claude.json'))).toBe(personJson)
    expect(readFileSync(join(dir, '.claude.json.diverged'), 'utf8')).toBe('{"mine":true}')
    expect(logs.some((l) => l.includes('.claude.json.diverged'))).toBe(true)
  })

  it('reads the person\'s dir and .claude.json from CLAUDE_CONFIG_DIR, else the home', () => {
    delete process.env.CLAUDE_CONFIG_DIR
    expect(personClaudeDir()).toBe(join(homedir(), '.claude'))
    expect(personClaudeJson()).toBe(join(homedir(), '.claude.json'))
    process.env.CLAUDE_CONFIG_DIR = person
    expect(personClaudeDir()).toBe(person)
    expect(personClaudeJson()).toBe(join(person, '.claude.json'))
    // Under CLAUDE_CONFIG_DIR the json sits inside the dir: linked once, as .claude.json.
    writeFileSync(join(person, '.claude.json'), '{}')
    pointAt('global', 'global@aaaaaaaaaaaa', [])
    const dir = ensureClaudeRoot({ root, scope: 'global', pointer: join(root, 'claude', 'scope', 'global'), log: (l) => logs.push(l) })
    expect(readlinkSync(join(dir, '.claude.json'))).toBe(join(person, '.claude.json'))
  })
})

describe('the driver\'s seam', () => {
  it('is null unconfigured; configured, it makes the scope\'s root, names its generation and relinks on a move', () => {
    expect(claudeSkillRootFor({ workspaceId: null, projectId: null, cwd: tmp })).toBeNull()
    expect(claudeSkillsGeneration(null)).toBeNull()
    process.env.CLAUDE_CONFIG_DIR = person
    pointAt('ws-w1', 'ws-w1@aaaaaaaaaaaa', ['alpha'])
    let moved: ((provider: 'claude' | 'codex' | 'muse', scope: ScopeKey, generation: string) => void) | null = null
    let gen = join(root, 'claude', 'ws-w1@aaaaaaaaaaaa')
    configureClaudeSkillRoots({
      scopeOf: (s) => s.workspaceId,
      root,
      log: (l) => logs.push(l),
      pointers: {
        path: (_p, ws) => join(root, 'claude', 'scope', ws ? `ws-${ws}` : 'global'),
        current: () => ({ generation: gen, movedAt: 0 }),
        onMoved: (fn) => ((moved = fn), () => {})
      }
    })
    const r = claudeSkillRootFor({ workspaceId: 'w1', projectId: null, cwd: tmp })!
    expect(r).toEqual({ dir: join(root, CLAUDE_ROOTS, 'ws-w1'), workspaceId: 'w1' })
    expect(readdirSync(join(r.dir, 'skills'))).toEqual(['alpha'])
    expect(claudeSkillsGeneration('w1')).toBe(gen)
    expect(claudeGenerationOfRoot(r.dir)).toBe(gen)
    expect(claudeGenerationOfRoot('/elsewhere/ws-w1')).toBeNull()
    pointAt('ws-w1', 'ws-w1@bbbbbbbbbbbb', ['alpha', 'beta'])
    gen = join(root, 'claude', 'ws-w1@bbbbbbbbbbbb')
    moved!('claude', 'ws-w1', gen)
    expect(readdirSync(join(r.dir, 'skills')).sort()).toEqual(['alpha', 'beta'])
    // Another provider's move relinks nothing.
    pointAt('ws-w1', 'ws-w1@cccccccccccc', ['alpha'])
    moved!('codex', 'ws-w1', gen)
    expect(readdirSync(join(r.dir, 'skills')).sort()).toEqual(['alpha', 'beta'])
  })
})

function lstatOrNull(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
