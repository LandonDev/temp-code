import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/events'
import { openDb, Store } from './db'
import { LIMIT_CONTINUE_DELAY_MS, SessionRegistry, type AccountRouter } from './sessions'

/** One controlled driver: every start hands back its emit and records its route, every send is recorded. */
const emits = new Map<string, (event: AgentEvent) => void>()
const routes: { id: string; route: unknown }[] = []
const sends: string[] = []
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: { session: { id: string }; route: unknown; emit: (event: AgentEvent) => void }) => {
        emits.set(ctx.session.id, ctx.emit)
        routes.push({ id: ctx.session.id, route: ctx.route })
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
  routes.length = 0
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
async function running(params: Partial<Parameters<SessionRegistry['create']>[0]> = {}): Promise<{ id: string; emit: (event: AgentEvent) => void }> {
  const session = await registry.create({ cwd: root, provider: 'claude', model: 'claude-sonnet-5', ...params })
  await registry.send(session.id, 'hello')
  const emit = emits.get(session.id)
  if (!emit) throw new Error('driver never started')
  return { id: session.id, emit }
}

/** A router that spawns every thread on `a@x.com` (pinned when a pin applies) and answers each limit with `result`. */
function limits(result: { from: string; to: string } | null): AccountRouter & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    routeFor: (meta, pin) => ({ route: { account: pin?.name ?? meta.account ?? 'a@x.com', pin: pin !== null }, current: meta.account ?? pin?.name ?? 'a@x.com' }),
    failover: async (sessionId, info) => {
      calls.push([sessionId, info])
      await sleep(10)
      return result
    }
  }
}

it('a limit error moves only that thread and continues the tree once the session settles', async () => {
  const fake = limits({ from: 'a@x.com', to: 'b@x.com' })
  registry.limits = fake
  const { id, emit } = await running()
  const { id: sibling, emit: siblingEmit } = await running()
  expect(registry.get(id)?.account).toBe('a@x.com')
  emit({ type: 'error', message: "You've hit your limit", limit: { window: '5h' } })
  expect(fake.calls).toEqual([[id, { provider: 'claude', model: 'claude-sonnet-5', window: '5h', account: 'a@x.com' }]])
  emit({ type: 'status', status: 'idle' })
  expect(registry.get(id)?.canContinue).toBe(true)
  await settle()
  expect(sends.filter((t) => t.startsWith('<continue-run>'))).toHaveLength(1)
  expect(sends.at(-1)).toContain('a usage limit on a@x.com; the app switched to b@x.com')
  expect(registry.get(id)?.canContinue).toBe(false)
  expect(registry.get(id)?.account).toBe('b@x.com')
  expect(registry.get(sibling)?.account).toBe('a@x.com')
  siblingEmit({ type: 'status', status: 'idle' })
  // Settling again later does not continue twice.
  emits.get(id)?.({ type: 'status', status: 'idle' })
  await settle()
  expect(sends.filter((t) => t.startsWith('<continue-run>'))).toHaveLength(1)
  expect(fake.calls).toHaveLength(1)
})

it('no account with room leaves the error, the Continue button and the account in place', async () => {
  const fake = limits(null)
  registry.limits = fake
  const { id, emit } = await running()
  emit({ type: 'error', message: 'weekly limit reached', limit: { window: 'weekly' } })
  emit({ type: 'status', status: 'error' })
  await settle()
  expect(fake.calls).toHaveLength(1)
  expect(sends.some((t) => t.startsWith('<continue-run>'))).toBe(false)
  expect(registry.get(id)?.canContinue).toBe(true)
  expect(registry.get(id)?.account).toBe('a@x.com')
})

it('the spawn names the resolved pin, a child never inherits the parent\'s, and a pin change respawns on the next send', async () => {
  registry.limits = limits(null)
  const ws = await registry.createWorkspace(root)
  registry.setWorkspaceAccounts(ws.id, { claude: 'ws@x.com' })
  const { id } = await running({ workspaceId: ws.id })
  expect(routes.at(-1)).toEqual({ id, route: { account: 'ws@x.com', pin: true } })
  expect(registry.get(id)?.account).toBe('ws@x.com')

  registry.setAccountPin(id, 'me@x.com')
  expect(registry.get(id)?.accountPin).toBe('me@x.com')
  expect(routes).toHaveLength(1)
  await registry.send(id, 'again')
  expect(routes.at(-1)).toEqual({ id, route: { account: 'me@x.com', pin: true } })
  // Same pin, no respawn.
  await registry.send(id, 'and again')
  expect(routes).toHaveLength(2)

  const child = await registry.create({ cwd: root, provider: 'claude', model: 'claude-sonnet-5', parentId: id, workspaceId: ws.id })
  expect(child.accountPin ?? null).toBeNull()
  await registry.send(child.id, 'go')
  expect(routes.at(-1)).toEqual({ id: child.id, route: { account: 'ws@x.com', pin: true } })

  // The gateway moved the thread: its row follows, nothing else changes.
  registry.setAccount(id, 'other@x.com')
  expect(registry.get(id)?.account).toBe('other@x.com')
  expect(registry.get(child.id)?.account).toBe('ws@x.com')
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
