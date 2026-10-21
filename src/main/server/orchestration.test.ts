import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CATALOG, supportsContext1m, type ProviderId } from '@shared/catalog'
import { DEFAULT_RULES, type OrchestrationRules } from '@shared/rules'
import type { SessionMeta } from '@shared/events'
import type { SessionRegistry } from './sessions'
import {
  extraWriteRoots,
  findingsContract,
  isMasterSession,
  MASTER_MECHANICS,
  mechanicsFor,
  notifyParentOfSettle,
  orchCheckAgent,
  orchListAgents,
  orchSendToAgent,
  projectPlanSpawnPrompt,
  orchSpawnAgent,
  setOrchestrationRegistry,
  settleTarget,
  SPAWN_BATCH_MAX,
  spawnableModels,
  supervisedBy,
  waitForSettled
} from './orchestration'

/** A registry stub: enough for a spawn to reach create(), nothing more.
 *  The real one starts a driver, which a unit test has no business doing. */
const created: Record<string, unknown>[] = []
const sent: string[] = []
const parent = {
  id: 'parent-1',
  provider: 'claude' as ProviderId,
  model: 'claude-opus-5',
  projectId: null,
  cwd: '/tmp/not-a-repo',
  permission: 'ask',
  threadRules: undefined
} as unknown as SessionMeta

let children: SessionMeta[] = []
let rules: OrchestrationRules = DEFAULT_RULES
/** Other sessions the stub knows (a master's batch, strangers), by id. */
let sessions: Record<string, SessionMeta> = {}
/** Projects by id; `masterThreadId` is the pin. */
let projects: Record<string, { id: string; masterThreadId: string | null }> = {}
const reports: { to: string; agentId: string; status: string; text: string }[] = []
const stub = {
  get: (id: string) => (id === parent.id ? parent : (sessions[id] ?? null)),
  childrenOf: (id: string) => (id === parent.id ? children : []),
  list: () => Object.values(sessions),
  getProject: (id: string) => projects[id] ?? null,
  getOrchestrationRules: () => rules,
  eventsAfter: () => [],
  lastActivityAt: () => Date.now(),
  hostName: () => 'box',
  deliverAgentReport: (to: string, r: { agentId: string; status: string; text: string }) => {
    reports.push({ to, agentId: r.agentId, status: r.status, text: r.text })
  },
  researchRootOf: () => null,
  reportsRootFor: () => '/tmp/ws',
  create: async (params: Record<string, unknown>) => {
    created.push(params)
    return { id: String(params.id ?? `child-${created.length}`), title: String(params.title ?? '') }
  },
  send: async (_id: string, text: string) => {
    sent.push(text)
  }
}

beforeEach(() => {
  created.length = 0
  sent.length = 0
  reports.length = 0
  children = []
  sessions = {}
  projects = {}
  rules = DEFAULT_RULES
  setOrchestrationRegistry(stub as unknown as SessionRegistry)
})

afterEach(() => {
  vi.restoreAllMocks()
})

it('supportsContext1m accepts every claude model and nothing else', () => {
  for (const model of CATALOG.claude.models) {
    expect(supportsContext1m('claude', model.id)).toBe(true)
  }
  for (const provider of ['codex', 'cursor'] as ProviderId[]) {
    for (const model of CATALOG[provider].models) {
      expect(supportsContext1m(provider, model.id)).toBe(false)
    }
  }
  expect(supportsContext1m('claude', 'not-a-model')).toBe(false)
})

it('the spawnable table marks the claude rows +1m and explains the marker once', () => {
  const table = spawnableModels(DEFAULT_RULES)
  for (const model of CATALOG.claude.models) {
    expect(table).toContain(`${model.id} (low|medium|high|xhigh|max) +1m`)
  }
  for (const model of CATALOG.codex.models) {
    expect(table).not.toContain(`${model.id} (low|medium|high|xhigh|max|ultra) +1m`)
  }
  expect(table.match(/context1m: false/g)).toHaveLength(1)
})

