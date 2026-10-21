import { describe, expect, it } from 'vitest'
import {
  isProjectPlanPath,
  milestoneAt,
  milestoneOrchestrationBrief,
  milestonePlanningBrief,
  milestoneProgress,
  milestoneSummary,
  nextMilestone,
  parseProjectPlan,
  planMayAutoStart,
  projectPlanComplete,
  projectPlanPathFor,
  setMilestoneDone,
  setPlanStatus
} from './projectPlan'

const DOC = `# Acme — project plan

## Goals
Ship the thing.

## Current state
Half built.

## Milestones

### [x] 1. Data model
- Scope: tables and migrations
- Dependencies: none
- Done when: the schema test passes

### [ ] 2. API
- **Scope:** the REST layer
- Dependencies: 1
- Done when: e2e passes

### 3. UI
Scope: screens
Depends on: 2
Done-when: the screens render

## Risks
- time

## Open questions
- none
`

describe('projectPlan paths', () => {
  it('names one file per project under .temp-code/plans', () => {
    expect(projectPlanPathFor('/repo/')).toBe('/repo/.temp-code/plans/project.md')
    expect(isProjectPlanPath('/repo/.temp-code/plans/project.md')).toBe(true)
    expect(isProjectPlanPath('/repo/.temp-code/plan-abc.md')).toBe(false)
    expect(isProjectPlanPath(null)).toBe(false)
  })

  it('never lets a project plan auto-start a build; an ordinary plan may', () => {
    expect(planMayAutoStart('project-plan')).toBe(false)
    expect(planMayAutoStart('planning')).toBe(true)
    expect(planMayAutoStart(null)).toBe(false)
  })
})

describe('parseProjectPlan', () => {
  it('reads the title, every fixed section and the milestones with their fields', () => {
    const plan = parseProjectPlan(DOC)
    expect(plan.title).toBe('Acme — project plan')
    expect(plan.missing).toEqual([])
    expect(plan.status).toBeNull()
    expect(Object.keys(plan.sections)).toEqual(['Goals', 'Current state', 'Milestones', 'Risks', 'Open questions'])
    expect(plan.sections.Goals).toBe('Ship the thing.')
    expect(plan.milestones.map((m) => [m.index, m.title, m.done])).toEqual([
      [1, 'Data model', true],
      [2, 'API', false],
      [3, 'UI', false]
    ])
    const [a, b, c] = plan.milestones
    expect(a.scope).toBe('tables and migrations')
    expect(a.dependencies).toBe('none')
    expect(a.doneWhen).toBe('the schema test passes')
    expect(b.scope).toBe('the REST layer')
    expect(c.dependencies).toBe('2')
    expect(c.doneWhen).toBe('the screens render')
    expect(c.body).toBe('Scope: screens\nDepends on: 2\nDone-when: the screens render')
  })

  it('names the fixed sections a document lacks, case-insensitively', () => {
    const plan = parseProjectPlan('# x\n\n## goals\nok\n\n## Milestones\n### A\n')
    expect(plan.missing).toEqual(['Current state', 'Risks', 'Open questions'])
    expect(plan.milestones).toEqual([
      expect.objectContaining({ index: 1, title: 'A', done: false })
    ])
  })

  it('ignores ### headings outside Milestones and inside code fences', () => {
    const plan = parseProjectPlan('## Risks\n### not a milestone\n## Milestones\n```\n### fenced\n```\n### [ ] 1. Real\n')
    expect(plan.milestones.map((m) => m.title)).toEqual(['Real'])
  })

  it('reads the frontmatter status without counting it as content', () => {
    const plan = parseProjectPlan('---\nstatus: complete\ncompleted: 2026-10-21T00:00:00.000Z\n---\n# T\n## Milestones\n### [ ] 1. A\n')
    expect(plan.status).toBe('complete')
    expect(plan.completedAt).toBe('2026-10-21T00:00:00.000Z')
    expect(plan.title).toBe('T')
    expect(plan.milestones[0].line).toBe(6)
  })
})

describe('milestone ticks', () => {
  it('counts progress and finds the next milestone in document order', () => {
    expect(milestoneProgress(DOC)).toEqual({ done: 1, total: 3 })
    expect(nextMilestone(DOC)?.index).toBe(2)
    expect(milestoneSummary(DOC)).toBe('Plan · 1 of 3 milestones done')
    expect(milestoneSummary('# t\n## Milestones\n')).toBe('Plan')
    expect(milestoneSummary(null)).toBeNull()
  })

  it('ticks and unticks one heading, keeping its number and title, and leaves the rest byte for byte', () => {
    const ticked = setMilestoneDone(DOC, 2, true)
    expect(ticked).toContain('### [x] 2. API')
    expect(ticked.replace('### [x] 2. API', '### [ ] 2. API')).toBe(DOC)
    expect(milestoneAt(ticked, 2)?.done).toBe(true)
    const unnumbered = setMilestoneDone(DOC, 3, true)
    expect(unnumbered).toContain('### [x] 3. UI')
    expect(setMilestoneDone(DOC, 1, false)).toContain('### [ ] 1. Data model')
    expect(setMilestoneDone(DOC, 9, true)).toBe(DOC)
    // Frontmatter shifts no lines: the tick lands on the heading, not above it.
    const withFm = setPlanStatus(DOC, 'in-progress')
    expect(setMilestoneDone(withFm, 2, true)).toContain('### [x] 2. API')
  })

  it('setPlanStatus writes frontmatter once and complete carries a timestamp', () => {
    const now = new Date('2026-10-21T12:00:00.000Z')
    const done = setPlanStatus(DOC, 'complete', now)
    expect(done.startsWith('---\nstatus: complete\ncompleted: 2026-10-21T12:00:00.000Z\n---\n# Acme')).toBe(true)
    expect(projectPlanComplete(done)).toBe(true)
    expect(projectPlanComplete(DOC)).toBe(false)
    const again = setPlanStatus(done, 'in-progress')
    expect(again.startsWith('---\nstatus: in-progress\n---\n# Acme')).toBe(true)
    expect(again.match(/^---$/gm)?.length).toBe(2)
    expect(parseProjectPlan(again).milestones.length).toBe(3)
  })
})

describe('milestone briefs', () => {
  it('name the milestone, its fields and the plan file, and fence the scope', () => {
    const m = milestoneAt(DOC, 2)!
    const brief = milestonePlanningBrief('/repo/.temp-code/plans/project.md', m)
    expect(brief).toContain('Plan milestone 2 of the project plan at /repo/.temp-code/plans/project.md: "API"')
    expect(brief).toContain('Scope: the REST layer')
    expect(brief).toContain('Done when: e2e passes')
    expect(brief).toContain('plan ONLY this milestone')
    const orch = milestoneOrchestrationBrief('/p/.temp-code/plans/project.md', m)
    expect(orch).toContain('Orchestrate milestone 2')
    expect(orch).toContain('split this one milestone across subagents')
  })
})
