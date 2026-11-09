import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codexLiveRoots,
  codexSkillRoot,
  codexSkillScope,
  configureCodexSkills,
  disableHomeSkillsArgs,
  homeSkillFiles,
  trackCodexSkills
} from './codexSkills'
import type { ScopeKey } from './pointers'

let tmp: string
let home: string
const savedCodexHome = process.env.CODEX_HOME

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tc-codex-skills-')))
  home = join(tmp, 'home')
  delete process.env.CODEX_HOME
})
afterEach(() => {
  configureCodexSkills(null)
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = savedCodexHome
  rmSync(tmp, { recursive: true, force: true })
})

const skill = (dir: string): string => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\n---\n')
  return join(dir, 'SKILL.md')
}

describe('homeSkillFiles', () => {
  it('lists each skill\'s SKILL.md under both home roots, both spellings of a linked skill, and skips .system, dot entries and dirs with none', () => {
    const a = skill(join(home, '.codex/skills/alpha'))
    const b = skill(join(home, '.agents/skills/beta'))
    skill(join(home, '.codex/skills/.system/builtin'))
    skill(join(home, '.agents/skills/.hidden'))
    mkdirSync(join(home, '.codex/skills/empty'), { recursive: true })
    writeFileSync(join(home, '.codex/skills/loose.md'), 'not a skill')
    const real = skill(join(tmp, 'elsewhere/gamma'))
    symlinkSync(join(tmp, 'elsewhere/gamma'), join(home, '.agents/skills/gamma'))
    // A group folder holds skill dirs of its own.
    const nested = skill(join(home, '.codex/skills/group/delta'))
    expect(homeSkillFiles(home)).toEqual([a, nested, b, join(home, '.agents/skills/gamma/SKILL.md'), real].sort())
  })

  it('reads $CODEX_HOME for the codex root, rescans every call, and is empty with no roots', () => {
    expect(homeSkillFiles(home)).toEqual([])
    process.env.CODEX_HOME = join(tmp, 'codex-home')
    const a = skill(join(tmp, 'codex-home/skills/alpha'))
    skill(join(home, '.codex/skills/ignored'))
    expect(homeSkillFiles(home)).toEqual([a])
    // A SKILL.md added later, even inside an existing dir named like a build folder, is listed at once.
    mkdirSync(join(tmp, 'codex-home/skills/build'))
    expect(homeSkillFiles(home)).toEqual([a])
    const build = skill(join(tmp, 'codex-home/skills/build'))
    expect(homeSkillFiles(home)).toEqual([a, build].sort())
  })
})

describe('disableHomeSkillsArgs', () => {
  it('is one -c pair with every path disabled, TOML strings escaped', () => {
    expect(disableHomeSkillsArgs([])).toEqual([])
    expect(disableHomeSkillsArgs(['/h/a/SKILL.md', '/h/q"uo\\te/SKILL.md'])).toEqual([
      '-c',
      'skills.config=[{path="/h/a/SKILL.md",enabled=false},{path="/h/q\\"uo\\\\te/SKILL.md",enabled=false}]'
    ])
  })
})

describe('the driver\'s seam', () => {
  it('names the scope and its root, reaches every live handle of a moved scope, and lists the roots they hold', () => {
    expect(codexSkillScope({ workspaceId: null, projectId: null, cwd: '/x' })).toBeUndefined()
    expect(codexSkillRoot(null)).toBeNull()
    let moved: ((provider: 'claude' | 'codex' | 'muse', scope: ScopeKey, generation: string) => void) | null = null
    let gen = '/data/harness/codex/global@aaaaaaaaaaaa'
    configureCodexSkills({
      scopeOf: (s) => s.workspaceId,
      pointers: { current: (_p, ws) => ({ generation: ws ? `/data/harness/codex/ws-${ws}@bbbbbbbbbbbb` : gen, movedAt: 0 }), onMoved: (fn) => ((moved = fn), () => {}) }
    })
    expect(codexSkillScope({ workspaceId: 'w1', projectId: null, cwd: '/x' })).toEqual({ workspaceId: 'w1' })
    expect(codexSkillRoot(null)).toBe(`${gen}/skills`)
    const got: string[] = []
    let held: string | null = `${gen}/skills`
    const untrack = trackCodexSkills({ workspaceId: null, held: () => held, moved: (r) => got.push(r) })
    trackCodexSkills({ workspaceId: 'w1', held: () => '/data/harness/codex/ws-w1@bbbbbbbbbbbb/skills', moved: (r) => got.push(`w1:${r}`) })
    expect([...codexLiveRoots()].sort()).toEqual([gen, '/data/harness/codex/ws-w1@bbbbbbbbbbbb'])
    gen = '/data/harness/codex/global@cccccccccccc'
    moved!('codex', 'global', gen)
    expect(got).toEqual([`${gen}/skills`])
    moved!('claude', 'global', gen)
    expect(got.length).toBe(1)
    held = null
    expect([...codexLiveRoots()]).toEqual(['/data/harness/codex/ws-w1@bbbbbbbbbbbb'])
    untrack()
    moved!('codex', 'global', gen)
    expect(got.length).toBe(1)
  })
})