it('the table by role: a thread sees orchestrators-only rows marked with the note, an orchestrator sees them plain, off rows never show', () => {
  const rules: OrchestrationRules = {
    ...DEFAULT_RULES,
    models: { ...DEFAULT_RULES.models, 'claude:claude-opus-5-5': { approved: false } }
  }
  const thread = spawnableModels(rules, 'thread')
  expect(thread).toContain('claude-fable-5-1 (low|medium|high|xhigh|max) +1m (orchestrators only)')
  expect(thread).toContain('Models marked orchestrators-only are available to an orchestration or master thread')
  expect(thread).not.toContain('claude-opus-5-5')
  const orch = spawnableModels(rules, 'orchestrator')
  expect(orch).toContain('claude-fable-5-1 (low|medium|high|xhigh|max) +1m\n')
  expect(orch).not.toContain('orchestrators only')
  expect(orch).not.toContain('claude-opus-5-5')
  // Nothing marked, nothing to explain.
  expect(spawnableModels({ ...DEFAULT_RULES, models: {} }, 'thread')).not.toContain('orchestrators-only')
})

it('spawn_agent with context1m on a claude model reaches create with the flag', async () => {
  const reply = await orchSpawnAgent(parent, {
    model: 'claude-opus-5',
    task: 'do the thing',
    context1m: true
  })
  expect(reply).toContain('child-1')
  expect(created).toHaveLength(1)
  expect(created[0].context1m).toBe(true)
  expect(created[0].model).toBe('claude-opus-5')
  expect(sent).toEqual(['do the thing'])
})

it('spawn_agent without context1m defaults a claude model to 1M', async () => {
  await orchSpawnAgent(parent, { model: 'claude-opus-5', task: 'do the thing' })
  expect(created[0].context1m).toBe(true)
})

it('spawn_agent with context1m: false keeps a claude model at 200k', async () => {
  await orchSpawnAgent(parent, { model: 'claude-opus-5', task: 'do the thing', context1m: false })
  expect(created[0].context1m).toBeUndefined()
})

it('spawn_agent without context1m leaves a codex model unset', async () => {
  await orchSpawnAgent(parent, { model: 'gpt-6-astra', task: 'do the thing' })
  expect(created[0].context1m).toBeUndefined()
})

it('spawn_agent names an orchestrators-only model as app_start_thread does, and an off model as not approved', async () => {
  const fable = await orchSpawnAgent(parent, { model: 'claude-fable-5-1', task: 'do the thing' })
  expect(fable).toMatch(/^refused: claude-fable-5-1 is approved for orchestrators only, and this thread \(role: thread\) may not start it/)
  expect(fable).toContain('Approved models:')
  rules = { ...DEFAULT_RULES, models: { ...DEFAULT_RULES.models, 'claude:claude-opus-5-5': { approved: false } } }
  const off = await orchSpawnAgent(parent, { model: 'claude-opus-5-5', task: 'do the thing' })
  expect(off).toMatch(/^refused: the user has not approved claude-opus-5-5 for subagents/)
  expect(created).toHaveLength(0)
})

it('spawn_agent refuses context1m on a codex model and creates nothing', async () => {
  const reply = await orchSpawnAgent(parent, {
    model: 'gpt-6-astra',
    task: 'do the thing',
    context1m: true
  })
  expect(reply).toMatch(/^refused:/)
  expect(reply).toContain('1M context window')
  expect(reply).toContain('Approved models:')
  expect(created).toHaveLength(0)
  expect(sent).toHaveLength(0)
})

const withConduct = (patch: Partial<OrchestrationRules['conduct']>): OrchestrationRules => ({
  ...DEFAULT_RULES,
  conduct: { ...DEFAULT_RULES.conduct, ...patch }
})
const live = (n: number): SessionMeta[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, status: 'running' }) as SessionMeta)

