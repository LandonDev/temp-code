import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-loose-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

it('a chat with no project and no workspace runs in the home directory', async () => {
  const session = await registry.create({ provider: 'claude', model: 'claude-sonnet-5' })
  expect(session.projectId).toBeNull()
  expect(session.workspaceId).toBeNull()
  expect(session.cwd).toBe(homedir())
  expect(store.getSession(session.id)?.cwd).toBe(homedir())
})

it('a chat in a folder the catalog does not know stays outside every workspace', async () => {
  const session = await registry.create({ cwd: root, provider: 'claude', model: 'claude-sonnet-5' })
  expect(session.projectId).toBeNull()
  expect(session.workspaceId).toBeNull()
  expect(session.cwd).toBe(root)
})
