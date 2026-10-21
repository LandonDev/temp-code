import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
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
  root = await mkdtemp(join(tmpdir(), 'tc-preconnect-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

it('a send into an idle thread pre-connects its provider under the row\'s account before the harness boots', async () => {
  const asked: [string, string | null][] = []
  registry.preconnect = (provider, account) => asked.push([provider, account])
  const session = await registry.create({ cwd: root })
  store.setSessionAccount(session.id, 'work')
  await registry.send(session.id, 'hello')
  expect(asked).toEqual([['claude', 'work']])
})

it('a thread with no account yet pre-connects the router\'s pick, or unscoped without a router', async () => {
  const asked: [string, string | null][] = []
  registry.preconnect = (provider, account) => asked.push([provider, account])
  const session = await registry.create({ cwd: root })
  await registry.send(session.id, 'hello')
  expect(asked).toEqual([['claude', null]])
})

it('composer focus pre-connects an idle thread and leaves a running one alone', async () => {
  const asked: [string, string | null][] = []
  registry.preconnect = (provider, account) => asked.push([provider, account])
  const session = await registry.create({ cwd: root })
  expect(registry.preconnectIdle(session.id)).toBe(true)
  expect(asked).toHaveLength(1)
  store.updateSession(session.id, { status: 'running' })
  expect(registry.preconnectIdle(session.id)).toBe(false)
  expect(asked).toHaveLength(1)
  expect(() => registry.preconnectIdle('nope')).toThrow(/unknown session/)
})

it('nothing happens without a pre-connect hook', async () => {
  const session = await registry.create({ cwd: root })
  expect(registry.preconnectIdle(session.id)).toBe(true)
  await registry.send(session.id, 'hello')
})
