import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyAccounts, type AccountsSnapshot } from '@shared/accounts'
import type { AgentEvent } from '@shared/events'
import { chooseAccount } from './accountRouting'
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

it('the spawn names the resolved pin, a child spawns under the same scope pin, and a pin change respawns on the next send', async () => {
  registry.limits = limits(null)
  const ws = await registry.createWorkspace(root)
  registry.setWorkspaceAccounts(ws.id, { claude: 'ws@x.com' })
  const { id } = await running({ workspaceId: ws.id })
  expect(routes.at(-1)).toEqual({ id, route: { account: 'ws@x.com', pin: true } })
  expect(registry.get(id)?.account).toBe('ws@x.com')

  registry.setWorkspaceAccounts(ws.id, { claude: 'me@x.com' })
  expect(routes).toHaveLength(1)
  await registry.send(id, 'again')
  expect(routes.at(-1)).toEqual({ id, route: { account: 'me@x.com', pin: true } })
  // Same pin, no respawn.
  await registry.send(id, 'and again')
  expect(routes).toHaveLength(2)

  const child = await registry.create({ cwd: root, provider: 'claude', model: 'claude-sonnet-5', parentId: id, workspaceId: ws.id })
  await registry.send(child.id, 'go')
  expect(routes.at(-1)).toEqual({ id: child.id, route: { account: 'me@x.com', pin: true } })

  // The gateway moved the thread: its row follows, nothing else changes.
  registry.setAccount(id, 'other@x.com')
  expect(registry.get(id)?.account).toBe('other@x.com')
  expect(registry.get(child.id)?.account).toBe('me@x.com')
})

/** A router whose pick depends on the model: Fable threads land on `f@x.com`, everything else on `o@x.com`;
 *  a pin wins, and the thread's sticky account is kept unless the pick is fresh. */
function byModel(): AccountRouter {
  return {
    routeFor: (meta, pin, opts) => {
      const best = meta.model?.includes('fable') ? 'f@x.com' : 'o@x.com'
      const picked = pin?.name ?? (opts?.fresh ? best : (meta.account ?? best))
      return { route: { account: picked, pin: pin !== null }, current: picked }
    },
    failover: async () => null
  }
}

it('a thread shows its expected account from creation, and again when its model changes', async () => {
  registry.limits = byModel()
  const created = await registry.create({ cwd: root, provider: 'claude', model: 'claude-opus-5-5' })
  expect(created.account).toBe('o@x.com')
  expect(registry.get(created.id)?.account).toBe('o@x.com')
  // The gateway moved the thread meanwhile: the same model keeps that (sticky) account.
  registry.setAccount(created.id, 'moved@x.com')
  await registry.send(created.id, 'same model')
  expect(registry.get(created.id)?.account).toBe('moved@x.com')
  // A model change re-picks for the new model; the sticky account does not carry over.
  await registry.send(created.id, 'switch', { model: 'claude-fable-5-1' })
  expect(registry.get(created.id)?.account).toBe('f@x.com')
  expect(routes.at(-1)).toEqual({ id: created.id, route: { account: 'f@x.com', pin: false } })
})

it('a model pick through tune lands before any send: the model persists and the account re-picks fresh', async () => {
  registry.limits = byModel()
  const { id } = await running({ model: 'claude-fable-5-1' })
  expect(registry.get(id)?.account).toBe('f@x.com')
  registry.setAccount(id, 'moved@x.com')
  await registry.tune(id, { model: 'claude-opus-5-5' })
  expect(registry.get(id)).toMatchObject({ model: 'claude-opus-5-5', account: 'o@x.com' })
  // The next send finds the model already in place and spawns under the new pick.
  const spawns = routes.length
  await registry.send(id, 'go')
  expect(routes).toHaveLength(spawns + 1)
  expect(routes.at(-1)).toEqual({ id, route: { account: 'o@x.com', pin: false } })
  // The same model again changes nothing; another provider's model is left to send().
  await registry.tune(id, { model: 'claude-opus-5-5', fast: true })
  expect(registry.get(id)).toMatchObject({ model: 'claude-opus-5-5', account: 'o@x.com', fast: true })
  await registry.tune(id, { model: 'gpt-6-astra' })
  expect(registry.get(id)?.model).toBe('claude-opus-5-5')
})

