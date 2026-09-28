import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CATALOG, supportsContext1m, type ProviderId } from '@shared/catalog'
import { DEFAULT_RULES } from '@shared/rules'
import type { SessionMeta } from '@shared/events'
import type { SessionRegistry } from './sessions'
import { orchSpawnAgent, setOrchestrationRegistry, spawnableModels } from './orchestration'

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

beforeEach(() => {
  created.length = 0
  sent.length = 0
  setOrchestrationRegistry({
    get: (id: string) => (id === parent.id ? parent : null),
    childrenOf: () => [],
    getProject: () => null,
    getOrchestrationRules: () => DEFAULT_RULES,
    create: async (params: Record<string, unknown>) => {
      created.push(params)
      return { id: 'child-1', title: String(params.title ?? '') }
    },
    send: async (_id: string, text: string) => {
      sent.push(text)
    }
  } as unknown as SessionRegistry)
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
