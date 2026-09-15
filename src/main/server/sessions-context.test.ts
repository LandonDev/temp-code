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
  root = await mkdtemp(join(tmpdir(), 'tc-context-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

async function reopen(): Promise<void> {
  await registry.disposeAll()
  db.close()
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
}

it('keeps the last context reading on the row and serves it after a relaunch', async () => {
  const session = await registry.create({ cwd: root })
  const listener = vi.fn()
  registry.onMeta(listener)
  registry.append(session.id, { type: 'context', tokens: 120_000, window: 200_000 })
  expect(listener).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: session.id, context: { tokens: 120_000, window: 200_000 } })
  )
  // Accounting is meta, never transcript: the log stays as it was.
  expect(store.eventsAfter(session.id, 0).some((r) => r.event.type === 'context')).toBe(false)
  // A reading is not an edit: the list order (updated_at) does not move.
  expect(store.getSession(session.id)?.updatedAt).toBe(session.updatedAt)
  // The window sticks when a later reading omits it.
  registry.append(session.id, { type: 'context', tokens: 130_000 })
  expect(store.getSession(session.id)?.context).toEqual({ tokens: 130_000, window: 200_000 })

  await reopen()
  expect(registry.get(session.id)?.context).toEqual({ tokens: 130_000, window: 200_000 })
  expect(registry.list().find((s) => s.id === session.id)?.context).toEqual({
    tokens: 130_000,
    window: 200_000
  })
})

it('a thread that never reported has no reading, before and after a relaunch', async () => {
  const session = await registry.create({ cwd: root })
  expect(registry.get(session.id)?.context).toBeNull()
  await reopen()
  expect(registry.get(session.id)?.context).toBeNull()
})