it('a batch spawns every entry in order and answers with all the ids', async () => {
  const reply = JSON.parse(
    await orchSpawnAgent(parent, {
      model: 'claude-opus-5',
      reasoning: 'high',
      agents: [{ task: 'one' }, { task: 'two', model: 'gpt-6-astra', reasoning: 'low' }, { task: 'three' }]
    })
  )
  expect(reply.agents.map((a: { agentId: string }) => a.agentId)).toEqual(['child-1', 'child-2', 'child-3'])
  expect(reply.parallel).toBe('3 of 4 allowed slots in use')
  expect(reply.note).toContain('3 agents')
  expect(created.map((c) => [c.model, c.reasoning, c.context1m])).toEqual([
    ['claude-opus-5', 'high', true],
    ['gpt-6-astra', 'low', undefined],
    ['claude-opus-5', 'high', true]
  ])
  expect(sent).toEqual(['one', 'two', 'three'])
})

it('a one-entry batch answers in the single-spawn shape', async () => {
  const reply = JSON.parse(await orchSpawnAgent(parent, { agents: [{ task: 'solo', model: 'claude-opus-5' }] }))
  expect(reply.agentId).toBe('child-1')
  expect(reply.agents).toBeUndefined()
})

it('a batch over the per-call limit is refused before anything starts', async () => {
  const reply = await orchSpawnAgent(parent, {
    model: 'claude-opus-5',
    agents: Array.from({ length: SPAWN_BATCH_MAX + 1 }, (_, i) => ({ task: `t${i}` }))
  })
  expect(reply).toMatch(/^refused: one spawn_agent call starts at most 16 agents \(17 given\)/)
  expect(created).toHaveLength(0)
})

it('a bad entry anywhere in the batch refuses the whole call, naming the slot', async () => {
  const reply = await orchSpawnAgent(parent, {
    model: 'claude-opus-5',
    agents: [{ task: 'fine' }, { task: 'fine too' }, { task: 'bad', model: 'gpt-6-astra', context1m: true }]
  })
  expect(reply).toMatch(/^refused: agents\[2\]: gpt-6-astra does not offer the 1M context window/)
  expect(created).toHaveLength(0)
  expect(sent).toHaveLength(0)
})

it('an unknown model in a batch names its slot after the refusal', async () => {
  const reply = await orchSpawnAgent(parent, { agents: [{ task: 'a', model: 'claude-opus-5' }, { task: 'b', model: 'no-such-model' }] })
  expect(reply).toMatch(/^refused: agents\[1\]: no provider serves an approved model matching "no-such-model"/)
  expect(created).toHaveLength(0)
})

it('an entry without a task is refused', async () => {
  expect(await orchSpawnAgent(parent, { model: 'claude-opus-5', agents: [{ task: 'x' }, { task: '  ' }] })).toMatch(
    /^refused: agents\[1\]: task is empty/
  )
  expect(await orchSpawnAgent(parent, { model: 'claude-opus-5' })).toMatch(/^refused: task is empty/)
  expect(created).toHaveLength(0)
})

it('the parallel cap counts the whole batch and says how many fit', async () => {
  rules = withConduct({ maxParallel: 4 })
  children = live(2)
  const reply = await orchSpawnAgent(parent, {
    model: 'claude-opus-5',
    agents: [{ task: 'a' }, { task: 'b' }, { task: 'c' }]
  })
  expect(reply).toBe(
    'refused: the user capped parallelism at 4 concurrent subagents (2 active): 2 slots free, not 3. Spawn at most 2 now and the rest after wait_for_agent.'
  )
  expect(created).toHaveLength(0)
  expect(JSON.parse(await orchSpawnAgent(parent, { model: 'claude-opus-5', agents: [{ task: 'a' }, { task: 'b' }] })).parallel).toBe(
    '4 of 4 allowed slots in use'
  )
})

it('a cap of 128 admits a full batch on top of a hundred live agents', async () => {
  rules = withConduct({ maxParallel: 128 })
  children = live(100)
  const reply = JSON.parse(
    await orchSpawnAgent(parent, {
      model: 'claude-opus-5',
      agents: Array.from({ length: SPAWN_BATCH_MAX }, (_, i) => ({ task: `t${i}` }))
    })
  )
  expect(reply.agents).toHaveLength(16)
  expect(reply.parallel).toBe('116 of 128 allowed slots in use')
})

