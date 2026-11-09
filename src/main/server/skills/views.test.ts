import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillMeta } from '@shared/contract-skills'
import { viewDigest } from '@shared/skills'
import { planView, planViews, workspaceForCwd, workspaceForPath, workspaceOfThread } from './views'

const you = { kind: 'person' } as const
let n = 0
const row = (over: Partial<SkillMeta> & { name: string }): SkillMeta => ({
  id: `sk_${++n}`,
  workspaceId: null,
  description: 'Use it.',
  harnesses: 'all',
  enabled: true,
  version: 1,
  digest: `d-${over.name}-${over.workspaceId ?? 'g'}`,
  bytes: 10,
  fileCount: 1,
  addedBy: you,
  writtenBy: you,
  createdAt: 1,
  updatedAt: 1,
  ...over
})

describe('planViews', () => {
  it('gives every provider a global view, empty or not', () => {
    const views = planViews([], ['w1'])
    expect(views.map((v) => `${v.provider}/${v.view}`)).toEqual(['claude/global', 'codex/global', 'muse/global'])
    expect(views[0]!.skills).toEqual([])
    expect(views[0]!.viewDigest).toBe(viewDigest([]))
  })

  it('gives a workspace its own view only when what its threads get differs from the global view', () => {
    const rows = [row({ name: 'tidy' }), row({ name: 'deploy', workspaceId: 'w1', harnesses: ['codex'] })]
    const views = planViews(rows, ['w1', 'w2'])
    expect(views.map((v) => `${v.provider}/${v.view}`)).toEqual(['claude/global', 'codex/global', 'codex/ws-w1', 'muse/global'])
    expect(views.find((v) => v.view === 'ws-w1')!.skills.map((s) => s.name)).toEqual(['deploy', 'tidy'])
    // A workspace row only claude would read, and an exact copy of the global row, change nothing for codex.
    expect(planView(rows, 'claude', 'w1').view).toBe('global')
    expect(planView(rows, 'codex', 'w2').view).toBe('global')
  })

  it('a disabled or a harness-excluded workspace row shadows the global one of its name', () => {
    const rows = [row({ name: 'tidy' }), row({ name: 'tidy', workspaceId: 'w1', enabled: false }), row({ name: 'tidy', workspaceId: 'w2', harnesses: ['muse'] })]
    expect(planView(rows, 'claude', 'w1')).toMatchObject({ view: 'ws-w1', skills: [] })
    expect(planView(rows, 'claude', 'w2')).toMatchObject({ view: 'ws-w2', skills: [] })
    expect(planView(rows, 'muse', 'w2').skills.map((s) => s.workspaceId)).toEqual(['w2'])
    expect(planView(rows, 'claude', null).skills.map((s) => s.name)).toEqual(['tidy'])
  })

  it('leaves out other harnesses\' rows and disabled rows, and sorts by name', () => {
    const rows = [row({ name: 'zeta' }), row({ name: 'alpha', harnesses: ['claude', 'muse'] }), row({ name: 'off', enabled: false }), row({ name: 'cx', harnesses: ['codex'] })]
    expect(planView(rows, 'claude', null).skills.map((s) => s.name)).toEqual(['alpha', 'zeta'])
    expect(planView(rows, 'codex', null).skills.map((s) => s.name)).toEqual(['cx', 'zeta'])
    expect(planView(rows, 'muse', null).skills.map((s) => s.name)).toEqual(['alpha', 'zeta'])
  })
})

describe('workspaceForPath', () => {
  let tmp: string
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tc-views-')))
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('takes the deepest workspace holding the folder, through a symlink, on a path boundary', () => {
    mkdirSync(join(tmp, 'work/app/sub'), { recursive: true })
    mkdirSync(join(tmp, 'work/apple'), { recursive: true })
    symlinkSync(join(tmp, 'work'), join(tmp, 'link'))
    const ws = [
      { id: 'outer', path: join(tmp, 'work') },
      { id: 'inner', path: join(tmp, 'link/app') }
    ]
    expect(workspaceForPath(ws, join(tmp, 'work/app/sub'))).toBe('inner')
    expect(workspaceForPath(ws, join(tmp, 'link/app'))).toBe('inner')
    expect(workspaceForPath(ws, join(tmp, 'work/apple'))).toBe('outer')
    // A folder that is not there yet still reads by its real parent.
    expect(workspaceForPath(ws, join(tmp, 'link/app/.claude/worktrees/x'))).toBe('inner')
    expect(workspaceForPath(ws, tmp)).toBeNull()
  })
})

describe('a thread\'s workspace', () => {
  let tmp: string
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tc-views-ws-')))
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  it('a worktree project\'s thread, outside its workspace\'s folder, is its project\'s workspace\'s; a loose chat keeps its own', () => {
    mkdirSync(join(tmp, 'work/app'), { recursive: true })
    mkdirSync(join(tmp, '.temp-code/worktrees/fix-x/sub'), { recursive: true })
    const workspaces = [{ id: 'w1', path: join(tmp, 'work/app') }]
    const projects = [{ id: 'p1', workspaceId: 'w1', cwd: join(tmp, '.temp-code/worktrees/fix-x') }]
    // A project thread carries no workspaceId of its own: the project row has it.
    expect(workspaceOfThread({ workspaceId: null, projectId: 'p1', cwd: join(tmp, '.temp-code/worktrees/fix-x') }, workspaces, projects)).toBe('w1')
    expect(workspaceOfThread({ workspaceId: 'w2', projectId: null, cwd: tmp }, workspaces, projects)).toBe('w2')
    expect(workspaceOfThread({ workspaceId: null, projectId: null, cwd: tmp }, workspaces, projects)).toBeNull()
    // The slash menu knows only the folder: a project's checkout counts as its workspace's.
    expect(workspaceForCwd(workspaces, projects, join(tmp, '.temp-code/worktrees/fix-x/sub'))).toBe('w1')
    expect(workspaceForPath(workspaces, join(tmp, '.temp-code/worktrees/fix-x/sub'))).toBeNull()
  })
})
