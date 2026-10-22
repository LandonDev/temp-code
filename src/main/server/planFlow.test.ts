import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent, Attachment, SessionMeta } from '@shared/events'
import type { CreateSessionInput } from '@shared/contract'
import { DEFAULT_PLAN_SETTINGS } from '@shared/plans'
import {
  completePlan,
  countTasks,
  implementPlan,
  isPlanSettle,
  linkPlanHandoff,
  notifyStarter,
  reopenPlan,
  resetPlanFlowForTests,
  resolvePlanSettings,
  setPlanSettings,
  settlePlan,
  type PlanFlowRegistry
} from './planFlow'

/** An in-memory registry: sessions, settings, rows, reports — what the flow touches. */
class Fake implements PlanFlowRegistry {
  sessions = new Map<string, SessionMeta>()
  settings = new Map<string, string>()
  rows: { id: string; event: AgentEvent }[] = []
  sends: { id: string; text: string; attachments?: Attachment[] }[] = []
  reports: { to: string; agentId: string; status: string; text: string }[] = []
  archived: string[] = []
  created: CreateSessionInput[] = []
  logs: string[] = []
  private n = 0

  add(id: string, patch: Partial<SessionMeta> = {}): SessionMeta {
    const meta: SessionMeta = {
      id,
      parentId: null,
      projectId: 'proj',
      workspaceId: null,
      threadType: 'planning',
      planPath: null,
      provider: 'claude',
      model: 'claude-haiku-5-5',
      reasoning: 'high',
      agentType: 'implementer',
      title: `Plan: ${id}`,
      cwd: '/tmp/x',
      status: 'running',
      pinned: false,
      archived: false,
      permission: 'auto',
      fast: false,
      ultrafast: false,
      context1m: true,
      busySince: null,
      pausedAt: null,
      frozenActiveElapsed: null,
      nativeId: null,
      planCompletedAt: null,
      implementationId: null,
      planThreadId: null,
      startedBy: null,
      createdAt: 1,
      updatedAt: 1,
      ...patch
    }
    this.sessions.set(id, meta)
    return meta
  }
  get(id: string): SessionMeta | null {
    return this.sessions.get(id) ?? null
  }
  listSessions(): SessionMeta[] {
    return [...this.sessions.values()]
  }
  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null
  }
  setSetting(key: string, value: string | null): void {
    if (value === null) this.settings.delete(key)
    else this.settings.set(key, value)
  }
  async create(input: CreateSessionInput): Promise<SessionMeta> {
    this.created.push(input)
    const id = `b${++this.n}`
    const meta = this.add(id, {
      threadType: input.threadType ?? null,
      planPath: input.planPath ?? null,
      provider: input.provider ?? 'claude',
      model: input.model ?? '',
      reasoning: input.reasoning ?? 'medium',
      context1m: input.context1m ?? false,
      permission: input.permission ?? 'edits',
      title: input.title ?? 'New task',
      projectId: input.projectId ?? null,
      status: 'idle',
      cwd: input.cwd ?? '/tmp/x'
    })
    // What the real create() does for every build born with a plan.
    linkPlanHandoff(this, meta)
    return this.get(id) ?? meta
  }
  async send(id: string, text: string, opts?: { attachments?: Attachment[] }): Promise<void> {
    this.sends.push({ id, text, attachments: opts?.attachments })
  }
  patch(id: string, patch: Partial<Pick<SessionMeta, 'planCompletedAt' | 'implementationId' | 'planThreadId'>>): SessionMeta | null {
    const cur = this.sessions.get(id)
    if (!cur) return null
    const next = { ...cur, ...patch }
    this.sessions.set(id, next)
    return next
  }
  append(id: string, event: AgentEvent): void {
    this.rows.push({ id, event })
  }
  async setArchived(id: string, archived: boolean): Promise<void> {
    this.archived.push(id)
    const cur = this.sessions.get(id)
    if (cur) this.sessions.set(id, { ...cur, archived })
  }
  deliverAgentReport(to: string, report: { agentId: string; title: string; status: string; text: string }): void {
    this.reports.push({ to, ...report })
  }
  hostName(): string {
    return 'box'
  }
  log(line: string): void {
    this.logs.push(line)
  }
}

let dir: string
let reg: Fake
const PLAN = '# Ship the widget\n\n## Tasks\n- [ ] one\n- [x] two\n'