it('the total cap counts the whole batch too', async () => {
  rules = withConduct({ maxAgents: 10, maxParallel: 0 })
  children = live(9)
  expect(await orchSpawnAgent(parent, { model: 'claude-opus-5', agents: [{ task: 'a' }, { task: 'b' }] })).toBe(
    'refused: the user capped this thread at 10 subagents total (9 already spawned): room for 1 more, not 2. Spawn at most 1 in this batch.'
  )
  children = live(10)
  expect(await orchSpawnAgent(parent, { model: 'claude-opus-5', task: 'a' })).toMatch(
    /^refused: the user capped this thread at 10 subagents total \(10 already spawned\)\. Reuse/
  )
})

it('waitForSettled sleeps through watching and resolves on the idle that follows', async () => {
  let status: SessionMeta['status'] = 'running'
  const listeners: ((row: { event: { type: string; status: string } }) => void)[] = []
  const reg = {
    get: () => ({ id: 'c', status }) as SessionMeta,
    subscribe: (_id: string, l: (row: { event: { type: string; status: string } }) => void) => {
      listeners.push(l)
      return () => {}
    }
  } as unknown as SessionRegistry
  let settled: SessionMeta | null | undefined
  void waitForSettled(reg, 'c', 0).then((m) => (settled = m))
  await Promise.resolve()
  status = 'watching'
  for (const l of listeners) l({ event: { type: 'status', status: 'watching' } })
  await Promise.resolve()
  expect(settled).toBeUndefined()
  status = 'idle'
  for (const l of listeners) l({ event: { type: 'status', status: 'idle' } })
  await Promise.resolve()
  await Promise.resolve()
  expect(settled?.status).toBe('idle')
  // Already watching when asked: still not settled.
  status = 'watching'
  let early: SessionMeta | null | undefined
  void waitForSettled(reg, 'c', 0).then((m) => (early = m))
  await Promise.resolve()
  expect(early).toBeUndefined()
})

it('extraWriteRoots grants the reports root only when it is not the cwd', () => {
  expect(extraWriteRoots('/repo/.worktrees/feature', '/repo')).toEqual(['/repo'])
  expect(extraWriteRoots('/repo', '/repo')).toEqual([])
  expect(extraWriteRoots('/repo', null)).toEqual([])
})

// ── research trees: app-assigned angle files ─────────────────────────

const researchRoot = {
  id: 'root-1',
  threadType: 'research',
  projectId: 'p1',
  cwd: '/tmp/wt'
} as unknown as SessionMeta

it('a spawn inside a research tree gets an app-assigned angle file, explorer type, no worktree, and the contract', async () => {
  setOrchestrationRegistry({ ...stub, researchRootOf: () => researchRoot } as unknown as SessionRegistry)
  const task = 'Competitor pricing: what do rivals charge?\nRead their pricing pages.'
  const reply = await orchSpawnAgent(parent, { model: 'claude-opus-5', task, useWorktree: true })
  expect(created).toHaveLength(1)
  const id = String(created[0].id)
  expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/)
  expect(reply).toContain(id)
  expect(created[0].agentType).toBe('explorer')
  expect(created[0].cwd).toBe(parent.cwd)
  expect(created[0].planPath).toBe(
    `/tmp/ws/.temp-code/reports/root-1/competitor-pricing-what-do-rivals-charge-${id.slice(0, 6)}.md`
  )
  expect(sent[0].startsWith(task)).toBe(true)
  expect(sent[0]).toContain(findingsContract(String(created[0].planPath)))
  expect(sent[0]).toContain('call cite_source')
  // A named type is kept; it still gets no worktree.
  await orchSpawnAgent(parent, { model: 'claude-opus-5', task: 'review', agentType: 'reviewer' })
  expect(created[1].agentType).toBe('reviewer')
  expect(created[1].planPath).toMatch(/\/root-1\/review-/)
})

