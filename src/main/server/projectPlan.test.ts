import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/events'
import { openDb, Store } from './db'
import { isPlanSettle } from './planFlow'
import { ProjectPlans, handleProjectPlan, inheritMilestoneLink, milestoneLinkOf } from './projectPlan'

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let plans: ProjectPlans
const sessions = new Map<string, SessionMeta>()

const PLAN = `# Acme — project plan

## Goals
ship

## Current state
half

## Milestones

### [ ] 1. Data model
- Scope: tables
- Dependencies: none
- Done when: schema test passes

### [ ] 2. API
- Scope: rest
- Dependencies: 1
- Done when: e2e passes

## Risks
none

## Open questions
none
`

const session = (id: string, over: Partial<SessionMeta>): SessionMeta => {
  const s = {
    id,
    parentId: null,
    projectId: 'p1',
    workspaceId: null,
    threadType: 'chat',
    planPath: null,
    provider: 'claude',
    model: 'm',
    reasoning: 'medium',
    agentType: 'implementer',
    title: id,
    cwd: '',
    status: 'idle',
    pinned: false,
    archived: false,
    permission: 'ask',
    fast: false,
    ultrafast: false,
    context1m: false,
    busySince: null,
    pausedAt: null,
    frozenActiveElapsed: null,
    nativeId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over
  } as SessionMeta
  sessions.set(id, s)
  return s
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-project-plan-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  sessions.clear()
  store.insertWorkspace({ id: 'ws1', name: 'repo', path: root, git: false, createdAt: 1 })
  store.insertProject({ id: 'p1', workspaceId: 'ws1', name: 'acme', mode: 'local', branch: null, cwd: root, archived: false, createdAt: 1 })
  plans = new ProjectPlans(store, {
    getProject: (id) => (id === 'p1' ? { id, cwd: root } : null),
    sessionsOfProject: (id) => [...sessions.values()].filter((s) => s.projectId === id),
    getSession: (id) => sessions.get(id) ?? null
  })
})
afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

const planPath = (): string => join(root, '.temp-code', 'plans', 'project.md')
const writePlan = (text = PLAN): void => {
  mkdirSync(join(root, '.temp-code', 'plans'), { recursive: true })
  writeFileSync(planPath(), text)
}

describe('ProjectPlans.state', () => {
  it('is null with no file and no plan thread, and names the file once either exists', () => {
    expect(plans.state('p1')).toBeNull()
    expect(plans.state('nope')).toBeNull()
    session('pp', { threadType: 'project-plan', planPath: planPath(), createdAt: 5 })
    expect(plans.state('p1')).toEqual({
      projectId: 'p1',
      path: planPath(),
      exists: false,
      pinned: false,
      sessionId: 'pp',
      complete: false,
      milestones: [],
      missing: []
    })
    writePlan()
    const state = plans.state('p1')!
    expect(state.exists).toBe(true)
    expect(state.milestones).toEqual([
      { index: 1, title: 'Data model', done: false },
      { index: 2, title: 'API', done: false }
    ])
  })

  it('names the newest project-plan thread, archived or not', () => {
    session('old', { threadType: 'project-plan', createdAt: 1, archived: true })
    session('new', { threadType: 'project-plan', createdAt: 9 })
    session('plan', { threadType: 'planning', createdAt: 99 })
    expect(plans.state('p1')?.sessionId).toBe('new')
  })
})

describe('plan_complete', () => {
  it('marks a project plan complete in its frontmatter and tells the thread to stop', () => {
    writePlan()
    session('pp', { threadType: 'project-plan', planPath: planPath() })
    const changed: string[] = []
    plans.onChange((id) => changed.push(id))
    const out = plans.complete('pp')
    expect(out).toContain('The project plan is complete: 2 milestones')
    expect(out).toContain('nothing starts from this thread')
    expect(readFileSync(planPath(), 'utf8').startsWith('---\nstatus: complete\ncompleted: ')).toBe(true)
    expect(plans.state('p1')?.complete).toBe(true)
    expect(changed).toEqual(['p1'])
  })

  it('refuses a plan that lacks a fixed section or has no milestone, naming what is missing', () => {
    session('pp', { threadType: 'project-plan', planPath: planPath() })
    expect(plans.complete('pp')).toContain('does not exist yet')
    writePlan('# t\n\n## Goals\nx\n\n## Milestones\n### [ ] 1. A\n')
    expect(plans.complete('pp')).toBe('refused: the plan lacks the sections ## Current state, ## Risks, ## Open questions. Add them, then call plan_complete again.')
    writePlan('# t\n## Goals\n## Current state\n## Milestones\n## Risks\n## Open questions\n')
    expect(plans.complete('pp')).toContain('has no `### [ ] N. <title>` milestone yet')
    expect(plans.state('p1')?.complete).toBe(false)
  })

  it('acknowledges an ordinary plan and refuses other thread types; never touches the file', () => {
    writePlan()
    session('pl', { threadType: 'planning', planPath: join(root, '.temp-code', 'plan-pl.md') })
    session('ch', { threadType: 'chat' })
    expect(plans.complete('pl')).toMatch(/^noted:/)
    expect(plans.complete('ch')).toMatch(/^refused: plan_complete is for planning and project-plan threads, not a chat thread/)
    expect(plans.complete('ghost')).toMatch(/^refused: unknown session/)
    expect(readFileSync(planPath(), 'utf8')).toBe(PLAN)
  })
})

