import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { isPlaceholderTitle, SessionRegistry } from './sessions'

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
  root = await mkdtemp(join(tmpdir(), 'tc-sessions-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})
it('persists pin changes across a reopened DB and pushes metadata', async () => {
  const session = await registry.create({ cwd: root })
  expect(session.pinned).toBe(false)
  const listener = vi.fn()
  const off = registry.onMeta(listener)
  registry.setPinned(session.id, true)
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: session.id, pinned: true }))
  expect(() => registry.setPinned('missing', true)).toThrow('unknown session')
  off()
  await registry.disposeAll()
  db.close()
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  expect(store.getSession(session.id)?.pinned).toBe(true)
  registry.setPinned(session.id, false)
  expect(store.getSession(session.id)?.pinned).toBe(false)
})
it('migrates pre-pin databases without changing their sessions', async () => {
  const session = await registry.create({ cwd: root, title: 'Keep me' })
  db.exec('ALTER TABLE sessions DROP COLUMN pinned')
  await registry.disposeAll()
  db.close()
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  expect(store.getSession(session.id)).toMatchObject({ pinned: false, title: 'Keep me' })
})
it('honors caller ids and rejects taken and invalid ids without altering the existing session', async () => {
  const session = await registry.create({ id: 'caller-1', cwd: root })
  expect(session.id).toBe('caller-1')
  await expect(registry.create({ id: 'caller-1', title: 'clobber' })).rejects.toThrow(
    'already taken'
  )
  await expect(registry.create({ id: '../bad' })).rejects.toThrow()
  expect(store.getSession(session.id)?.title).toBe(session.title)
})
it('adopts old path-only sessions and assigns new path-only sessions to matching workspaces', async () => {
  const a = await registry.create({ cwd: root })
  const b = await registry.create({ cwd: join(root, 'other') })
  const listener = vi.fn()
  registry.onMeta(listener)
  const catalog = vi.fn()
  registry.onCatalog(catalog)
  const workspace = await registry.createWorkspace(root)
  expect(store.getSession(a.id)?.workspaceId).toBe(workspace.id)
  expect(store.getSession(b.id)?.workspaceId).toBeNull()
  expect(listener).toHaveBeenCalledWith(
    expect.objectContaining({ id: a.id, workspaceId: workspace.id })
  )
  expect(catalog).toHaveBeenCalledWith('workspaces')
  expect((await registry.create({ cwd: root })).workspaceId).toBe(workspace.id)
  expect((await registry.createWorkspace(root)).id).toBe(workspace.id)
})
it('recognizes typed and untyped placeholder titles while preserving custom titles', async () => {
  const session = await registry.create({ cwd: root })
  expect(isPlaceholderTitle(session)).toBe(true)
  expect(isPlaceholderTitle({ ...session, title: 'New task' })).toBe(true)
  expect(isPlaceholderTitle({ ...session, title: 'Custom' })).toBe(false)
})

it('replaces an untyped placeholder on the first send and keeps a custom title', async () => {
  const plain = await registry.create({ cwd: root })
  await registry.send(plain.id, 'First message title')
  expect(store.getSession(plain.id)?.title).toBe('First message title')
  const custom = await registry.create({ cwd: root, title: 'My title' })
  await registry.send(custom.id, 'Do not rename')
  expect(store.getSession(custom.id)?.title).toBe('My title')
})
