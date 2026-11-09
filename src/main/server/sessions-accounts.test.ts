import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/events'
import { openDb, Store } from './db'
import { REFRESH_SLICE, SessionRegistry, type AccountRouter } from './sessions'
import type { DriverCtx } from './drivers/types'

/**
 * The account re-pick by changed set (plan S6, F31): a window reset on one
 * account re-picks its threads and the unassigned ones, in slices behind
 * the loop, each meta tagged `accounts`; the other accounts' threads push
 * nothing.
 */
const emits = new Map<string, (e: AgentEvent) => void>()
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx) => {
        emits.set(ctx.session.id, ctx.emit)
        return { send: async () => ctx.emit({ type: 'status', status: 'running' }), interrupt: () => {}, alive: () => true, dispose: async () => {} }
      }
    }
  }
}))

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-accounts-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
})
afterEach(async () => {
  await registry.close()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** A router whose pick for an unassigned thread is `best`, keeping an assigned one where it is. */
const router = (best: string): AccountRouter => ({
  routeFor: (meta, pin, opts) => {
    const account = pin?.name ?? (opts?.fresh ? best : (meta.account ?? best))
    return { route: { account, pin: pin !== null }, current: account }
  },
  failover: async () => null
})

async function idleOn(account: string | null): Promise<string> {
  const s = await registry.create({ cwd: root, provider: 'claude', model: 'claude-opus-5-5' })
  registry.setAccount(s.id, account)
  return s.id
}

/** The rows as a boot sees them: no harness behind any (a live one keeps its account, sticky). */
async function cold(router: AccountRouter): Promise<void> {
  await registry.close()
  registry = new SessionRegistry(store)
  registry.limits = router
}

it('a Meta model with no Meta key on this host is refused at the send with the host\'s line, never sent unscoped', async () => {
  // The router knows the accounts and has no key: the route is null.
  registry.limits = { routeFor: () => ({ route: null, current: null }), failover: async () => null }
  const s = await registry.create({ cwd: root, provider: 'claude', model: 'muse-wonder-1.0' })
  await registry.send(s.id, 'hello').catch(() => {})
  await settle()
  const rows = registry.events(s.id, {}).map((r) => r.event)
  const error = rows.find((e) => e.type === 'error')
  expect(error).toMatchObject({ type: 'error', message: 'No Meta Model API key on this host' })
  expect(store.getSession(s.id)?.status).toBe('error')
  expect((error as { failure?: unknown }).failure).toMatchObject({ kind: 'account_unknown', summary: 'No Meta Model API key on this host' })
  expect(emits.has(s.id)).toBe(false)
  // A key on file: the same thread spawns, scoped to it.
  registry.limits = { routeFor: () => ({ route: { account: 'Meta key …LJY', pin: false, service: 'meta' }, current: 'Meta key …LJY' }), failover: async () => null }
  const t = await registry.create({ cwd: root, provider: 'claude', model: 'muse-spark-1.3' })
  await registry.send(t.id, 'hello').catch(() => {})
  await settle()
  expect(emits.has(t.id)).toBe(true)
  expect(store.getSession(t.id)?.account).toBe('Meta key …LJY')
})

it("A's reset re-picks A's threads and the unassigned ones, tagged accounts; B's threads push no meta", async () => {
  const onA = await idleOn('a@x.com')
  const onB = await idleOn('b@x.com')
  const none = await idleOn(null)
  await cold(router('best@x.com'))
  const pushed: { id: string; producer: string }[] = []
  registry.onMeta((m, producer) => pushed.push({ id: m.id, producer }))
  registry.refreshAccounts({ claude: new Set(['a@x.com']) })
  await settle()
  expect(pushed.map((p) => p.id).sort()).toEqual([onA, none].sort())
  expect(pushed.every((p) => p.producer === 'accounts')).toBe(true)
  expect(registry.get(onA)?.account).toBe('best@x.com')
  expect(registry.get(none)?.account).toBe('best@x.com')
  expect(registry.get(onB)?.account).toBe('b@x.com')
  // A pin that moved names the provider whole: every thread of it re-picks; only a changed pick pushes.
  pushed.length = 0
  registry.refreshAccounts({ claude: 'all' })
  await settle()
  expect(pushed.map((p) => p.id)).toEqual([onB])
  expect(registry.get(onB)?.account).toBe('best@x.com')
  // Another provider's change touches nothing here.
  pushed.length = 0
  registry.refreshAccounts({ codex: 'all' })
  await settle()
  expect(pushed).toEqual([])
})

it('a large pass runs in slices with the loop between them, every row written', async () => {
  const ids: string[] = []
  for (let i = 0; i < REFRESH_SLICE + 5; i++) ids.push(await idleOn('a@x.com'))
  await cold(router('best@x.com'))
  const pushed: string[] = []
  registry.onMeta((m) => pushed.push(m.id))
  registry.refreshAccounts({ claude: new Set(['a@x.com']) })
  // The first slice lands at once; the rest after the loop's turn.
  expect(pushed).toHaveLength(REFRESH_SLICE)
  await settle()
  expect(new Set(pushed)).toEqual(new Set(ids))
  expect(ids.every((id) => registry.get(id)?.account === 'best@x.com')).toBe(true)
})
