import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CATALOG, supportsContext1m, type ProviderId } from '@shared/catalog'
import { DEFAULT_RULES } from '@shared/rules'
import type { SessionMeta } from '@shared/events'
import type { SessionRegistry } from './sessions'
import {
  extraWriteRoots,
  findingsContract,
  orchSpawnAgent,
  setOrchestrationRegistry,
  spawnableModels,
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

const stub = {
  get: (id: string) => (id === parent.id ? parent : null),
  childrenOf: () => [],
  getProject: () => null,
  getOrchestrationRules: () => DEFAULT_RULES,
  researchRootOf: () => null,
  reportsRootFor: () => '/tmp/ws',
  create: async (params: Record<string, unknown>) => {
    created.push(params)
    return { id: String(params.id ?? 'child-1'), title: String(params.title ?? '') }
  },
  send: async (_id: string, text: string) => {
    sent.push(text)
  }
}

beforeEach(() => {
  created.length = 0
  sent.length = 0
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