it('outside a research tree a spawn is unchanged: implementer, no id, no planPath, bare task', async () => {
  await orchSpawnAgent(parent, { model: 'claude-opus-5', task: 'do the thing' })
  expect(created[0].id).toBeUndefined()
  expect(created[0].planPath).toBeUndefined()
  expect(created[0].agentType).toBe('implementer')
  expect(sent).toEqual(['do the thing'])
})

it('a project-plan thread spawns explorers for the survey and never a builder or another thread', () => {
  const text = projectPlanSpawnPrompt({ id: 'pp', projectId: null, threadRules: null } as unknown as SessionMeta)
  expect(text).toContain('PROJECT PLAN thread')
  expect(text).toContain('Spawn explorers')
  expect(text).toContain('Never implementers')
  expect(text).toContain('no thread of any type is\nstarted from here')
})

// ── master threads (CLAUDE.md "Master threads") ───────────────────────

const session = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id,
    title: `Thread ${id}`,
    status: 'idle',
    provider: 'claude',
    model: 'claude-haiku-5-5',
    reasoning: 'low',
    threadType: 'implementation',
    projectId: 'p1',
    parentId: null,
    masterId: null,
    archived: false,
    createdAt: 1,
    cwd: '/tmp',
    ...extra
  }) as SessionMeta

/** The parent pinned as project p1's master, with one batch thread and one subagent. */
const pinParentAsMaster = (): { batch: SessionMeta; sub: SessionMeta; stranger: SessionMeta } => {
  ;(parent as { projectId: string | null }).projectId = 'p1'
  projects = { p1: { id: 'p1', masterThreadId: parent.id } }
  const batch = session('batch-1', { masterId: parent.id, threadType: 'planning', reasoning: 'high' })
  const sub = session('sub-1', { parentId: parent.id })
  const stranger = session('other-1')
  sessions = { [batch.id]: batch, [sub.id]: sub, [stranger.id]: stranger }
  children = [sub]
  return { batch, sub, stranger }
}

afterEach(() => {
  ;(parent as { projectId: string | null }).projectId = null
})

it('supervisedBy admits a subagent and, for the master, a batch thread; never a stranger or itself', () => {
  const { batch, sub, stranger } = pinParentAsMaster()
  expect(supervisedBy(parent, sub)).toBe(true)
  expect(supervisedBy(parent, batch)).toBe(true)
  expect(supervisedBy(parent, stranger)).toBe(false)
  expect(supervisedBy(parent, parent)).toBe(false)
  // A subagent of a batch thread is the batch thread's, not the master's.
  expect(supervisedBy(parent, session('deep', { parentId: batch.id, masterId: parent.id }))).toBe(false)
  // Unpinned, the same batch thread is no longer the caller's to steer.
  projects = { p1: { id: 'p1', masterThreadId: null } }
  expect(supervisedBy(parent, batch)).toBe(false)
  expect(supervisedBy(parent, sub)).toBe(true)
})

it('isMasterSession reads the pin on the project row', () => {
  expect(isMasterSession(parent)).toBe(false)
  pinParentAsMaster()
  expect(isMasterSession(parent)).toBe(true)
  expect(isMasterSession(session('batch-1'))).toBe(false)
})

it('the supervision tools answer a batch thread and refuse a stranger with the widened text', async () => {
  const { batch, stranger } = pinParentAsMaster()
  expect(await orchSendToAgent(parent, batch.id, 'carry on')).toBe('sent')
  expect(sent).toEqual(['carry on'])
  expect(JSON.parse(await orchCheckAgent(parent, batch.id)).agentId).toBe(batch.id)
  const refused = await orchSendToAgent(parent, stranger.id, 'hi')
  expect(refused).toContain('is not a subagent or batch thread of this session')
  expect(sent).toHaveLength(1)
})