beforeEach(() => {
  resetPlanFlowForTests()
  dir = mkdtempSync(join(tmpdir(), 'plans-'))
  reg = new Fake()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const planFile = (name = 'plan.md', body = PLAN): string => {
  const p = join(dir, name)
  writeFileSync(p, body)
  return p
}

describe('settings', () => {
  it('resolves project override → global → defaults', () => {
    expect(resolvePlanSettings(reg, 'proj')).toEqual(DEFAULT_PLAN_SETTINGS)
    setPlanSettings(reg, null, { ...DEFAULT_PLAN_SETTINGS, autoImplement: false })
    expect(resolvePlanSettings(reg, 'proj').autoImplement).toBe(false)
    setPlanSettings(reg, 'proj', { ...DEFAULT_PLAN_SETTINGS, implementModel: 'gpt-6.1-sol' })
    expect(resolvePlanSettings(reg, 'proj')).toMatchObject({ autoImplement: true, implementModel: 'gpt-6.1-sol' })
    setPlanSettings(reg, 'proj', null)
    expect(resolvePlanSettings(reg, 'proj').autoImplement).toBe(false)
  })
  it('counts checklist tasks', () => {
    expect(countTasks(PLAN)).toBe(2)
    expect(countTasks('# no tasks\n- a bullet')).toBe(0)
  })
})

describe('completePlan (detection)', () => {
  it('refuses outside a planning thread and while the plan file is empty', async () => {
    reg.add('impl', { threadType: 'implementation', planPath: planFile() })
    expect(await completePlan(reg, 'impl')).toMatch(/^refused: plan_complete is for planning threads/)
    reg.add('p', { planPath: join(dir, 'missing.md') })
    expect(await completePlan(reg, 'p')).toMatch(/missing or empty/)
    reg.add('e', { planPath: planFile('empty.md', '  \n') })
    expect(await completePlan(reg, 'e')).toMatch(/missing or empty/)
    expect(reg.get('p')!.planCompletedAt).toBeNull()
  })
  it('stamps a running planner and defers the start to its settle', async () => {
    reg.add('p', { planPath: planFile() })
    const r = await completePlan(reg, 'p')
    expect(r).toMatchObject({ ok: true, title: 'Ship the widget', implementationId: null })
    expect((r as { next: string }).next).toMatch(/starts on box the moment this turn ends/)
    expect(reg.get('p')!.planCompletedAt).toBeTypeOf('number')
    expect(reg.created).toHaveLength(0)
  })
  it('tells the planner when auto-start is off', async () => {
    setPlanSettings(reg, null, { ...DEFAULT_PLAN_SETTINGS, autoImplement: false })
    reg.add('p', { planPath: planFile() })
    expect((await completePlan(reg, 'p')) as { next: string }).toMatchObject({ next: expect.stringMatching(/auto-start is off/) })
  })
  it('fires at once for a planner that is not mid-turn, and is idempotent', async () => {
    reg.add('p', { planPath: planFile(), status: 'idle' })
    const first = await completePlan(reg, 'p')
    expect(first).toMatchObject({ ok: true, implementationId: 'b1' })
    const again = await completePlan(reg, 'p')
    expect(again).toMatchObject({ ok: true, implementationId: 'b1', next: expect.stringMatching(/already complete/) })
    expect(reg.created).toHaveLength(1)
  })
  it('isPlanSettle: only a completed, unbuilt planning thread leaving running for idle or watching', () => {
    const p = reg.add('p', { planPath: 'x', planCompletedAt: 5 })
    expect(isPlanSettle('running', 'idle', p)).toBe(true)
    expect(isPlanSettle('running', 'watching', p)).toBe(true)
    expect(isPlanSettle('starting', 'idle', p)).toBe(true)
    expect(isPlanSettle('watching', 'idle', p)).toBe(false)
    expect(isPlanSettle('running', 'error', p)).toBe(false)
    expect(isPlanSettle('running', 'idle', { ...p, planCompletedAt: null })).toBe(false)
    expect(isPlanSettle('running', 'idle', { ...p, implementationId: 'b' })).toBe(false)
    expect(isPlanSettle('running', 'idle', { ...p, threadType: 'chat' })).toBe(false)
    expect(isPlanSettle('running', 'idle', null)).toBe(false)
  })
  it('reopenPlan clears the mark of a completed plan without a build only', () => {
    const p = reg.add('p', { planPath: 'x', planCompletedAt: 5 })
    reopenPlan(reg, p)
    expect(reg.get('p')!.planCompletedAt).toBeNull()
    const built = reg.add('q', { planPath: 'x', planCompletedAt: 5, implementationId: 'b' })
    reopenPlan(reg, built)
    expect(reg.get('q')!.planCompletedAt).toBe(5)
  })
})

describe('implementPlan (inheritance and overrides)', () => {
  it('inherits host, cwd, model, effort and the 1M window; seeds the plan thread; titles from the heading', async () => {
    reg.add('p', { planPath: planFile(), status: 'idle', cwd: '/work/here', projectId: null })
    const built = await implementPlan(reg, 'p')
    expect(reg.created[0]).toMatchObject({
      provider: 'claude',
      model: 'claude-haiku-5-5',
      reasoning: 'high',
      context1m: true,
      permission: 'auto',
      threadType: 'implementation',
      planPath: reg.get('p')!.planPath,
      title: 'Ship the widget',
      cwd: '/work/here',
      goal: "Every task in the plan's checklist is checked off and typecheck passes"
    })
    expect(reg.sends[0]).toMatchObject({ id: built.id, text: 'Implement the plan "Ship the widget".' })
    expect(reg.sends[0].attachments).toEqual([{ path: 'thread:p', name: 'Plan: p', kind: 'thread', sessionId: 'p' }])
    expect(reg.get('p')).toMatchObject({ implementationId: built.id })
    expect(reg.get(built.id)).toMatchObject({ planThreadId: 'p' })
  })
  it("a plan child's build stays in the batch: masterId, after and the master as startedBy travel", async () => {
    reg.add('p', { planPath: planFile(), status: 'idle', masterId: 'master', after: 'sib', startedBy: 'master' })
    const built = await implementPlan(reg, 'p')
    expect(reg.created[0]).toMatchObject({ masterId: 'master', after: 'sib', startedBy: 'master', planPath: reg.get('p')!.planPath })
    expect(reg.get(built.id)).toMatchObject({ planThreadId: 'p' })
    // A plan outside any batch carries none of it.
    reg.add('q', { planPath: planFile(), status: 'idle' })
    await implementPlan(reg, 'q')
    expect(reg.created[1]).not.toHaveProperty('masterId')
    expect(reg.created[1]).not.toHaveProperty('after')
    expect(reg.created[1]).not.toHaveProperty('startedBy')
  })
  it('a fixed plans.implementModel routes to its own provider and clamps the effort to that ladder', async () => {
    setPlanSettings(reg, 'proj', { ...DEFAULT_PLAN_SETTINGS, implementModel: 'gpt-6.1-sol', implementReasoning: 'xhigh' })
    reg.add('p', { planPath: planFile(), status: 'idle' })
    await implementPlan(reg, 'p')
    expect(reg.created[0]).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', reasoning: 'xhigh' })
    // Codex never gets the 1M flag, whatever the plan ran with.
    expect(reg.created[0].context1m).toBeUndefined()
  })
  it('plans.implementContext fixes the window; explicit options win over settings', async () => {
    setPlanSettings(reg, null, { ...DEFAULT_PLAN_SETTINGS, implementContext: '200k', implementReasoning: 'low' })
    reg.add('p', { planPath: planFile(), status: 'idle' })
    await implementPlan(reg, 'p', { reasoning: 'max', threadType: 'orchestration', goal: 'done when green' })
    expect(reg.created[0]).toMatchObject({ reasoning: 'max', threadType: 'orchestration', goal: 'done when green' })
    expect(reg.created[0].context1m).toBeUndefined()
    expect(reg.sends[0].text).toMatch(/^Orchestrate/)
  })
  it("a hand-off is the person's choice: an orchestrators-only model is not refused to a chat-role plan thread", async () => {
    // The model policy by role (apptools.ts) governs what a THREAD may
    // start; a plan → build hand-off never passes through it. Fable is
    // orchestrators-only by default and a planning thread is a 'thread'.
    reg.add('p', { planPath: planFile(), status: 'idle', model: 'claude-fable-5-1', reasoning: 'high' })
    const built = await implementPlan(reg, 'p')
    expect(reg.created[0]).toMatchObject({ provider: 'claude', model: 'claude-fable-5-1', reasoning: 'high' })
    expect(reg.get(built.id)).toMatchObject({ planThreadId: 'p' })
  })
  it('answers the live build instead of starting a second one', async () => {
    reg.add('p', { planPath: planFile(), status: 'idle' })
    const first = await implementPlan(reg, 'p')
    const second = await implementPlan(reg, 'p')
    expect(second.id).toBe(first.id)
    expect(reg.created).toHaveLength(1)
  })
  it('refuses a plan without a document', async () => {
    reg.add('p', { planPath: join(dir, 'none.md'), status: 'idle' })
    await expect(implementPlan(reg, 'p')).rejects.toThrow(/missing or empty/)
  })
})

describe('linkPlanHandoff (the archive and the row)', () => {
  it('links both ways, leaves a handoff row, and archives the settled plan thread', async () => {
    reg.add('p', { planPath: planFile(), status: 'idle' })
    await implementPlan(reg, 'p')
    expect(reg.rows).toEqual([{ id: 'p', event: { type: 'plan-handoff', sessionId: 'b1', title: 'Ship the widget', how: 'manual' } }])
    expect(reg.archived).toEqual(['p'])
  })
  it('plans.archiveAfterStart off keeps the plan thread', async () => {
    setPlanSettings(reg, null, { ...DEFAULT_PLAN_SETTINGS, archiveAfterStart: false })
    reg.add('p', { planPath: planFile(), status: 'idle' })
    await implementPlan(reg, 'p')
    expect(reg.archived).toEqual([])
    expect(reg.get('p')!.implementationId).toBe('b1')
  })
  it('never archives a planner mid-turn (a build started by hand while it speaks)', async () => {
    reg.add('p', { planPath: planFile(), status: 'running' })
    await reg.create({ threadType: 'implementation', planPath: reg.get('p')!.planPath!, provider: 'claude', model: 'm', title: 'By hand' })
    expect(reg.archived).toEqual([])
    expect(reg.rows[0].event).toMatchObject({ type: 'plan-handoff', how: 'manual', title: 'By hand' })
    expect(reg.get('p')!.implementationId).toBe('b1')
  })
})

describe('settlePlan (the auto path and the notifications)', () => {
  it('auto-starts the build on settle and wakes the thread that started the plan', async () => {
    reg.add('parent', { threadType: 'orchestration', status: 'idle' })
    const p = reg.add('p', { planPath: planFile(), planCompletedAt: 5, startedBy: 'parent', status: 'idle' })
    const built = await settlePlan(reg, p)
    expect(built?.id).toBe('b1')
    expect(reg.rows[0].event).toMatchObject({ type: 'plan-handoff', how: 'auto' })
    expect(reg.archived).toEqual(['p'])
    expect(reg.reports).toHaveLength(1)
    expect(reg.reports[0]).toMatchObject({ to: 'parent', agentId: 'p', status: 'done' })
    expect(reg.reports[0].text).toContain('<subagent-report>')
    expect(reg.reports[0].text).toContain(`Plan "Ship the widget" is done: ${p.planPath}. Implementation thread b1 started on box.`)
  })
  it('with auto-start off, nothing starts and the starter hears it is waiting', async () => {
    setPlanSettings(reg, null, { ...DEFAULT_PLAN_SETTINGS, autoImplement: false })
    reg.add('parent', { threadType: 'chat', status: 'running' })
    const p = reg.add('p', { planPath: planFile(), planCompletedAt: 5, parentId: 'parent' })
    expect(await settlePlan(reg, p)).toBeNull()
    expect(reg.created).toHaveLength(0)
    expect(reg.archived).toEqual([])
    expect(reg.reports[0]).toMatchObject({ to: 'parent', status: 'idle' })
    expect(reg.reports[0].text).toContain('Waiting for you to start it')
  })
  it('a person-started plan reports to nobody (the notifier carries it); an archived starter is skipped', async () => {
    const p = reg.add('p', { planPath: planFile(), planCompletedAt: 5 })
    expect(notifyStarter(reg, p, null, DEFAULT_PLAN_SETTINGS)).toBe(false)
    reg.add('gone', { archived: true })
    const q = reg.add('q', { planPath: planFile(), planCompletedAt: 5, startedBy: 'gone' })
    expect(notifyStarter(reg, q, null, DEFAULT_PLAN_SETTINGS)).toBe(false)
    expect(reg.reports).toHaveLength(0)
  })
  it('a failed auto-start is logged and the starter still hears', async () => {
    reg.add('parent', { threadType: 'chat', status: 'idle' })
    const p = reg.add('p', { planPath: join(dir, 'vanished.md'), planCompletedAt: 5, startedBy: 'parent' })
    expect(await settlePlan(reg, p)).toBeNull()
    expect(reg.logs[0]).toMatch(/auto-start of plan p failed/)
    expect(reg.reports[0].text).toContain('could not be started')
  })
})