describe('pin, ticks and milestone links', () => {
  it('pins and unpins the plan for the project', () => {
    writePlan()
    expect(plans.pin('p1', true)?.pinned).toBe(true)
    expect(plans.pinned('p1')).toBe(true)
    expect(plans.pin('p1', false)?.pinned).toBe(false)
    expect(() => plans.pin('nope', true)).toThrow(/unknown project/)
  })

  it('ticks a milestone by hand in the file and reports a missing one', () => {
    writePlan()
    const changed: string[] = []
    plans.onChange((id) => changed.push(id))
    expect(plans.tick('p1', 2, true)).toBe(true)
    expect(readFileSync(planPath(), 'utf8')).toContain('### [x] 2. API')
    expect(plans.state('p1')?.milestones[1].done).toBe(true)
    expect(plans.tick('p1', 2, true)).toBe(true) // already there
    expect(plans.tick('p1', 7, true)).toBe(false)
    expect(plans.tick('nope', 1, true)).toBe(false)
    expect(changed).toEqual(['p1'])
  })

  it('a build inherits the milestone of the plan thread it was started from, and landing ticks it', () => {
    writePlan()
    const plan = session('plan-m2', { threadType: 'planning', planPath: join(root, '.temp-code', 'plan-m2.md') })
    plans.link('plan-m2', { projectId: 'p1', milestone: 2 })
    expect(plans.linkOf('plan-m2')).toEqual({ projectId: 'p1', milestone: 2 })
    const build = session('build', { threadType: 'implementation', planPath: plan.planPath })
    inheritMilestoneLink(store, build, plan)
    expect(milestoneLinkOf(store, 'build')).toEqual({ projectId: 'p1', milestone: 2 })
    // A chat from the same plan inherits nothing; an explicit link is kept.
    const chat = session('chat', { threadType: 'chat', planPath: plan.planPath })
    inheritMilestoneLink(store, chat, plan)
    expect(milestoneLinkOf(store, 'chat')).toBeNull()
    expect(plans.landed('p1')).toEqual([2])
    expect(plans.state('p1')?.milestones.map((m) => m.done)).toEqual([false, true])
    // Landing again ticks nothing new; a link to another project is ignored.
    expect(plans.landed('p1')).toEqual([])
    expect(() => plans.link('ghost', { projectId: 'p1', milestone: 1 })).toThrow(/unknown session/)
  })

  it('handleProjectPlan routes the five methods and leaves others alone', () => {
    writePlan()
    session('pp', { threadType: 'project-plan', planPath: planPath() })
    const req = (method: string, params: Record<string, unknown>) =>
      handleProjectPlan({ id: '1', method, params } as never, plans)
    expect(req('projectPlan.get', { projectId: 'p1' })).toMatchObject({ handled: true, result: { projectId: 'p1', sessionId: 'pp' } })
    expect(req('projectPlan.pin', { projectId: 'p1', pinned: true })).toMatchObject({ handled: true, result: { pinned: true } })
    expect(req('projectPlan.tick', { projectId: 'p1', milestone: 1, done: true })).toMatchObject({
      handled: true,
      result: { ticked: true, state: { milestones: [{ index: 1, done: true }, { index: 2, done: false }] } }
    })
    expect(req('projectPlan.link', { sessionId: 'pp', projectId: 'p1', milestone: 2 })).toEqual({ handled: true, result: null })
    expect(req('projectPlan.linkOf', { sessionId: 'pp' })).toEqual({ handled: true, result: { projectId: 'p1', milestone: 2 } })
    expect(req('session.list', {})).toEqual({ handled: false })
  })
})

describe('never auto-started', () => {
  it("the plan flow's settle rule never fires for a project plan, complete or not, whatever the setting", () => {
    const pp = session('pp', { threadType: 'project-plan', planPath: planPath(), planCompletedAt: Date.now() })
    expect(isPlanSettle('running', 'idle', pp)).toBe(false)
    expect(isPlanSettle('running', 'idle', { ...pp, planCompletedAt: null })).toBe(false)
    const ordinary = session('pl', { threadType: 'planning', planPath: '/x/plan.md', planCompletedAt: Date.now() })
    expect(isPlanSettle('running', 'idle', ordinary)).toBe(true)
  })

  it('plan_complete on a project plan stamps nothing the plan flow reads and starts no thread', () => {
    writePlan()
    const pp = session('pp', { threadType: 'project-plan', planPath: planPath() })
    plans.complete('pp')
    expect(pp.planCompletedAt ?? null).toBeNull()
    expect([...sessions.values()].filter((s) => s.threadType === 'implementation')).toEqual([])
  })
})
