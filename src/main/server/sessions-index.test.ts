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
  root = await mkdtemp(join(tmpdir(), 'tc-index-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

it('meta pushes that write no session row reuse one index; a row write rebuilds it once', async () => {
  const parent = await registry.create({ cwd: root })
  const child = await registry.create({ cwd: root, parentId: parent.id })
  const pushes: string[] = []
  registry.onMeta((m) => pushes.push(m.id))
  // create() decorated through the index already: a row write makes the
  // next read a known miss.
  store.updateSession(parent.id, { title: 'parent' })
  const lists = vi.spyOn(store, 'listSessions')

  registry.get(parent.id)
  expect(lists).toHaveBeenCalledTimes(1)
  // Twenty tool calls: each moves the activity line and pushes the child
  // and its root, and none touches the sessions table.
  for (let i = 0; i < 20; i++) {
    registry.append(child.id, { type: 'tool-call', callId: `c${i}`, name: 'Read', input: { file_path: `/f${i}.ts` } })
  }
  expect(pushes.length).toBeGreaterThanOrEqual(40)
  expect(lists).toHaveBeenCalledTimes(1)
  registry.childrenOf(parent.id)
  registry.runningCount()
  expect(lists).toHaveBeenCalledTimes(1)

  // A sessions-table write invalidates: the next decorate reads once more
  // and sees the change through the index (the parent's tree flag comes
  // from its children's rows).
  expect(registry.get(parent.id)?.treeHasLiveWork).toBe(false)
  store.updateSession(child.id, { status: 'running' })
  expect(registry.get(parent.id)?.treeHasLiveWork).toBe(true)
  expect(lists).toHaveBeenCalledTimes(2)
  expect(registry.runningCount()).toBe(1)
  expect(lists).toHaveBeenCalledTimes(2)

  // list() reads fresh rows once and they become the index.
  expect(registry.list().map((s) => s.id).sort()).toEqual([parent.id, child.id].sort())
  expect(lists).toHaveBeenCalledTimes(3)
  registry.get(child.id)
  expect(lists).toHaveBeenCalledTimes(3)
})

it('every sessions-table write bumps the version', async () => {
  const session = await registry.create({ cwd: root })
  let v = store.sessionsVersion
  const bumped = (): void => {
    expect(store.sessionsVersion).toBeGreaterThan(v)
    v = store.sessionsVersion
  }
  store.updateSession(session.id, { title: 't' })
  bumped()
  store.setSessionAccount(session.id, 'a@x')
  bumped()
  store.setSessionContext(session.id, { tokens: 1, window: null })
  bumped()
  store.setSessionWorkspace(session.id, 'w')
  bumped()
  store.setRetyped(session.id, true)
  bumped()
  store.deleteSessionTree(session.id)
  bumped()
  expect(registry.get(session.id)).toBeNull()
})

it('deleting a thread removes its HTML pages along with its children\'s', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { existsSync } = await import('node:fs')
  const { setHtmlRenderRoot } = await import('./htmlRender')
  const pages = join(root, 'html-renders')
  setHtmlRenderRoot(pages)
  const parent = await registry.create({ cwd: root })
  const child = await registry.create({ cwd: root, parentId: parent.id })
  const other = await registry.create({ cwd: root })
  for (const id of [parent.id, child.id, other.id]) {
    await mkdir(join(pages, id), { recursive: true })
    await writeFile(join(pages, id, 'p.html'), '<p/>')
  }
  await registry.delete(parent.id)
  expect(existsSync(join(pages, parent.id))).toBe(false)
  expect(existsSync(join(pages, child.id))).toBe(false)
  expect(existsSync(join(pages, other.id, 'p.html'))).toBe(true)
})
