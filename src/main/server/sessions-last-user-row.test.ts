import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'

let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
beforeEach(() => {
  db = openDb(':memory:')
  store = new Store(db)
  registry = new SessionRegistry(store)
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
})

it('recovers a queued message through the last-user-row lookup, with its first-message stamp', async () => {
  const session = await registry.create({ cwd: '/tmp', provider: 'claude' })
  const send = vi.spyOn(registry, 'send').mockResolvedValue()
  const lookup = vi.spyOn(store, 'lastUserRow')
  vi.spyOn(store, 'eventsAfter').mockImplementation(() => { throw new Error('whole log read') })
  store.appendEvent(session.id, { type: 'user-text', text: 'first' })
  store.appendEvent(session.id, { type: 'assistant-text', text: 'reply', delta: false })
  store.updateSession(session.id, { status: 'queued' })
  expect(await registry.startQueued(session.id)).toBe(true)
  expect(send).toHaveBeenLastCalledWith(session.id, 'first', { attachments: undefined, echoed: { first: true } })
  store.appendEvent(session.id, { type: 'user-text', text: 'latest', attachments: [{ path: '/tmp/a.png', name: 'a.png', kind: 'image' }] })
  store.appendEvent(session.id, { type: 'assistant-text', text: '"user-text"', delta: false })
  expect(await registry.startQueued(session.id)).toBe(true)
  expect(send).toHaveBeenLastCalledWith(session.id, 'latest', { attachments: [{ path: '/tmp/a.png', name: 'a.png', kind: 'image' }], echoed: { first: false } })
  expect(lookup).toHaveBeenCalledTimes(2)
})

it('a queued session without a user row returns to idle', async () => {
  const session = await registry.create({ cwd: '/tmp', provider: 'claude' })
  store.updateSession(session.id, { status: 'queued' })
  const send = vi.spyOn(registry, 'send').mockResolvedValue()
  expect(await registry.startQueued(session.id)).toBe(false)
  expect(store.getSession(session.id)?.status).toBe('idle')
  expect(send).not.toHaveBeenCalled()
})