it('a tune mid-turn keeps the stream and reboots once the turn settles', async () => {
  registry.limits = byModel()
  const { id, emit } = await running({ model: 'claude-fable-5-1' })
  emit({ type: 'status', status: 'running' })
  const spawns = routes.length
  await registry.tune(id, { model: 'claude-opus-5-5' })
  expect(registry.get(id)).toMatchObject({ model: 'claude-opus-5-5', account: 'o@x.com', status: 'running' })
  expect(emits.get(id)).toBeDefined()
  emit({ type: 'status', status: 'idle' })
  await settle()
  await registry.send(id, 'go')
  expect(routes).toHaveLength(spawns + 1)
  expect(routes.at(-1)).toEqual({ id, route: { account: 'o@x.com', pin: false } })
})

it('a scope pin change recomputes threads under it; a refresh re-picks threads with no account', async () => {
  registry.limits = byModel()
  const ws = await registry.createWorkspace(root)
  const idle = await registry.create({ cwd: root, provider: 'claude', model: 'claude-opus-5-5', workspaceId: ws.id })
  // A thread outside the workspace: its cwd is elsewhere (a cwd inside a workspace's path joins it).
  const elsewhere = await mkdtemp(join(tmpdir(), 'tc-loose-'))
  const loose = await running({ cwd: elsewhere, model: 'claude-opus-5-5' })
  expect(registry.get(idle.id)?.account).toBe('o@x.com')
  registry.setWorkspaceAccounts(ws.id, { claude: 'ws@x.com' })
  expect(registry.get(idle.id)?.account).toBe('ws@x.com')
  expect(registry.get(loose.id)?.account).toBe('o@x.com')

  // Rows from before the pick existed (or made while no account was known).
  registry.setAccount(idle.id, null)
  registry.setAccount(loose.id, null)
  registry.refreshAccounts()
  expect(registry.get(idle.id)?.account).toBe('ws@x.com')
  expect(registry.get(loose.id)?.account).toBe('o@x.com')
  await rm(elsewhere, { recursive: true, force: true })
})

it('a refresh re-picks a thread with no live process fresh, keeps a live one sticky, and drops a live one whose pick moved', async () => {
  registry.limits = byModel()
  // Live: the gateway moved it; a refresh keeps that (sticky) while it has room.
  const { id: live } = await running({ model: 'claude-opus-5-5' })
  registry.setAccount(live, 'moved@x.com')
  registry.refreshAccount(live)
  expect(registry.get(live)?.account).toBe('moved@x.com')
  // No process (a thread from before this boot): the stale account gives way to the best pick for its model.
  const cold = await running({ model: 'claude-opus-5-5' })
  await registry.disposeAll()
  registry.setAccount(cold.id, 'stale@x.com')
  registry.refreshAccount(cold.id)
  expect(registry.get(cold.id)?.account).toBe('o@x.com')
  // A live process whose pick moved (here: a workspace pin) is dropped so the next send respawns under it.
  const ws = await registry.createWorkspace(root)
  const { id: pinned } = await running({ model: 'claude-opus-5-5', workspaceId: ws.id })
  const spawns = routes.length
  registry.setWorkspaceAccounts(ws.id, { claude: 'ws@x.com' })
  expect(registry.get(pinned)?.account).toBe('ws@x.com')
  await registry.send(pinned, 'again')
  expect(routes).toHaveLength(spawns + 1)
  expect(routes.at(-1)).toEqual({ id: pinned, route: { account: 'ws@x.com', pin: true } })
  // Mid-turn: untouched.
  const { id: busy, emit } = await running({ model: 'claude-opus-5-5' })
  emit({ type: 'status', status: 'running' })
  registry.setAccount(busy, 'gateway@x.com')
  registry.refreshAccount(busy)
  expect(registry.get(busy)?.account).toBe('gateway@x.com')
})