it('list_agents marks subagents and batch threads, the batch rows with type, effort and host', async () => {
  const { batch, sub } = pinParentAsMaster()
  const rows = JSON.parse(await orchListAgents(parent)) as Record<string, unknown>[]
  expect(rows.map((r) => [r.agentId, r.kind])).toEqual([
    [sub.id, 'subagent'],
    [batch.id, 'thread']
  ])
  const row = rows[1]
  expect(row.threadType).toBe('planning')
  expect(row.reasoning).toBe('high')
  expect(row.host).toBe('box')
  expect(row.status).toBe('idle')
  // Not the master: the batch rows are gone, the subagent stays.
  projects = { p1: { id: 'p1', masterThreadId: null } }
  expect((JSON.parse(await orchListAgents(parent)) as { agentId: string }[]).map((r) => r.agentId)).toEqual([sub.id])
})

it('settleTarget is the parent, else the master, never the session itself', () => {
  expect(settleTarget(session('a', { parentId: 'p' }))).toBe('p')
  expect(settleTarget(session('a', { parentId: 'p', masterId: 'm' }))).toBe('p')
  expect(settleTarget(session('a', { masterId: 'm' }))).toBe('m')
  expect(settleTarget(session('a'))).toBeNull()
  expect(settleTarget(session('a', { masterId: 'a' }))).toBeNull()
})

it('a batch thread settling reports to its master, with its type; a stranger hears nothing', () => {
  const { batch } = pinParentAsMaster()
  notifyParentOfSettle(stub as unknown as SessionRegistry, { ...batch, status: 'idle' })
  expect(reports).toHaveLength(1)
  expect(reports[0].to).toBe(parent.id)
  expect(reports[0].agentId).toBe(batch.id)
  expect(reports[0].text).toContain('batch thread "Thread batch-1" (batch-1, planning) settled with status idle')
  // A root thread with no master and no parent settles for no one.
  notifyParentOfSettle(stub as unknown as SessionRegistry, session('other-1'))
  expect(reports).toHaveLength(1)
})

it('a master messaging a batch thread that answers is one settle, one report; the master settling reports to no one', async () => {
  const { batch } = pinParentAsMaster()
  expect(await orchSendToAgent(parent, batch.id, 'do the thing')).toBe('sent')
  notifyParentOfSettle(stub as unknown as SessionRegistry, { ...batch, status: 'idle' })
  expect(reports).toHaveLength(1)
  // The report wakes the master; its own settle is nobody's business.
  notifyParentOfSettle(stub as unknown as SessionRegistry, { ...parent, status: 'idle' })
  expect(reports).toHaveLength(1)
  // Two threads naming each other as master would ping-pong forever: refused.
  sessions['loop-a'] = session('loop-a', { masterId: 'loop-b' })
  sessions['loop-b'] = session('loop-b', { masterId: 'loop-a' })
  notifyParentOfSettle(stub as unknown as SessionRegistry, sessions['loop-a'])
  expect(reports).toHaveLength(1)
})

it('a waiting batch thread reports the question it asked', () => {
  const { batch } = pinParentAsMaster()
  const withQuestion = {
    ...stub,
    eventsAfter: () => [
      {
        seq: 1,
        ts: 1,
        event: {
          type: 'question-request',
          requestId: 'q1',
          questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }]
        }
      }
    ]
  }
  notifyParentOfSettle(withQuestion as unknown as SessionRegistry, { ...batch, status: 'waiting' })
  expect(reports).toHaveLength(1)
  expect(reports[0].text).toContain('answer_agent (requestId q1)')
  expect(reports[0].text).toContain('Q: Ship it? (options: Yes | No)')
})

it('the master block rides the mechanics only for the pinned thread', () => {
  expect(mechanicsFor(parent)).not.toContain(MASTER_MECHANICS)
  pinParentAsMaster()
  expect(mechanicsFor(parent)).toContain(MASTER_MECHANICS)
  expect(MASTER_MECHANICS).toContain('never edit code yourself')
})
