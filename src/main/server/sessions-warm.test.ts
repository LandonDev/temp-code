import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { WarmPool, retireWarmPools, warmStatuses } from './drivers/warm'
import { SessionRegistry } from './sessions'

vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async () => ({ send: async () => {}, interrupt: () => {}, dispose: async () => {} })
    }
  }
}))

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-warm-sessions-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

it('a warm process is no session: the list, the running count and the tree stay as they were', async () => {
  const session = await registry.create({ cwd: root })
  store.updateSession(session.id, { status: 'running' })
  const before = { list: registry.list().map((s) => s.id), running: registry.runningCount() }
  const pool = new WarmPool<{ killed: boolean }>({
    driver: 'claude',
    replaceAfterMs: 0,
    log: () => {},
    spawn: async () => ({ killed: false }),
    kill: (p) => {
      p.killed = true
    }
  })
  pool.noteStart({ command: 'claude', args: [], cwd: root, env: {} })
  await pool.settled()
  expect(pool.status().warm).toHaveLength(1)
  expect(warmStatuses().map((s) => s.warm.length)).toEqual([1])
  expect(registry.list().map((s) => s.id)).toEqual(before.list)
  expect(registry.runningCount()).toBe(before.running)
  expect(registry.get(session.id)?.status).toBe('running')
  // The status surface is its own: harness.warm answers the pools, and retire empties them.
  retireWarmPools()
  expect(warmStatuses().map((s) => s.warm.length)).toEqual([0])
  expect(registry.runningCount()).toBe(before.running)
  pool.close()
})