type Windows = { label: string; usedPercent: number; resetsAt?: number }[]
const NOW = 1_800_000_000_000

/** The real pick over a snapshot the test edits in place. */
function snapshotRouter(reports: Record<string, Windows>): AccountRouter {
  const snapshot: AccountsSnapshot = emptyAccounts()
  const provider = snapshot.providers.claude
  provider.owner = 'temp-code'
  provider.profiles = Object.keys(reports).map((name) => ({ name, createdAt: 1, active: false }))
  provider.reports = Object.entries(reports).map(([profileName, windows]) => ({ profileName, windows }))
  return {
    routeFor: (meta, pin, opts) =>
      chooseAccount({ pin: pin?.name ?? null, current: opts?.fresh ? null : (meta.account ?? null), model: meta.model ?? null, provider: meta.provider, snapshot, now: NOW }),
    failover: async () => null
  }
}

it('an idle Opus thread leaves an account whose Fable window came back for one whose Fable window is spent', async () => {
  const a: Windows = [{ label: 'Weekly', usedPercent: 10, resetsAt: NOW + 1 }, { label: 'Fable', usedPercent: 100, resetsAt: NOW + 9 }]
  const b: Windows = [{ label: 'Weekly', usedPercent: 20, resetsAt: NOW + 9 }, { label: 'Fable', usedPercent: 100, resetsAt: NOW + 9 }]
  registry.limits = snapshotRouter({ 'a@x.com': a, 'b@x.com': b })
  // Both Fable windows spent: the Opus thread takes the soonest weekly reset, a.
  const { id: opus } = await running({ model: 'claude-opus-5-5' })
  expect(registry.get(opus)?.account).toBe('a@x.com')
  // a's Fable window reset: the idle Opus thread moves to b and its process is dropped, so the next send respawns there.
  a[1] = { label: 'Fable', usedPercent: 0, resetsAt: NOW + 9 }
  const spawns = routes.length
  registry.refreshAccount(opus)
  expect(registry.get(opus)?.account).toBe('b@x.com')
  await registry.send(opus, 'again')
  expect(routes).toHaveLength(spawns + 1)
  expect(routes.at(-1)).toEqual({ id: opus, route: { account: 'b@x.com', pin: false } })
  // A Fable thread on a stays: a is the only account with Fable room.
  const { id: fable } = await running({ model: 'claude-fable-5-1' })
  expect(registry.get(fable)?.account).toBe('a@x.com')
  registry.refreshAccount(fable)
  expect(registry.get(fable)?.account).toBe('a@x.com')
  // b's week is gone: the Opus thread falls back to a (out of room, as before)…
  b[0] = { label: 'Weekly', usedPercent: 100, resetsAt: NOW + 9 }
  registry.refreshAccount(opus)
  expect(registry.get(opus)?.account).toBe('a@x.com')
  // …and stays there while no other account has room, however its own Fable window looks.
  registry.refreshAccount(opus)
  expect(registry.get(opus)?.account).toBe('a@x.com')
  // Mid-turn: untouched even when a spent account with room appears.
  b[0] = { label: 'Weekly', usedPercent: 20, resetsAt: NOW + 9 }
  const { id: busy, emit } = await running({ model: 'claude-opus-5-5' })
  registry.setAccount(busy, 'a@x.com')
  emit({ type: 'status', status: 'running' })
  registry.refreshAccount(busy)
  expect(registry.get(busy)?.account).toBe('a@x.com')
})

