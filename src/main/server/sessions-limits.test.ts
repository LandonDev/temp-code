import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/events'
import { openDb, Store } from './db'
import { LIMIT_CONTINUE_DELAY_MS, SessionRegistry, type LimitFailover } from './sessions'

/** One controlled driver: every start hands back its emit, every send is recorded. */
const emits = new Map<string, (event: AgentEvent) => void>()
const sends: string[] = []
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: { session: { id: string }; emit: (event: AgentEvent) => void }) => {
        emits.set(ctx.session.id, ctx.emit)
        return {
          send: async (text: string) => {
            sends.push(text)
          },
          interrupt: () => {},
          dispose: async () => {}
        }
      }
    }
  }
}))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const settle = () => sleep(LIMIT_CONTINUE_DELAY_MS + 50)

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
beforeEach(async () => {
  emits.clear()
  sends.length = 0
  root = await mkdtemp(join(tmpdir(), 'tc-limits-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

/** A running claude session whose driver emit we hold. */
async function running(): Promise<{ id: string; emit: (event: AgentEvent) => void }> {
  const session = await registry.create({ cwd: root, provider: 'claude', model: 'claude-sonnet-5' })
  await registry.send(session.id, 'hello')
  const emit = emits.get(session.id)
  if (!emit) throw new Error('driver never started')
  return { id: session.id, emit }
}

function limits(result: { from: string; to: string } | null): LimitFailover & { calls: unknown[]; liveDuring: string[] } {
  const calls: unknown[] = []
  const liveDuring: string[] = []
  return {
    calls,
    liveDuring,
    failover: async (provider, info) => {
      calls.push([provider, info])
      liveDuring.push(...registry.limitedModels('claude'))
      await sleep(10)
      return result
    }
  }
}

it('a limit error switches accounts and continues the tree once the session settles', async () => {
  const fake = limits({ from: 'a@x.com', to: 'b@x.com' })
  registry.limits = fake
  const { id, emit } = await running()
  emit({ type: 'error', message: "You've hit your limit", limit: { window: '5h' } })
  expect(fake.calls).toEqual([['claude', { model: 'claude-sonnet-5', window: '5h' }]])
  expect(fake.liveDuring).toEqual(['claude-sonnet-5'])
  emit({ type: 'status', status: 'idle' })
  expect(registry.get(id)?.canContinue).toBe(true)
  await settle()
  expect(sends.filter((t) => t.startsWith('<continue-run>'))).toHaveLength(1)
  expect(sends.at(-1)).toContain('a usage limit on a@x.com; the app switched to b@x.com')
  expect(registry.get(id)?.canContinue).toBe(false)
  expect(registry.limitedModels('claude')).toEqual([])
  // Settling again later does not continue twice.
  emits.get(id)?.({ type: 'status', status: 'idle' })
  await settle()
  expect(sends.filter((t) => t.startsWith('<continue-run>'))).toHaveLength(1)
  expect(fake.calls).toHaveLength(1)
})

it('no account with room leaves the error and the Continue button in place', async () => {
  const fake = limits(null)
  registry.limits = fake
  const { id, emit } = await running()
  emit({ type: 'error', message: 'weekly limit reached', limit: { window: 'weekly' } })
  emit({ type: 'status', status: 'error' })
  await settle()
  expect(fake.calls).toHaveLength(1)
  expect(sends.some((t) => t.startsWith('<continue-run>'))).toBe(false)
  expect(registry.get(id)?.canContinue).toBe(true)
  expect(registry.limitedModels('claude')).toEqual([])
})

it('transient limits, stops and errors without a limit never ask for a switch', async () => {
  const fake = limits({ from: 'a@x.com', to: 'b@x.com' })
  registry.limits = fake
  const { emit } = await running()
  emit({ type: 'error', message: 'overloaded', limit: { window: 'transient' } })
  emit({ type: 'error', message: 'stopped by user', stopped: true, limit: { window: '5h' } })
  emit({ type: 'error', message: 'Prompt is too long' })
  emit({ type: 'status', status: 'idle' })
  await settle()
  expect(fake.calls).toEqual([])
  expect(sends.some((t) => t.startsWith('<continue-run>'))).toBe(false)
})