it('an empty snapshot leaves the account unknown rather than clearing it', async () => {
  registry.limits = { routeFor: () => ({ route: null, current: null }), failover: async () => null }
  const created = await registry.create({ cwd: root, provider: 'claude', model: 'claude-opus-5-5' })
  expect(created.account).toBeNull()
  registry.setAccount(created.id, 'kept@x.com')
  registry.expectAccount(created.id)
  expect(registry.get(created.id)?.account).toBe('kept@x.com')
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

it('liveLoad counts running, watching and starting threads per account; idle and archived ones do not count', async () => {
  registry.limits = limits(null)
  const { id: a, emit: emitA } = await running()
  const { id: b, emit: emitB } = await running()
  const { emit: emitC } = await running()
  // The mocked driver never reports a status: nothing is live yet.
  expect(registry.liveLoad('claude')).toEqual({})
  emitA({ type: 'status', status: 'running' })
  emitB({ type: 'status', status: 'watching' })
  emitC({ type: 'status', status: 'running' })
  expect(registry.liveLoad('claude')).toEqual({ 'a@x.com': 3 })
  registry.setAccount(b, 'b@x.com')
  emitC({ type: 'status', status: 'idle' })
  expect(registry.liveLoad('claude')).toEqual({ 'a@x.com': 1, 'b@x.com': 1 })
  await registry.setArchived(a, true)
  expect(registry.liveLoad('claude')).toEqual({ 'b@x.com': 1 })
  expect(registry.liveLoad('codex')).toEqual({})
  // A spawn in flight counts before its driver says anything.
  const d = await registry.create({ cwd: root, provider: 'claude', model: 'claude-sonnet-5' })
  const privy = registry as unknown as { starting: Map<string, Promise<unknown>>; dropHandle: (id: string) => Promise<void> }
  await privy.dropHandle(d.id)
  privy.starting.set(d.id, new Promise(() => {}))
  expect(registry.liveLoad('claude')).toEqual({ 'a@x.com': 1, 'b@x.com': 1 })
  privy.starting.delete(d.id)
})

it('refreshAccounts reads the sessions table and the live load once per pass, however many threads it re-picks', async () => {
  // Like AccountsService: the live load comes in the options, else it is read.
  // Read per thread (a table scan, then a walk of every handle), a snapshot
  // cost threads × rows: 16 s of blocked loop on 1.8k threads × 3.2k rows.
  registry.limits = {
    routeFor: (meta, _pin, opts) => {
      if (!opts?.load) registry.liveLoad(meta.provider)
      return { route: { account: 'a@x.com', pin: false }, current: 'a@x.com' }
    },
    failover: async () => null
  }
  for (let i = 0; i < 20; i++) await registry.create({ cwd: root, provider: 'claude', model: 'claude-sonnet-5' })
  const list = vi.spyOn(store, 'listSessions')
  const load = vi.spyOn(registry, 'liveLoad')
  registry.refreshAccounts()
  expect(list).toHaveBeenCalledTimes(1)
  expect(load).toHaveBeenCalledTimes(1)
})

it('a spawn picks fresh: the sticky account is ignored so a resume spreads by the live load', async () => {
  const opts: unknown[] = []
  registry.limits = {
    routeFor: (meta, _pin, o) => {
      const account = o?.fresh ? 'fresh@x.com' : (meta.account ?? 'sticky@x.com')
      opts.push(o)
      return { route: { account, pin: false }, current: account }
    },
    failover: async () => null
  }
  const session = await registry.create({ cwd: root, provider: 'claude', model: 'claude-sonnet-5' })
  // The row showed the sticky pick; the process that spawned with it is gone (idle sweep, say).
  await (registry as unknown as { dropHandle: (id: string) => Promise<void> }).dropHandle(session.id)
  registry.setAccount(session.id, 'sticky@x.com')
  const spawns = routes.length
  await registry.send(session.id, 'hello')
  expect(routes).toHaveLength(spawns + 1)
  expect(opts.at(-1)).toEqual({ fresh: true })
  expect(routes.at(-1)).toEqual({ id: session.id, route: { account: 'fresh@x.com', pin: false } })
  expect(registry.get(session.id)?.account).toBe('fresh@x.com')
})
